# Execution Graph Engineering: production-readiness review and improvement plan

This is the assessment of the source before the subsequent PostgreSQL and engineering-controls upgrade. Its code line references describe that earlier snapshot. See [the upgrade guide](local-engine-upgrade-2026-09-13.md) for implemented changes and current validation; this historical report is not a fresh security scan of the upgraded code.

Review date: 2026-09-13. Target: a local checkout of this repository.

**Decision: retain the current desktop architecture, close the security and execution-lifecycle gaps, then qualify a trusted macOS release. The inspected implementation is not ready for unattended operation, broad trusted distribution, or a shared hosted deployment.** This is a readiness assessment and proposed implementation plan; application fixes have not been applied.

The current checkout has no Git commits and its project files are untracked. This review describes the files present on the review date, not a versioned release. The product now includes the IDE layout, scoped discussion/refinement, versioned catalogs, engineering harness, memory and terminal described in its current README. Earlier workbench-history notes were used only to orient the review and avoid confusing the separate generated gallery with the core product.

Contents: [Scope and evidence](#scope-and-evidence), [Security findings](#security-findings), [Reliability and release findings](#reliability-and-release-findings), [Implementation sequence](#implementation-sequence), [Release gates](#release-gates), [Product ideas](#product-ideas), [Hosted-service roadmap](#hosted-service-roadmap).

## Scope and evidence

The implementation is a React/Vite workbench, Tauri host, Node 24 loopback engine, SQLite metadata and history, content-addressed evidence store, AI provider adapters, Codex executor and Python PTY terminal. The current [README boundary](../README.md:197) explicitly lists identity, tenant isolation, distributed workers, HA, disaster recovery and production observability as unimplemented. Architecture documents are design intent, not deployed controls.

The primary release target assumed here is a single-user macOS desktop application. No current deployment, external production infrastructure, provider account, or business SLO was supplied. A hosted multi-user version is a separate engineering track below.

| Evidence layer | What this review established | Limit |
|---|---|---|
| Source | Independent security baseline, independent architecture mapping, reliability/release inspection and parent validation of actionable findings | Selective review of large server/database/planner modules and frontend; not exhaustive repository coverage |
| Server tests | `npm --workspace @execution-graph/local-server test`: 151 passed, 0 failed | Existing tests; not live provider or native desktop certification |
| Workbench tests | `npm --workspace @graph-engineering/workbench test`: 26 files, 122 tests passed | Component/unit tests, not final native UI or clean-machine QA |
| TypeScript | Workbench `typecheck` passed | Does not prove bundling, signing, runtime or deployment |
| Containment reproduction | Temporary Git fixture confirmed external inert text captured through an ancestor symlink | No real user data, secret, provider call or deployed sandbox escape involved |
| Release/operations | Source-backed gaps in process lifetime, packaging, backups and observability | No full `npm run check`, Rust build/test, new DMG build, signing/notarization, dependency advisory audit, load test or restore drill performed |

The generated Frame gallery, dependency trees, bundled third-party skill corpus, generated bundles and binaries were not exhaustively audited. This is a partial source audit with three validated security findings, not a certificate that all other code is secure. The security plugin reports Daybreak `not_granted`, programs `none`; it nevertheless completed and indexed the three findings. Independent workers stayed offline; the parent consulted official Python, SQLite and Tauri documentation for the related implementation guidance.

Useful implemented safeguards should be preserved: exact plan-hash approval, fresh source/provider/agent/skill pins, transactional node and receipt persistence, no silent replay of an interrupted live node, atomic digest-verified evidence publication, bounded chat and evidence context, trace redaction, and locally reviewed provenance-bound memory. See [approval/admission](../apps/local-server/src/server.mjs:2725), [restart recovery](../apps/local-server/src/server.mjs:3174), [object storage](../apps/local-server/src/object_store.mjs:93), and [memory filtering](../apps/local-server/src/harness_memory.mjs:79).

## Security findings

Security severity measures impact and reachability. Roadmap priority additionally considers release risk: P1 blocks the intended trusted release; P2 must be resolved or explicitly bounded before general availability. No critical or Internet-reachable RCE finding was established.

### S1 — High: privileged local API has no client authentication

The shared request guard checks loopback Host and allowed Origin headers, but `/api/session` explicitly returns `auth: none` and no token. A different local OS account able to connect to loopback can set these headers, list or create graphs, open a terminal and submit shell input as the engine owner. Desktop startup permits workspace bindings under the owner's home directory. Manual shell commands are a separate intentional capability from plan execution, and they require no approved plan.

Evidence: [request boundary](../apps/local-server/src/server.mjs:2193), [terminal spawn/input](../apps/local-server/src/terminal_routes.mjs:130), [desktop root](../apps/desktop/src-tauri/src/main.rs:163).

Loopback binding and Origin validation protect against ordinary unrelated remote websites and reduce exposure. They do not identify a native TCP client. A process already possessing unrestricted access as the same OS user is not a new account-privilege escalation. This finding is source-validated; no cross-account exploit was run. Packaged startup also inherits trusted development origins on port 5173, which unnecessarily broadens the browser boundary.

**Required change:** authenticate every private read, mutation and event stream using a high-entropy per-launch capability delivered through trusted native IPC, or move privileged operations to an authenticated per-user native transport. Keep the capability out of URLs, logs and unauthenticated bootstrap endpoints. Preserve Host/Origin checks and make development origins explicit development-only configuration. Use authenticated fetch streaming or a native bridge if the existing EventSource client cannot send the credential.

**Acceptance:** absent/wrong/expired/previous-launch credentials fail for graph, terminal, approval, provider, memory, artifact and SSE APIs; the legitimate native client works; another OS account cannot obtain the capability; packaged mode rejects developer origins. **Priority P1; owner: desktop/backend.**

### S2 — High: terminal bootstrap imports code from the selected repository

The PTY bridge starts `python3 -u -c` with the workspace as its current directory, then imports `pty` and other modules before launching the shell. An untrusted repository can supply `pty.py`; opening Terminal can import that file before the user types a command. The fixed Python command and environment allowlist prevent command interpolation and strip PYTHONPATH, but do not remove Python's normal current-directory module search path.

Evidence: [bridge imports](../apps/local-server/src/terminal_routes.mjs:12), [spawn arguments](../apps/local-server/src/terminal_routes.mjs:130). Official [Python command-line documentation](https://docs.python.org/3.10/using/cmdline.html) explains the `-c` search path and isolated `-I` behavior.

**Required change:** use a trusted Python interpreter with isolated startup, such as `-I -u -c`, or import from a trusted directory before changing the child shell into the project. Add an explicit workspace-trust policy for automatic project tool discovery; a warning alone does not repair unsafe imports.

**Acceptance:** opening a fixture repository containing inert `pty.py` and `select.py` creates no import marker, while shell cwd, input, interrupt and cleanup still work. **Priority P1; owner: terminal/runtime.** The current finding is source-validated, with no malicious module executed.

### S3 — Medium: ancestor symlinks escape project artifact containment

Both workspace manifests and changed-artifact capture use lexical path containment and `lstat` on the final component. A tracked path can remain in Git's index after its parent directory is replaced with a symlink. The final file then appears regular even though its actual location is outside the project. Accepted artifacts can be stored and included in a later node's dependency context.

Evidence: [manifest read](../apps/local-server/src/execution_adapters.mjs:142), [artifact read](../apps/local-server/src/execution_adapters.mjs:250), [artifact persistence](../apps/local-server/src/server.mjs:1696).

A safe local reproduction tracked `capture/canary.txt`, replaced `capture` with a symlink to a sibling fixture directory, and observed both manifest inclusion and capture of the external inert text, with no skipped-path record. The temporary tree was removed. Persistence requires an accepted receipt; onward provider disclosure and an OS sandbox escape were not reproduced or assumed.

**Required change:** enforce containment across every ancestor and the opened file, using race-resistant descriptor/no-follow traversal where supported. Apply the same helper to manifest and artifact reads. Checking only `realpath` before a later path-based read leaves a replacement race.

**Acceptance:** indexed descendants beneath escaping symlinks and concurrent ancestor replacements cannot contribute external bytes; legitimate contained files and supported leaf-link behavior still work. **Priority P1 for release integrity; owner: filesystem/executor.**

## Reliability and release findings

| ID / priority | Concrete problem and evidence | Required behavior and acceptance test |
|---|---|---|
| R1 / P1 | Normal desktop quit calls [child.kill()](../apps/desktop/src-tauri/src/main.rs:232). The installed Tauri shell/shared_child implementation uses Unix SIGKILL. This bypasses [sidecar SIGTERM cleanup](../apps/desktop/src/sidecar.mjs:59); [detached Codex](../apps/local-server/src/execution_adapters.mjs:611) descendants may keep writing. Source-backed; actual native quit survival not run. | Intercept quit, stop admission, request authenticated shutdown, abort/reap child trees and acknowledge completion before exiting; bounded forced escalation only afterward. A packaged test with a controlled descendant writer must stop all writes after quit. Cover startup failure and timeout cleanup too. |
| R2 / P1 | [Admission](../apps/local-server/src/database.mjs:1110) creates a new execution for each valid request; [scheduler deduplication](../apps/local-server/src/server.mjs:1279) only keys by execution ID. Multiple requests or graphs can write one checkout. [Cancellation](../apps/local-server/src/database.mjs:1361) reports a terminal state before the process has exited. | Transactionally own the canonical checkout, not only a graph ID. Keep ownership through CANCEL_REQUESTED/STOPPING until reaping. Add idempotency keys and a data-directory single-instance guard. Race two graph admissions and retries; exactly one writer starts. Cancellation must block new runs/terminal until cleanup completes. |
| R3 / P2 | [Planner timeout](../apps/local-server/src/planners.mjs:416) sends SIGTERM once and waits for close, without shutdown abort linkage. A TERM-ignoring child can exceed the nominal deadline indefinitely. | Shared managed-process lifecycle with request/shutdown cancellation, group signalling, escalation and bounded settlement. A fake TERM-ignoring planner plus descendant must terminate within deadline plus grace. |
| R4 / P2 | Planner and executor call `child.stdin.end` without a stdin error listener: [planner](../apps/local-server/src/planners.mjs:431), [executor](../apps/local-server/src/execution_adapters.mjs:645). Early child exit can produce timing-dependent unhandled EPIPE. | Handle stdin errors before writing, settle the operation with useful diagnostics and clean up the process tree. Isolated-process tests with a large prompt and early stdin closure must keep the engine healthy; include deterministic injected stream errors. |
| R5 / P2 | Execution/trace [broadcasts](../apps/local-server/src/server.mjs:1169) ignore write backpressure; [replay](../apps/local-server/src/server.mjs:2575) synchronously queues all history. Slow clients and large histories can consume memory and delay cancellation. | Bound clients and pending bytes, yield between replay batches, handle drain or disconnect slow clients, and preserve durable cursor replay. Test a non-reading socket with a large history while health/cancel requests remain responsive. Reuse the terminal stream's existing bounded-client pattern. |
| R6 / P2 | [Workspace scanning](../apps/local-server/src/execution_adapters.mjs:160) reads a whole regular file before enforcing its 8 MiB/file and 256 MiB aggregate budgets. [Planning HTTP JSON](../apps/local-server/src/planners.mjs:121) also lacks a response-byte cap. | Check metadata before reading, then enforce a real read/hash byte budget including file-growth races. Bound provider and planner-output JSON before parsing. Test oversized sparse files, shrinking remaining budget, growth during reads and oversized provider bodies; assert bytes read and bounded memory, not only eventual rejection. |
| R7 / P1 release gate | SQLite/WAL and evidence objects are [separate durable resources](../apps/local-server/src/server.mjs:832). No coordinated backup/restore workflow or versioned migration ledger was found; [migrations run at startup](../apps/local-server/src/database.mjs:280). | Consistent database snapshot plus referenced object manifest, app/schema version and hashes; verified pre-upgrade backup, versioned transactional migrations, and restore into a fresh directory. Verify integrity, foreign keys, every object digest, graphs and receipts. State that external project folders require a separate backup unless explicitly included. To cover device/storage loss, verify a copy in a user-selected independent storage location and show the last successful backup timestamp. |
| R8 / P2 | After readiness the [native receiver](../apps/desktop/src-tauri/src/main.rs:195) only prints stderr; termination is not surfaced as native health. [/api/health](../apps/local-server/src/server.mjs:2228) reports static ok, and telemetry degradation is stderr-only. | Emit native lifecycle state, expose separate liveness/readiness/storage/telemetry health, and offer controlled restart with interrupted-run inspection. Kill the sidecar and inject trace-store failures; UI must identify degradation without claiming work or telemetry completed. |
| R9 / P1 distribution gate | [Packaging](../apps/desktop/scripts/build-sidecar.mjs:78) copies the builder's Node executable under a configurable target triple; the [smoke test](../apps/desktop/test/sidecar.test.mjs:14) launches the host Node. [macOS signing](../apps/desktop/src-tauri/tauri.conf.json:50) is ad hoc. No commit identifies this checkout. | Record a source revision, exact Node/Rust/dependency/skill inputs and payload hashes; reject runtime-target mismatch; test the actual packaged executable. Qualify Developer ID signing, notarization and clean-Mac installation. Add repeatable CI gates, dependency/secret scanning and SBOM generation as implementation work. Verify redistribution notices and provenance for the shipped Node runtime, Rust and frontend dependencies, bundled skills and packaged assets; this review does not establish a rights violation. |

For R1, the reviewed dependency chain was `tauri-plugin-shell::CommandChild::kill` to `shared_child 1.1.1::kill`; its local implementation explicitly documents SIGKILL. This is a source-level process-lifetime finding, not an observation of an orphaned live executor in this session.

For R7, use a supported consistent snapshot mechanism such as the [SQLite Online Backup API](https://www.sqlite.org/backup.html), with the referenced content-addressed object set. Merely copying `local.db` during activity can omit WAL state. Durability mode should be explicitly measured and documented; no evidence here establishes that this repository deliberately uses unsafe `synchronous=OFF` or `NORMAL` settings.

For R9, trusted direct macOS distribution needs signing and notarization as described in [Tauri's distribution guidance](https://v2.tauri.app/distribute/). A signed updater is a later product decision; adding an unauthenticated update endpoint is not part of this plan.

Additional P2 hardening belongs in these work packages: parser worker isolation and actual decompressed-byte limits; total storage quotas/retention and safe orphan-object cleanup; explicit application-data permissions/ACL validation; per-provider request concurrency and bounded retry/backoff for retry-safe calls; visible context transmission choices and optional OS-keychain persistence. A configured HTTPS memory endpoint is not by itself an SSRF finding. Prompt-injected text, a valid citation and a model-reported PASS must remain distinct from authorized execution and independently observed evidence.

## Implementation sequence

Estimates are planning ranges, not delivery commitments. Assume one experienced developer familiar with this code and part-time QA/security review. Several fixes share one process manager and one filesystem helper, so effort is not the sum of every row. Allow roughly **25–40 engineer-days for a dependable desktop release candidate**, then pilot observation and any external signing-account lead time. Hosted production is not included.

| Phase | Deliverable | Dependencies / estimate | Exit condition |
|---|---|---|---|
| 0 | Establish a local versioned baseline, inventory supported macOS/CPU/runtime targets and existing gate requirements; preserve all current work | 1–2 days | Source revision and reproducible test commands recorded; no publication implied |
| 1 | Close S1–S3: authenticated native/engine boundary, isolated terminal bootstrap and contained bounded file reader | 4–6 days; first implementation priority | All negative security regressions pass; valid user flows preserved |
| 2 | Unified child-process manager and canonical workspace ownership; idempotent run requests; precise stop states; native quit cleanup | 6–9 days; auth needed for shutdown protocol | Concurrent-admission, cancellation, EPIPE, timeout, app-quit and restart tests pass |
| 3 | Versioned migrations, consistent archive/restore, pre-upgrade backup and retention controls | 5–8 days; process drain/ownership in place | Fresh-directory restore and interrupted-migration drill pass; recovery scope documented |
| 4 | Bounded streams/parsers/provider responses, runtime health, diagnostics, packaged-runtime verification and release gates | 6–10 days; can partly overlap phase 3 | Stress checks and actual packaged binary tests pass; release identity and signing evidence recorded |
| 5 | Focused clean-Mac and failure-injection qualification, then a small opt-in pilot | 3–5 engineering days plus observation | No open release-blocking security/lifecycle/data-loss issue; evidence reviewed before general distribution |

Make these dependency rules explicit: authentication precedes privileged shutdown/recovery control; workspace ownership precedes resumable/parallel execution; process termination confirmation precedes releasing write ownership; restore qualification precedes upgrade automation; build identity precedes trustworthy release comparisons.

Implementation should preserve the existing UI shell and immutable execution model. No cloud migration, deployment, package installation, source push or application behavior change was performed by this review.

## Release gates

These are **proposed test targets**, to calibrate on a declared reference Mac and representative projects. They are not measured service guarantees.

| Gate | Acceptance target / evidence |
|---|---|
| Client identity | 100% of private API/stream routes reject missing or stale capability credentials; packaged development origins rejected |
| Write ownership | At most one live automated writer per canonical checkout across graph IDs, retries, processes and cancellation transitions |
| Stop correctness | UI shows cancellation requested immediately; cancellation confirmed only after reaping. Controlled test child groups terminate within a proposed 10-second grace, or UI visibly reports an unresolved stop failure and retains the lock |
| Crash recovery | At every checkpoint boundary, terminate/restart the engine; no false completion or automatic duplicate live side effect; partial changes remain inspectable |
| Data recovery | Every restored graph, approval, receipt, harness checkpoint and referenced object validates; daily archive RPO and a 30-minute restore RTO are initial planning targets, conditional on dataset size and a verified backup copy in user-selected independent storage; a local sibling archive covers rollback but not device loss |
| Responsiveness | Under declared large-history/slow-client tests, proposed p95 local health/cancel acknowledgement below 500 ms and bounded queued bytes; select final limits from measurements |
| Resource bounds | Large/growing files, oversized provider bodies, many streams and invalid archives fail within actual byte/time/process limits; no uncaught EPIPE or unbounded replay |
| Availability | Sidecar exit is detected and explained; restart restores service without silently rerunning a live node. A local desktop app makes no 24/7 uptime or HA claim |
| Supply chain | Exact source/runtime/dependency/skill identity, dependency and secret-scan results, SBOM, required redistribution notices and asset/runtime provenance, verified release signature and notarization, installed-artifact smoke evidence |
| Device compatibility | Clean supported Macs, declared CPU architectures, offline startup, missing Python/Codex, invalid provider credentials, sleep/wake and denied-folder behavior tested |

Run the repository's full required check pipeline in the release environment after implementation. The current 273 passing tests and TypeScript pass are a baseline, not substitutes for these new failure-mode tests. Do not automatically replay provider/tool calls with possible side effects after a timeout; use idempotency where supported and explicit reconciliation where outcome is unknown.

## Product ideas

Prioritize features that make execution safer, easier to understand and easier to recover. Existing plans, receipts, context pins, lineage and trace data provide a strong starting point.

| Idea | User value | Small useful first version / acceptance |
|---|---|---|
| Recovery center | Explains exactly what happened after failure and what can safely happen next | Show last accepted checkpoint, interrupted node, current file differences and missing evidence; offer a reviewed replacement plan. Never silently revert user edits or repeat an unknown side effect |
| Readiness view per node and release | Makes “Production” an evidence requirement instead of only a prompt profile | Track required checks, observed results, source/artifact hashes, environment and evidence age. Show missing/stale/failed separately; AI cannot self-certify a gate |
| Workspace activity and ownership | Prevents confusing competing runs and makes cancellation honest | One view of active writer, terminals, stop state and pending requests for the canonical project; explain why Run or Terminal is temporarily blocked |
| Preview changes in an isolated checkout | Lets the user inspect changes before they touch the working project | Opt-in Git worktree execution with explicit starting-state choice, patch preview and reviewed apply. Preserve uncommitted files and exact base hashes; offer a separate strategy for non-Git folders |
| Dependency impact and freshness | Shows what needs rerunning after a source, prompt, skill or decision changes | Highlight affected nodes and explain the invalidation path. Preserve semantic relations separately from execution prerequisites; only reuse receipts with matching pins |
| Evidence-preserving receipt repair | Avoids expensive implementation reruns when only the final receipt format is wrong | Allow a receipt-only correction tied to unchanged before/after hashes and immutable observed commands. Never turn a failed command into PASS or let the model rewrite execution evidence |
| Run comparison and cost preview | Helps choose a better plan using observed outcomes | Compare predecessor/successor scope, reused nodes, changed files, checks, duration and reported usage. Label estimated tokens/cost separately from provider billing and never use savings to waive required gates |
| Portable project record and support bundle | Makes moving computers and diagnosing failures practical | Restore-preview archive of metadata/objects with digest verification; separate explicitly redacted support export. Exclude credentials; clearly state whether external source checkout files are included |

Suggested product order after phase 2: recovery center and workspace activity first, then readiness view and portable record, then isolated-checkout preview and comparison features. This builds on the current workbench instead of expanding the number of agents or panels without an observable benefit.

## Hosted-service roadmap

A shared always-on service requires a new production deployment boundary. Keep the desktop qualification work reusable, but do not expose the current no-login loopback API through a proxy and call it production.

| Capability | Required design before shared use | Evidence required |
|---|---|---|
| Identity and authorization | OIDC identity, tenant-scoped records and objects, role/capability checks, attributable immutable approvals and audit trail | Cross-tenant and unauthorized-action tests, account lifecycle and revocation tests |
| Durable scheduling | Durable queue/outbox, leased/fenced workers, idempotent admission and reconciliation of uncertain external effects | Duplicate-delivery, worker-loss and split-brain tests; no assumption of exactly-once external side effects |
| Executor isolation | Per-job sandbox/VM/container with bounded CPU/RAM/disk/time, scoped credentials and controlled network access | Escape-boundary validation, denied egress/secret tests and cleanup evidence |
| Data and HA | Production database topology, durable object storage, tested PITR/backups, schema ownership and failover procedures | Restore and failover drills measured against an agreed RPO/RTO; selected region/account capacity evidence |
| Observability and operations | Structured bounded logs, metrics and tracing with redaction, provider availability/spend, queue age, error budget and incident runbooks | Alerts tested with injected failures; SLO windows and maintenance rules agreed |
| Delivery | Protected review/release process, artifact signatures/digests, migration compatibility, staged rollout and rollback/forward-repair rules | Deployment provenance and verification of the exact running artifact, not only a successful build |

Choose hosted availability and scale targets only after defining expected users, concurrent executions, data classification, deployment region, operator coverage and cost envelope. A generic 99.9% target would currently be an unmeasured proposal. Keep PostgreSQL/queue/cloud-object architecture documents as the starting design inputs; verify each implemented ownership boundary when that track begins.


The completed [security report](../docs/reviews/2026-09-13-security/report.md) and byte-identical copies of its [manifest](../docs/reviews/2026-09-13-security/scan-manifest.json), [findings](../docs/reviews/2026-09-13-security/findings.json) and [coverage](../docs/reviews/2026-09-13-security/coverage.json) are saved beside this plan. The plugin reports 8,592,516 total tokens across four threads, including 8,060,544 cached input tokens and 60,559 output tokens (`codex_rollout` accounting). These are plugin-reported processing counters, not a billing estimate.
