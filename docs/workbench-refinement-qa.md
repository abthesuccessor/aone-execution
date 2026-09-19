# Workbench refinement verification

Verified locally on 12 September 2026 on macOS arm64, using Node.js 24.18.0.

The refinement adds a compact dark IDE shell, configurable nodes and catalogs, many-to-many graph editing, persistent AI discussions and reviewed graph proposals, a local terminal, and observable checkpointed execution. Usage and provider boundaries are documented in the [README](../README.md).

## Automated validation

`npm run check` passed after the implementation changes: 224 tests in total (111 local-server, 110 workbench, and 3 desktop/sidecar tests), architecture and version checks, contract validation, PostgreSQL DDL validation, the production frontend build, and the Rust desktop check. `npm audit` reported zero known vulnerabilities in the installed dependency tree.

The regression coverage includes stale AI proposals, exactly-once Apply, scoped conversation persistence, provider streaming, cancellation, dependency cycles, selected-run prerequisite closure, catalog revisions and drift, breakpoints, checkpoint lineage, observed command matching, dependency receipt provenance, workspace drift, graph status projection, and real React Flow pointer interactions. Modifier selection was reproduced as a failure before its fix; Shift, Command, and Control sequences pass integration tests afterward.

## Browser and live-provider evidence

The developer preview used an isolated SQLite database and disposable project under `/tmp/ege-qa-20260912`; it did not run generated work against this source repository.

- Created five nodes and six `SUPPORTS` relationships using the N:M editor (two sources by three targets).
- Edited node acceptance criteria, execution limits, breakpoint, group, agent, and skills; verified persistence after restarting the local engine.
- Created a custom agent and skill and revised a prompt template through the UI.
- Used the command palette, hid and resized panes, dragged a node, and verified Undo restored its original position.
- Used live Codex chat to refine a node, reviewed the proposed changes, applied them, and reopened saved conversation history.
- Fact-checked an attached requirements excerpt. The model cited the excerpt for the whitespace requirement and returned insufficient evidence for the claim that implementation tests had passed.
- Used live Codex chat to create a node in an empty graph, then generated and approved a two-specialist plan.
- Opened the real terminal, checked its bound working directory, executed a marker command, and stopped the shell.
- Observed a durable pause after the first accepted node, resumed the original plan, and verified graph statuses matched execution checkpoints.

The completed live execution was `c1bf6d04-c0a9-4f2d-b830-a3d503aa723f`, against plan `7bd1269b-bdd4-4e98-8239-5f5ea19c0946`. Both `create-verification-file` and `verify-exact-file-bytes` completed with accepted verification receipts. The second node received and cited the first node's accepted receipt and engine-observed file manifests. Its own before/after manifests were identical, confirming it made no file changes.

The produced `verification.txt` contained exactly `WORKBENCH_EXECUTION_OK` plus one newline: 23 bytes, SHA-256 `2232e9ee1d027159c4498a2a05ac29e9e21cb60b6530b2e8fa4b5643750bb53b`. The pre-existing README retained its original hash. The browser displayed the intent and both specialist nodes as Complete.

Earlier live attempts exposed exact-criterion/command receipt mismatches and missing predecessor evidence. Those attempts remained failed in history. The fixes preserve exact receipt checks and add bounded, provenance-linked prerequisite context; they do not turn unsupported claims into successful execution. Final post-context workspace/identity guards were also verified by regression tests.

## Delivery and remaining boundaries

- The macOS app and arm64 DMG are built locally. `codesign --verify --deep --strict` passed for the app, and `hdiutil verify` confirmed the DMG checksum. Signing is ad hoc; Apple notarization and installation are separate from these checks.
- Browser interaction checks used the Vite diagnostic surface. They do not claim a separate native app launch or native folder-picker verification; the disposable folder binding was supplied through the local API.
- Live Codex chat, planning, and workspace execution were exercised. OpenAI, Anthropic, and Ollama protocol paths have automated coverage; this run did not perform live calls with their credentials. API chat does not enable workspace file execution.
- Fact-check labels remain AI assessments of supplied excerpts. Source citations alone are not proof of a claim or of completed implementation.
- Pause occurs at a checkpoint; cancellation may leave partial file edits. Requested tool classes are instructions, while the CLI sandbox and runtime checks constrain actual workspace execution.
- The terminal requires host `python3` and provides line/raw input with streamed text, not a full-screen terminal emulator. Terminal output is not an execution receipt.
- This machine's Codex CLI emitted model-cache warnings during successful runs. They are preserved in execution activity and were not treated as failure or hidden.
- Multi-select pointer behavior is covered by React Flow integration tests. The in-app browser automation's modified-click actions did not provide reliable additional manual proof.

Local diagnostic logs are `/tmp/ege-final-check.log`, `/tmp/ege-desktop-package-final.log`, and `/tmp/ege-qa-20260912/completed-execution.json`. These temporary files are local evidence, not part of the distributed app.
