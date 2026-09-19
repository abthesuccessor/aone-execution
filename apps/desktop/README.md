# Aone Execution desktop

This package hosts the React/Vite workbench in a native Tauri 2 window. It shares the minimal dark IDE layout with the browser development build: activity bar, searchable Explorer, central graph/node/relationship/catalog editors, AI chat sidebar, status bar, and a collapsible bottom panel. Pane visibility and sizes persist locally.

The UI uses React Flow, Radix Themes, a shadcn/ui-compatible component layer under `apps/workbench/src/components/ui`, and shared dark CSS tokens. The root [workbench guide](../../README.md#implemented-desktop-flow) describes configuration, AI review/apply, typed N:M relationships, selected-node runs, breakpoints, cancellation, and keyboard shortcuts.

## Local development

From the repository root, with Node.js 24 and the Rust toolchain installed:

```sh
npm ci
npm run desktop:start
```

Tauri opens a resizable native window and starts the bundled local engine on an ephemeral `127.0.0.1` port. The engine stores its native PostgreSQL cluster in `engine-data/postgres` and object data under Tauri's per-user application-data directory in `engine-data`. On macOS this is below `~/Library/Application Support/com.aone.execution/`.

Finder does not inherit an interactive shell profile. The native shell therefore appends only existing, known executable directories such as `~/.local/bin`, `/opt/homebrew/bin`, and `/usr/local/bin` to its inherited `PATH`. It never starts a shell to import profile variables.

There is no application account, login, role, authorization service, session cookie, or renderer token. The API still binds only to loopback and validates exact browser origins to prevent unrelated web pages from sending mutations. This is a local browser boundary, not identity or production access control.

The desktop sidecar enables the existing Codex workspace adapter. A Codex provider connection, explicitly selected project folder, approved exact plan, and fresh pinned context are still required by the execution workflow. Create or rebind workspaces through Tauri's native folder picker.

The **Traces** panel records observed local planning/execution activity. **Agents**, **Skills**, and **Prompt templates** provide editable, versioned catalogs with seeded defaults. AI chat can discuss, fact-check attached excerpts, and propose node edits, new nodes, and relationships for explicit Apply. Applying a chat proposal updates the draft; it does not approve or execute code. API chat connectivity does not imply workspace execution support.

**Pause after current node** waits for a checkpoint; a node breakpoint pauses before execution. **Cancel** requests interruption of a running CLI process and leaves partial edits for review. No Langfuse, Grafana, Tempo, OTLP collector, or external observability deployment is included.

### Optional local terminal

The Terminal panel needs an installed `python3` executable in the sidecar's `PATH`. Python's standard-library PTY bridge supplies an interactive shell; Python itself is not bundled. If it is unavailable, the session displays a clear failure and the rest of the workbench remains usable.

The terminal provides streamed text, line commands, raw stdin, EOF, Ctrl+C, command history, and process-tree shutdown. It does not emulate full-screen terminal applications. Output is capped at the latest 1 MiB and remains session-local. The shell runs as the local user; its starting project directory is not a filesystem sandbox. Active or paused executions block terminal input for the same canonical project folder, and terminals must be stopped before an approved run can start or resume.

## Build the native app and DMG

Run on macOS:

```sh
npm run desktop:make:dmg
```

Tauri writes artifacts below:

```text
apps/desktop/src-tauri/target/release/bundle/macos/Aone Execution.app
apps/desktop/src-tauri/target/release/bundle/dmg/
```

The build bundles:

- the compiled React/Vite workbench;
- the Rust Tauri shell;
- the local server and planner schema;
- the fixed project snapshot of both `~/.agents/skills` and `~/.codex/skills`, with user overrides stored separately in application data;
- a platform-matched Node 24 runtime used only as the local sidecar.

The build script copies the current Node executable into Tauri's target-triple sidecar location. Build each Windows, macOS, or Linux artifact on its matching operating system and architecture. Local macOS artifacts use Tauri's ad-hoc signing identity so the complete bundle has verifiable local integrity. Trusted distribution still requires an Apple Developer ID signature and notarization; do not treat the local DMG as a distribution-ready release.

The macOS entitlement file grants the bundled Node/V8 sidecar executable-memory and JIT capabilities required by the signed runtime. It does not enable App Sandbox filesystem access or add a renderer bridge.

The repository's macOS script sets Tauri's documented `CI=true` mode so DMG creation is reliable in terminals and non-GUI build agents. This skips Finder-only cosmetic positioning inside the installer while preserving the app and Applications link.

## Runtime bridge

The webview receives only this narrow bridge:

```ts
window.egeDesktop = {
  platform: string,
  appVersion: string,
  selectWorkspaceDirectory(): Promise<string | undefined>,
};
```

At startup, the Rust shell validates the sidecar's exact ephemeral `http://127.0.0.1:<port>` origin and returns it through a Tauri command. The renderer validates that origin again before routing API and SSE requests to it. The native folder command returns only a canonical directory selected by the user. Native bridge primitives do not expose arbitrary filesystem/process access; the explicit loopback terminal API separately starts user-requested shells after checking the workspace execution state.

## Verification

```sh
npm --workspace @aone-execution/desktop test
npm --workspace @aone-execution/desktop run check
npm run build:workbench
npm run desktop:make:dmg
```

The sidecar test starts the real bundled engine and checks `/api/health`. Rust tests cover strict loopback-origin parsing and desktop executable-path construction. The workbench suite covers the React behavior and the production build validates its Tauri bootstrap path.

## Fixed skill snapshot

`npm run skills:ingest` from the repository root explicitly copies both home-folder skill catalogs into `apps/desktop/resources/skills`. The snapshot retains supporting scripts, references, assets, and licenses as regular files. Package and file hashes, source paths, and excluded environments/caches are recorded in `.catalog-manifest.json`. Existing Agents paths retain their IDs; Codex copies live under `codex/`.

`prepare:tauri`, tests, and builds only validate this fixed snapshot. They do not read or refresh the source folders. Configure assignments under **Agents → Default skills** or per-node **Configure → Skills**; edit skill instructions under **Skills** using database-backed revisions. No skill scripts execute during import.

For migration of existing SQLite data and the new controls, see [the local engine upgrade guide](../../docs/local-engine-upgrade-2026-09-13.md). Packaging currently qualifies macOS ARM64 locally; Windows is explicitly unsupported by this private socket runtime.
