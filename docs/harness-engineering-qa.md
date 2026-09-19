# Engineering harness verification

Date: 2026-09-12. This record covers the local workbench implementation described in [ADR 0001](adr/0001-engineering-harness.md). The distributed platform blueprint has a separate scope.

## Browser and live-provider journey

The diagnostic workbench at `http://127.0.0.1:5189/` used an isolated SQLite database and project folders under `/tmp/ege-qa-20260912`. The browser was controlled through the visible application controls. The temporary project-folder binding was set through the local API because the browser diagnostic surface does not provide Tauri's native folder picker.

1. Created an empty **Harness QA** workspace and exactly one **Task board MVP** idea node. Its request specified Next.js, Mantine, TypeScript, fixtures, client state, small functional modules, and proportional documentation and checks.
2. Opened the dark IDE's **Engineering harness** editor and ran **Design the system in chat** using the connected Codex CLI. The first live attempt exposed insufficient default headroom: Codex reported 20,430 input tokens for its brief, despite only 2,960 estimated prompt tokens. The 24,000 budget correctly prevented the next call. The default was adjusted to 80,000 with an explanation of provider runtime overhead; explicit lower limits and all budget guards remain supported.
3. Stopped the next run after its brief checkpoint. **Resume saved stages** continued at review and then composition. The completed conversation contains exactly one user message and one assistant message, with one interrupted attempt retained. It did not duplicate the user message or rerun the brief.
4. Inspected the completed brief, specialist review, composer, editable agent names, questions, alternatives, input pins, and usage. The run proposed four connected work nodes: specification, Next.js/Mantine foundation, fixture-backed interactions, and checks/documentation. It treated a backend and TanStack Query as future choices and marked implementation/version verification as insufficient evidence.
5. Sent the identical request in a fresh conversation with unchanged context. All three stages were reused, the response completed without a new model call, and it received its own reviewable proposal identity.
6. Used **Keep as candidate memory**, then **Apply to draft**. The graph became five nodes and eight relations. The original idea remained. **Harness → Memory → Confirm** moved the candidate from `suggested` to `user_confirmed`; the service reported it current.
7. Inspected links and backlinks in node configuration, including their direction, relation type, and rationale. Version checks displayed installed tools and missing Java/.NET/CMake with setup references. No toolchain was installed.
8. Completed **Request plan** and observed real `capture_context`, `propose_plan`, and `validate_plan` LangGraph spans, including the separate Codex model span. The node filter can be cleared to display graph-level planning spans. The immutable plan includes the MVP profile, environment snapshot, and the exact confirmed-memory record digest.
9. Opened **Edit suggested nodes**, omitted two of four specialists, and adopted only the selected specification and foundation nodes. The graph became seven editable nodes and eleven relations. The source plan became `SUPERSEDED` without changing its content hash. Fixed the resulting UI transition to clear the obsolete proposal overlay and approval controls; an integration regression covers this transition.
10. Renamed the adopted specification, navigated its source-plan reference and linked foundation node, removed the foundation suggestion, and saved. Source-plan provenance survived the edit. A further delete/undo check verified that deleting a selected node clears its new-chat scope; the restored final draft contains six nodes and nine relations. The bound project directory remains empty and the graph has no admitted executions.

The main live chat run was `21275437-eaa7-4cde-8f06-0fac7c11df81`; the reused run was `dbac07ee-4ff4-4b50-867b-9468466e1f5f`. The first recorded 63,610 provider input tokens, 29,568 cached input tokens, 4,371 output tokens, and 613 reasoning-output tokens. The application records counters as reported; they are not a monetary calculation. Its interrupted attempt also retains estimates. The repeated run reported three application cache hits, zero estimated new input/output, and no new provider usage.

## Compaction and memory evidence

An API compaction request for the completed conversation used a 500-character bound. It produced 498 characters from 757 original characters, retained both message IDs and digests, and explicitly reported truncation. Reading the conversation afterward retained both original messages. The compaction made no model request. These are derived excerpts, not a guarantee that every decision survives a bounded summary.

Local reviewed memory was exercised through the browser and read back from the API. Hindsight and mem0 integrations were verified with controlled HTTP responses against inspected upstream contracts. No live external Hindsight or mem0 server was connected during this QA session, and no external memory retention was performed.

Regression tests cover current-source checks, confirmation/rejection/forgetting, graph scope, explicit remote sends, fallback, credential handling, and remote retention races. A retention result cannot restore an older record over a concurrent edit, rejected record, stale source, or forget tombstone. A successfully sent older revision is reported as stale; an uncertain write remains unconfirmed.

## Automated and packaging gates

The check suite covers architecture/version/contracts, OpenAPI, AsyncAPI, Protobuf, PostgreSQL DDL, the local server, workbench interactions, the bundled sidecar, Rust, and production frontend compilation. Focused harness tests exercise actual LangGraph transitions with controlled provider outputs, durable SQLite checkpoints, reuse/invalidation, Stop races, selected-node adoption, idempotency, source-plan races, and retained node configuration/provenance during save and replan.

The complete `npm run check` passed with 261 tests: 143 local-server, 115 workbench, one bundled-sidecar Node test, and two Rust tests. The final adoption/selection UI changes passed all 28 focused App, harness-panel, and API tests, including one new App regression. They were followed by a rebuilt production frontend and desktop package. Logs are `/tmp/ege-harness-final-check.log`, `/tmp/ege-harness-final-ui-targeted.log`, and `/tmp/ege-harness-desktop-package.log`.

The desktop package includes the direct LangGraph dependencies and full applicable third-party notices. Its embedded Node runtime and loopback API have a separate sidecar smoke test. Local app signing is ad hoc; a local package build does not establish notarized distribution or a native installed-app interaction journey.

The final arm64 installer is `apps/desktop/src-tauri/target/release/bundle/dmg/Execution Graph Engineering_0.1.0_aarch64.dmg` (44,941,615 bytes), SHA256 `9ce8171c4248eaa7cbc9371757fa465c46f33975373dcbd06d80131c6f815642`. DMG checksum verification, deep/strict app signature verification, and an actual packaged-node sidecar smoke test passed. The bundled frontend includes both final adoption/selection fixes, and the sidecar includes the reviewed-memory retention fix. Notarization was not performed.

## Evidence boundaries

This QA demonstrates engineering assistance, editable graph proposals, reviewed memory, traceable planning, and repeatable context reuse. It does not establish universal language/executor support, compatibility of every suggested dependency, or production readiness of a generated application. The Next.js/Mantine example was discussed and planned; its project was not installed, built, or deployed during this journey. Workspace writing remains the supported, approval-gated Codex CLI execution path. Existing execution and receipt regressions remain part of the automated suite.

Raw diagnostic records are local temporary files under `/tmp/ege-harness-qa-20260912`; they are not shipped as application state or treated as repository test fixtures. No source commit, push, external service deployment, or user-memory update was performed.
