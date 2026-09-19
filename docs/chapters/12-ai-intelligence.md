# 12. AI Intelligence Plane

The intelligence plane makes models, retrieval, memory, agents, evaluation, and graph optimization available as governed runtime capabilities. It does not own execution state, authorization, billing, or side effects. The deterministic runtime remains in control: an AI component may propose a route, plan, tool call, memory write, graph, or refactor, but typed validation, policy, budgets, approvals, leases, fencing, and effect adapters decide whether that proposal can run.

## 12.1 Design principles and invariants

1. **Every AI artifact is versioned.** Model profiles, prompts, context policies, embedding profiles, retrieval pipelines, tools, agent roles, evaluators, datasets, and optimization proposals have immutable revisions and content digests.
2. **Provider identifiers are not graph logic.** GraphVersion references a logical `ModelProfile`; a recorded routing decision selects an exact provider/model revision for a node attempt.
3. **Routing is constraint-first.** Data classification, residency, tenant allow-list, capability, context window, structured-output/tool support, safety, and contract status are hard filters. Cost/latency/quality scores never override them.
4. **Fallback preserves semantics and authority.** A fallback may not widen provider data use, tools, context, output schema, cost, or effect permissions. Incompatible fallback is a compilation or runtime failure, not a best effort.
5. **Provider/model output is untrusted.** It must pass a typed parser, policy, and application validation before state mutation or tool invocation.
6. **Memory is a governed write.** Conversation text is not automatically durable memory. Memory records require namespace authorization, provenance, classification, retention, conflict, poisoning, and deletion policy.
7. **Retrieval never authorizes.** Access is decided against canonical metadata before candidate search and verified after projection lookup.
8. **Hidden chain-of-thought is not requested or persisted.** The platform stores user-visible conclusions, citations, structured plans, concise decision summaries, and evaluator evidence—not private reasoning traces.
9. **Optimization is proposal-first.** Automatic graph generation/refactoring/performance optimization creates a candidate diff with evidence. Production activation follows compile, security, evaluation, approval, and canary gates.
10. **AI loops are bounded.** Iterations, wall time, tokens, cost, tool calls, graph expansion, parallel agents, and minimum improvement are explicit monotonic counters.
11. **Reproducibility is honest.** Model sampling and provider infrastructure may be nondeterministic. `EXACT_REPLAY` with `execution_mode=REPLAY` and adapter `effect_mode=SUBSTITUTE_RECORDED` can return the recorded result; a new `LIVE` call is not claimed to reproduce identical tokens.
12. **Canonical facts survive projection changes.** PostgreSQL/object storage preserve source records, versions, provenance, and memory intent; vector and graph indexes are rebuildable projections.

## 12.2 Component architecture

```text
                       CONTROL PLANE
 +-------------------------------------------------------------------+
 | Model Registry       Prompt Registry       Tool Registry           |
 | Context Policies     Memory Policies       Agent/Role Registry     |
 | Eval Datasets        Evaluators            Optimization Proposals  |
 +-------------------------------+-----------------------------------+
                                 | immutable digests in Graph IR
                                 v
                       EXECUTION / INTELLIGENCE
 +-----------+   +------------------+   +---------------+
 | Scheduler |-->| WorkerSupervisor |-->| WorkerGateway |
 | + budgets |   | JetStream owner  |   | claim/commit  |
 +-----------+   +------------------+   +-------+-------+
                                                |
                                          trusted host RPC
                                                v
                    +--------------+   +----------------+   +----------+
                    | AI Node      |-->| Model Router   |-->| Provider |
                    | Controller   |   | + health/cost  |   | Adapters |
                    +--+-----+--+--+   +----------------+   +----------+
                       |     |  |
                       |     |  +--------> Tool Proxy -> governed effects
                       |     +-----------> Evaluator/Critic -> typed score
                       +-----------------> Context Service
                                           |
             +-----------------------------+-------------------------+
             |                 |                 |                   |
       Memory Service    Retrieval Service   Prompt Compiler   Token Budgeter
             |                 |
       PostgreSQL facts   ACL service -> search/vector/graph projections
       + object storage       -> reranker -> evidence bundle

 Feedback/evidence (outbox) -> ClickHouse analytics -> offline evaluation
                                                    -> candidate policy/model
```

The `AI Node Controller` is trusted platform code, but it is not database authority. `WorkerSupervisor` consumes JetStream, manages process lifecycle, and may hold/present the proof-of-possession/mTLS-bound `ExecutionGrant`. `WorkerGateway` alone claims and commits the node attempt in PostgreSQL, mints the grant, persists its hash/constraints, validates supervisor RPCs, and mediates model/tool/artifact/secret operations. The supervisor cannot exercise those operations directly. Any sandboxed adapter or custom AI code receives only a sanitized invocation plus opaque capability handles—never NATS or database connectivity, an `ExecutionGrant`, or a secret. Provider adapters, rerankers, evaluators, and agent messages are treated as fallible dependencies, and the controller returns only validated results to the gateway for fenced commit.

## 12.3 AI artifact model

### 12.3.1 Artifact identities

| Artifact | Mutable alias | Immutable revision contents |
|---|---|---|
| `ModelProfile` | `support-balanced` | required capabilities, allowed provider/model revisions, route policy, output/tool mode, data policy, budgets |
| `PromptTemplate` | `ticket-triage` | typed variables, section roles/trust, template AST, output schema, tests |
| `ContextPolicy` | `support-context` | token allocation, source priorities, compression and truncation rules |
| `EmbeddingProfile` | `support-embedding` | provider/model dimensions, normalization, tokenizer, chunk profile, distance |
| `RetrievalPipeline` | `support-rag` | source/ACL filters, queries, fusion, reranker, thresholds, diversity, citation rules |
| `MemoryPolicy` | `account-memory` | namespace, write/read rules, schema, TTL, merge, review, index profiles |
| `AgentRole` | `researcher` | prompt/context/tool grants, output contract, limits |
| `Evaluator` | `support-grounding` | code/model judge revision, rubric, calibration, output schema |
| `EvalSuite` | `support-release` | dataset snapshot, evaluators, thresholds, slices, statistical rules |
| `OptimizationProposal` | none | source/target graph revisions, typed diff, evidence, risk, gates |

Aliases resolve to a digest at GraphVersion compilation/deployment. A running execution never observes alias drift.

### 12.3.2 Model registry schema

```yaml
apiVersion: ege.dev/v1
kind: ModelProfileRevision
metadata:
  id: support-balanced
  revision: 0197f3c2-8600-7666-88ee-fd5000000014
  digest: sha256:3fe...
spec:
  capabilities:
    modalities: [text]
    tools: required
    structuredOutput: json_schema_strict
    streaming: required
    minContextTokens: 64000
  dataPolicy:
    maxClassification: CONFIDENTIAL
    allowedResidencies: [JP]
    zeroRetentionRequired: true
    trainingUseAllowed: false
  candidates:
    - providerConnection: jp-provider-a-prod
      providerModel: model-a-2026-07
      family: model-a
      adapterRevision: sha256:11a...
      qualityProfile: support-v7
      maxInputTokens: 120000
      maxOutputTokens: 8000
    - providerConnection: jp-provider-b-prod
      providerModel: model-b-stable
      family: model-b
      adapterRevision: sha256:9b3...
      qualityProfile: support-v7
      maxInputTokens: 100000
      maxOutputTokens: 6000
  routing:
    strategy: constrained_score
    weights: {quality: 0.50, latency: 0.20, cost: 0.20, reliability: 0.10}
    explorationPercent: 2
    stickyBy: execution
  fallback:
    on: [provider_unavailable, rate_limited, deadline_feasible]
    maxDistinctCandidates: 2
    forbidAfterFirstOutputByte: true
  limits:
    timeout: 45s
    maxAttempts: 2
    maxInputTokens: 50000
    maxOutputTokens: 3000
    maxCostMicros: 150000
```

Provider model IDs are data, not hard-coded enums. Registry ingestion periodically verifies declared capabilities through adapter contract tests. A change in provider behavior creates a new effective capability record; it never rewrites an old route decision.

## 12.4 Multi-model routing and model selection

### 12.4.1 Selection pipeline

```text
node requirements + tenant policy + data labels + budgets + deadline
        |
        v
  registry candidates
        |
        +-- hard filters --------------------------------------------+
        | capability, region/residency, classification, provider     |
        | contract, tenant allow-list, context/output size, tools,    |
        | schema mode, health breaker, deadline feasibility          |
        +------------------------------------------------------------+
        |
        v
 normalized score(quality, latency, cost, reliability, cache affinity)
        |
        v
 deterministic tie-break + exploration policy + capacity reservation
        |
        v
 immutable RouteDecision + model invocation
```

Quality is eval-suite and workload-slice specific, never a universal model ranking. Latency distributions are regional and input/output-size conditioned. Cost uses the effective price version and predicted tokens. Reliability excludes policy/user failures.

For candidate `m`:

```text
eligible(m) = capabilities AND data_policy AND tenant_policy
              AND healthy_enough AND context_fits AND deadline_fits

score(m) = wq * calibrated_quality(m, workload_slice)
         - wl * predicted_p95_latency(m, token_bucket, region)
         - wc * predicted_cost(m, input_tokens, max_output_tokens)
         + wr * recent_success_rate(m)
         + wa * cache_affinity(m)
```

Each feature is normalized to `[0,1]` against the profile cohort. The router records raw feature values, normalization revision, weights, exclusions, selected candidate, price revision, health snapshot, exploration decision, and route-policy digest.

### 12.4.2 Router pseudocode

```rust
fn route(req: RouteRequest, registry: &Snapshot) -> Result<RouteDecision> {
    let candidates = registry.resolve_pinned(req.model_profile_digest)?;
    let mut eligible = Vec::new();

    for model in candidates {
        let exclusions = hard_constraint_failures(&req, model);
        if exclusions.is_empty() {
            eligible.push((model, score(&req, model, registry)));
        } else {
            record_exclusion(model, exclusions);
        }
    }
    if eligible.is_empty() { return Err(NoCompliantModel); }

    stable_sort_by_score_then_digest(&mut eligible);
    let chosen = apply_versioned_exploration(req.routing_seed, eligible)?;
    reserve_provider_capacity_and_budget(&req, chosen)?;
    Ok(sign_route_decision(req, chosen, registry.snapshot_digest))
}
```

`routing_seed` is derived from `execution_id`, deterministic `activation_id`, and route-policy revision for stable cohort assignment; it is not used to claim deterministic provider output.

### 12.4.3 Health and circuit breaking

Health is maintained per provider connection, model revision, region, and operation mode. Breakers use a rolling minimum-volume window and distinguish rate limits, server failures, client/schema failures, policy denial, and tenant quota. A provider-wide incident does not trip on one tenant's invalid credentials.

States are `closed`, `degraded`, `open`, and `half_open`. Half-open probes use synthetic non-sensitive requests and a small real-traffic canary budget. The router reserves capacity before invocation to prevent a thundering herd from selecting the same recovering provider.

### 12.4.4 Model fallback semantics

Fallback is allowed only when:

- the node has not emitted externally visible streaming output;
- no external effect is in flight, and any fallback call is effect class `READ_ONLY` under current policy;
- the next candidate satisfies every original hard constraint;
- remaining deadline, token, and cost budgets can cover it;
- prompt and tool representations compile for the target adapter;
- policy permits the candidate and the route count remains bounded.

Do not fallback on deterministic input/schema/policy failures. On an ambiguous timeout after a provider tool call with class `IDEMPOTENT_WRITE`, `COMPENSATABLE_WRITE`, `NON_IDEMPOTENT_WRITE`, or `HUMAN_EFFECT`, query provider request status or use the effect journal; do not blindly call a second provider. If streaming has begun, finish, fail, or resume with provider-specific support—never splice another model into the same output while pretending it is one response.

### 12.4.5 Hedging and batching

Hedged requests are disabled by default because they multiply cost and load. They are permitted only for latency-critical calls whose effect class is `READ_ONLY`, before externally visible output, after a learned p95 delay, with at most one hedge and immediate cancellation of the loser. Both requests are metered and recorded.

Batching is limited to the same provider connection, model/settings, data residency, compatible deadline, and isolation class. Tenant data is logically separated inside the batch, and provider contracts must permit multi-tenant batching. Cost allocation uses provider usage when available; otherwise the versioned allocation rule is auditable.

## 12.5 Provider adapter contract

Adapters normalize platform requests without flattening provider-specific capabilities.

```rust
trait ModelAdapter {
    fn capabilities(&self) -> CapabilityDocument;
    fn compile(&self, request: CanonicalModelRequest) -> Result<ProviderRequest>;
    async fn invoke(&self, request: ProviderRequest, permit: ModelPermit)
        -> Result<ProviderStream>;
    fn normalize_usage(&self, response: &ProviderResponse) -> UsageReport;
    fn normalize_error(&self, error: ProviderError) -> PlatformFailure;
    async fn query_request(&self, provider_request_id: &str) -> RequestStatus;
}
```

The canonical request includes typed messages/sections, content parts, tools, response schema, sampling controls, safety policy, max output, deadline, tenant data-policy flags, and idempotency/client request ID where supported. Unknown provider fields cannot be injected through an untyped `extra` map in production.

Adapters pass a conformance suite for cancellation, streaming frame order, Unicode, usage accounting, structured output, tool calls, timeouts, duplicate frames, partial responses, content filters, and normalized errors. A provider SDK upgrade creates a new adapter revision and canary.

## 12.6 Prompt versioning, registry, and compilation

### 12.6.1 Prompt as a typed program

A prompt revision contains:

- typed variable schema with classification and maximum size;
- a template AST, not executable string interpolation;
- ordered sections with role and trust (`platform`, `developer`, `tenant_trusted`, `retrieved_untrusted`, `user_untrusted`, `tool_untrusted`);
- required context sources and citations;
- tool contract digests;
- output JSON Schema and parser revision;
- supported adapter capabilities;
- token estimate fixtures and golden compilation tests;
- evaluation suite/thresholds and owner.

```yaml
apiVersion: ege.dev/v1
kind: PromptTemplateRevision
metadata:
  id: ticket-triage
  revision: 0197f3c2-8700-7777-99ff-0e6100000015
  digest: sha256:0af...
spec:
  variables:
    type: object
    additionalProperties: false
    required: [ticket, evidence]
    properties:
      ticket: {type: string, maxLength: 20000, x-ege-trust: user_untrusted}
      evidence:
        type: array
        maxItems: 20
        items: {$ref: "ege://schemas/evidence-fragment-v1"}
  sections:
    - {role: developer, literal: "Classify the ticket using only the supplied evidence."}
    - {role: user, variable: ticket, encoding: quoted_text}
    - {role: user, variable: evidence, encoding: cited_evidence_blocks}
  responseSchema: "ege://schemas/ticket-triage-v3"
  missingVariable: error
  tests:
    - evalSuite: ticket-triage-release-v8
```

Compilation resolves an immutable prompt digest plus adapter revision into the provider representation. It rejects missing variables, wrong trust encoders, unsupported roles/tools/schema mode, token overflow, or disallowed classification. Rendered prompt content is not logged; its digest, template revision, variable hashes/sizes, and token count are.

### 12.6.2 Prompt promotion

Draft -> lint/compile -> injection/security fixtures -> offline eval -> cost/latency simulation -> reviewer approval -> shadow -> canary -> production alias. A prompt-only change is still executable behavior and cannot bypass GraphVersion release policy.

## 12.7 Context engineering and context compression

### 12.7.1 Context assembly plan

Context assembly is a deterministic plan around nondeterministic sources:

```text
model input limit
  - reserved output
  - system/developer/tool/schema overhead
  - safety margin
  = allocatable context budget

allocatable budget -> mandatory recent state
                   -> high-priority retrieved evidence
                   -> memory
                   -> conversation/history
                   -> optional enrichments
```

```json
{
  "context_plan_revision": "sha256:6de...",
  "model_tokenizer": "provider-a:model-a-2026-07",
  "max_input_tokens": 50000,
  "reserved_output_tokens": 3000,
  "safety_margin_tokens": 1000,
  "allocations": [
    {"source": "instructions", "min": 1200, "max": 2000, "priority": 100, "overflow": "error"},
    {"source": "current_state", "min": 500, "max": 4000, "priority": 95, "overflow": "schema_prune"},
    {"source": "retrieval", "min": 2000, "max": 24000, "priority": 80, "overflow": "diverse_top_k"},
    {"source": "memory", "min": 0, "max": 6000, "priority": 60, "overflow": "summarize"},
    {"source": "history", "min": 0, "max": 9000, "priority": 40, "overflow": "hierarchical_summary"}
  ]
}
```

Tokenization uses the selected model adapter's tokenizer when available and a conservative upper bound otherwise. Context is rechecked after routing because candidate tokenizers and limits differ.

### 12.7.2 Compression methods

Apply methods from least semantic risk to greatest:

1. remove exact duplicates by content digest;
2. strip markup/navigation and keep source offsets;
3. select required fields from typed state;
4. group adjacent chunks and apply diversity/novelty selection;
5. extract sentences/spans with source anchors;
6. generate a schema-constrained summary with citations;
7. hierarchical history summary with a retained delta since summary.

A generated summary never replaces canonical source. It is a derived artifact containing source digests, prompt/model/adapter revisions, generation time, classification, expiry, supported claims/citations, and evaluator result. If sources change or access is revoked, the summary becomes stale and is not served. Critical numbers, dates, identifiers, negation, approval state, and policy text use extractive/typed preservation rules rather than unconstrained summarization.

### 12.7.3 Context provenance

Every fragment retains:

```text
fragment_id, tenant_id, source_resource_id/version, source offsets,
content digest, trust, classification, ACL/authorization epoch,
retrieval query/rank/score, transformation chain, expiry, citation label
```

The model-facing citation label maps back to this provenance. A citation proves what source was supplied, not that the model's claim is correct.

## 12.8 Memory management

### 12.8.1 Memory types

| Type | Scope/lifetime | Canonical representation | Example |
|---|---|---|---|
| working memory | node/execution; until terminal + retention | execution state/checkpoint | current plan and tool results |
| episodic memory | actor/project; policy TTL | typed event with provenance | resolved incident summary |
| semantic memory | tenant knowledge; versioned | source record/fact with evidence | account uses JPY billing |
| procedural memory | graph/agent; release controlled | prompt/tool/graph artifact | approved support procedure |
| preference memory | subject; consent/TTL | schema-bound preference | preferred response language |

Model weights are not platform memory. Provider conversation IDs are external references and cannot be the only canonical state.

### 12.8.2 Memory write lifecycle

```text
candidate fact from user/model/tool
   -> schema + provenance + classification
   -> authorization/consent/purpose/TTL
   -> contradiction and poisoning checks
   -> confidence/evidence threshold
   -> optional human review
   -> canonical PostgreSQL SourceRecord/MemoryRecord commit + outbox
   -> vector/graph/search projections
```

```json
{
  "memory_id": "0197f3c2-8800-7888-aa10-1f7200000016",
  "tenant_id": "0197f3c2-5000-7555-8066-75d890000005",
  "namespace": "project:support/customer-preferences",
  "subject_ref": "customer:8c2...",
  "schema": "ege://schemas/language-preference-v1",
  "value": {"language": "ja-JP"},
  "valid_time": {"from": "2026-08-06T00:00:00Z", "to": null},
  "system_time": {"recorded_at": "2026-08-06T12:00:00Z", "superseded_at": null},
  "provenance": [{"source_type": "user_assertion", "source_id": "0197f3c2-8900-7999-bb21-208300000017", "digest": "sha256:..."}],
  "confidence": 1.0,
  "classification": "CONFIDENTIAL",
  "purpose": "support_response_localization",
  "retention_until": "2027-08-06T00:00:00Z",
  "policy_revision": "sha256:..."
}
```

Updates preserve prior system-time versions. Contradictions coexist until a versioned resolution rule or reviewer decides; last-write-wins is not valid for facts merely because it is easy. Deletes emit tombstones to every projection and maintain legally permitted minimal proof.

### 12.8.3 Memory read controls

Memory retrieval binds principal/execution, purpose, subject, namespace, classification, environment, valid time, system time, and authorization epoch. The runtime limits memories by relevance and necessity; it does not inject an entire user profile. Sensitive memory use is visible in execution provenance.

## 12.9 Embedding pipelines

An `EmbeddingProfile` pins provider/model revision, dimensions, distance function, normalization, tokenizer, maximum input, data policy, and adapter. A `ChunkProfile` pins parser, structural boundaries, target/overlap tokens, metadata extraction, and language rules.

```text
SourceRecord version commit
 -> outbox `source.changed`
 -> parse to normalized document (versioned parser)
 -> classify + ACL snapshot
 -> chunk with stable chunk IDs/source offsets
 -> content digest dedupe
 -> policy-compatible embedding route
 -> batch/embed with idempotency key
 -> canonical embedding manifest + encrypted vector artifact if retained
 -> upsert projection (tenant, source version, ACL epoch, profile digest)
 -> verify count/checksum -> advance projection cursor
```

Chunk ID is derived from source version, chunk profile, offsets, and normalized content digest. An embedding change writes a parallel index generation; reads shift only after backfill, quality eval, ACL verification, and canary. Blue/green generations allow rollback.

Failures go to a projection DLQ with source version and retry class. They do not roll back the canonical source. Deletion and access revocation are high-priority tombstones; stale projections must be query-denied by authorization epoch even before physical removal.

## 12.10 Retrieval and reranking

### 12.10.1 Pipeline stages

1. Parse the information need into a typed query plan; do not let the model choose arbitrary indexes or tenant filters.
2. Resolve principal/execution and purpose to an authoritative candidate ACL predicate.
3. Rewrite/decompose query within bounded variants; retain original and generated-query provenance.
4. Retrieve in parallel from keyword, vector, structured SQL, and optional knowledge-graph projections.
5. Apply source-side tenant/ACL filters and minimum projection authorization epoch.
6. Fuse ranks using a versioned method such as reciprocal-rank fusion; raw scores from different systems are not directly comparable.
7. Deduplicate by canonical source/version and enforce source/domain diversity.
8. Rerank only authorized candidates using a policy-compatible model; cap candidates/tokens/time.
9. Verify current authorization and source version against canonical metadata.
10. Apply relevance/quality threshold, context budget, and citation packing.
11. Return an `EvidenceBundle`, not anonymous text.

```yaml
apiVersion: ege.dev/v1
kind: RetrievalPipelineRevision
metadata: {id: support-rag, digest: "sha256:7ca..."}
spec:
  sources:
    - {type: keyword, index: support-docs-v4, topK: 50}
    - {type: vector, index: support-embed-v8, topK: 50, efSearch: 128}
    - {type: graph, projection: product-relations-v3, maxHops: 2, topK: 20}
  acl: {mode: prefilter_and_recheck, maxProjectionLag: 30s}
  fusion: {method: reciprocal_rank_fusion, k: 60}
  reranker: {profile: support-reranker-v2, candidates: 40, topK: 12}
  quality: {minimumScore: 0.62, minDistinctSources: 2}
  context: {maxTokens: 18000, perSourceMaxTokens: 5000}
  citations: {required: true, sourceOffsets: true}
```

### 12.10.2 Retrieval correctness

Evaluation covers recall@k against labeled evidence, nDCG/MRR, answer-support/grounding, citation precision, access-filter correctness, freshness lag, duplicate rate, diversity, latency, cost, and “no answer” precision. Security tests verify unauthorized records do not affect results through content, count, rank, timing beyond accepted leakage budgets, cache, or citation metadata.

## 12.11 Tool calling and structured output

### 12.11.1 Tool-call state machine

```text
MODEL_PROPOSED
   -> PARSED -> SCHEMA_VALIDATED -> POLICY_EVALUATED
       | invalid        | deny          | approval
       v                v               v
   REPAIR_BOUNDED     DENIED       WAITING_APPROVAL
                                           |
                              args digest still matches
                                           v
                                  GATEWAY_GRANT_BOUND
                                           v
                                     TOOL_DISPATCHED
                                      /          \
                               RESULT_VALIDATED  FAILED
                                      |
                               MODEL_CONTINUATION
```

The tool name must match a structured `CapabilityRequirement { action, resource, constraints }` narrowed into the attempt's proof-of-possession/mTLS-bound `ExecutionGrant`. `WorkerSupervisor` may present that grant only to `WorkerGateway`; the model and sandbox receive only an opaque capability handle, never the grant or credentials. After validating the supervisor RPC, `WorkerGateway` sends a schema-bounded request to the tool proxy, which supplies destination, method, headers, credential, timeout, and idempotency key from the signed tool manifest. A model cannot call the secret broker, policy engine, scheduler, database, NATS, or raw network.

Parallel tool calls are allowed only if their declared effect classes commute or ordering is irrelevant. The only classes are `PURE`, `READ_ONLY`, `IDEMPOTENT_WRITE`, `COMPENSATABLE_WRITE`, `NON_IDEMPOTENT_WRITE`, and `HUMAN_EFFECT`; determinism is declared separately as `PURE`, `RECORDED_NONDETERMINISTIC`, or `EFFECTFUL`. `NON_IDEMPOTENT_WRITE` and `HUMAN_EFFECT` default to serialization and approval, while compensation never implies rollback. Tool results carry trust/classification and are untrusted context on continuation.

### 12.11.2 Structured output

The output contract is a pinned JSON Schema subset with deterministic limits: maximum depth, properties, array length, string length, numeric bounds, and `additionalProperties: false` unless explicitly required. The decoder consumes provider-native strict-schema output where supported, but validates again locally.

Repair sequence:

1. deterministic parse/normalization allowed by the schema contract (e.g., remove an explicitly permitted wrapper);
2. one local validation report with no sensitive content;
3. bounded model repair using original output as quoted untrusted data;
4. fail with `OUTPUT_SCHEMA_INVALID` after configured attempts.

Never use regex to parse security-sensitive model output. Never accept a partial object and fill missing effect parameters with dangerous defaults.

## 12.12 Agent collaboration and agent swarms

### 12.12.1 Agent model

An agent is a bounded subgraph composed from existing node/runtime primitives. An `AgentRole` declares objective schema, context policy, model profile, structured capability requirements, output schema, evaluator, and limits. “Autonomy” does not bypass Graph IR.

```yaml
apiVersion: ege.dev/v1
kind: AgentTeamRevision
metadata: {id: incident-analysis, digest: "sha256:a01..."}
spec:
  coordinator: {role: incident-lead, strategy: planner_worker_critic}
  roles:
    - id: telemetry-researcher
      maxInstances: 3
      capabilityRequirements:
        - action: telemetry.read
          resource: {kind: telemetry_view, id: incident-scoped}
          constraints: {timeWindowMax: PT2H, payloads: false}
    - id: change-reviewer
      maxInstances: 1
      capabilityRequirements:
        - action: repository.read
          resource: {kind: repository, id: current-project}
          constraints: {refs: [pinned_revision], write: false}
    - {id: critic, maxInstances: 2, capabilityRequirements: []}
  communication:
    schema: "ege://schemas/agent-message-v2"
    maxMessages: 60
    maxBytes: 500000
    sharedState: append_only_blackboard
  limits:
    maxAgents: 6
    maxDepth: 2
    maxIterations: 8
    deadline: 5m
    tokenBudget: 180000
    costMicros: 3000000
  terminal:
    evaluator: incident-report-v5
    minimumScore: 0.82
    noImprovementIterations: 2
```

### 12.12.2 Collaboration patterns

| Pattern | Use | Control |
|---|---|---|
| planner-worker | decomposable tasks | typed plan; scheduler validates each task |
| map-reduce | independent evidence sets | bounded fan-out; deterministic merge contract |
| debate/critic | reduce single-response errors | independent context/routes where useful; evaluator chooses |
| specialist handoff | domain-specific tools/data | capability changes only at explicit subgraph boundary |
| blackboard | incremental shared findings | append-only typed claims with provenance/conflict status |
| auction/router | select best specialist | deterministic candidate constraints and budget |

Agent-to-agent messages are untrusted input, schema validated, sized, classified, and attributed. An agent cannot delegate authority it does not possess; a child capability is the intersection of parent authority, role manifest, node policy, and current context. “Swarm” means dynamically expanded bounded activations, not an untracked process mesh.

### 12.12.3 Convergence and failure

The coordinator terminates on accepted output, no-improvement threshold, hard limit, deadline/cost, cancellation, or an unrecoverable dependency/policy failure. Agent crashes retry under node semantics. Conflicting claims remain explicit; majority vote is not truth. A synthesizer must cite evidence and report unresolved disagreement.

## 12.13 Reflection, self critique, planning, and reasoning

### 12.13.1 Reflection/critic loop

```text
candidate artifact
   -> deterministic checks
   -> independent evaluator(s): rubric scores + cited defects
   -> controller compares score/confidence/cost/iteration
   -> accept | targeted repair | escalate | fail
```

The generator never decides its own acceptance alone. Evaluators have versioned rubrics and calibrated thresholds. For high-stakes output, combine deterministic validators, evidence checks, and a model judge whose known bias/variance is measured on human-labeled data.

Store:

- candidate digest and user-visible output;
- evaluator scores, defect codes, citations, and revision;
- concise repair instruction and changed artifact digest;
- termination reason and budget counters.

Do not store private chain-of-thought. If an application needs an explanation, request a concise rationale/evidence object designed for user review; treat it as another potentially incorrect output.

### 12.13.2 Planning

A plan is typed data, for example:

```json
{
  "goal": "resolve_incident",
  "steps": [
    {"id": "s1", "action": "query_metrics", "depends_on": [], "args": {"window": "30m"}},
    {"id": "s2", "action": "inspect_deployments", "depends_on": [], "args": {}},
    {"id": "s3", "action": "synthesize", "depends_on": ["s1", "s2"], "args": {}}
  ],
  "success": {"schema": "ege://schemas/incident-report-v3"}
}
```

The plan validator checks allowed action kinds, dependency acyclicity (or declared bounded loop), schemas, authority, data flow, maximum expansion, resources, deadline, cost, and side effects. Valid plans compile to a dynamic subgraph expansion with a digest and parent execution provenance. Planning output is never directly interpreted as code.

## 12.14 Evaluation platform

### 12.14.1 Evaluation layers

| Layer | Trigger | Evidence |
|---|---|---|
| component | prompt/model/retriever/tool adapter revision | focused fixtures, schema/security tests |
| graph | candidate GraphVersion | end-to-end golden/simulation cases |
| release | deployment promotion | full suite, slices, cost/latency, red-team, regression bounds |
| online shadow | production input copy under policy | paired outputs, no side effects |
| canary | small authorized traffic cohort | live task metrics and guardrails |
| continuous | scheduled/drift signal | quality, safety, route, retrieval, cost drift |

### 12.14.2 Dataset governance

An `EvalDatasetSnapshot` is immutable and records item IDs, content/object digests, schema, provenance, consent/license, classifications, residency, de-identification, split, slice labels, and retention. Production samples enter a quarantine/review pipeline; they are not silently copied into eval/training data. Test/train contamination checks compare exact and semantic similarity against prompts, examples, and tuning data where available.

### 12.14.3 Evaluator types

- deterministic: JSON/schema, exact/normalized match, compilation, policy, citation existence, SQL/result comparison;
- executable: unit tests, sandboxed code tests, simulation, effect journal assertions;
- statistical: latency/cost/token/retry distributions, calibration, confidence intervals;
- retrieval: recall/nDCG/MRR, grounding/citation, access/freshness;
- model judge: rubric-constrained structured score plus cited defects;
- human: blinded pairwise preference, domain review, risk acceptance;
- adversarial: prompt injection, exfiltration, unsafe tool use, bias/safety policy.

Model judges are calibrated against human labels by slice; self-judging is flagged. Judge model/prompt revisions are pinned, and raw judge variance is retained. Aggregate improvements cannot hide a regression in a protected/high-risk slice.

### 12.14.4 Release gate example

```yaml
apiVersion: ege.dev/v1
kind: EvalGate
metadata: {id: support-release-v8}
spec:
  baseline: deployment:prod/support@current
  dataset: eval-dataset://support-v12@sha256:92c...
  repetitions: 3
  thresholds:
    schemaValidity: {min: 0.999}
    taskSuccess: {nonInferiority: -0.005, confidence: 0.95}
    groundedClaims: {min: 0.97}
    unsafeToolInvocation: {max: 0}
    promptInjectionSuccess: {max: 0}
    p95LatencyRegression: {maxPercent: 10}
    meanCostRegression: {maxPercent: 5}
  slices:
    - {name: japanese, taskSuccess: {nonInferiority: -0.01}}
    - {name: high_risk_accounts, unsafeToolInvocation: {max: 0}}
  requiredApprovals: [graph_owner, security_for_effect_changes]
```

Threshold direction and statistical test are explicit. A release report contains sample size, confidence interval, failures, slices, evaluator revisions, route distributions, and cost/latency—not only one score.

## 12.15 AI-assisted graph engineering

All automatic features operate on the typed Graph IR and produce `OptimizationProposal` artifacts.

### 12.15.1 Automatic node suggestions

Inputs: cursor/selected nodes, port schemas, unresolved compiler diagnostic, catalog of permitted nodes/plugins/tools, environment policy, and optionally anonymized patterns from the same tenant. Output:

```json
{
  "proposal_type": "insert_node",
  "base_graph_version_id": "0197f3c2-6a00-7b22-9d33-42a560000002",
  "base_compiled_plan_id": "0197f3c2-6a00-7b22-9d33-42a560000003",
  "base_plan_hash": "sha256:4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f",
  "operations": [
    {"op": "add_node", "temp_id": "n-new", "node_type": "OutputValidation", "config_revision": "sha256:..."},
    {"op": "replace_edge", "edge_id": "e-7", "via": "n-new"}
  ],
  "rationale": "Output schema is declared but not enforced before the effectful node.",
  "evidence": [{"type": "compiler_diagnostic", "id": "UNVALIDATED_EFFECT_INPUT"}],
  "predicted_impact": {"latency_ms": 2, "cost_micros": 0},
  "required_gates": ["compile", "security", "graph_tests"]
}
```

Suggested catalog entries are filtered by tenant install, signature, compatibility, license, data classification, and permissions before the model sees them. Suggestions never install plugins or grant tools.

### 12.15.2 Automatic graph generation

1. Convert natural-language intent into a typed `GraphIntent`: inputs/outputs, invariants, SLAs, data classes, integrations, effects, approval points, budgets, failure semantics.
2. Ask targeted clarification only for materially ambiguous authority/effects/data; otherwise use explicitly displayed safe defaults.
3. Retrieve allowed templates/nodes/tools and their schemas.
4. Produce Graph IR candidate, not arbitrary source code.
5. Run compiler/type/effect/loop/budget/policy/static security analysis.
6. Generate tests, mocks, and assumptions with traceability to intent.
7. Execute with `execution_mode=SIMULATION`, using recorded/mocked dependencies and `effect_mode=FORBID` for production effects, then run evaluation/red-team suites.
8. Present the visual graph, diff, unresolved decisions, costs, and gates. A human publishes/deploys according to environment policy.

### 12.15.3 Automatic graph refactoring

Supported typed transformations include extract/inline subgraph, replace deprecated node, consolidate duplicated nodes whose effect class and determinism are both `PURE`, add validation/timeout/retry/circuit breaker, make implicit state dependency explicit, split oversized prompt/context, and migrate schema/adapter versions.

Each refactor declares semantic assumptions and proof obligation:

| Transformation | Required evidence |
|---|---|
| parallelize A and B | no data/effect/order dependency; race tests |
| cache node N | effect class `PURE`, or explicitly cacheable `READ_ONLY`; determinism, cache key, inputs, policy, versions, TTL, and freshness all covered |
| merge model calls | compatible trust/context/tools/output; quality eval |
| move filter before retrieval/rerank | equivalent predicate and no authorization weakening |
| replace model | capability/data-policy parity; non-inferiority eval |
| increase batch size | deadline/memory/provider limits; tenant isolation |
| remove “redundant” validation | prohibited unless downstream contract proves equivalent enforcement |

### 12.15.4 Automatic performance optimization

The optimizer consumes activation graphs, critical paths, queue/provider spans, token/cost ledger, cache statistics, failures, and graph semantics. It identifies:

- avoidable serialization and safe parallelism;
- fan-out concurrency that exceeds the useful provider/database budget;
- repeated `PURE` computations and policy-approved `READ_ONLY` cache candidates;
- over-retrieval, context duplication, excessive output bounds;
- route profiles with poor cost/quality/latency frontier;
- retry amplification and timeouts that cannot succeed within deadlines;
- checkpoint granularity/size problems;
- cold-start/sandbox-pool affinity;
- subgraphs suitable for batching or precomputation.

Predictions include uncertainty and required experiments. The optimizer may automatically apply a change only in an ephemeral branch/simulation environment. Production changes require the same gate as human changes.

### 12.15.5 Proposal state machine

```text
DRAFT -> COMPILED -> STATICALLY_SAFE -> EVALUATED -> APPROVED
  |          |             |               |           |
  +--------> REJECTED <----+---------------+-----------+
                                                    |
                                                    v
                                            CANARY -> PROMOTED
                                                \-> ROLLED_BACK
```

An AI proposal cannot approve itself. For effect, authority, data-residency, plugin, or secret-scope changes, security/owner approval is mandatory even if evaluations improve.

## 12.16 Graph optimization engine implementation

The optimizer works over typed Graph IR plus observed activation statistics.

```rust
struct OptimizationProposal {
    proposal_id: UuidV7,
    tenant_id: TenantId,
    base_graph_version_id: GraphVersionId,
    base_compiled_plan_id: CompiledPlanId,
    base_plan_hash: Digest,
    operations: Vec<GraphPatchOp>,
    preconditions: Vec<SemanticPredicate>,
    predicted: ImpactDistribution,
    evidence: Vec<EvidenceRef>,
    risks: Vec<Risk>,
    required_gates: Vec<Gate>,
    generator: ArtifactRevision,
}

fn propose(ir: &GraphIr, profile: &ActivationProfile) -> Vec<OptimizationProposal> {
    static_rules(ir)
        .chain(critical_path_rules(ir, profile))
        .chain(cost_rules(ir, profile))
        .filter_map(|candidate| prove_preconditions_or_mark_manual(candidate, ir))
        .map(estimate_impact_with_uncertainty)
        .collect()
}
```

Static rules are deterministic and preferred. A model may explain or rank candidates and synthesize missing test fixtures, but it cannot label an unproven transformation equivalent. The engine retains before/after activation profiles and automatically rolls back a canary on guardrail breach.

## 12.17 APIs and event contracts

### 12.17.1 Resolve a model route

```http
POST /v1/model-routes:resolve
Idempotency-Key: 0197f3c2-8a00-7aaa-8c32-319400000018
Content-Type: application/json

{
  "executionId": "0197f3c2-7b10-7a11-8c22-31f450000001",
  "activationId": "sha256:4a1...",
  "modelProfileRevision": "sha256:3fe...",
  "requirements": {
    "inputTokens": 18400,
    "maxOutputTokens": 2000,
    "tools": true,
    "structuredOutput": "sha256:5a2...",
    "classification": "CONFIDENTIAL",
    "residency": "JP",
    "deadlineAt": "2026-08-06T12:35:00Z"
  },
  "remainingBudgetMicros": 180000
}
```

Response contains `routeDecisionId`, selected provider connection/model/adapter revisions, reservation ID, price version, exclusions summarized by reason, and expiry. It never contains provider credentials.

### 12.17.2 AI invocation provenance event

```json
{
  "specversion": "1.0",
  "type": "dev.ege.ai.model_invocation.completed.v1",
  "source": "ege://cell/apne1-03/model-gateway",
  "id": "0197f3c2-8b00-7bbb-9d43-42a500000019",
  "time": "2026-08-06T12:34:56.123Z",
  "subject": "executions/0197f3c2-7b10-7a11-8c22-31f450000001/activations/sha256:4a1.../attempts/0197f3c2-8300-7333-95bb-ca2de0000011",
  "data": {
    "tenantId": "0197f3c2-5000-7555-8066-75d890000005",
    "routeDecisionId": "0197f3c2-8c00-7ccc-ae54-53b600000020",
    "modelProfileRevision": "sha256:3fe...",
    "providerConnectionRevision": "sha256:70a...",
    "providerModel": "model-a-2026-07",
    "adapterRevision": "sha256:11a...",
    "promptRevision": "sha256:0af...",
    "contextManifestDigest": "sha256:1d8...",
    "responseSchemaDigest": "sha256:5a2...",
    "providerRequestIdHash": "hmac:v1:...",
    "usage": {"inputTokens": 18400, "cachedInputTokens": 9000, "outputTokens": 882},
    "finishReason": "stop",
    "outputArtifactDigest": "sha256:81f...",
    "validation": {"status": "valid", "repairAttempts": 0}
  }
}
```

Sensitive contents are referenced through authorized encrypted artifacts, not placed on the event bus.

## 12.18 Observability and SLOs

Required dimensions are bounded provider, model family, route profile, adapter revision cohort, operation, environment, outcome, and failure class. Per-execution IDs belong in traces/events, not metrics labels.

Metrics include route exclusions/selections, breaker state, provider requests/latency/first-token/tokens/cost, fallback/hedge/cancellation, output validation/repair, context tokens by source, compression ratio/staleness, memory candidate/accept/reject/conflict, embedding backlog/lag/failure, retrieval latency/recall proxies/zero-result/ACL recheck denial, tool proposal/denial/approval/effect, agent expansion/messages/convergence, evaluator score/drift, and proposal gate/canary outcomes.

Initial objectives:

| SLI | Target |
|---|---:|
| Route decisions satisfying all recorded hard constraints | 100% |
| Model invocations with complete route/provenance/usage record | >= 99.99% within 15 min; 100% reconciled |
| Structured output accepted without local schema validation | 0% |
| Tool effects without a gateway-validated PoP/mTLS-bound `ExecutionGrant` + policy decision | 0 |
| Retrieval results failing final canonical authorization | 0 released; any candidate failure is security alert |
| Source-to-embedding projection lag | p99 <= 5 min normal load; explicit stale denial by policy |
| Production AI revision with passing required EvalGate | 100% |
| Auto-generated/refactored production graph without human/policy gate | 0 |

Task quality, latency, and cost SLOs are graph/profile specific and defined in EvalGate/deployment policy.

## 12.19 Failure handling and runbooks

### 12.19.1 Model provider degradation

1. Slice failures by provider connection, model revision, region, operation, response mode, and tenant credential; exclude client/schema failures.
2. Confirm breaker and capacity reservation behavior; stop exploration/hedging first.
3. Verify fallbacks meet data/capability/deadline/cost constraints. Do not add an emergency provider outside registry/policy.
4. Pin/route affected profiles to a tested candidate through a signed registry revision and canary.
5. Reconcile ambiguous/partial requests and usage; avoid duplicate effects or mixed streams.

### 12.19.2 Retrieval quality or freshness regression

1. Compare source commit cursor, parser/chunk/embed projection cursors, tombstone lag, and ACL epoch.
2. Sample failures by language/source/type and compare exact keyword, vector, fusion, and reranker stages.
3. If access correctness is uncertain, disable the projection and fall back only to an authorized source, even at lower quality.
4. Rebuild a blue/green generation from canonical records; validate counts, digests, ACL filters, and eval suite before shift.

### 12.19.3 Memory poisoning indication

1. Suspend reads/writes for the affected namespace or source class without deleting evidence.
2. Identify candidate provenance, writer capability/policy, downstream reads, and projection generations.
3. Mark records disputed/quarantined in canonical state and emit high-priority tombstones/updates.
4. Re-evaluate affected outputs if required; restore only after policy/evaluator fixes and review.

### 12.19.4 Evaluation drift

1. Confirm dataset/evaluator/model-route revisions and sample sizes; separate judge drift from candidate drift.
2. Run deterministic and human-calibrated checks on failing slices.
3. Freeze promotion and exploration for the affected profile; retain current production revision.
4. Update evaluator only as a new revision with back-comparison; never rewrite historical scores.

### 12.19.5 Agent explosion

1. Cancel expansion at the scheduler and preserve completed state/effects.
2. Inspect plan digest, expansion counters, duplicate-task keys, convergence/no-improvement state, and coordinator messages.
3. Do not simply raise `maxAgents`/iterations. Fix the plan validator, deduplication, or stopping rule and run `operation=FORKED_REPLAY` with `execution_mode=SIMULATION` and production adapter `effect_mode=FORBID`.

## 12.20 Verification strategy

- Adapter contract suites against recorded and live sandbox accounts for every provider/model mode.
- Property tests proving routing never violates hard constraints under random health, price, budget, and policy states.
- Fallback tests for partial streams, ambiguous timeouts, tool-call responses, cancellation races, and depleted budgets.
- Prompt compiler golden tests across providers and tokenizer boundary cases.
- Context tests preserving critical facts/negation/numbers/citations under compression and source revocation.
- Memory temporal/conflict/deletion/poisoning tests and projection rebuilds.
- Retrieval two-tenant tests, stale ACL epochs, tombstones, empty filters, timing/cache isolation, and blue/green index changes.
- Tool-call fuzzing and effect-journal/idempotency tests.
- Agent property tests for authority intersection, bounded expansion, cancellation, message limits, and convergence.
- Eval system tests for slice regressions, judge calibration, confidence intervals, data leakage, and historical reproducibility.
- Optimizer metamorphic tests proving rejected dependency/effect changes and canary rollback on guardrails.

## 12.21 Anti-patterns

- **Hard-coded model name in every graph:** prevents governed routing and safe migration.
- **Cheapest/fastest model wins before policy filters:** turns optimization into a data-governance violation.
- **Fallback after streaming output or ambiguous effect:** corrupts semantics or duplicates work.
- **One generic provider request map:** allows unreviewed features and adapter drift into production.
- **String-concatenated prompts:** loses typing, trust separation, escaping, and provenance.
- **“Summarize until it fits”:** can erase negation, limits, approvals, and citations.
- **Store the transcript as memory:** creates unbounded, contradictory, privacy-hostile state.
- **Vector database as canonical knowledge:** index/model changes then destroy historical truth.
- **ACL after top-k only:** both leaks ranking information and harms authorized recall.
- **Let the model choose tools/endpoints/credentials:** grants authority to untrusted output.
- **Parse JSON with regex or accept partial effects:** unsafe and nondeterministic.
- **Agent swarm with a shared super-token:** one compromised agent owns every tool and datum.
- **Majority vote equals truth:** correlated models can agree on the same error.
- **Persist chain-of-thought for debugging:** creates sensitive, unreliable data without operational necessity.
- **LLM judge as the only release gate:** hides evaluator bias and self-preference.
- **Auto-apply “obvious” production optimizations:** performance transformations can change ordering, effects, quality, and authority.
- **Average benchmark score:** masks high-risk slice regressions and statistical uncertainty.
