# ADR 0001: A bounded engineering harness around graph refinement and execution

Status: Implemented. Date: 2026-09-12.

This decision describes the local implementation. A successful unit test, an accepted proposal, an installed compiler, and a completed workspace execution are different evidence claims.

## Context

A user should be able to start with one intention, discuss the scope with AI, inspect connected references, and receive an editable engineering proposal. Repeated manual prompting should become a visible, repeatable workflow. The proposal may describe a proof of concept, an MVP, or production work; the required disciplines and number of nodes should follow that scope.

The application already owns graph drafts, evidence attachments, editable agents and skills, provider connections, plan approval, execution checkpoints, and verification receipts. Adding an independent general-purpose coding agent would create competing owners for these responsibilities. The workbench therefore adds orchestration around its existing contracts.

## Decision

Use the JavaScript `StateGraph` API directly from `@langchain/langgraph`, with application-owned SQLite persistence and provider adapters. The local-server package pins `@langchain/langgraph` to `1.4.15` and `@langchain/core` to `1.2.11`; the workspace lockfile pins the installed dependency graph. The installed package identifies LangGraph as MIT licensed. See the [local package declaration](../../apps/local-server/package.json) and [upstream LangGraph repository](https://github.com/langchain-ai/langgraphjs).

No Deep Agents or Hermes implementation is copied into this repository. Deep Agents is an alternative higher-level agent package; this implementation instead supplies its own small stage prompts, approval boundaries, context manifests, cache keys, and storage. Direct `StateGraph` composition keeps these mechanisms visible beside the existing graph-engineering code. The tradeoff is that this application must implement and test its own checkpoint and resume behavior. See [LangGraph overview](https://docs.langchain.com/oss/javascript/langgraph/overview) and [Deep Agents overview](https://docs.langchain.com/oss/javascript/deepagents/overview).

Two workflows use LangGraph, with different costs and persistence contracts:

| Workflow | Stages | Model calls | Persistence and continuation |
| --- | --- | --- | --- |
| Engineering chat | `brief` → `review` → `compose` | Up to three configured provider requests; a valid cache hit skips its request | SQLite stage checkpoints and bounded handoffs support continuation after interruption |
| Request plan | `capture_context` → `propose_plan` → `validate_plan` | One configured planner request; explicit simulation/local compilation does not call a model | The complete validated plan is persisted atomically for review; the planning stages do not resume after process restart |

The three Request plan stages are orchestration steps, not three extra AI agents. The three engineering-chat stages do make separate model requests when uncached. Enabling the chat harness can therefore cost more than a single ordinary chat response. Its purpose is to reduce repeated user orchestration and make review steps observable; token savings depend on context size, provider behavior, and actual cache reuse.

## Ownership and implementation

| Responsibility | Owner |
| --- | --- |
| Engineering profiles, bounded conventions, editable agent selection | [harness_profiles.mjs](../../apps/local-server/src/harness_profiles.mjs) |
| Chat stage execution, budgets, handoffs, pin checks, cache lookup | [harness_runner.mjs](../../apps/local-server/src/harness_runner.mjs) |
| Durable stage checkpoints and cache records | [harness_store.mjs](../../apps/local-server/src/harness_store.mjs) |
| Chat context capture, streaming, proposal validation, Apply and continuation | [chat_routes.mjs](../../apps/local-server/src/chat_routes.mjs) |
| Request plan stage transitions and trace spans | [engineering_planning.mjs](../../apps/local-server/src/engineering_planning.mjs) |
| Planning inputs, immutable plan approval, execution admission and receipts | [server.mjs](../../apps/local-server/src/server.mjs) |
| Local reviewed memory, provenance, compaction and optional projections | [harness_memory.mjs](../../apps/local-server/src/harness_memory.mjs) |
| Editable adoption of selected proposed specialists | [engineering_proposals.mjs](../../apps/local-server/src/engineering_proposals.mjs) |
| Bounded local toolchain inspection and setup suggestions | [engineering_environment.mjs](../../apps/local-server/src/engineering_environment.mjs) |

Agent definitions and prompts remain editable catalog records. Stage routing chooses applicable enabled presets; it does not introduce a separate fixed population of autonomous agents. If there are no enabled catalog agents, the harness exposes its fallback stage role explicitly. All stages use the connected provider/model selected for that chat. Agent prompts and skill contents are supplied as contextual guidance, not as additional execution permission.

Agent-to-agent communication consists of bounded structured handoffs: summary, proposed decisions, assumptions, questions, critique, and alternatives. Each handoff records the originating stage and agent, previous handoff, next agent, content digest, usage, and cache provenance. These are inspectable engineering conclusions, not private reasoning transcripts or proof that implementation occurred.

## One intention to an editable project graph

1. The user creates an intention node and supplies a desired outcome, constraints, references, and scope.
2. Engineering chat can refine selected nodes and propose connected additions. Direct neighbors may be included as bounded read-only references; selected scope still controls which existing nodes can be modified.
3. The user reviews chat changes before Apply. Unapplied suggestions remain proposals. Applying changes creates a new graph draft revision and does not approve execution.
4. Request plan captures the current draft, attached evidence, agent/skill/provider configuration, reviewed memory, engineering profile, and available environment information. The configured planner proposes a proportionate specialist graph.
5. The user can adopt selected suggested specialists into the editable draft, refine their fields and relations, then request a new plan. Adoption preserves source-plan and source-intention provenance, copies relationships between selected specialists, and adds semantic `DERIVED_FROM` links. These links do not create execution dependencies.
6. Only a current, explicitly approved plan can be admitted to the workspace executor. Editing the draft or pinned inputs can require a new plan and approval.

Adoption uses deterministic node identities and a stored request fingerprint. Repeating the same request returns its original result; reusing the request ID with different inputs conflicts. Adoption checks graph ownership, the current draft, selected plan nodes, and execution activity. It supersedes the source proposal after creating the draft revision. Adopting a subset does not silently adopt omitted specialists or approve their work.

Profiles guide the expected deliverables: appropriate fixtures, user flows, domain/API contracts, implementation structure, tests, README, `spec.md`, `AGENTS.md`, relevant skills, setup, and operating guidance. These remain proposed outputs with acceptance criteria. Library selection, API style, architecture, file-size conventions, and production requirements must follow user intent and available evidence; the harness does not hard-code a universal stack or claim current package compatibility without checking it.

## Context, checkpoints, and caches

The graph and SQLite records are canonical local state. LangGraph schedules the bounded transitions; this implementation does not install a LangGraph database checkpointer or treat framework state as a second source of truth.

Chat checkpoints persist only validated complete stage results. The cache key binds the harness version, complete pinned input, stage, and actual prompt messages. Relevant input includes graph/evidence scope, provider/model configuration, agent prompts, selected skill digests, history pins, reviewed memory, profile, and user conventions. Changed pins invalidate reuse. Cached composer output is checked again against the permitted proposal scope before use.

Stage validation and context freshness are checked before and after provider work. A stopped or failed partial stage is not cached as a successful handoff. Its observed or estimated usage remains recorded. Continuation uses the latest interrupted harness message and its completed stage checkpoints; changed inputs require a new run. Stop is checked around asynchronous context preparation and pin validation, preventing an already-stopped request from starting later provider work.

There are two distinct cache concepts. The application can reuse a successful stage result without calling the model. Providers may separately report cached input tokens. Provider-reported cache counters do not prove an application-stage cache hit, and the application does not promise a particular provider cache-retention policy.

Token limits use bounded text estimates and observed provider usage. Supported API adapters receive output limits; CLI behavior is constrained by local cancellation and observed output rather than a guaranteed remote billing ceiling. Each chat stage has a five-minute timeout and the full engineering chat has a fifteen-minute limit. Hidden model reasoning, request failure, or delayed cancellation may consume provider tokens before local rejection. A token budget is not a monetary guarantee.

## Reviewed memory and derived compaction

Memory is local by default. Canonical records contain graph/node scope, content, revision, digest, and source/message/execution provenance. States distinguish suggested, user-confirmed, evidence-validated, rejected, stale, and forgotten records. Only current user-confirmed or validated records enter recall. Editing reviewed content normally resets review; explicit confirmation is a user action.

Validation checks reference identity and integrity. It does not independently prove that a user's statement or interpretation of a source is correct. Source hash changes, changed semantic node content, missing references, or changed messages prevent stale recall. An execution-result record requires an accepted PASS receipt from a completed run; a failed run or an assistant's assertion cannot establish successful execution. Memory supplied to planning remains supplemental context and cannot authorize work.

Conversation compaction is deterministic and extractive. It preserves the original messages and persists bounded excerpts, original-message IDs and digests, candidate decision/question references, character counts, and omission/truncation information. It makes no additional model call. Candidate labels are lexical aids, not accepted decisions. Original messages remain available when a summary omits detail. See [compaction implementation](../../apps/local-server/src/harness_context_compaction.mjs).

Recall has a bounded character budget and exposes included/omitted counts. The harness retains memory digests alongside its other context pins. Plans pin selected memory record IDs and digests; changed or excluded selected memory can invalidate approval or subsequent execution admission. Forget creates a recoverable local exclusion tombstone, while the original conversation remains intact.

## Optional Hindsight and mem0 projections

The [memory adapters](../../apps/local-server/src/memory_adapters.mjs) are original HTTP integration code with inspected upstream protocol references. Neither service is bundled, started, or required for local memory.

| Adapter | Contract used | Pinned upstream reference |
| --- | --- | --- |
| Hindsight | `POST /v1/default/banks/{bank_id}/memories` and `POST /v1/default/banks/{bank_id}/memories/recall`; graph-specific bank, document ID, tags and metadata | [OpenAPI at `4cc131c0b238c8f206def60804d7b6591f6a45e7`](https://github.com/vectorize-io/hindsight/blob/4cc131c0b238c8f206def60804d7b6591f6a45e7/hindsight-docs/static/openapi.json) |
| mem0 Open Source | `POST /memories` with `infer: false`, and `POST /search`; graph-specific user filter and provenance metadata | [Server contract at `c7ee362aff94a369af70f13f2b4f853f6793ff4c`](https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/server/main.py) |

The mem0 adapter intentionally uses OSS paths, not the hosted platform's `/v1/` routes. Protocol documentation is available in the [Hindsight HTTP reference](https://hindsight.vectorize.io/api-reference) and [mem0 OSS REST guide](https://docs.mem0.ai/open-source/features/rest-api).

Remote use requires explicit configuration. Endpoints require HTTPS or loopback HTTP, reject embedded credentials and redirects, and use bounded requests and responses. API keys stay in session memory, are not returned or stored in SQLite, and are cleared when the endpoint/provider changes. Environment variables do not silently enable memory integrations.

Allowing remote recall permits bounded query requests. It does not automatically retain chats, attachments, or memory records. Sending a record is a separate explicit action. A remote result can rank an entry only when its graph, local record ID, digest, and known synced projection match a current reviewed local record. Remote-generated prose is never injected as an independent fact. Unavailable remote recall falls back visibly to current local records.

An uncertain retention response is marked unconfirmed, not successful. A user should inspect the provider before retrying because a remote write may have completed. Forgetting or editing locally prevents stale projection reuse but does not automatically delete a previously sent remote copy. Remote lifecycle management remains an explicit external-service responsibility.

## Environment and execution boundaries

Environment inspection runs a fixed list of version commands, never user-supplied install commands. Checks run with bounded output, two-second command timeouts, at most three concurrent subprocesses, and a short cache. Detected project manifests help identify potentially missing tools. Official setup links and compatible alternatives are suggestions; no installation is performed.

An available compiler means its version command completed. It does not prove dependency resolution, project compatibility, a successful build, container availability, deployment readiness, or provider authentication. Missing tools remain actionable limitations. The user can choose a different stack or install a suitable environment before execution.

OpenAI, Anthropic, Ollama, and Codex support the configured planning/chat paths. Actual workspace writing remains the existing explicitly enabled Codex CLI execution adapter, with a bound workspace, current plan approval, pinned inputs, and receipt validation. API-only chat is not an arbitrary executor. Simulation does not write application code or run real tests. Supporting a language in a proposal does not supply its compiler or create a new executor.

Codex chat uses an isolated temporary directory, read-only sandbox, and disabled web search. The instruction not to invoke tools is prompt guidance; observed command activity remains visible. Workspace execution has its own sandbox and approval boundary. Requested agent tool classes are guidance, while actual capability enforcement belongs to the execution adapter and sandbox.

## Validation and limitations

Focused regression coverage lives in [harness runner tests](../../apps/local-server/test/harness_runner.test.mjs), [memory tests](../../apps/local-server/test/harness_memory.test.mjs), [chat tests](../../apps/local-server/test/chat.test.mjs), [planning stage tests](../../apps/local-server/test/engineering_planning.test.mjs), [proposal adoption tests](../../apps/local-server/test/engineering_proposals.test.mjs), and [environment tests](../../apps/local-server/test/engineering_environment.test.mjs).

Those tests exercise real `StateGraph` scheduling and SQLite persistence with controlled provider responses. HTTP adapter tests verify paths, payloads, bounds, credentials, provenance filtering, and failure behavior. They do not establish live Hindsight/mem0 connectivity or retrieval quality. Browser journeys, desktop packaging, and live Codex execution require their own evidence; this architectural decision does not substitute for those checks.

The harness supports structured engineering assistance and repeatable review. It cannot guarantee a correct architecture, comprehensive production readiness, truthful model conclusions, an installed development environment, or successful execution for every language and system type. Unresolved decisions and unavailable evidence must remain visible until the user or an observed check resolves them.
