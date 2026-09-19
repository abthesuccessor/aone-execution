# Security Review: execution-graph-engineering

## Scope

Partial source-backed production-readiness audit of current core desktop/local-engine workbench; 32 fully security-reviewed files plus selective inspection of larger modules. Generated gallery, bundled skill corpus, dependencies and generated binaries not exhaustively audited.

- Scan mode: repository
- Target kind: directory_snapshot
- Target ID: target_sha256_65bcca0c8304f126361b4e983cd76aa3ac1e9f2cce6eeab9d1fad8f72c7ee953
- Snapshot digest: codex-security-snapshot/v1:sha256:5c47f9fdca816b1eb8021f7be429143b5291b5a744c01721dd53232feab37cba
- Inventory strategy: directory
- Included paths: .
- Excluded paths: none
- Runtime or test status: 151 existing server tests and 122 workbench tests passed; TypeScript typecheck passed. Inert temporary Git fixture reproduced ancestor-symlink external artifact capture. No live provider or native packaged-app test performed.
- Artifacts reviewed: apps/local-server/src/catalog_routes.mjs, apps/local-server/src/chat_adapters.mjs, apps/local-server/src/chat_routes.mjs, apps/local-server/src/embedded.mjs, apps/local-server/src/engineering_environment.mjs, apps/local-server/src/engineering_proposals.mjs, apps/local-server/src/evidence.mjs, apps/local-server/src/execution_adapters.mjs, apps/local-server/src/harness_context_compaction.mjs, apps/local-server/src/harness_memory.mjs, apps/local-server/src/harness_memory_provenance.mjs, apps/local-server/src/harness_memory_routes.mjs, apps/local-server/src/harness_memory_store.mjs, apps/local-server/src/harness_runner.mjs, apps/local-server/src/index.mjs, apps/local-server/src/memory_adapters.mjs, apps/local-server/src/object_store.mjs, apps/local-server/src/provider_connections.mjs, apps/local-server/src/research_policy.mjs, apps/local-server/src/skills.mjs, apps/local-server/src/terminal_routes.mjs, apps/local-server/src/trace_data.mjs, apps/desktop/src/sidecar.mjs, apps/desktop/src-tauri/src/main.rs, apps/desktop/src-tauri/tauri.conf.json, apps/desktop/src-tauri/capabilities/default.json, apps/workbench/src/lib/desktop.ts, apps/workbench/src/lib/terminal-api.ts, apps/workbench/src/lib/chat-api.ts, apps/workbench/src/components/TerminalPanel.tsx, apps/workbench/src/main.tsx, apps/workbench/vite.config.ts

Limitations and exclusions:
- Current checkout has no commits; source evidence is specific to the unversioned snapshot.
- Coverage is partial, with explicit unreviewed and runtime gaps; no absence-of-vulnerabilities guarantee.
- Cross-account API exploit and Python malicious import not executed.
- Existing tests do not cover newly identified lifecycle, release and security failure modes.
- Excluded node_modules: Dependency implementation not exhaustively audited.
- Excluded generated/frame-infinite-gallery: Separate generated demonstration, outside core product review focus.
- Excluded apps/desktop/resources/skills: Third-party content corpus not exhaustively audited.

### Scan Summary

| Field | Value |
| --- | --- |
| Scan outcome | completed |
| Reportable findings | 3 |
| Severity mix | high: 2, medium: 1 |
| Confidence mix | high: 3 |
| Coverage | partial |
| Validation mode | independent static baseline and architecture review; parent source validation; one inert local containment reproduction |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Execution Graph Engineering currently implements a single-user local engineering workbench: React/Vite UI, Tauri desktop host, loopback Node 24 API, SQLite metadata/history, content-addressed evidence objects, hosted or local AI planning/chat adapters, optional remote memory adapters, approval-gated Codex workspace execution, and a separate interactive PTY terminal. The README explicitly distinguishes this implementation from its distributed production architecture blueprint (README.md:6, README.md:8, README.md:199, README.md:201). Startup modes materially differ: direct API startup derives paths from the process working directory and EGE_\* variables (apps/local-server/src/index.mjs:8); embedded startup derives state/local.db, object-store, workspaces and skills below caller-provided dataDir (apps/local-server/src/embedded.mjs:41); packaged desktop startup passes Tauri app_data/engine-data/local.db, app_data/engine-data/object-store, bundled resource_dir/skills, and the user's home directory as the maximum accepted workspace root, and enables Codex workspace writes (apps/desktop/src-tauri/src/main.rs:140, apps/desktop/src-tauri/src/main.rs:163, apps/desktop/src-tauri/src/main.rs:175). API admission and data ownership are single-user local controls, not authenticated user or tenant boundaries: all routes pass loopback Host/exact Origin checks, and the health/session APIs explicitly return auth:none (apps/local-server/src/server.mjs:2193, apps/local-server/src/server.mjs:2228).

### Assets

- Selected project contents and filesystem identity; plans pin the selected binding and baseline, and admitted execution rechecks folder identity and baseline before continuing (apps/local-server/src/server.mjs:1066, apps/local-server/src/server.mjs:1077, apps/local-server/src/server.mjs:1088).
- Plan versions, graph revisions, approval hashes, execution state, chat/history, accepted memory, and diagnostic traces stored in the same LocalRepository SQLite database. The constructor enables foreign keys, WAL, and a 5000 ms busy timeout; it does not establish a separate database identity boundary (apps/local-server/src/database.mjs:280). Desktop SQLite location is Tauri app_data/engine-data/local.db, direct API default is process.cwd()/.ege/local.db, and embedded default is dataDir/state/local.db (apps/desktop/src-tauri/src/main.rs:140, apps/desktop/src-tauri/src/main.rs:163, apps/local-server/src/index.mjs:8, apps/local-server/src/embedded.mjs:41).
- Uploaded source originals and derived evidence at objectRoot/objects/\<first-two-digest-characters\>/\<next-two-digest-characters\>/\<sha256\>. Reads verify SHA-256 and reject non-regular or final symlink files; writes use private temporary files, fsync, and hard-link no-overwrite publication (apps/local-server/src/object_store.mjs:61, apps/local-server/src/object_store.mjs:71, apps/local-server/src/object_store.mjs:93, apps/local-server/src/object_store.mjs:144).
- Hosted provider credentials held in the running ProviderConnectionManager private map; planning resolves a session secret first, then only the provider's canonical OPENAI_API_KEY or ANTHROPIC_API_KEY environment reference. OpenAI recipients are api.openai.com/v1/models and /v1/responses; Anthropic recipients are api.anthropic.com/v1/models and /v1/messages (apps/local-server/src/provider_connections.mjs:5, apps/local-server/src/provider_connections.mjs:235, apps/local-server/src/provider_connections.mjs:250, apps/local-server/src/planners.mjs:77, apps/local-server/src/planners.mjs:612, apps/local-server/src/planners.mjs:664).
- CLI account context and host capabilities: Codex subprocesses inherit PATH, HOME, CODEX_HOME, temporary-directory, locale, certificate and proxy settings, preserving access needed by its existing login context. The adapter does not create an OS-user, container or network-egress boundary (apps/local-server/src/execution_adapters.mjs:278, apps/local-server/README.md:361).
- Optional remote memory session credentials, explicitly retained record contents, provenance digests and remote identifiers. Credentials remain in a per-graph in-memory map; synchronized content is sent to a user-configured HTTPS or loopback HTTP endpoint (apps/local-server/src/harness_memory.mjs:16, apps/local-server/src/harness_memory.mjs:30, apps/local-server/src/harness_memory.mjs:107, apps/local-server/src/memory_adapters.mjs:8, apps/local-server/src/memory_adapters.mjs:44).
- Installed skill package integrity and database-backed overrides, with bounded package discovery and a source-relative fixed default root at apps/desktop/resources/skills; packaged desktop explicitly selects resource_dir/skills (apps/local-server/src/skills.mjs:8, apps/local-server/src/skills.mjs:16, apps/local-server/src/skills.mjs:287, apps/desktop/src-tauri/src/main.rs:140).

### Trust Boundaries

- Browser/webview -\> local HTTP API. Server binding accepts only 127.0.0.1 or localhost. Every request requires a loopback Host; supplied Origin must equal a configured exact origin or http://Host; mutation methods require an Origin. Default trusted browser origins always include configured webPort on 127.0.0.1 and localhost, including desktop startup, which adds three Tauri origins. These are browser request controls, not proof of caller identity (apps/local-server/src/server.mjs:796, apps/local-server/src/server.mjs:807, apps/local-server/src/server.mjs:2193).
- Tauri webview -\> Rust host. The application exposes bootstrap and native directory selection commands; selection canonicalizes the selected directory. The bootstrap validates the sidecar's exact ephemeral HTTP IPv4-loopback origin; webview JavaScript obtains it through invoke. The declared window capability is core:default, and CSP permits its own assets and local API connections (apps/desktop/src-tauri/src/main.rs:45, apps/desktop/src-tauri/src/main.rs:98, apps/desktop/src-tauri/src/main.rs:243, apps/desktop/src-tauri/capabilities/default.json:5, apps/desktop/src-tauri/tauri.conf.json:26, apps/workbench/src/lib/desktop.ts:10). The independent HTTP API retains its own authority; a native picker is not an HTTP caller authentication mechanism.
- User-authored intent, source evidence, skill instructions, catalog data, chat and provider responses -\> plans and proposals. Inputs are bounded at HTTP and evidence-parser layers. JSON request bodies are capped at 2 MiB; source default is 8 MiB; evidence extraction has row, text, ZIP entry, expanded-size and compression-ratio limits (apps/local-server/src/server.mjs:267, apps/local-server/src/server.mjs:283, apps/local-server/src/evidence.mjs:10, apps/local-server/src/evidence.mjs:320, apps/local-server/src/evidence.mjs:593). AI suggestions are reviewed application state; approval requires the exact plan content hash and fresh context (apps/local-server/src/server.mjs:2725).
- Approved plan -\> project-writing Codex subprocess. Execution requires APPROVED status, graph ownership, matching requested provider, exact expected plan hash, fresh pinned context, idle terminal, and a bound workspace. The adapter independently requires EGE_ENABLE_WORKSPACE_WRITE=1, rechecks the captured workspace manifest, uses Codex workspace-write/ephemeral/ignore-user-config flags, and passes an environment allowlist. Timeout and cancellation signal process groups on non-Windows hosts. Actual changed files and observed command results are reconciled with the returned receipt (apps/local-server/src/server.mjs:2750, apps/local-server/src/execution_adapters.mjs:278, apps/local-server/src/execution_adapters.mjs:368, apps/local-server/src/execution_adapters.mjs:528, apps/local-server/src/execution_adapters.mjs:584, apps/local-server/src/execution_adapters.mjs:604, apps/local-server/src/execution_adapters.mjs:656).
- Local terminal API -\> Python PTY -\> interactive host shell. This is a separate user-requested execution capability, not the approved-plan executor. It launches python3 from PATH in the canonical bound project and then /bin/zsh or /bin/sh. The environment is allowlisted, input/output/session counts are bounded, and queued/running/pause-requested/paused executions block terminal use for the same canonical workspace. The shell retains the OS user's normal filesystem/process/network authority (apps/local-server/src/terminal_routes.mjs:6, apps/local-server/src/terminal_routes.mjs:12, apps/local-server/src/terminal_routes.mjs:54, apps/local-server/src/terminal_routes.mjs:65, apps/local-server/src/terminal_routes.mjs:95, apps/local-server/src/terminal_routes.mjs:124, apps/local-server/src/terminal_routes.mjs:157).
- Local backend -\> hosted AI and Ollama. Hosted discovery and inference use fixed official HTTPS targets and reject redirects. Hosted planning can use canonical environment credentials; hosted chat requires a connected session secret. Connected Ollama discovery/chat permits only literal loopback HTTP origins without path/credentials/query/fragment. Low-level planning contains a broader loopback URL normalizer, so actual exposure must be assessed through its configuration callers rather than assuming that helper alone is reachable (apps/local-server/src/provider_connections.mjs:51, apps/local-server/src/provider_connections.mjs:115, apps/local-server/src/provider_connections.mjs:161, apps/local-server/src/planners.mjs:77, apps/local-server/src/planners.mjs:91, apps/local-server/src/planners.mjs:107, apps/local-server/src/chat_adapters.mjs:87).
- Local accepted memory -\> optional remote retention/recall. Remote access defaults off; endpoint/credentials require explicit configuration and each record requires explicit synchronization. Remote recall returns only matching ID/graph/digest hints, then ranks current accepted local records with a matching synchronized digest and endpoint. Provider-generated text is not admitted directly. Forgetting locally does not remove already retained remote content (apps/local-server/src/harness_memory.mjs:7, apps/local-server/src/harness_memory.mjs:71, apps/local-server/src/harness_memory.mjs:79, apps/local-server/src/harness_memory.mjs:107, apps/local-server/src/memory_adapters.mjs:35).
- Diagnostics -\> persistent local traces. Trace payloads pass recursive redaction and a 64 KiB payload cap before SQLite writes. This diagnostic path is distinct from raw source/artifact storage and from live terminal output (apps/local-server/src/trace_data.mjs:4, apps/local-server/src/trace_data.mjs:25, apps/local-server/src/trace_data.mjs:54, apps/local-server/src/database.mjs:1595, apps/local-server/src/database.mjs:1635).
- Optional same-origin static HTTP delivery -\> filesystem assets. The static server rejects decoded traversal segments, canonicalizes paths under the selected root, opens with O_NOFOLLOW where supported, requires regular files, and applies CSP/anti-framing/MIME/referrer headers (apps/local-server/src/server.mjs:63, apps/local-server/src/server.mjs:114, apps/local-server/src/server.mjs:145, apps/local-server/src/server.mjs:174).

### Attacker Capabilities

- An arbitrary remote website can induce browser requests to a discovered loopback service but cannot freely forge browser Origin. Successful crossing would add access to local engineering data or execution capability; loopback Host and exact Origin checks are the relevant existing controls (apps/local-server/src/server.mjs:2193). No public network listener or reverse-proxy deployment was established.
- A local process can make HTTP requests and choose headers. The application does not authenticate local OS users or processes, so origin checks do not separate such callers from the operator. Do not assume local access is a newly gained privilege or treat this deliberate single-user trust model as an undocumented production authorization system (apps/local-server/src/server.mjs:2228, apps/local-server/README.md:99).
- A source/package/provider author may supply malicious or misleading text to an operator's import, planning or chat workflow without already controlling the operator's account, approved plan or chosen project. A meaningful failure would convert that content into unauthorized project changes, misleading accepted verification, unintended remote transmission, or resource exhaustion. Plan hashes, fresh context, constrained CLI modes and receipt reconciliation must be investigated separately rather than collapsed into one prompt-injection claim (apps/local-server/src/server.mjs:2725, apps/local-server/src/server.mjs:2750, apps/local-server/src/execution_adapters.mjs:656).
- A configured remote memory service can return arbitrary response data or fail/timeout; it cannot directly supply accepted prompt text through recall because the adapter returns ID/graph/digest hints and the caller matches local accepted synchronized records (apps/local-server/src/memory_adapters.mjs:35, apps/local-server/src/harness_memory.mjs:79).
- An attacker who already controls PATH entries, the user's HOME/CODEX_HOME, trusted packaged resources, local database files, or the privileged build environment has capabilities outside the intended untrusted-input boundary. Such control must not be silently assumed when claiming a new escalation (apps/desktop/src-tauri/src/main.rs:117, apps/local-server/src/execution_adapters.mjs:278, apps/desktop/src-tauri/tauri.conf.json:44).
- Parent validation distinguishes a separate local OS account with TCP loopback access from a process already holding unrestricted owner privileges. The former crosses an OS identity boundary through the unauthenticated terminal API; this is finding BASE-001, not an Internet-exposure claim.

### Security Objectives

- Keep network exposure local and reject unrelated browser origins, including mutations without an allowed Origin (apps/local-server/src/server.mjs:796, apps/local-server/src/server.mjs:2193).
- Bind approval and execution to the exact current immutable plan, selected provider, canonical project identity, baseline, agent/skill context and approved acceptance criteria; stop stale or interrupted work closed (apps/local-server/src/server.mjs:1088, apps/local-server/src/server.mjs:2160, apps/local-server/src/server.mjs:2725, apps/local-server/src/server.mjs:2750, apps/local-server/src/server.mjs:3174).
- Keep the manual terminal and automated workspace execution mutually exclusive for a shared canonical workspace; bound live terminal sessions, retained output, input length and idle lifetime (apps/local-server/src/terminal_routes.mjs:6, apps/local-server/src/terminal_routes.mjs:65, apps/local-server/src/terminal_routes.mjs:106, apps/local-server/src/terminal_routes.mjs:157).
- Send provider credentials only to the intended recipient, retain configured hosted keys in session memory, restrict planning environment fallback to canonical provider references, and avoid redirect forwarding (apps/local-server/src/provider_connections.mjs:115, apps/local-server/src/provider_connections.mjs:250, apps/local-server/src/planners.mjs:77, apps/local-server/src/planners.mjs:91).
- Preserve evidence content integrity and no-overwrite publication while bounding ingestion and extraction. Do not present trace redaction as proof that every stored artifact or source is secret-free (apps/local-server/src/object_store.mjs:93, apps/local-server/src/object_store.mjs:144, apps/local-server/src/evidence.mjs:10, apps/local-server/src/trace_data.mjs:54).
- Admit only current locally accepted provenance-bound memory to prompts; require explicit remote retention and disclose the remote-deletion boundary (apps/local-server/src/harness_memory.mjs:71, apps/local-server/src/harness_memory.mjs:79, apps/local-server/src/harness_memory.mjs:107).
- For the user's requested stability/availability/reliability readiness review, assess process interruption, bounded work, storage growth, recovery, terminal/executor lifecycle and external-provider failure behavior. The present source supports a local harness review; production HA/DR/SLO guarantees require new design and evidence (README.md:201, apps/local-server/src/server.mjs:3158, apps/local-server/src/server.mjs:3174).

### Assumptions

- User context supplied by parent: review scope is repository '.', prioritizing core apps rather than generated gallery/bundled skill implementations/dependencies; request is readiness findings and ideas/plan, with no execution, external access, edits or full audit delegated to this reviewer.
- The SECURITY.md resolver returned no inherited policy for apps. Only bundled third-party skill-specific SECURITY.md files appeared in inventory; they do not establish core application security policy.
- Supported startup paths are not interchangeable. The embedded helper's dataDir/state/local.db and dataDir/workspaces do not describe packaged desktop's app_data/engine-data/local.db and home-root configuration (apps/local-server/src/embedded.mjs:41, apps/desktop/src-tauri/src/main.rs:140, apps/desktop/src-tauri/src/main.rs:163).
- Documentation/configuration qualification: README.md:130 describes EGE_SKILLS_ROOT as a runtime override. Direct API startup passes it through (apps/local-server/src/index.mjs:8), but packaged desktop passes an explicit bundled resource_dir/skills path (apps/desktop/src-tauri/src/main.rs:140, apps/desktop/src-tauri/src/main.rs:163; apps/desktop/src/sidecar.mjs:36), so the packaged path does not consume that environment override.
- Filesystem permissions are host-dependent. Embedded setup requests mode 0700, and desktop sidecar mkdir also requests 0700, but Rust has already created engine-data with fs::create_dir_all and LocalRepository does not explicitly chmod its database. Existing directory modes, umask and ACLs must be verified before claiming private-per-user permissions are enforced end to end (apps/local-server/src/embedded.mjs:52, apps/desktop/src-tauri/src/main.rs:149, apps/desktop/src/sidecar.mjs:36, apps/local-server/src/database.mjs:280).
- The desktop release configuration uses ad-hoc signingIdentity '-'; the packaging guide explicitly requires Developer ID signing and notarization for trusted distribution, and macOS entitlements do not establish App Sandbox isolation (apps/desktop/src-tauri/tauri.conf.json:50, apps/desktop/README.md:57, apps/desktop/README.md:59). Build success alone is not distribution readiness.
- Native chooser provenance is a UI workflow fact. Backend graph workspace paths are accepted after canonical containment checks; the HTTP API does not require a cryptographic native-picker grant (apps/desktop/src-tauri/src/main.rs:45, apps/local-server/src/server.mjs:813).
- CLI sandbox behavior, external login handling, configured provider service behavior, OS process termination semantics and actual platform filesystem protections were not executed or externally verified. Windows-specific process group behavior differs, and the PTY implementation uses Unix Python pty plus /bin shells and /bin/ps (apps/local-server/src/execution_adapters.mjs:528, apps/local-server/src/execution_adapters.mjs:611, apps/local-server/src/terminal_routes.mjs:12, apps/local-server/src/terminal_routes.mjs:54).
- The adapter does not automatically roll back partial edits on failed, timed-out, interrupted or rejected execution; source documentation states this explicitly. Restart handling fails a live node interrupted before a durable receipt and asks for inspection/replanning rather than silently accepting it (apps/local-server/README.md:361, apps/local-server/src/server.mjs:3174).
- This is an independent offline architecture mapping, not completed vulnerability-audit coverage or runtime readiness certification. Material source anchors were batch-checked: 134 nonblank locations across 26 inspected repository files.
- Parent performed existing server/workbench tests, TypeScript checking and an inert symlink-containment fixture; the independent architecture review itself remained offline/static. Parent traced local shared_child Unix SIGKILL semantics for readiness planning. These do not establish live provider or packaged-runtime behavior.

## Findings

| Finding | Severity | Confidence | Detailed write-up |
| --- | --- | --- | --- |
| [Unauthenticated loopback terminal permits cross-account code execution](#finding-1) | high | high | inline below |
| [Opening an untrusted workspace terminal imports repository Python modules](#finding-2) | high | high | inline below |
| [Workspace artifact capture follows symlinked directories outside the project](#finding-3) | medium | high | inline below |

### Confidence Scale

| Label | Meaning |
| --- | --- |
| high | Direct evidence supports the finding with no material unresolved blocker. |
| medium | Evidence supports a plausible issue, but material runtime or reachability proof remains. |
| low | Evidence is incomplete and the item is retained only for explicit follow-up. |

<a id="finding-1"></a>

### [1] Unauthenticated loopback terminal permits cross-account code execution

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Parent traced the shared route guard, graph API, terminal spawn and stdin sink; absence of any session credential is explicit. |
| Category | missing-authentication |
| CWE | CWE-306 |
| Affected lines | apps/local-server/src/server.mjs:2193-2208, apps/local-server/src/terminal_routes.mjs:130, apps/local-server/src/terminal_routes.mjs:159-166, apps/desktop/src-tauri/src/main.rs:163-181 |

#### Summary

A different local OS account with loopback access can forge the accepted Host and Origin headers, list or create a graph, and open and write to the desktop owner's terminal. The server authenticates no client.

#### Root Cause

The shared `enforceBrowserBoundary` gate checks browser headers but establishes no client identity. `route` dispatches to graph and terminal handlers after this gate. Terminal workspace validation verifies directory existence and execution state, then spawns a shell and accepts stdin; it never authenticates the caller as the desktop owner.

**Browser guard accepts caller-selected headers** — `apps/local-server/src/server.mjs:2193-2208`

The only global request gate validates Host and Origin values; a native TCP client controls both and supplies an accepted pair.

```
function enforceBrowserBoundary(request) {
    const hostname = hostNameFromHeader(request.headers.host);
    if (!hostname || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
      throw new HttpError(403, 'HOST_REJECTED', 'Only loopback Host headers are accepted.');
    }
    const origin = request.headers.origin;
    if (origin) {
      const sameOrigin = `http://${request.headers.host}`;
      const allowed = new Set([...browserOrigins, sameOrigin]);
      if (!allowed.has(origin)) {
        throw new HttpError(403, 'ORIGIN_REJECTED', 'Browser Origin is not allowed.');
      }
    }
    if (MUTATING_METHODS.has(request.method)) {
      if (!origin) throw new HttpError(403, 'ORIGIN_REQUIRED', 'Mutating browser requests require an allowed Origin.');
    }
```

**Privileged terminal creation** — `apps/local-server/src/terminal_routes.mjs:130`

A routed caller can launch a PTY process in the bound workspace under the engine's OS account.

```
const child = spawnImpl('python3', ['-u', '-c', PTY_BRIDGE], { cwd: workspacePath, env: cleanEnvironment(environment), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
```

**Terminal command input** — `apps/local-server/src/terminal_routes.mjs:166`

Input supplied by the same unauthenticated caller is written directly to that shell.

```
session.process.stdin.write(body.input);
```

#### Validation

Parent verified loopback-only binding, the explicit auth:none session route, accepted same-origin calculation, terminal workspace checks, process spawn and input sink. A different local account can construct the accepted headers without accessing an owner credential.

Validation method: parent static source trace

Counterevidence and remaining uncertainty:
- Loopback-only binding, Host and Origin validation protect ordinary remote websites. Random port is not client authentication. Opening terminal is intentional for owner.

Limitations:
- No cross-account or live desktop exploit was executed; local TCP reachability is required. Same-user clients are not claimed as an OS privilege escalation.

#### Dataflow

TCP peer forges loopback Host and matching Origin, lists graphs, opens /api/graphs/:id/terminal and submits input as server owner.

#### Reachability

Requires another local OS account/process with loopback access while the engine is running and Python available. Arbitrary remote browser origins are rejected.

- **Attacker:** Different local OS account with loopback TCP access; no same-user privilege escalation asserted.

- **Entry point:** Loopback graph and terminal HTTP routes

#### Severity

**High** — Owner-privileged command execution crosses local OS account separation; requires local host access rather than an Internet-reachable service.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Why:** Read/write and execute as the desktop owner across local account separation.

Likelihood assessment:
- **Level:** medium
- **Why:** Requires a local foothold or another local account, not Internet exposure.

#### Remediation

Authenticate every private API read, write and stream with an unpredictable per-launch capability delivered through trusted native IPC, or use a private per-user transport with peer identity checks. Retain Origin/Host checks and remove developer origins from packaged mode. Do not place the capability in URLs or logs.

Tests:
- Missing, wrong, expired and previous-launch credentials fail on graph, terminal, provider, memory, execution and SSE routes.
- A separate OS account cannot access the running owner's engine.
- Packaged mode rejects localhost developer origins.

<a id="finding-2"></a>

### [2] Opening an untrusted workspace terminal imports repository Python modules

| Field | Value |
| --- | --- |
| Severity | high |
| Confidence | high |
| Confidence rationale | Fixed import and spawn arguments establish current-directory module resolution; Python command-line documentation confirms the missing isolation behavior. |
| Category | untrusted-search-path |
| CWE | CWE-427 |
| Affected lines | apps/local-server/src/terminal_routes.mjs:130, apps/local-server/src/terminal_routes.mjs:12-17 |

#### Summary

Terminal startup invokes Python with `-c` in the selected repository. The bridge imports `pty` before starting the shell, allowing a repository `pty.py` to run immediately when the user opens Terminal.

#### Root Cause

`assertWorkspace` returns the bound repository path. Terminal creation uses it as Python cwd with `-u -c`; `PTY_BRIDGE` immediately imports `pty`. A clean environment removes PYTHONPATH but not Python's default current-directory search path, so repository source can shadow the expected standard library.

**Python launched in repository** — `apps/local-server/src/terminal_routes.mjs:130`

The workspace becomes Python's current directory and no isolated-mode argument removes it from module lookup.

```
const child = spawnImpl('python3', ['-u', '-c', PTY_BRIDGE], { cwd: workspacePath, env: cleanEnvironment(environment), stdio: ['pipe', 'pipe', 'pipe'], detached: true });
```

**Bridge imports standard library** — `apps/local-server/src/terminal_routes.mjs:12-17`

Importing pty can resolve repository-controlled pty.py before the intended shell is started.

```
const PTY_BRIDGE = String.raw`
import os, pty, select, sys, signal, errno, struct, fcntl, termios
pid, master = pty.fork()
if pid == 0:
    shell = '/bin/zsh' if os.path.exists('/bin/zsh') else '/bin/sh'
    os.execv(shell, [shell, '-f', '-i', '-o', 'NO_BANG_HIST', '-o', 'NO_ZLE'] if shell.endswith('zsh') else [shell, '-i'])
```

#### Validation

Parent verified the bridge imports, spawn arguments and environment allowlist. Python -c prepends the current directory unless isolated/safe-path options apply.

Validation method: parent source trace and official Python command-line reference

Counterevidence and remaining uncertainty:
- Fixed source/argv, stripped PYTHONPATH, zsh -f do not remove Python -c current directory lookup. Requires opening terminal in supplied repository.

Limitations:
- No malicious module was executed; requires the user to open Terminal in an attacker-controlled repository.

#### Dataflow

workspace cwd -\> python3 -u -c -\> default Python cwd module lookup -\> import pty -\> owner-privileged repository code before shell input.

#### Reachability

The attacker controls ordinary repository content; the user must select that repository and open Terminal. No approved AI execution is required.

- **Attacker:** Repository author supplies pty.py; owner binds repository and opens Terminal.

- **Entry point:** POST /api/graphs/:id/terminal

#### Severity

**High** — An untrusted repository author can cause owner-privileged execution on terminal open, before the user submits a shell command.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** high
- **Why:** Arbitrary code execution under the desktop account.

Likelihood assessment:
- **Level:** medium
- **Why:** Depends on opening an attacker-provided project terminal.

#### Remediation

Run a trusted Python interpreter in isolated mode (`-I`) for the PTY bridge, or import only from a trusted startup directory before changing the child shell into the workspace. Keep repository content and user site packages out of bootstrap imports.

Tests:
- Opening Terminal in a fixture with inert pty.py and select.py does not import either file or produce a marker.
- Normal shell startup, cwd, input, interrupt and shutdown behavior still pass.

<a id="finding-3"></a>

### [3] Workspace artifact capture follows symlinked directories outside the project

| Field | Value |
| --- | --- |
| Severity | medium |
| Confidence | high |
| Confidence rationale | Parent reproduced both manifest inclusion and artifact content capture with a temporary Git fixture and an inert external canary. |
| Category | improper-symlink-resolution |
| CWE | CWE-59 |
| Affected lines | apps/local-server/src/execution_adapters.mjs:258-267, apps/local-server/src/execution_adapters.mjs:142-167, apps/local-server/src/server.mjs:1693-1710 |

#### Summary

The workspace manifest and artifact reader validate lexical paths and only lstat the final component. An indexed path under a directory replaced with a symlink can read an external file and include its contents as a project artifact.

#### Root Cause

`git ls-files --cached --others` supplies indexed descendant names even after an ancestor directory changes to a symlink. Both manifest capture and artifact reading use lexical containment and final-component lstat. Ancestor symlinks therefore redirect the engine's file read outside the selected project. Accepted node outputs then persist the returned contents.

**Indexed descendant also enters manifest** — `apps/local-server/src/execution_adapters.mjs:165-169`

Git's cached file path can survive replacement of its parent with a symlink; final-component lstat makes the external descendant appear regular in the manifest.

```
    let bytes;
    if (metadata.isSymbolicLink()) bytes = Buffer.from(`symlink:${await readlink(absolutePath)}`);
    else if (metadata.isFile()) bytes = await readFile(absolutePath);
    else continue;
    if (bytes.length > MAX_WORKSPACE_FILE_BYTES) {
```

**Artifact path remains lexical** — `apps/local-server/src/execution_adapters.mjs:250-254`

resolve and relative reject textual traversal but do not resolve a symlink in an ancestor directory.

```
    const absolutePath = resolve(canonicalRoot, path);
    const relation = relative(canonicalRoot, absolutePath);
    if (relation.startsWith('..') || isAbsolute(relation)) {
      skipped.push({ path, reason: 'OUTSIDE_WORKSPACE' });
      continue;
```

**Final-component check follows ancestor symlinks** — `apps/local-server/src/execution_adapters.mjs:256-267`

lstat rejects a leaf symlink but follows an ancestor link. The resulting external regular file passes the checks and readFile reads its bytes.

```
    let metadata;
    try {
      metadata = await lstat(absolutePath);
    } catch (error) {
      skipped.push({ path, reason: error.code === 'ENOENT' ? 'DELETED' : 'UNREADABLE' });
      continue;
    }
    if (!metadata.isFile() || metadata.size > MAX_ARTIFACT_FILE_BYTES || totalBytes + metadata.size > MAX_ARTIFACT_TOTAL_BYTES) {
      skipped.push({ path, reason: !metadata.isFile() ? 'NOT_REGULAR_FILE' : 'SIZE_LIMIT' });
      continue;
    }
    const bytes = await readFile(absolutePath);
```

**Accepted artifact reaches durable node output** — `apps/local-server/src/server.mjs:1705-1710`

Once an execution satisfies receipt validation, captured file contents are passed to completeNode for durable persistence; dependency context can later include these artifacts.

```
            ...result.workspaceArtifacts.artifacts,
          ],
          receiptArtifact: { name: receiptName, mediaType: 'application/json', content: JSON.stringify(receiptDocument, null, 2) },
          receiptDocument,
          workspaceBaseline: advancedWorkspaceBaseline,
        });
```

#### Validation

In a temporary Git repository, tracked capture/canary.txt was replaced by an ancestor symlink to a sibling fixture directory. The manifest still included capture/canary.txt, changed paths included it, and artifact reading returned the external canary with no skipped record. Fixture cleanup completed.

Validation method: parent static trace plus inert local fixture reproduction

Assertions:
- manifestContainsExternalDescendant=true
- externalCanaryCaptured=true
- skipped=\[\]

Counterevidence and remaining uncertainty:
- Leaf symlinks are recorded as links in manifests and excluded as artifact files.
- An accepted receipt is required before server persistence; creating the symlink alone does not automatically exfiltrate data.

Limitations:
- No user files or secrets were accessed.
- No live Codex run or provider exfiltration was performed.
- Any claim of escaping the Codex OS sandbox depends on its effective filesystem policy and is not asserted.

#### Dataflow

Git indexed descendant -\> lexical containment -\> ancestor symlink resolution -\> engine file read -\> captured artifact -\> accepted completeNode output

#### Reachability

Requires attacker influence over workspace contents during an authorized execution and an engine-readable external target. Runtime reproduction proves the reader boundary; accepted receipt and later node consumption are additional prerequisites.

- **Attacker:** Untrusted repository content or generated workspace changes

- **Entry point:** Workspace manifest and changed-artifact capture

#### Severity

**Medium** — A workspace-controlled ancestor link crosses the intended project artifact boundary and can copy engine-readable external data into artifacts. Persistence and onward provider context require an accepted execution.

Additional runtime or deployment evidence could raise or lower this severity.

Impact assessment:
- **Level:** medium
- **Why:** External data can be misattributed to the project and enter stored/shared execution context.

Likelihood assessment:
- **Level:** medium
- **Why:** Requires a suitable filesystem layout and an accepted execution for onward persistence.

#### Remediation

Enforce canonical containment for every ancestor and the opened file in both manifest and artifact reads; use no-follow or descriptor-relative traversal with race-resistant checks. Reject paths whose parent chain escapes the pinned workspace, including tracked paths. Perform bounded reads on verified handles.

Tests:
- A tracked descendant under an ancestor symlink to an inert external file is rejected or skipped in both manifest and artifact capture.
- Race changing an ancestor between validation and open cannot include external bytes.
- Direct symlink behavior, ordinary contained files and receipts continue to work.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| Local engine authentication and terminal authority | not recorded | Reported | Source validation confirms missing client identity; loopback binding and browser Origin/Host protections reduce remote exposure. |
| PTY interpreter startup | not recorded | Reported | Python starts in repository cwd without isolated mode; fixed command text does not enforce module provenance. |
| Workspace manifest and artifact containment | not recorded | Reported | Inert local reproduction confirmed ancestor-symlink external capture. No deployed Codex sandbox escape or real data exfiltration is asserted. |
| Provider endpoint and credential boundaries | not recorded | No issue found | Fixed hosted provider destinations and canonical secret names, redirect rejection, and loopback Ollama checks at provider_connections.mjs:51-185, chat_adapters.mjs:89-107, planners.mjs:77-119. Memory endpoints are explicitly configured and use separate credentials; no independent arbitrary credential forwarding finding established. |
| Exact approval, proposal scope and reviewed memory | not recorded | No issue found | Exact hash and context admission (server.mjs:2725-2788), selected-node proposal checks (chat_routes.mjs:47-98,178-212), and current local memory validation (harness_memory.mjs:76-108; memory_adapters.mjs:42-45). API caller identity remains the separate reported failure. |
| Targeted model, terminal and artifact rendering | not recorded | No issue found | Inspected TerminalPanel.tsx:6-7,72 uses text rendering; no innerHTML/eval sink found in targeted searches; packaged/static script CSPs limit execution. This is not exhaustive frontend coverage. |
| Evidence parser limits and process isolation | not recorded | Needs follow-up | evidence.mjs:10-29,292-312,320-386,416-424 bounds input, YAML aliases, declared ZIP sizes and extraction. XLSX dependency decompression implementation was not audited; malformed declared sizes bypass remains unproven. |
| Process lifetime and output bounds | not recorded | Needs follow-up | Reliability plan covers planner TERM-only deadline (planners.mjs:401-434), absent planner/executor stdin error listeners, and unbounded provider JSON response parsing (planners.mjs:121-145). No exploit or production crash claimed. |
| Startup modes, private data and package authority | not recorded | Needs follow-up | Packaged uses app_data/engine-data/local.db, app_data/engine-data/object-store and HOME workspace root; embedded uses dataDir/state/local.db and workspaces. Rust precreates engine-data without explicit mode; actual ACL/umask privacy needs runtime validation. Packaged skills path is explicit and does not consume EGE_SKILLS_ROOT, unlike direct startup (main.rs:140-181; embedded.mjs:41-60; sidecar.mjs:36-58). Ad-hoc signing and absent native-picker grant are documented release/authority boundaries, not independent proven attacks. |

## Open Questions And Follow Up

- Core review is partial: large server.mjs, planners.mjs, database.mjs and most frontend components were selectively inspected; bundled code, binaries and dependencies not exhaustively audited.
- No live provider calls, full packaged-app shutdown test, cross-account exploit, dependency advisory audit, clean-Mac install, load/soak or restore drill was performed.
- Effective Codex filesystem/network sandbox behavior and read-only confidentiality need separate runtime verification; declared tool classes are instructions rather than separately enforced permissions.
- Third-party XLSX parsing/decompression limits need independent implementation and resource-isolation validation.
- Partial production-readiness review focused on core trust boundaries; exhaustive repository audit remains out of scope for this report.
  - Follow-up prompt: Review deferred unit remaining-source and close its stated proof gap. Paths: apps/local-server/src/server.mjs, apps/local-server/src/planners.mjs, apps/local-server/src/database.mjs, apps/local-server/src/intent_compiler.mjs, apps/workbench/src.
- Dependency advisory/decompression audits and packaged native runtime tests were not performed.
  - Follow-up prompt: Review deferred unit dependency-and-package-runtime and close its stated proof gap. Paths: package-lock.json, apps/desktop/src-tauri/Cargo.lock, apps/desktop/resources, generated.
