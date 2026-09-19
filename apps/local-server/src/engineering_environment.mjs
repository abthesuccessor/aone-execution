import { execFile } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const TOOL_CHECKS = Object.freeze([
  { id: 'node', label: 'Node.js', command: 'node', args: ['--version'], guide: 'https://nodejs.org/en/download', files: ['package.json'] },
  { id: 'npm', label: 'npm', command: 'npm', args: ['--version'], guide: 'https://docs.npmjs.com/downloading-and-installing-node-js-and-npm', files: ['package-lock.json'] },
  { id: 'python', label: 'Python', command: 'python3', args: ['--version'], guide: 'https://www.python.org/downloads/', files: ['pyproject.toml', 'requirements.txt'] },
  { id: 'rust', label: 'Rust', command: 'rustc', args: ['--version'], guide: 'https://www.rust-lang.org/tools/install', files: ['Cargo.toml'] },
  { id: 'cargo', label: 'Cargo', command: 'cargo', args: ['--version'], guide: 'https://www.rust-lang.org/tools/install', files: ['Cargo.toml'] },
  { id: 'go', label: 'Go', command: 'go', args: ['version'], guide: 'https://go.dev/doc/install', files: ['go.mod'] },
  { id: 'java', label: 'Java', command: 'java', args: ['-version'], guide: 'https://dev.java/learn/getting-started/', files: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
  { id: 'dotnet', label: '.NET SDK', command: 'dotnet', args: ['--version'], guide: 'https://dotnet.microsoft.com/download', files: ['global.json'] },
  { id: 'cmake', label: 'CMake', command: 'cmake', args: ['--version'], guide: 'https://cmake.org/download/', files: ['CMakeLists.txt'] },
  { id: 'cc', label: 'C/C++ compiler', command: 'cc', args: ['--version'], guide: 'https://clang.llvm.org/get_started.html', files: ['CMakeLists.txt', 'Makefile'] },
  { id: 'git', label: 'Git', command: 'git', args: ['--version'], guide: 'https://git-scm.com/downloads', files: ['.git'] },
]);

export function createEngineeringEnvironment({ environment = process.env, runCommand = execFileAsync, clock = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();
  async function inspect(workspacePath, { refresh = false } = {}) {
    if (typeof workspacePath !== 'string' || !isAbsolute(workspacePath)) throw Object.assign(new Error('Select an existing absolute workspace folder before inspecting its environment.'), { code: 'WORKSPACE_REQUIRED', status: 422 });
    const canonicalPath = await realpath(workspacePath);
    if (!(await stat(canonicalPath)).isDirectory()) throw Object.assign(new Error('The bound workspace must be a directory.'), { code: 'WORKSPACE_REQUIRED', status: 422 });
    const key = JSON.stringify([canonicalPath, environment.PATH, environment.HOME]);
    const cached = cache.get(key);
    if (!refresh && cached && clock() - cached.time < 30_000 && clock() >= cached.time) return cached.value;
    if (pending.has(key)) return pending.get(key);
    const task = (async () => {
      const safeEnvironment = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'JAVA_HOME', 'DOTNET_ROOT', 'RUSTUP_HOME', 'CARGO_HOME'].filter((name) => environment[name] !== undefined).map((name) => [name, environment[name]]));
      Object.assign(safeEnvironment, { GOTOOLCHAIN: 'local', RUSTUP_AUTO_INSTALL: '0', CARGO_NET_OFFLINE: 'true', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' });
      const tools = [];
      // At most three read-only version commands run concurrently. No supplied command is executed.
      for (let offset = 0; offset < TOOL_CHECKS.length; offset += 3) {
        tools.push(...await Promise.all(TOOL_CHECKS.slice(offset, offset + 3).map(async (tool) => {
          const detectedFiles = [];
          for (const file of tool.files) { try { await access(join(canonicalPath, file)); detectedFiles.push(file); } catch { /* Not detected. */ } }
          let available = false;
          let version = null;
          let detail;
          try {
            const result = await runCommand(tool.command, [...tool.args], { cwd: canonicalPath, env: safeEnvironment, timeout: 2_000, maxBuffer: 16_384, killSignal: 'SIGKILL', encoding: 'utf8', shell: false });
            available = true;
            version = String(result.stdout || result.stderr || '').trim().split('\n').slice(0, 2).join('\n').slice(0, 500) || null;
            detail = 'The fixed version check completed. Project builds and dependency compatibility have not been tested.';
          } catch (error) {
            detail = error.code === 'ENOENT' ? `${tool.label} was not found in the server PATH.` : error.killed || error.code === 'ETIMEDOUT' ? `${tool.label} did not finish its version check within 2 seconds.` : `${tool.label} is present but its version check failed; check the selected toolchain and local setup.`;
          }
          return { id: tool.id, label: tool.label, available, version, command: [tool.command, ...tool.args], detail,
            detectedProjectFiles: detectedFiles, suggestedByProject: detectedFiles.length > 0,
            setupOptions: available ? [] : [{ label: `Review official ${tool.label} setup`, url: tool.guide }, { label: 'Use an already installed compatible toolchain or choose a different stack.' }],
          };
        })));
      }
      const missing = tools.filter((tool) => !tool.available && tool.suggestedByProject);
      const value = { workspacePath: canonicalPath, checkedAt: new Date(clock()).toISOString(), platform: process.platform, architecture: process.arch,
        readOnly: true, installsPerformed: false, tools, missingSuggestedToolIds: missing.map((tool) => tool.id),
        summary: missing.length ? `${missing.length} tool checks suggested by project files need attention. Setup is manual; no installation was attempted.` : 'Environment inspected. Version checks are not a build, test, deployment, or provider-authentication result.',
      };
      cache.set(key, { time: clock(), value });
      if (cache.size > 32) cache.delete(cache.keys().next().value);
      return value;
    })();
    pending.set(key, task);
    try { return await task; } finally { pending.delete(key); }
  }
  return { inspect };
}

export function normalizeEngineeringOptions({ engineeringProfile = 'mvp', conventions = '' } = {}) {
  if (!['poc', 'mvp', 'production'].includes(engineeringProfile)) throw Object.assign(new Error('engineeringProfile must be poc, mvp, or production.'), { code: 'VALIDATION_ERROR', status: 422 });
  if (typeof conventions !== 'string' || conventions.length > 8_000 || conventions.includes('\0')) throw Object.assign(new Error('conventions must be text of at most 8000 characters.'), { code: 'VALIDATION_ERROR', status: 422 });
  return { engineeringProfile, conventions: conventions.trim() };
}

export function engineeringPlanningGuidance(context) {
  return [
    'Engineering harness brief (planning evidence and user choices, not permission to execute):',
    JSON.stringify(context),
    'Match the proposal to the requested scope. POC: smallest testable experiment with explicit shortcuts and stop criteria. MVP: coherent usable end-to-end slice with core error paths, tests, fixtures and operating instructions. Production: add reliability, security, migrations, observability, rollout/rollback and maintenance only where applicable.',
    'Choose the number and boundaries of specialist nodes from this intention and repository. Do not use a fixed seven-node template or create every discipline for a narrow change.',
    'Before choosing a stack, consider existing code, user conventions, environment evidence and relevant alternatives. Explain consequential frontend, API, data-store, language and runtime choices; do not invent installed tools or pin framework versions without evidence.',
    'For substantial new software, cover proportionate frontend/user flows, domain/data/API contracts, high-level architecture, low-level modules and state, sample fixtures, useful code generation, tests, setup/run configuration, and documentation. Represent requested README, specification, AGENTS.md, project skills and setup guides as reviewable planned outputs with acceptance checks. Preserve existing project instructions; generated guidance must describe this project and its real commands, not generic boilerplate.',
    'Use dependency edges for required execution order and semantic edges for other relationships. Inputs should name the predecessor outputs/evidence each specialist consumes; outputs must be useful to dependent nodes. Missing tools require an actionable setup option or compatible alternative, never a fabricated passing build or unapproved automatic installation.',
  ].join('\n');
}
