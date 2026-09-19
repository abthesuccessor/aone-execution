# Local graph-engineering server

This directory contains the runnable Node 24 backend for the localhost workbench. It is a bounded local engineering harness with an owned native PostgreSQL process. It is not the distributed production runtime described in `docs/`.

## Implemented local behavior

- dynamic user intent nodes with arbitrary names, objectives, contexts, optional edges, and source attachments;
- append-only graph draft revisions in PostgreSQL;
- bounded ingestion of Markdown, text, CSV, JSON, YAML, and XLSX sources into a local content-addressed object directory;
- provenance-aware chunks and deterministic BM25 plus trigram retrieval combined with reciprocal-rank fusion (RRF);
- configured-AI proposal generation in which Codex CLI, OpenAI, Anthropic, or loopback Ollama chooses the graph decomposition without a fixed domain or semantic relationship template;
- server-side normalization that binds only active configured agents and prompt revisions, reconciles `REQUIRES` relationships with dependencies, and enforces traceability, finite graph budgets, stop policies, and an acyclic execution graph;
- 12 seeded agent archetypes across seven broader engineering departments, editable catalog overrides, custom agents/domains, and provider/model/skill defaults;
- immutable agent prompt and configuration revisions with optimistic concurrency, digests, and parent-revision lineage;
- discovery, validation, automatic or explicit assignment, and versioned editing/import of `SKILL.md` instructions with package fingerprints;
- persistent scoped AI conversations, attached-evidence fact-check assessments, and reviewable node updates, node creation, and relationship additions;
- typed many-to-many relationship editing and node configuration for runtime, inputs/outputs, acceptance criteria, budgets, and breakpoints;
- deterministic simulation planning, Codex CLI planning, OpenAI API planning, Anthropic API planning, and loopback Ollama planning when each provider is ready;
- explicit Codex-only live web-research opt-in with provider/tool/mode/digest pins and primary-source/citation instructions;
- exact-hash human approval and freshness checks for the graph draft, evidence manifest, skills, agent prompts and policies, provider profile, and Git workspace baseline;
- checkpointed simulation execution and an explicitly enabled Codex CLI workspace-write adapter;
- selected-node execution with prerequisite closure, pause after the current node, before-node breakpoints, cancellation, and predecessor-to-successor continuation lineage;
- canonical local-project binding with per-node workspace checkpoint verification and advancement;
- ordered durable events, cursor replay, SSE, simulation restart recovery, and stored artifacts and receipts; and
- a local diagnostic trace store with W3C-shaped trace/span IDs, causal plan and execution spans, bounded redacted payloads, graph-level replayable SSE, and historical query APIs; and
- an explicit local PTY shell with streamed output, requiring an installed Python 3 interpreter.

The simulation provider does not edit application source or run real tests. Its generated verification documents explicitly say `SIMULATED_PASS`. The Codex adapter can edit the selected workspace when the process starts with `EGE_ENABLE_WORKSPACE_WRITE=1` and has additional boundaries documented below. The Tauri desktop sidecar sets this for its single-user local workflow.

## Run

From the repository root:

```sh
npm --prefix apps/local-server start
```

Defaults:

- URL: `http://127.0.0.1:4317`
- PostgreSQL database: `.ege/postgres`
- local object directory: `.ege/object-store`
- workspace boundary: the process working directory
- skill root: the fixed `apps/desktop/resources/skills` project snapshot

Configuration:

| Variable | Purpose |
|---|---|
| `EGE_PORT` | Loopback API port. Default: `4317`. |
| `EGE_WEB_PORT` | Trusted workbench origin port. Default: `5173`. It must match the Vite port. |
| `EGE_HOST` | Must be `127.0.0.1` or `localhost`. |
| `EGE_DATABASE_PATH` | Private native PostgreSQL directory. Default: `.ege/postgres`. |
| `EGE_OBJECT_ROOT` | Content-addressed object directory. Default: `object-store` beside the PostgreSQL directory. It is created lazily on first upload. |
| `EGE_WORKSPACE_ROOT` | Maximum filesystem boundary accepted for graph workspace paths. |
| `EGE_SKILLS_ROOT` | Skill catalog root. Default: the fixed `apps/desktop/resources/skills` project snapshot. |
| `EGE_STATIC_ROOT` | Optional built workbench directory. When set, the UI and API are served from the same loopback origin with SPA fallback. |
| `EGE_SIMULATION_STEP_MS` | Delay per simulated node checkpoint. |
| `EGE_ENABLE_WORKSPACE_WRITE` | Set to `1` before startup to expose Codex CLI execution after plan approval. It has no effect on other providers. |

See [PostgreSQL, Caveman, and review controls](../../docs/local-engine-upgrade-2026-09-13.md) for legacy import, `psql`, and the new controls. The old SQLite file is never opened as runtime storage or silently discarded.

## Embed as a desktop sidecar

The Tauri desktop build bundles the Node 24 service, PostgreSQL worker, process guardian,
and pinned native PostgreSQL binaries and starts the API on an ephemeral loopback port. The React webview calls the engine's
HTTP routes, including the explicit terminal route, without receiving Node.js
globals or native filesystem/process primitives. The source-level helper remains useful
for tests and other local hosts:

```js
import { startEmbeddedLocalServer } from '@aone-execution/local-server';

const service = await startEmbeddedLocalServer({
  dataDir: app.getPath('userData'),
  staticRoot: packagedWorkbenchDirectory,
  host: '127.0.0.1',
  port: 0,
});

// During app shutdown:
await service.close();
```

The helper creates default `state/postgres`, `object-store`, `workspaces`, and
`skills` locations under `dataDir`. `databasePath`, `objectRoot`,
`workspaceRoot`, and `skillsRoot` can each be overridden. It returns the actual
ephemeral `origin` and `port`, resolved path contract, and an idempotent
`close()` function.

Static delivery requires a contained `index.html`, serves known asset MIME
types, uses no-store for HTML and immutable caching for packaged assets, and
applies a self-only CSP plus frame, MIME, referrer, permissions, and
cross-origin isolation headers. Extensionless routes fall back to `index.html`;
missing asset filenames do not. Raw and percent-encoded traversal attempts and
static symlink escapes are rejected. The existing loopback Host and exact Origin
checks also apply to the desktop API.

## Browser boundary

There is no user account, login page, or production authorization system. There is still a local browser boundary:

1. The server binds only to loopback and rejects non-loopback `Host` headers.
2. Browser mutations accept only the configured `EGE_WEB_PORT` on `127.0.0.1` or `localhost`, or the server's same origin.
3. There is no application session cookie or bearer/header token. `GET /api/session` remains only as a compatibility response reporting `auth: "none"`.
4. CORS never uses `*`, and cross-origin browser mutations fail unless their exact origin was configured at startup.

This reduces drive-by browser requests. It is not identity, role-based access control, tenant isolation, or a production security boundary.

## Dynamic AI proposal generation

The dark IDE workbench provides an activity bar, searchable Node Library, central Graph/Node/Relationships/catalog editors, a chat sidebar, and a collapsible Plan/Execution/Traces/Terminal/Problems panel. Node Library `+` creates a user intent node with a required name and objective, optional context, and optional evidence files. Nodes may remain independent or include typed relationships. The N:M editor previews source/target pairs and separates semantic links from execution dependencies.

For a live provider, planning sends the latest draft, evidence manifest and excerpts, automatically routed guidance, workspace baseline, research policy, and active execution-agent catalog to the configured model. The model chooses how many focused specialist nodes are justified and supplies each semantic domain, objective, configured `agentId`, typed inputs and outputs, dependencies, acceptance criteria, traceability, and node-to-node relationships. Domains are arbitrary bounded text. Relationship types are arbitrary uppercase snake case; `REQUIRES` alone controls execution ordering, while other types express richer semantic connections.

The service does not trust model-supplied authority or digests. It resolves every selected agent against the active catalog, binds the current immutable prompt digest, reconciles dependency edges, validates cited intent and evidence IDs, adds finite node and graph budgets and stop policies, rejects cycles, and computes canonical proposal and plan digests. The safety ceiling is 48 proposal nodes and 256 semantic relationships; these are resource bounds, not content templates.

The deterministic seven-domain compiler remains only behind the explicit `simulation` provider for repeatable tests and harness demonstrations. It is not selected by the desktop UI for new proposal generation. No proposal, whether model-generated or simulated, proves semantic completeness or implementation success; human plan review remains required.

### Draft node shape

The API stores the browser's Objective field as `description`:

```json
{
  "id": "customer-onboarding",
  "title": "Customer onboarding",
  "kind": "custom",
  "description": "Deliver an accessible onboarding flow with a versioned API.",
  "context": "Known constraints, technology choices, flows, and unresolved questions.",
  "group": "Customer experience",
  "providerId": "codex-cli",
  "skills": [],
  "inputs": ["Approved onboarding requirements"],
  "outputs": ["Accessible onboarding implementation"],
  "acceptanceCriteria": ["The main flow can be completed using only a keyboard."],
  "budgets": { "timeoutMs": 300000, "maxAttempts": 1 },
  "breakpoint": false,
  "position": { "x": 120, "y": 240 }
}
```

Optional `agentId` and `model` override catalog/workspace defaults. `skills` supplies explicit skill IDs when nonempty; automatic routing remains the default. Configuration is resolved into the next immutable proposal and execution steps. Draft edges use `{id, source, target, type, label?, rationale?}`; `REQUIRES` means source must finish before target. A `VERIFIES` relationship describes intended responsibility and is not a verification receipt.

## Evidence storage and retrieval

`POST /api/graphs/:graphId/sources` accepts raw file bytes. Supply the filename through `filename=`, `X-EGE-Filename`, or `Content-Disposition`; supply an optional node link through `nodeId=` or `X-EGE-Node-Id`.

The default source limit is 8 MiB. The parser also enforces bounds on extracted text, chunks, structured depth and values, CSV/XLSX rows and cells, workbook sheets, ZIP entries, expanded bytes, entry sizes, and compression ratio.

Supported extraction:

- Markdown and text with line and section provenance;
- CSV with row and column provenance;
- JSON and YAML with structured-path provenance;
- XLSX BRDs with worksheet, row, and cell provenance.

Unsupported formats are retained as `OPAQUE` source bytes but do not produce searchable chunks. Parse failures are retained with bounded error metadata rather than being represented as successfully parsed.

Both original bytes and evidence manifests are stored by SHA-256. PostgreSQL stores graph/source references, metadata, chunks, and citations. Reads verify the object digest. Uploads of identical bytes deduplicate. Deleting a source removes its PostgreSQL reference and chunks but intentionally retains the content-addressed object; garbage collection is not implemented.

Retrieval ranks parsed chunks independently with BM25 and normalized trigram overlap, then combines the rank lists with deterministic RRF. Responses include fused scores, rank signals, citations, and a retrieval manifest digest. This is not vector search, embedding retrieval, a learned reranker, or authorization-aware enterprise retrieval.

## Agent catalog and prompt revisions

The seeded catalog contains 12 archetypes:

| Engineering department | Agent archetypes |
|---|---|
| Product and requirements | Intake and document curator; Requirements and traceability analyst |
| Architecture and computation | Graph architect and compiler; Retrieval, ranking, and context specialist |
| Client experience | Frontend and interaction engineer |
| Integration and services | API and integration engineer; Backend and distributed-systems engineer |
| Data and intelligence | Data and intelligence engineer |
| Assurance and security | QA, evaluation, and validation engineer; Security and AI-safety engineer |
| Platform and delivery | Performance and flamegraph engineer; Critical reviewer and release engineer |

The **Agents** editor supports create, duplicate, rename, disable, archive, custom domains, descriptions, capability metadata, prompt text, provider/model defaults, requested tool classes, and default skills. Saving appends immutable configuration and prompt revisions. Updates require the configuration `expectedDigest` and the prompt's `expectedPromptDigest`; stale edits return a conflict instead of overwriting newer work. Overrides survive startup seeding. The **Prompt templates** editor versions the Ask, Refine, Fact-check, and Develop instructions, and also accepts custom templates.

Capability and tool policies are structurally separate from editable prompts and retain explicit denied capabilities. Plans bind configuration, prompt, and policy digests; approval and execution reject drift. Requested tool classes are passed as agent instructions. The external CLI's sandbox governs actual workspace access; arbitrary class names are not a separate enforced per-tool allowlist.

## Editable skill catalog

The catalog recursively discovers `SKILL.md` files under an explicit `EGE_SKILLS_ROOT` or the fixed `apps/desktop/resources/skills` project snapshot. The snapshot includes both Agents and Codex skill folders; refresh it explicitly with `npm run skills:ingest`. A usable skill requires YAML frontmatter with a lowercase directory-matching `name` and a `description`.

Scanning rejects or marks invalid packages that escape the root, contain package symlinks, exceed nesting/file/byte limits, or change during binding. Diagnostic list responses expose relative paths and digests. The explicit catalog detail route supplies the instruction text for editing. Plans pin both the `SKILL.md` digest and the whole package manifest digest. Partial activation of an oversized routed package is forbidden.

The host supplies installed packages, and the user can create or import additional skill text through **Skills**. Edits, enable/disable/archive state, and history live in PostgreSQL overrides. Installed package files are not overwritten. Edited installed skills preserve their original package fingerprint and sibling asset manifest; later package drift makes the override unavailable pending review. A user-created skill is a text-only package; importing a `SKILL.md` file does not also import its referenced scripts or assets.

The server routes up to four relevant enabled packages automatically, unless an assigned agent or node supplies explicit skill IDs. Disabled and archived skills are excluded. Skill instructions and package fingerprints establish which guidance was supplied, not whether the resulting work is correct.

## Scoped AI chat and review/apply

Chat supports connected OpenAI API, Anthropic API, Ollama, and Codex CLI providers. Conversations persist under their graph with an explicit node selection. Each response records the supplied draft revision, bounded attached-source excerpts, evidence fingerprints, contextual agent/skill pins, selected prompt-template revision, status, and provider-reported activity. Stop interrupts a response; the saved status distinguishes completion, failure, and interruption.

The chat actions are `discuss`, `refine`, `fact-check`, and `develop`. Fact-checking is an AI assessment of the selected attached excerpts. The server accepts cited excerpt IDs only from that context and changes uncited supported/contradicted claims to `insufficient_evidence`. It does not independently verify the model's interpretation, browse cited websites, or turn an AI answer into canonical source evidence. API chat sends the supplied context without tool execution. Codex chat uses a temporary working directory, the CLI's read-only sandbox, and disabled web search. Its instruction not to invoke tools is prompt guidance; the CLI still has command capability, and observed command activity is reported. Chat does not use the workspace-write execution adapter.

Refine and Develop can return a reviewable proposal with `nodeUpdates`, `nodeAdditions`, and `edgeAdditions`. New-node temporary IDs are remapped server-side; selected-node conversations require new nodes to connect to that selection. Apply validates scope and graph structure, checks draft/evidence freshness, and atomically appends a draft revision and records the applied proposal. Repeated Apply is idempotent. It does not execute code, modify agent permissions, or approve a plan. A separate plan review and approval precedes workspace execution.

## Local terminal

The terminal allocates an actual PTY using Python 3's standard-library `pty` module, then starts an interactive local shell in the graph's bound project folder. `python3` must be discoverable in the engine's `PATH`; it is not included in the desktop package. An unavailable interpreter produces a failed session with an explicit error.

The UI provides line input, raw stdin without an appended newline, EOF, Ctrl+C, recent command history, and a streamed text output view. It does not emulate full-screen terminal applications. Stop terminates the shell's process tree. Sessions are in memory, capped at eight; output retains the latest 1 MiB and reports truncation. Idle sessions stop after 30 minutes without input or output. Server shutdown closes streams and stops shells. Shell output is not a durable, redacted execution receipt.

An active or paused approved execution blocks shell creation/input for every graph bound to the same canonical project folder. An active terminal likewise blocks execution start/resume. These are application workflow guards; the shell runs as the local user, and the starting directory is not an operating-system filesystem sandbox.

## Route manifest

All JSON failures use `{ "error": { "code", "message", "details?" } }`.

| Method and route | Request | Result |
|---|---|---|
| `GET /api/health` | None | Process, storage, and browser-boundary status. |
| `GET /api/session` | None | Compatibility response reporting `auth: "none"`; no session token. |
| `GET /api/skills` | None | Skill metadata, validation, contained package manifest, and SHA-256 digests. |
| `GET /api/providers` | None | Provider detection, configuration, readiness, capabilities, and non-secret profile settings. |
| `PUT /api/provider-profiles/:providerId` | `{enabled?, model?, baseUrl?, secretEnvName?}` | Update non-secret provider settings. Secret values are rejected. |
| `POST /api/provider-connections/discover` | `{kind, providerId, apiKey?, baseUrl?}` | Verify the credential, CLI, or local endpoint and discover available models. Hosted keys remain in engine memory. |
| `POST /api/provider-connections/connect` | `{kind, providerId, model?, baseUrl?}` | Connect a verified provider and persist its non-secret model/profile settings. |
| `GET /api/provider-connections/:providerId/models` | None | Refresh available models for the selected provider. |
| `DELETE /api/provider-connections/:providerId` | None | Disconnect, clear the session credential, and disable the profile. |
| `GET /api/agents` | None | Seeded department metadata and agent definitions/current prompts, including disabled definitions. |
| `POST /api/agents` | `{slug, name, domain, description, prompt, capabilities?, allowedToolClasses?}` | Create a custom local agent and prompt revision 1. |
| `GET /api/agents/:agentId` | None | Agent plus complete prompt-revision history. |
| `POST /api/agents/:agentId/prompts` | `{prompt, expectedDigest}` | Append a validated prompt revision using optimistic concurrency. |
| `GET /api/catalog/agents` | None | Agent configuration revisions, custom domains, and provider choices. |
| `POST /api/catalog/agents` | `{name, domain, prompt, slug?, description?, providerId?, model?, skillIds?, capabilities?, allowedToolClasses?}` | Create an agent and its first prompt/configuration revision. |
| `PATCH /api/catalog/agents/:id` | Configuration fields plus `expectedDigest` and `expectedPromptDigest` | Update metadata/defaults/prompt or set `status` and `archived`, preserving version history. |
| `GET /api/catalog/skills` | None | Installed and custom skill metadata, enabled/archive state, and fingerprints. |
| `POST /api/catalog/skills` | `{name, description, content, enabled?, archived?}` | Create/import a validated text skill. |
| `PATCH /api/catalog/skills/:id` | Skill fields plus `expectedDigest` | Append a content/configuration override without changing installed package files. |
| `GET /api/catalog/prompts` | None | Seeded and custom action prompt templates. |
| `POST /api/catalog/prompts` | `{name, content, description?, enabled?, archived?}` | Create a prompt template. |
| `PATCH /api/catalog/prompts/:id` | Template fields plus `expectedDigest` | Append an editable template revision. |
| `GET /api/catalog/:kind/:id` | `kind` is `agents`, `skills`, or `prompts` | Full current catalog item; skill detail includes instruction text. |
| `GET /api/catalog/:kind/:id/history` | None | Configuration history and, for agents, prompt history. |
| `GET /api/catalog/domains` | None | Seeded and custom domain choices. |
| `POST /api/catalog/domains` | `{name, description?}` | Persist an additional domain for custom agent configuration. |
| `GET /api/graphs` | None | Graph summaries. |
| `POST /api/graphs` | `{name, description?, workspacePath?}` | Create a graph and empty draft revision 1. |
| `GET /api/graphs/:graphId` | None | Graph, latest draft, immutable plans, and executions. |
| `PATCH /api/graphs/:graphId` | Graph metadata fields | Update mutable graph metadata. A project-folder change is rejected while an execution is queued, running, waiting to pause, or paused. |
| `DELETE /api/graphs/:graphId` | None | Delete an inactive local graph and its PostgreSQL history. |
| `PUT /api/graphs/:graphId/draft` | `{nodes, edges, context?}` | Append a draft revision. |
| `GET /api/graphs/:graphId/chat` | None | Persistent conversations for the graph. |
| `POST /api/graphs/:graphId/chat` | `{nodeIds?, title?}` | Create a conversation scoped to selected nodes or the workspace. |
| `GET /api/graphs/:graphId/chat/context` | None | Current graph nodes and available source metadata. |
| `GET /api/graphs/:graphId/chat/templates` | None | Enabled action prompt templates. |
| `GET /api/graphs/:graphId/chat/:id` | None | Conversation and saved messages, context pins, assessments, and proposals. |
| `POST /api/graphs/:graphId/chat/:id/messages` | `{content, providerId, action?, sourceIds?, templateId?}` | Stream a scoped AI response as SSE and persist its status. |
| `POST /api/graphs/:graphId/chat/:id/stop` | `{}` | Interrupt the active response. |
| `POST /api/graphs/:graphId/chat/proposals/:id/apply` | `{}` | Apply a fresh, validated graph proposal once. |
| `GET /api/graphs/:graphId/terminal` | None | Latest in-memory terminal session for the graph, if present. |
| `POST /api/graphs/:graphId/terminal` | `{}` | Open an interactive shell in the bound project folder. |
| `GET /api/terminals/:id` | None | Status and bounded output snapshot. |
| `GET /api/terminals/:id/events` | None | Initial snapshot followed by output/status SSE. |
| `POST /api/terminals/:id/input` | `{input}` | Send raw stdin bytes encoded as JSON text. |
| `POST /api/terminals/:id/interrupt` | `{}` | Send Ctrl+C to the PTY. |
| `POST /api/terminals/:id/stop` | `{}` | Stop the terminal process tree. |
| `GET /api/graphs/:graphId/traces` | `?limit=&before=` | Page stable newest-first plan and execution trace history. |
| `GET /api/graphs/:graphId/traces/events` | `?after=` or `Last-Event-ID` | Replay graph-wide plan/execution trace SSE, then remain connected. |
| `GET /api/graphs/:graphId/sources` | Optional `?nodeId=` | List graph or node source records. |
| `POST /api/graphs/:graphId/sources` | Raw bytes plus filename; optional `nodeId` | Store, parse, chunk, cite, and link source evidence. |
| `POST /api/graphs/:graphId/retrieve` | `{query, limit?}` | Return BM25/trigram/RRF hits and retrieval-manifest digest. Limit: 1 to 50. |
| `GET /api/sources/:sourceId` | None | Source metadata and ordered chunks. |
| `GET /api/sources/:sourceId/content` | None | Verified original bytes as a download attachment. |
| `DELETE /api/sources/:sourceId` | None | Remove the graph source reference and chunks; retain the immutable object. |
| `POST /api/graphs/:graphId/plans` | `{provider?, instructions?, research?: {enabled: boolean}}` | Compile a ProposedGraph, generate immutable plan content, and diff against the previous plan. Live research is Codex-only. |
| `GET /api/plans/:planId` | None | Plan and approval record. |
| `POST /api/plans/:planId/approve` | `{expectedContentHash, rationale?}` | Bind human approval to the exact plan hash. Semantic feedback requires replanning. |
| `POST /api/graphs/:graphId/executions` | `{planId, expectedPlanHash, provider?, nodeIds?}` | Start an approved plan or selected nodes with their prerequisite closure. The optional provider must equal the approved plan provider. `/execute` is an alias. |
| `GET /api/executions/:executionId` | `?after=&limit=` | Execution, pinned plan, paginated events, and lineage-aware artifacts. |
| `GET /api/executions/:executionId/trace` | `?after=&limit=` | Execution trace, causal spans, and paginated trace events. |
| `POST /api/executions/:executionId/pause` | `{}` | Request pause after the in-flight node reaches a boundary. |
| `POST /api/executions/:executionId/cancel` | `{}` | Mark an active run cancelled and request interruption of its CLI process; partial edits remain. |
| `POST /api/executions/:executionId/replan` | `{provider?, instructions?, research?: {enabled: boolean}, draft?}` | Create a replacement plan while the predecessor is paused. |
| `POST /api/executions/:executionId/resume` | `{mode?}` | Resume `PINNED_PLAN` or create an `APPROVED_REPLAN` successor. |
| `GET /api/executions/:executionId/events` | `?after=` or `Last-Event-ID` | Replay ordered SSE events, then remain connected for live events. |
| `GET /api/executions/:executionId/artifacts` | `?includeLineage=&history=` | Effective artifacts or full ancestor history. |
| `GET /api/artifacts/:artifactId` | None | Full stored artifact document. |
| `GET /api/traces/:traceId` | `?after=&limit=` | Any plan or execution trace, causal spans, and paginated trace events. |

## Approval and continuation semantics

- A plan pins its draft revision, ProposedGraph digest, evidence manifest, provider profiles, Codex research provider/tool/mode/digest, canonical workspace binding and baseline, assigned agent configuration/prompt/policy revisions, selected skill packages, and per-step semantic input digest.
- Approval requires the exact `expectedContentHash` presented to the user.
- Approval and new execution return `PLAN_CONTEXT_STALE` when source evidence, skills, agent prompts or policies, provider settings, or workspace state changed. A newer draft returns `PLAN_DRAFT_STALE`.
- Pause is checkpoint-oriented. It does not terminate an in-flight Codex process; the request is observed between nodes.
- A configured node breakpoint pauses before that node starts. The admitted execution records the reached breakpoint so resuming the pinned run can proceed through it once.
- Selected-node runs resolve intent/proposal IDs against the approved graph and include required prerequisites. They do not bypass approval or dependency checks.
- Cancellation records a terminal cancelled state and requests interruption of the CLI process. Late completion events cannot turn the cancelled run into a successful run. It does not roll back partial workspace edits or provide a success receipt.
- Replan creates another immutable plan and diff. It never mutates the admitted plan.
- `APPROVED_REPLAN` checks freshness, marks the predecessor `SUPERSEDED`, and atomically creates a successor with lineage and only digest-compatible reusable checkpoints.
- `PINNED_PLAN` resumes the already admitted plan and discards a pending proposal. It intentionally does not readmit changed semantics. For Codex, selected skill content is still revalidated before each step.
- A Codex execution uses its admitted canonical project path, not mutable graph metadata. It verifies the persisted file baseline before every node and atomically advances that checkpoint after an accepted node. External drift stops the execution closed.
- Simulation restart recovery reruns only an incomplete node and does not duplicate its durable `node.started` event.
- An interrupted in-flight Codex workspace step is failed on server restart because no durable receipt proves its outcome. The workspace must be inspected before creating and approving another plan.

Approval `rationale` is an audit note only. Sending `semanticFeedback` to approval returns `REPLAN_REQUIRED`; put semantic changes into a draft or replan request.

## Provider setup and truth table

| Provider | Ready when | Planning adapter | Execution adapter |
|---|---|---|---|
| `simulation` | Profile is enabled; explicit API/test use only | Deterministic local test planner; disabled for new desktop proposals | Deterministic simulated checkpoints and receipts |
| `codex-cli` | Profile enabled, `codex` in `PATH`, and `codex login status` succeeds | Ephemeral read-only Codex CLI call with strict JSON schema | Available only with `EGE_ENABLE_WORKSPACE_WRITE=1` |
| `openai-api` | Profile enabled, session credential verified, and a discovered model connected | OpenAI Responses API with strict structured output | None |
| `anthropic-api` | Profile enabled, session credential verified, and a discovered model connected | Anthropic Messages API with JSON-schema output | None |
| `ollama` | Profile enabled and a model connected from the verified loopback `/api/tags` endpoint | Non-streaming local chat request with JSON schema | None |
| `claude-cli` | Never in this slice | Detection only | None |
| `copilot-cli` | Never in this slice | Detection only | None |

Provider profiles persist in PostgreSQL. Configure them in workbench **Settings**. Hosted connection discovery accepts a session API key, verifies it, and loads model choices; raw session keys remain in engine memory. `PUT /api/provider-profiles/:providerId` remains available for non-secret settings and named environment-variable references. OpenAI and Anthropic base URLs are restricted to their fixed official HTTPS API roots. Ollama is restricted to HTTP loopback. Chat readiness does not imply a workspace execution adapter exists for that provider.

### Opt-in Codex live research

The workbench exposes **Live web research** only when the installed and authenticated Codex CLI advertises the global `--search` option and accepts an explicit disabled `web_search` configuration. It is off by default. A planning or replanning request opts in with `research: {"enabled": true}`; other providers reject that request.

Enabled plans pin `codex-cli`, the `web_search` tool, `live` mode, evidence/citation requirements, and a policy digest into the immutable plan and every step input digest. Codex planning and later Codex execution receive `codex --strict-config --search exec ...`. Disabled plans explicitly receive `web_search="disabled"`. Approval and execution fail stale if the pinned CLI capability disappears.

The prompts require primary authoritative sources, exact URLs for web-derived claims, cross-checking of consequential guidance, and independent validation. The current harness does not independently fetch those URLs, prove source quality, or provide an application-level network egress boundary. A Codex failure or incomplete citation remains a model/tool failure, not verified evidence.

Example API startup:

```sh
OPENAI_API_KEY='your-value' npm run dev:server
```

For API-driven planning, enable `openai-api`, configure its model, and keep `OPENAI_API_KEY` as the secret environment-variable name. Anthropic works the same way with `ANTHROPIC_API_KEY`. In the workbench, verify a session key and connect a discovered model through Settings; chat requires that connected state. Planning and chat surface request failures. Automated provider tests use controlled responses and do not establish that a particular live account is connected.

Example Ollama setup:

```sh
ollama pull qwen3-coder
ollama serve
npm run dev:server
```

Then enable `ollama`, confirm the model, and use a loopback base URL such as `http://127.0.0.1:11434`.

### Opt-in Codex workspace execution

```sh
codex login
EGE_ENABLE_WORKSPACE_WRITE=1 npm run dev
```

The current workbench's Run action requires a `codex-cli` plan and supported pinned step providers. The backend selects the execution adapter from each step's approved provider override, falling back to the planning provider; this does not imply the workbench offers a mixed planning/execution-provider journey. Every run still requires approval of the exact plan hash and fresh pinned context. The execution request cannot change the planning provider or replace the approved per-step provider choices at run time.

For each Codex specialist node, the adapter:

1. resolves the exact pinned agent prompt and selected skill contents;
2. supplies bound user intents, evidence excerpts, dependencies, and acceptance criteria;
3. invokes `codex exec` with an ephemeral session, `workspace-write` sandbox, ignored user configuration, no interactive approval, and a strict receipt schema;
4. streams bounded, redacted progress and real command exit codes as events;
5. captures before/after workspace file hashes and reconciles actual changed files with the model's receipt;
6. accepts the node only when the receipt reports `COMPLETED`, every approved criterion is reported `PASS`, each final reported verification matches an observed successful command, and changed-file lists match; and
7. stores the receipt, summary, and bounded text artifacts for changed files.

Earlier failed command attempts remain in the observed history and do not automatically reject a later successful final verification. The agent is instructed to disclose corrected attempts and rerun evidence in the receipt's risks; the harness does not independently determine whether every relevant check was reported.

Only an environment allowlist is passed to the CLI. The Codex login context remains available because the CLI needs it. This is not a container, VM, network-egress control, operating-system user boundary, or production secret broker. The adapter does not automatically roll back file changes after a failed, timed-out, interrupted, or rejected step. Use version control and backups, inspect changes, and run it only in a disposable or recoverable workspace.

## Events

SSE frames use the database sequence as `id`, event type as `event`, and event document as `data`. Common payload fields such as `nodeId`, `message`, and `artifactId` are projected at the top level and retained under `payload`. `timestamp` equals `createdAt`.

`GET /api/executions/:id` returns a bounded event page:

```json
{
  "events": [],
  "eventPage": {
    "after": 0,
    "nextAfter": 42,
    "hasMore": false,
    "limit": 500
  }
}
```

Follow `nextAfter` until `hasMore` is false, then connect SSE with that cursor.

## Local trace explorer contract

Durable execution state and receipts remain canonical. Trace rows are a diagnostic projection whose failure cannot approve, complete, or otherwise change execution truth. Planning and execution use separate traces so no span remains open across human approval. Replans and successor executions create new correlated records.

The trace store records only operations the harness observes: intent compilation, workspace-baseline capture, provider request/response, plan persistence, graph node and assigned-agent boundaries, Codex CLI process activity, emitted command start/completion, verification, artifacts, checkpoints, and errors. Simulation spans are labeled simulated. Hidden model reasoning and unreported provider internals are not observable and are never represented as if they were.

Every trace payload is captured locally through recursive key and free-text redaction, structural/depth limits, and a 64 KiB field cap. Each input/output records capture metadata including redaction and truncation state. API keys, authorization/cookie values, private keys, common cloud tokens, database connection URLs, and the process environment are excluded or redacted. Absolute project paths remain local and there is no external exporter in this implementation.

The schema uses 32-lowercase-hex trace IDs and 16-lowercase-hex span IDs compatible with the [W3C Trace Context](https://www.w3.org/TR/trace-context/) shape. `spanKind` uses the OpenTelemetry `INTERNAL`, `CLIENT`, `SERVER`, `PRODUCER`, or `CONSUMER` vocabulary; the separate application category identifies graph, planner, model, agent, node, tool, command, verifier, artifact, or checkpoint work.

## Verification

```sh
npm --prefix apps/local-server test
```

The tests cover the compiler, versioned catalog overrides and builtin seeding, skill package drift, chat scope/proposals/evidence guards, object-store integrity, bounded evidence parsing including XLSX, deterministic RRF, provider adapters with controlled responses, Codex live-research argument ordering and stale-capability rejection, Git workspace baselines, execution-adapter receipts/manifests, selected-node and pause/cancel lifecycles, more-than-2,000 event replay, cycle rejection, continuation lineage, source routes, and restart behavior. Native PTY tests exercise real shell input, Ctrl+C recovery, exit status, child cleanup, output limits, and same-project execution locks when Python 3 is available.

These tests validate local behavior. They do not prove live OpenAI or Anthropic credentials, real Ollama model quality, a real Codex-generated application change, production security, or distributed operation.

## Deliberately not implemented

- production authentication, authorization, organizations, tenancy, quotas, billing, or remote ingress;
- PostgreSQL, MinIO, cloud object storage, queues, distributed workers, high availability, or disaster recovery;
- remote multi-user collaboration and conflict resolution;
- vector embeddings, learned reranking, authorization-aware retrieval, or a production search index;
- object garbage collection or retention policy enforcement;
- automatic installation of missing skill dependencies or import of assets referenced by skill text;
- Claude Code CLI or Copilot CLI planning/execution;
- OpenAI, Anthropic, or Ollama workspace execution;
- container-grade isolation, network egress policy, per-tool runtime authorization, or automatic rollback;
- a separate independent verifier service for Codex results; and
- external OTLP, Grafana Tempo, or Langfuse export; production metrics, alerting, SLOs, retention enforcement, load qualification, or the architecture's million-graph scale target.
