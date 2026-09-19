use serde::Serialize;
use std::{
    collections::HashSet,
    env,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use url::Url;

const READY_PREFIX: &str = "EGE_SERVER_READY ";

struct DesktopRuntime {
    api_origin: String,
    child: Mutex<Option<CommandChild>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopBootstrap {
    api_origin: String,
    platform: String,
    app_version: String,
}

#[tauri::command]
fn desktop_bootstrap(
    app: tauri::AppHandle,
    runtime: State<'_, DesktopRuntime>,
) -> DesktopBootstrap {
    DesktopBootstrap {
        api_origin: runtime.api_origin.clone(),
        platform: env::consts::OS.to_string(),
        app_version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
async fn select_workspace_directory(
    app: tauri::AppHandle,
    initial_directory: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app
        .dialog()
        .file()
        .set_title("Choose an engineering workspace");

    if let Some(directory) = picker_start_directory(&app, initial_directory.as_deref()) {
        dialog = dialog.set_directory(directory);
    }

    let (sender, receiver) = tokio::sync::oneshot::channel();
    dialog.pick_folder(move |selection| {
        let result = selection
            .map(|path| {
                path.into_path()
                    .map_err(|error| error.to_string())
                    .and_then(canonical_directory)
            })
            .transpose();
        let _ = sender.send(result);
    });

    receiver
        .await
        .map_err(|_| "The project folder picker closed unexpectedly.".to_string())?
}

fn picker_start_directory(
    app: &tauri::AppHandle,
    initial_directory: Option<&str>,
) -> Option<PathBuf> {
    initial_directory
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .or_else(|| app.path().document_dir().ok().filter(|path| path.is_dir()))
        .or_else(|| app.path().home_dir().ok().filter(|path| path.is_dir()))
}

fn canonical_directory(path: PathBuf) -> Result<String, String> {
    let canonical = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !canonical.is_dir() {
        return Err("The selected workspace must be a directory.".to_string());
    }
    canonical
        .into_os_string()
        .into_string()
        .map_err(|_| "The selected workspace path is not valid UTF-8.".to_string())
}

fn loopback_origin(line: &str) -> Result<Option<String>, String> {
    let Some(value) = line.trim().strip_prefix(READY_PREFIX) else {
        return Ok(None);
    };
    let parsed = Url::parse(value).map_err(|error| format!("Invalid sidecar origin: {error}"))?;
    let valid = parsed.scheme() == "http"
        && parsed.host_str() == Some("127.0.0.1")
        && parsed.port().is_some()
        && parsed.path() == "/"
        && parsed.username().is_empty()
        && parsed.password().is_none()
        && parsed.query().is_none()
        && parsed.fragment().is_none();
    if !valid {
        return Err("The desktop engine reported a non-loopback origin.".to_string());
    }
    Ok(Some(parsed.origin().ascii_serialization()))
}

fn executable_path(home: &Path) -> Result<String, String> {
    let mut entries: Vec<PathBuf> = env::var_os("PATH")
        .map(|value| env::split_paths(&value).collect())
        .unwrap_or_default();
    let candidates = [
        home.join(".local/bin"),
        home.join(".npm-global/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    entries.extend(candidates.into_iter().filter(|path| path.is_dir()));
    let mut seen = HashSet::new();
    entries.retain(|path| seen.insert(path.clone()));
    env::join_paths(entries)
        .map_err(|error| error.to_string())?
        .into_string()
        .map_err(|_| "The executable search path is not valid UTF-8.".to_string())
}

fn start_sidecar(app: &tauri::AppHandle) -> Result<DesktopRuntime, String> {
    let app_data = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let resource_dir = app.path().resource_dir().map_err(|error| error.to_string())?;
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let engine_data = app_data.join("engine-data");
    let object_root = engine_data.join("object-store");
    let server_script = resource_dir.join("sidecar/server.mjs");
    let plan_schema = resource_dir.join("sidecar/plan-output.schema.json");
    let skills_root = resource_dir.join("skills");
    fs::create_dir_all(&engine_data).map_err(|error| error.to_string())?;

    for required in [&server_script, &plan_schema] {
        if !required.is_file() {
            return Err(format!("Required desktop resource is missing: {}", required.display()));
        }
    }
    if !skills_root.is_dir() {
        return Err(format!(
            "Required bundled skill catalog is missing: {}",
            skills_root.display()
        ));
    }

    let arguments = vec![
        server_script.to_string_lossy().into_owned(),
        format!("--database-path={}", engine_data.join("postgres").display()),
        format!("--object-root={}", object_root.display()),
        format!("--skills-root={}", skills_root.display()),
        format!("--workspace-root={}", home.display()),
        "--browser-origin=tauri://localhost".to_string(),
        "--browser-origin=http://tauri.localhost".to_string(),
        "--browser-origin=https://tauri.localhost".to_string(),
        "--port=0".to_string(),
    ];

    let command = app
        .shell()
        .sidecar("ege-node")
        .map_err(|error| error.to_string())?
        .args(arguments)
        .env("PATH", executable_path(&home)?)
        .env("EGE_ENABLE_WORKSPACE_WRITE", "1")
        .env("EGE_PLAN_SCHEMA_PATH", plan_schema.as_os_str());
    let (mut receiver, child) = command.spawn().map_err(|error| error.to_string())?;

    let origin = tauri::async_runtime::block_on(async {
        tokio::time::timeout(Duration::from_secs(90), async {
            let mut stdout = String::new();
            let mut stderr = String::new();
            while let Some(event) = receiver.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => {
                        stdout.push_str(&String::from_utf8_lossy(&bytes));
                        for line in stdout.lines() {
                            if let Some(origin) = loopback_origin(line)? {
                                tauri::async_runtime::spawn(async move {
                                    while let Some(event) = receiver.recv().await {
                                        if let CommandEvent::Stderr(bytes) = event {
                                            eprintln!("{}", String::from_utf8_lossy(&bytes));
                                        }
                                    }
                                });
                                return Ok(origin);
                            }
                        }
                    }
                    CommandEvent::Stderr(bytes) => {
                        stderr.push_str(&String::from_utf8_lossy(&bytes));
                    }
                    CommandEvent::Error(message) => return Err(message),
                    CommandEvent::Terminated(payload) => {
                        return Err(format!(
                            "Desktop engine exited before startup (code {:?}). {}",
                            payload.code,
                            stderr.trim()
                        ));
                    }
                    _ => {}
                }
            }
            Err("Desktop engine closed its output before startup.".to_string())
        })
        .await
        .map_err(|_| "Desktop engine startup timed out.".to_string())?
    })?;

    Ok(DesktopRuntime {
        api_origin: origin,
        child: Mutex::new(Some(child)),
    })
}

fn stop_sidecar(app: &tauri::AppHandle) {
    let Some(runtime) = app.try_state::<DesktopRuntime>() else {
        return;
    };
    if let Ok(mut guard) = runtime.child.lock() {
        if let Some(child) = guard.take() {
            let _ = child.kill();
        }
    }
}

fn main() {
    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let runtime = start_sidecar(app.handle()).map_err(std::io::Error::other)?;
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_bootstrap,
            select_workspace_directory
        ])
        .build(tauri::generate_context!())
        .expect("Aone Execution could not start");

    application.run(|app, event| {
        if matches!(event, tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }) {
            stop_sidecar(app);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{executable_path, loopback_origin};
    use std::path::Path;

    #[test]
    fn accepts_only_ephemeral_ipv4_loopback_origins() {
        assert_eq!(
            loopback_origin("EGE_SERVER_READY http://127.0.0.1:4317").unwrap(),
            Some("http://127.0.0.1:4317".to_string())
        );
        assert!(loopback_origin("EGE_SERVER_READY https://127.0.0.1:4317").is_err());
        assert!(loopback_origin("EGE_SERVER_READY http://localhost:4317").is_err());
        assert!(loopback_origin("not a ready line").unwrap().is_none());
    }

    #[test]
    fn desktop_path_contains_system_candidates_without_duplicates() {
        let path = executable_path(Path::new("/tmp/ege-home")).unwrap();
        let entries: Vec<_> = std::env::split_paths(&path).collect();
        let unique: std::collections::HashSet<_> = entries.iter().collect();
        assert_eq!(entries.len(), unique.len());
        assert!(entries.iter().any(|entry| entry == Path::new("/usr/bin")));
    }
}
