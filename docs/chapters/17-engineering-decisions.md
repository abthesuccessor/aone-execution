# 17. Engineering Decision Record

This chapter is the decision ledger for the reference architecture. “Accepted” means the implementation must follow the decision unless a superseding Architecture Decision Record (ADR) is reviewed and linked. “Conditional” means the capability has an explicit adoption threshold and is not part of the default critical path. The decisions are intentionally opinionated: combining contradictory alternatives at runtime is not flexibility; it is unbounded failure and operational complexity.

## 17.1 Decision principles

Architecture changes are evaluated in this order:

1. execution correctness and effect safety;
2. tenant isolation, authorization, and data governance;
3. recoverability and auditability;
4. predictable latency/cost and horizontal scaling;
5. developer/operator usability;
6. feature breadth and local optimization.

No benchmark overrides an invariant. A faster queue does not own work; a better vector score does not authorize a record; a successful LLM response does not grant a tool; a cache hit does not prove state.

## 17.2 Decision dependency map

```text
ADR-001 Typed immutable CompiledPlan
  +-> ADR-002 Custom deterministic runtime
  |     +-> ADR-003 Event journal + materialized state
  |     +-> ADR-005 At-least-once + idempotency/fencing
  |     |     +-> ADR-006 JetStream hints + DB claims
  |     |     +-> ADR-009 Replay + effect journal
  |     +-> ADR-008 Checkpoints + object indirection
  |     +-> ADR-010 Bounded dynamic expansion
  +-> ADR-020 Visual/code/DSL surfaces compile to one IR
  +-> ADR-021 CRDT draft separated from publication
  +-> ADR-022 Signed plugin/node contract
  +-> ADR-035 Proposal-only AI graph changes

ADR-004 PostgreSQL canonical + cells
  +-> ADR-007 Transactional outbox
  +-> ADR-012 Home-cell single writer + DR tiers
  +-> ADR-014 Non-authoritative cache
  +-> ADR-015/016 Rebuildable analytics/search/vector/graph projections
  +-> ADR-029 Tenant isolation in every plane

ADR-024 Human/workload identity
  +-> ADR-025 RBAC+ABAC policy
        +-> ADR-026 Gateway-minted and validated attempt capabilities
              +-> ADR-027 Just-in-time secrets
              +-> ADR-028 Sandbox + controlled egress
              +-> ADR-032 Governed model tool calls

ADR-030 Model registry/routing
  +-> ADR-031 Governed context/memory/retrieval
  +-> ADR-033 Agents compile to subgraphs
  +-> ADR-034 Evaluation gates
  +-> ADR-035 Generated/refactored graphs are proposals
```

## 17.3 Master ADR matrix

The matrix records the required dimensions for every major decision: rationale, alternatives, trade-offs, performance, scalability, failure behavior, and operational complexity.

### 17.3.1 Graph and runtime decisions

| ADR / status | Decision and why | Alternatives considered | Trade-offs | Performance implications | Scalability implications | Failure modes and required response | Operational complexity |
|---|---|---|---|---|---|---|---|
| **ADR-001 Accepted** | Compile visual/code/YAML `GraphVersion` sources into one typed, normalized, immutable, content-addressed `CompiledPlan`. Admission pins its `compiled_plan_id`/`plan_hash` together with an immutable `PolicySnapshot`; one executable meaning prevents editor/runtime/policy drift and stabilizes diffs, signatures, tests, and replay. | Execute editor JSON directly; interpret YAML dynamically; code-only graphs; resolve policy aliases during execution. | Compiler/migration and snapshot lifecycle work in exchange for early errors and reproducibility. | Compilation/admission adds latency but removes repeated runtime validation; cache plans and policy snapshots by digest. | Immutable plans/snapshots distribute and read-cache without coordination. | Compiler bug or wrong snapshot could affect many graphs; use golden/property/differential tests, versioned readers, canary, and retain source + exact plan/policy hashes. | Own schemas, compiler, policy-snapshot builder, compatibility/upcasters, inspection, and deprecation policy. |
| **ADR-002 Accepted** | Build a graph-specific deterministic execution engine/state machine over the execution-pinned `CompiledPlan` and `PolicySnapshot`, rather than place a general workflow library at the core. Required for typed ports/state, dynamic expansion, graph debugging, AI loops, effect journal, and visual activation semantics. | Temporal; Cadence; Airflow/Prefect; LangGraph; durable functions; Kubernetes Jobs only. | Largest engineering investment; gains exact product semantics and avoids forcing graph behavior through another engine's abstractions. | Optimized ready-node scheduling and incremental checkpoints; must engineer hot-path DB/query efficiency. | Shard by cell/scheduler partition/worker pool; millions of dormant runs cost database rows, not resident processes. | State-machine bug, wrong plan/policy pin, stuck lease, incompatible revision; event invariants, pin validation, reconciliation, replay verification, and kill switches. | High: scheduler, recovery, timers, retries, cancellation, upgrades, DLQ, replay, plan/policy compatibility, and on-call ownership. A managed workflow engine remains an adapter option for customer integration, not authority. |
| **ADR-003 Accepted** | Persist an append-only `execution_event` journal plus transactional current-state/materialized tables. The journal explains transitions; current tables make scheduling efficient. | Event sourcing only; mutable rows only; full snapshot per transition. | Dual representations require invariants/projection checks; avoids replaying entire history for every claim and avoids unexplained mutation. | One transaction writes state/event/outbox; extra write amplification is bounded. Reads are fast by purpose. | Partition/archive events by time/cell/tenant bucket; current work stays small/indexed. | Event/state mismatch only if transaction/invariant is bypassed; periodic checksum/rebuild tests and fail hard on sequence gaps. | Schema evolution, archival, event upcasters, projection verification, and retention tooling. |
| **ADR-004 Accepted** | PostgreSQL is canonical and is deployed per execution cell; object storage holds large immutable bodies referenced by digest. Transactions fit leases, state, outbox, idempotency, cost, and audit invariants. | Global Spanner/Cockroach/Yugabyte; DynamoDB/Cassandra; MongoDB; Redis; graph DB. | Vertical/partition/connection tuning and cell routing versus simpler cross-record correctness and mature recovery. | Strong local transactions; keep payloads out of hot rows, use checked SQL/partitions/pools, never hold transactions over network calls. | Scale by cells and table partitions before database replacement; large tenants can get dedicated cells/clusters. | Primary/AZ/region outage, hot tenant/partition, locks, connection exhaustion; admission backpressure, failover, PITR, home-cell DR. | Moderate/high but well understood: backups, failover, vacuum, indexes, partitions, migrations, capacity. |
| **ADR-005 Accepted** | Runtime delivery is at-least-once. Exactly-once external effects exist only when an `IDEMPOTENT_WRITE` sink contract or transactional adapter proves them. Every lease has a monotonically increasing fencing token and every write/effect handoff checks it. | Claim end-to-end exactly once; at-most-once; distributed transactions/2PC across every provider. | Adapters must implement the contract for `PURE`, `READ_ONLY`, `IDEMPOTENT_WRITE`, `COMPENSATABLE_WRITE`, `NON_IDEMPOTENT_WRITE`, or `HUMAN_EFFECT` and journal as required; avoids false guarantees and blocking global coordination. | Conditional writes/idempotency lookups add small DB cost; safe retries improve availability. | Stateless workers scale horizontally; duplicate delivery does not require global locks. | Lost ACK, stale worker, ambiguous timeout, duplicate provider call; reject stale fence, dedupe key, query status, compensate only by explicit contract, manually resolve unknown `NON_IDEMPOTENT_WRITE`. | Requires canonical effect/determinism contracts, idempotency, journal, reconciliation, and operator tooling. |
| **ADR-006 Accepted** | NATS JetStream carries durable dispatch/wakeup hints. Trusted `WorkerSupervisor` consumes them; `WorkerGateway` alone claims/commits PostgreSQL work and exercises effects. The gateway mints the PoP/mTLS-bound `ExecutionGrant`, persists its hash/constraints, and validates it on supervisor RPCs. Sandboxes have no NATS/DB/grant path. | DB polling only; Kafka; RabbitMQ; Redis Streams; queue, supervisor, or sandbox owns work. | Two systems participate, but no distributed transaction: outbox/reconciler repairs hints and the gateway preserves one authority path. | Fast pull consumers and batching; gateway DB claim/validation adds one round trip and prevents ghost work. | Subjects/consumers shard as `dispatch.<cell>.<pool>.<priority_band>.<shard>`; DB remains the limiting authority and scales by cells. | Duplicate/missing/expired hint, broker quorum loss, stolen grant, stale supervisor/gateway, lag; `Nats-Msg-Id=outbox_message.id`, readiness generation, PoP/mTLS, fenced claim/commit, sweeper, DB scan. | Operate JetStream HA, trusted gateway/supervisor pools, grant validation, stream limits, DLQ advisories, consumer lag, and reconciler. |
| **ADR-007 Accepted** | Use a transactional outbox for every state change that must trigger asynchronous work/projection. | Dual write DB + broker; CDC only; distributed transaction; periodic full polling. | Extra table/relay/cleanup versus atomic intent and retriable delivery. | Adds one indexed insert in the state transaction; batch relay avoids per-row overhead. | Partition by time/cell; parallel relays claim ranges; consumers are idempotent. | Relay crash, duplicate publish, poison event, lag; leases, idempotency IDs, retry/DLQ, lag SLO, source reconciliation. | Moderate: relay fleet, schema compatibility, partition retention, replay/backfill. |
| **ADR-008 Accepted** | Store incremental state deltas plus periodic checkpoints; put large serialized blobs in object storage with transactional manifests. | Full snapshot every node; event replay from origin only; in-memory state; single mutable blob. | More reconstruction/versioning logic; controls write volume and recovery time. | Small deltas reduce IO; checkpoint interval balances write amplification against replay latency. | Object storage absorbs large data; partition/checkpoint per execution; GC by reachability/retention. | Missing/corrupt object, manifest race, incompatible serializer, long replay; checksums, finalize protocol, redundant storage, versioned migrator, checkpoint cadence cap. | Serializer compatibility, orphan/GC sweeps, restore drills, storage lifecycle and encryption. |
| **ADR-009 Accepted** | Replay records three independent axes: operation (`STATE_REBUILD`, `EXACT_REPLAY`, `FORKED_REPLAY`), `execution_mode` (`LIVE`, `REPLAY`, `SIMULATION`), and adapter effect mode (`SUBSTITUTE_RECORDED`, `REEXECUTE_READ_ONLY`, `REEXECUTE_AUTHORIZED_EFFECT`, `FORBID`). Nondeterministic inputs and effects use a journal/fence. | One overloaded replay mode; resubmit original input; rerun everything live; prohibit replay. | Adapter/journal/vocabulary burden and storage cost; enables safe debugging, recovery, audit, and version comparison without ambiguous “shadow” semantics. | Recorded substitution is fast; provenance checks and artifact fetch add overhead. | Replay/simulation workloads use separate quotas/pools to avoid production starvation. | Missing journal, incompatible schema, duplicate effect, revoked access, invalid axis combination; compatibility report, default `FORBID`, fresh authorization/approval, stop on ambiguity. | High but essential: effect adapters, migrators, artifact retention, replay UI, policy, and telemetry for all three axes. |
| **ADR-010 Accepted** | Dynamic graph generation expands into validated, content-digested activation subgraphs with explicit bounds and parent provenance. It never executes arbitrary planner text. | Static DAG only; arbitrary tasks spawned by agents; mutate GraphVersion in place. | Validation/compilation cost per expansion; enables planning/agents while retaining controls. | Small compiler cost; cache identical expansion digests; bound size to protect scheduler. | Hierarchical expansion and quotas prevent scheduler explosion; activations shard normally. | Cycles, runaway expansion, authority escalation, duplicate expansion; schema/policy/budget validation, deterministic expansion key, depth/node caps. | Compiler/runtime/debugger must represent static and expanded topology plus provenance. |
| **ADR-011 Accepted** | Admission reserves concurrency/cost/provider capacity and scheduling uses hierarchical weighted fairness across plan, tenant, project, and queue class. | FIFO; priority only; unlimited submit then autoscale; per-tenant static queues. | Fairness may delay a large tenant's burst; prevents starvation and overload. | Admission adds durable counter transaction; scheduler scoring must remain bounded/O(log n). | Shard fairness by cell with periodic durable reconciliation; worker pools scale independently within downstream budgets. | Cache drift, priority inversion, quota leak, overload; PostgreSQL reservation truth, aging, ceilings, load shedding, fairness metrics. | Policy tuning, capacity models, tenant explanations, and incident controls. |
| **ADR-012 Accepted** | Placement is keyed by `(tenant_id, environment_id, routing_epoch)` and resolves one write-authoritative home cell. Default cross-region DR is asynchronous (target RPO <=5m/RTO <=30m); synchronous premium RPO 0 is explicit. | Global active-active writes; tenant-only placement; one global region; tenant-managed conflict resolution. | Cross-region callers carry/refresh an epoch and incur routing latency; relocation/failover workflow is required. Avoids distributed execution-state conflicts. | Local write path stays region-local; synchronous tier adds WAN commit latency. | Add cells/regions and rebalance tenant/environment placement; large tenants get dedicated cells. | Home-region outage, stale epoch/DR, split brain, bad failover; fencing/epoch, one promotion authority, routing update, reconciliation, restore drill. | High: placement catalog, epoch issuance, replication, failover, failback, residency, and per-tier runbooks. |

### 17.3.2 Data, projection, and observability decisions

| ADR / status | Decision and why | Alternatives considered | Trade-offs | Performance implications | Scalability implications | Failure modes and required response | Operational complexity |
|---|---|---|---|---|---|---|---|
| **ADR-013 Accepted** | Use S3-compatible object storage for large immutable artifacts/checkpoints/eval data/archives, addressed by digest and committed through a manifest. | Database BLOBs; shared POSIX filesystem; per-worker volumes. | Eventual aspects and two-phase finalize/GC; avoids database bloat and gains cheap durable scale. | Extra network fetch; offset with local encrypted cache and small metadata in DB. | Provider-native object scale; prefix/tenant isolation and lifecycle tiers. | Partial/orphan upload, checksum mismatch, delayed delete, unavailable bucket; verify digest, reconcile manifests, retry, multi-AZ/region policy. | Lifecycle, object lock, encryption keys, inventory, restore, purge/legal hold. |
| **ADR-014 Accepted** | Valkey/Redis-compatible storage is a TTL cache/rate/fairness accelerator only. Every correctness path has a conservative canonical fallback. | Redis as primary/lock/queue; no cache; process-local cache only. | Cache invalidation and another service; significant latency relief without correctness dependency. | Sub-millisecond common reads; cache key must include tenant/resource/policy versions; stampede controls. | Cluster/shard by key; noisy tenants quota-limited. | Eviction, failover loss, partition, stale decision; miss/recompute, authorization epoch, conservative limit, never promote cached state. | Moderate: memory/eviction, cluster failover, hot keys, hit ratios. |
| **ADR-015 Accepted** | ClickHouse is a rebuildable analytical projection for timelines, heatmaps, cost/failure/eval analytics; PostgreSQL remains billing/runtime truth. | Query PostgreSQL; Elasticsearch analytics; data warehouse only; Kafka stream processor. | Duplicate data and eventual freshness; isolates analytical scans from runtime. | Columnar compression/vectorized scans deliver cohort queries; batch ingest creates seconds of lag. | Shard/replicate by tenant/time; archive cold partitions to object storage. | Duplicate/late/out-of-order rows, projection lag/loss; version/idempotency keys, cursors, backfill, no runtime dependency. | Schema/materialized view evolution, part management, query quotas, rebuild procedures. |
| **ADR-016 Conditional** | OpenSearch (text), pgvector then Qdrant (vector), and Neo4j (knowledge graph) are independently rebuildable projections enabled only by workload need. | One multi-model DB; PostgreSQL only; proprietary search/vector/graph service. | Best-of-purpose query performance versus more services/eventual consistency. Projection code and canonical provenance are mandatory. | Search/ANN/traversal accelerate reads; cross-system joins and post-authorization add latency. | Each projection scales independently; dedicated tenant shard/cluster when justified. | Stale ACL/tombstone, wrong generation, index loss, partial backfill; authorization epoch, final canonical recheck, blue/green generation, disable/rebuild. | Potentially high. Default deployments should omit unused projections; adoption needs SLO/volume threshold and owner. |
| **ADR-017 Accepted** | OpenTelemetry is the instrumentation/transport standard; metrics, traces, logs, and profiles have separate fit-for-purpose backends. | Vendor-native agents/APIs; custom tracing; one all-in-one telemetry database. | Semantic governance/collector fleet; portability and polyglot correlation. | Instrumentation/serialization cost is bounded by batching/sampling; metrics labels strictly bounded. | Regional gateways, tenant budgets, scalable Mimir/Tempo/Loki backends. | Collector/backend outage, cardinality explosion, sensitive capture; bounded WAL, drop diagnostics in order, allow-list/redaction, preserve separate audit/cost path. | Collector config/schema ownership, backend capacity, retention, dashboards, SLOs. |
| **ADR-018 Accepted** | Cost and audit are append-only ledgers with compensating records and integrity-protected archive; they are not derived solely from telemetry. | Mutable billing totals; provider invoice only; application logs as audit; blockchain ledger. | More durable writes/reconciliation and retention cost; gives attributable, replayable financial/compliance evidence. | One ledger append per billable/governed event; batch projections and partitioning contain cost. | Partition/archive by tenant/time; independently export/verify. | Missing/duplicate usage, pricing drift, audit deletion/tamper; idempotency, effective price versions, adjustments, signed Merkle roots/WORM, reconciliation SLO. | High control discipline: key custody, legal holds, finance close, exports, verification and access separation. |

### 17.3.3 API, developer-experience, and plugin decisions

| ADR / status | Decision and why | Alternatives considered | Trade-offs | Performance implications | Scalability implications | Failure modes and required response | Operational complexity |
|---|---|---|---|---|---|---|---|
| **ADR-019 Accepted** | Public mutations are command-oriented REST with idempotency; internal worker calls use gRPC/Protobuf; SSE is default execution streaming; optional GraphQL is read/projection only. | GraphQL for all; gRPC public; WebSocket-only; direct broker access. | Multiple protocol contracts, each with narrow purpose; avoids opaque mutation/retry and browser coupling. | gRPC efficient internal streams; SSE cheap/reconnectable; REST caching/pagination for resources. | Stateless gateways; cursor streams can shard by cell/tenant. | Duplicate command, broken stream, schema skew, slow consumer; idempotency keys, deadlines, cursor resume, compatibility tests, bounded buffers. | API/schema generation, gateway versions, stream fan-out and documentation. |
| **ADR-020 Accepted** | Visual editor, YAML/JSON DSL, and code-first SDK all compile to the same Graph IR; no surface has secret runtime semantics. | Separate visual and code engines; serialize UI component state; code-only. | Some surface-specific features must wait for IR support; eliminates impossible-to-diff or nonportable graphs. | Compile once/cache by digest; UI receives derived layout separately. | Artifact distribution/CDN and stateless compiler scaling. | Round-trip loss, editor/compiler version mismatch; preserve extensions/layout separately, golden cross-surface tests, compatibility report. | Maintain SDK/codegen/editor schema/compiler together. |
| **ADR-021 Accepted** | Yjs CRDT is used for live `DraftBranch` collaboration, while publish freezes/normalizes/compiles an immutable GraphVersion. | Lock-based editing; CRDT GraphVersion; last-write-wins JSON; Git text merges only. | CRDT update storage/compaction and semantic conflict UX; collaboration does not compromise release reproducibility. | Low-latency local edits; snapshots/compaction control update-log growth. | Collaboration rooms shard by draft; awareness is ephemeral. | Divergent/offline updates, malformed client op, semantic conflict, lost room; server validation, durable update log/snapshots, compiler diagnostics, restore. | Dedicated collaboration gateway, CRDT migrations, presence, backups and abuse limits. |
| **ADR-022 Accepted** | Plugins/packages are immutable OCI artifacts with manifest, API compatibility, digest, SBOM, provenance, signature, structured `CapabilityRequirement {action, resource, constraints}`, canonical effect class, separate determinism, and revocation. Plugins with effect class and determinism `PURE` prefer WebAssembly; arbitrary images use strong sandboxes. | In-process dynamic libraries; colon-delimited permission strings; npm/pip install at runtime; source snippets. | Packaging/signing/review friction and WASI limits; sharply reduces dependency confusion, parser drift, and host authority. | WASM fast start with brokered host-call overhead; sandboxed containers slower but isolated. | Registry/CDN distribution and supervisor/gateway pools by runtime/requirement. | Malicious package, requirement widening, incompatible ABI, revoked signer, sandbox escape; verify before install/run, digest pin, fresh grant review, canary, kill switch, quarantine. | Marketplace review, signing trust, requirement/effect/determinism compatibility, vulnerability response, ABI/support matrix, licensing. |
| **ADR-023 Accepted** | Schemas are source-controlled and versioned: Protobuf for internal RPC, OpenAPI/JSON Schema for public/control contracts, CloudEvents-style metadata for async events. | Ad-hoc JSON; Avro everywhere; Protobuf everywhere; language-native serialization. | Multiple schema toolchains; each matches its consumer and avoids untyped drift. | Binary internal RPC is compact; JSON public APIs are debuggable; validation costs are bounded. | Schema registries/modules and compatibility CI enable independent consumers. | Unknown/removed fields, enum reuse, upcaster bug, oversized input; compatibility gates, limits, versioned upcasters, DLQ. | Code generation, linting, release windows, cross-language fixtures. |

### 17.3.4 Security and tenancy decisions

| ADR / status | Decision and why | Alternatives considered | Trade-offs | Performance implications | Scalability implications | Failure modes and required response | Operational complexity |
|---|---|---|---|---|---|---|---|
| **ADR-024 Accepted** | Human authentication uses OIDC/OAuth with enterprise federation; workloads use SPIFFE/SPIRE X.509 identities and mTLS. | Custom auth; static API tokens between services; Kubernetes service-account JWTs alone; full service-mesh identity. | Identity infrastructure and certificate lifecycle; removes long-lived shared service secrets and keeps standards boundary. | Token verification/local cert auth is low latency; federation/step-up adds interactive round trips. | SPIRE trust domains/cells federate explicitly; IdP scales independently. | IdP/SPIRE outage, expired cert, bad federation, token theft; short lifetime, bounded cache, revocation, fail closed governed actions, break-glass. | High-security ownership: federation, rotation, SCIM, trust bundles, MFA, incident response. |
| **ADR-025 Accepted** | Authorization combines tenant-scoped RBAC with contextual ABAC in OPA; every service remains a PEP and undefined means deny. | RBAC only; ACLs in each table/handler; Zanzibar/ReBAC only; central synchronous auth service only. | Policy language/bundle governance and input-model discipline; gains uniform explainable contextual decisions. | Local/sidecar evaluation is low latency; data loading and cache invalidation require design. | Signed bundles distribute per cell; decisions evaluate locally; relationship data is materialized/queried as needed. | Stale/bad bundle, inconsistent PEP obligation, PDP outage; revision/epoch, shadow/canary, compatible last-valid bundle, fail closed. | Policy tests, impact simulation, bundle signing/distribution, decision audit, on-call. |
| **ADR-026 Accepted** | Each claimed attempt gets a short-lived `ExecutionGrant`, audience-bound to `WorkerGateway` and PoP/mTLS-bound to `WorkerSupervisor`, that narrows structured requirements by execution, `CompiledPlan`, pinned `PolicySnapshot`, approval, data/tool constraints, and fence. Gateway mints it, persists hash/constraints, and validates supervisor RPCs; the supervisor cannot use it directly, and the sandbox gets only opaque handles. | Forward user JWT/grant to sandbox; give supervisor direct DB/broker rights; static per-graph API key; capability in graph state. | Grant/revocation checks and gateway mediation; dramatically limits blast radius/replay. | Issue once per attempt; local proof/signature validation plus selective revocation lookup and broker hop. | Stateless mint/verify with sharded revocation/usage state; bounded token sizes; gateways scale with pools. | Theft/replay, stale fence, wrong presenter/audience, confused deputy, clock skew, signer compromise; nonce/expiry/audience/PoP/fence, structured-resource match, counters, rotation/revoke cell. | Key custody/rotation, requirement/grant schema, gateway/supervisor PEP conformance, revocation, and debugging. |
| **ADR-027 Accepted** | Secrets are handles in graph/state and are resolved just in time by a trusted broker using Vault/cloud KMS; dynamic credentials preferred. | Secrets embedded/encrypted in graph; environment variables for all workers; direct Vault access from user code; cloud secret manager only. | Broker dependency and integration work; prevents ambient/reusable secret exposure. | One resolution per needed attempt with short safe caching; dynamic credential minting adds latency. | Broker/Vault scale per region/cell; secret namespaces/keys per tenant/environment. | Broker/Vault outage, leaked static key, failed rotation, secret in output; fail closed, lease/revoke, rotate, redaction canaries, audit. | Vault/KMS HA, key/lease/rotation, provider-specific adapters, access review, recovery. |
| **ADR-028 Accepted** | Isolation is risk-tiered: restricted container for trusted platform code, Wasmtime for compatible plugins, gVisor for untrusted language code, Kata/microVM for highest assurance; egress only through a policy proxy. | Ordinary containers for all; VM per job; serverless vendor; language sandbox only. | Multiple pools and cold-start/performance costs; matches isolation strength to threat and cost. | Native fastest; WASM low cold start; gVisor syscall/IO overhead; microVM highest startup/memory. Pooling never crosses tenant/risk. | Pools autoscale by resource/risk; dedicated pools/cells for large tenants. | Escape, side channel, OOM/fork/log bomb, incompatible syscall, proxy bypass; cgroups, no ambient network/host mounts, node quarantine, never downgrade isolation. | Very high: runtime patching, node images, compatibility, capacity, forensics, escape testing. |
| **ADR-029 Accepted** | Defense-in-depth tenant isolation uses home cells, tenant composite keys/predicates, PostgreSQL RLS, tenant-bound object/projection/cache keys, one tenant per sandbox, and authorized query gateways. | Shared schema with app checks only; database/schema per tenant for everyone; cluster per tenant only; trust projection ACL. | Repeated tenant metadata and tests; balances shared economics with dedicated isolation tiers. | Tenant predicates support index pruning; RLS/authorization recheck adds bounded work. | Cells and dedicated tenant resources scale blast radius/isolation; shared small tenants use bucketed shards. | IDOR, pool context leak, stale projection ACL, cache collision, support misuse; canaries, fail closed, disable path, incident/breach process. | Cross-plane test matrix, placement, deletion/export, support JIT access, tenant migrations. |

### 17.3.5 AI intelligence decisions

| ADR / status | Decision and why | Alternatives considered | Trade-offs | Performance implications | Scalability implications | Failure modes and required response | Operational complexity |
|---|---|---|---|---|---|---|---|
| **ADR-030 Accepted** | Graphs reference versioned logical ModelProfiles. A constraint-first router selects an exact provider/model/adapter using policy, capability, residency, health, quality, latency, and cost, and records the decision. | Hard-code provider/model; provider proxy black box; lowest cost; user chooses every call manually. | Registry/evaluation/health complexity; enables safe provider diversity, portability, and auditable optimization. | Routing/reservation adds milliseconds; improves tail/cost via health-aware choice and cache affinity. | Routers stateless over distributed snapshots; provider capacity and tenant budgets gate scale. | No eligible model, stale capabilities/price, route herd, provider degradation; fail explicit, pinned snapshot, reservations/breakers, tested fallback. | Provider adapters/contracts, registry ingestion, price/health/eval data, route explanations. |
| **ADR-031 Accepted** | Prompt, context, memory, embedding, and retrieval policies are immutable versioned artifacts. PostgreSQL/object storage preserve canonical sources/provenance; pgvector/Qdrant/OpenSearch/Neo4j are rebuildable projections. | Provider-managed conversation/memory only; transcript as memory; vector DB canonical; prompt strings in node config. | More data modeling and projection pipelines; enables privacy, temporal truth, replay, deletion, and model/index migration. | Context assembly/recheck and provenance add latency; caching/versioned summaries control cost. | Projection generations backfill independently; canonical stores shard by cell/tenant. | Memory poisoning/conflict, stale ACL/index, lost provenance, summary distortion; quarantine, bitemporal versions, authorization epoch, source-retaining rebuild/eval. | High: retention/DSR, backfills, embedding migrations, eval, source/projection cursors. |
| **ADR-032 Accepted** | Model tool calls are proposals. A trusted controller parses strict output; `WorkerSupervisor` presents its PoP/mTLS-bound grant to `WorkerGateway`, which validates schema/grant/pinned policy, checks tool manifest/effect class/approval, and invokes through a proxy/effect adapter. The model/sandbox receives only opaque handles, never raw authority or credentials. | Give model raw HTTP/SDK/credentials; prompt-only tool rules; parse free-form text; agent framework owns tools. | Additional gateway/policy/repair/approval latency and adapter work; prevents model output from becoming authority. | Schema/native tool modes reduce parsing; gateway/proxy add bounded latency relative to external call. | Tool proxies and gateways scale by class/destination; quotas and attempt grants contain fan-out. | Prompt injection, invalid args, approval substitution, SSRF, duplicate effect; structured requirement, typed manifest, bound digest, PoP, egress proxy, effect journal, deny. | Tool registry, manifests, gateway/supervisor PEPs, approvals, adapters, provider quirks, incident review. |
| **ADR-033 Accepted** | Agents/swarms are bounded dynamically expanded subgraphs with typed roles/messages/state and field-wise narrowed `CapabilityRequirement {action, resource, constraints}` objects. | Autonomous processes with shared super-token; one giant prompt; external agent framework as runtime; prohibit multi-agent. | Scheduling/message/eval overhead; retains graph debugging, limits, cancellation, and authority boundaries. | Parallel agents can reduce wall time but multiply tokens/cost; bound concurrency and use critical-path evidence. | Scheduler expands activations under tenant/graph caps; agent roles/pools scale normally. | Runaway expansion, message storm, correlated hallucination, deadlock, authority delegation; monotonic limits, dedupe, convergence/no-improvement, cancellation, explicit disagreement. | Agent registry, message schemas, coordinator patterns, evaluations, cost explanations. |
| **ADR-034 Accepted** | Every AI/prompt/model/retrieval/graph revision must pass versioned EvalGates with deterministic checks, workload slices, statistical rules, security tests, cost/latency, shadow/canary as risk requires. | Manual spot check; single LLM judge; global average benchmark; deploy then monitor. | Evaluation compute/data/human-review cost and slower release; prevents unmeasured semantic regression. | Release-path cost, not hot-path except canary/online metrics. | Parallel eval workers and immutable datasets; sampling controls expense. | Dataset leakage/drift, judge bias, insufficient sample, false pass; provenance/splits, human calibration, confidence/slices, freeze promotion. | Dataset governance, evaluator versions, compute budgets, reporting, reviewer ownership. |
| **ADR-035 Accepted** | Automatic node suggestions, graph generation, refactoring, and performance optimization create typed proposals/diffs. They may auto-run with `execution_mode=SIMULATION` and production adapter `effect_mode=FORBID`, but cannot self-approve or directly change production. | Auto-apply; text/code generation with manual copy; prohibit AI assistance; rules only. | Human gate limits autonomous speed; preserves authority and makes evidence/test obligations visible. | Static rules first; model proposals off hot path; canaries measure real impact. | Proposal/eval workers scale asynchronously; no production scheduler coupling. | Unsafe semantic/effect/order change, fabricated benefit, stale base graph; preconditions, source revision/diff, compile/security/eval/approval/canary/rollback. | Proposal lifecycle/UI, evidence store, gate orchestration, model/rule updates and feedback. |
| **ADR-036 Accepted** | Do not request or persist hidden chain-of-thought. Store structured plans, concise rationales, citations, decisions, evaluator defects, and observable actions. | Persist all reasoning; hide all explanations; provider-specific reasoning traces. | Less internal text for debugging; avoids sensitive/unreliable data and provider coupling while retaining auditable evidence. | Lower storage/token leakage; explicit rationale may add small token cost when required. | Structured evidence indexes efficiently and follows retention. | Missing explanation for regulated decision, rationale hallucination, accidental trace capture; require domain evidence schemas, label rationale as output, telemetry redaction/tests. | Data classification, provider adapter filtering, product UX and legal policy. |

### 17.3.6 Platform implementation decisions

| ADR / status | Decision and why | Alternatives considered | Trade-offs | Performance implications | Scalability implications | Failure modes and required response | Operational complexity |
|---|---|---|---|---|---|---|---|
| **ADR-037 Accepted** | Rust/Tokio/Axum/tonic implement trusted control/runtime services, including `WorkerSupervisor` and the database-authoritative `WorkerGateway`; Python/Node/WASM/custom images are isolated sandboxes behind an authority-free Protobuf ABI. | Go/Java/.NET for core; Python/TypeScript monolith; one language everywhere; grant-bearing sandbox protocol. | Rust compile/learning/ecosystem costs and a gateway hop; predictable resources and strong state-machine types in trusted hot paths while preserving user-language reach. | Low overhead and controlled allocation in scheduler/streaming; FFI avoided through RPC. | Stateless Rust services and polyglot pools scale independently. | Panic/unsafe bug, gateway compromise, SDK drift, blocking call; supervised process, no unsafe without review, least-privilege DB role, contract tests, blocking pools/deadlines. | Toolchains, gateway/supervisor operations, cross-language SDKs, build cache, profiling, hiring/training. |
| **ADR-038 Accepted** | Kubernetes/containerd is the deployment substrate; cells are blast-radius units; Helm + Argo CD + OpenTofu deliver GitOps; all artifacts are signed/digest-pinned. | VMs/systemd; serverless-only; Nomad; bespoke scheduler; one global cluster. | Kubernetes/operator/GitOps complexity; gains portable scheduling, isolation pools, rollout, and ecosystem. | Control-plane overhead is small relative to AI work; pod/microVM cold starts require warm pools. | Add clusters/cells/worker pools; avoid one enormous failure domain. | control-plane/AZ failure, bad operator/admission/release, image compromise; topology spread/PDB, canary rings, signatures, rollback, restore, cell isolation. | High platform engineering: cluster upgrades, CNI, autoscaling, stateful services, security, cost. |
| **ADR-039 Accepted** | Versions are exact digest-pinned release inputs. The repository-root `versions.lock` is the machine-readable architecture lock; Bazel is the hermetic CI/release graph generated from canonical Cargo/pnpm declarations. Use expand/migrate/contract schemas, mixed-version windows, signed provenance/SBOM, canary rings, and guardrail halt/rollback. | Floating latest; mutable tags; prose-only version matrix; independent Cargo/pnpm release builds; Bazel-only local workflow; big-bang migration. | Lock materialization/Bazel translation metadata plus CI/storage/compatibility work; fast native local workflows remain while release artifacts are reproducible. | Remote caching/parallel builds improve CI; lock/translation checks add work; dual-read/write can temporarily add latency. | Remote build/cache and rings/cells permit fleet rollout; artifact registry scales distribution. | Unresolved blueprint pin, lock/translation drift, incompatible schema/event/policy, impossible rollback, compromised build; fail deployable validation, equivalence/compatibility gates, signed build, recovery plan. | Release/build engineering, lock schema/automation, Bazel toolchains/cache, migration inventory, artifact trust, patch SLA, rollback drills. |

## 17.4 Consequential decision details

### 17.4.1 Why not make the broker authoritative?

Queue systems are good at delivery, not at atomically enforcing all execution invariants. A ready node depends on execution status, dependencies, cancellation, budget, deadline, retry policy, approval, tenant fairness, lease, and graph/state version. Encoding authority in a message either duplicates canonical state or requires distributed transactions.

The selected sequence is:

```text
DB: state transition + READY node + outbox commit
 -> relay publishes {token_id, readiness_generation}
    to dispatch.<cell>.<pool>.<priority_band>.<shard>
    with Nats-Msg-Id=outbox_message.id
 -> trusted WorkerSupervisor consumes hint
 -> local WorkerGateway conditionally claims DB row and increments fencing_token
 -> WorkerGateway mints grant, persists hash/constraints, returns PoP/mTLS-bound grant
 -> supervisor starts sandbox with opaque capability handles only
 -> sandbox returns host calls/result to supervisor
 -> supervisor presents grant on WorkerGateway RPC
 -> WorkerGateway validates and conditionally performs effect/commit with same fence
 -> WorkerSupervisor ACKs hint after accepted/already-accepted commit
```

If the broker loses a hint, the reconciler republishes from DB. If it duplicates a hint, only one gateway claim wins. If a sandbox or supervisor outlives its lease, `WorkerGateway` rejects the stale result/effect request. Sandboxes have no NATS, PostgreSQL, `ExecutionGrant`, or secret path. The price is a DB round trip and trusted gateway hop per claim; the benefit is a single, inspectable source of authority.

### 17.4.2 Why not promise exactly-once execution?

No platform can atomically coordinate every model provider, email server, SaaS API, database, and user function. Failures can occur after the remote effect but before acknowledgment. “Exactly once” is therefore scoped:

| Effect class/domain | Guarantee |
|---|---|
| internal PostgreSQL state/event/outbox | one committed transition under unique keys and fencing |
| `IDEMPOTENT_WRITE` with durable destination key | effectively once within the sink's retention/contract |
| platform transactional adapter sharing a DB transaction | exactly once within that transaction domain |
| `PURE` | no external effect; recomputation additionally follows the separate determinism declaration |
| `READ_ONLY` | bounded at-least-once observation subject to freshness/privacy policy |
| `COMPENSATABLE_WRITE` | at-least-once write plus an explicit, separately authorized compensation; not rollback |
| `NON_IDEMPOTENT_WRITE` without status API | at-least-once delivery; ambiguity stops for operator/approval policy |
| `HUMAN_EFFECT` | recorded human identity/decision/action; never synthesized or silently repeated |

These are the only six effect classes. Determinism (`PURE`, `RECORDED_NONDETERMINISTIC`, `EFFECTFUL`) is a separate node property and does not upgrade an effect guarantee. This honesty drives adapter design, testing, UI status (`UNKNOWN_EFFECT` is distinct from failure), and replay safety.

### 17.4.3 Why a custom runtime despite engineering cost?

Adopting an external workflow engine would accelerate timers/retries/leases but creates a second execution model between Graph IR and actual behavior. The product requires activation-level graph debugging, dynamic typed expansion, state scopes, visual replay, AI loop budgets, model/tool provenance, effect-aware optimization, and graph-specific pause/step/breakpoint semantics. If implemented as an adapter layer over a generic history model, the platform still owns most hard semantics while also operating and upgrading the external engine.

The decision is revisited only if a candidate can prove, with a prototype, that it can be the runtime authority without semantic duplication and can meet:

- state transition, outbox, and fencing invariants;
- graph revision and dynamic activation identity;
- replay operation, execution mode, adapter effect mode, and effect-journal contracts;
- tenant/cell placement and isolation;
- query/debug/timeline requirements;
- cost and operational SLOs under the target scale.

### 17.4.4 Why projections never authorize

Search, vector, graph, cache, and analytics systems receive asynchronous updates and have different consistency/security semantics. Allowing them to authorize makes an ACL revocation wait for every projection and turns an index bug into cross-tenant access. The query path therefore:

1. obtains an authoritative authorization predicate/epoch;
2. applies it inside the projection for performance;
3. rechecks returned canonical resource/version metadata;
4. denies results from a stale projection generation/epoch;
5. records projection lag and final denial.

This can reduce availability during lag, but security is not traded for stale convenience. Low-risk public content may have a separately explicit stale-read policy.

### 17.4.5 Why automatic AI changes stop at a proposal

Graph changes affect data access, authority, ordering, retries, cost, latency, and irreversible external effects. Model confidence cannot prove semantic equivalence or authorize a new tool. The proposal artifact makes uncertainty reviewable:

```text
base graph digest + typed patch + assumptions/preconditions
+ predicted impact distribution + evidence
+ changed permissions/effects/data flows
+ generated tests/eval results + required approvers
```

Rules may auto-merge low-risk source-format/layout changes only if they do not alter Graph IR. Executable IR changes always follow environment policy; production effect/authority changes require human separation of duties.

## 17.5 Performance and capacity consequences

The architecture prefers bounded local work and shifts fan-out away from global coordination.

### 17.5.1 Per-node transition budget

For a normal node attempt, the platform target is:

```text
1 WorkerGateway DB conditional claim transaction
1 WorkerGateway grant mint/persist + PoP/mTLS validation on supervisor RPCs
0..1 secret/tool/model gateway setup
N external frames streamed without per-token DB writes
1 WorkerGateway DB result + state delta + event + outbox transaction
periodic/size-triggered checkpoint, not every token
OTel emitted asynchronously through bounded buffers
```

Token streams are coalesced into UI/event chunks; storing a row per token is explicitly rejected. Large state/output goes to object storage and is referenced by digest.

### 17.5.2 Principal scale units

| Scale unit | Why it exists | Primary ceiling | Expansion action |
|---|---|---|---|
| execution cell | write authority/blast radius/residency | DB write/WAL/restore, broker, scheduler | add/rebalance cells; dedicate large tenant |
| scheduler shard | ready-work decisions/leases | DB contention and decision latency | increase shards with stable ownership |
| worker pool | runtime/risk/resource/provider affinity | slots, cold start, downstream quotas | autoscale within reserved budget |
| table partition | maintenance/index/archive | rows/bytes/vacuum/query pruning | create/detach/archive partitions |
| projection generation | safe rebuild/migration | index build/storage | parallel blue/green generation |
| model route/provider connection | external capacity/governance | provider quota/latency/error/cost | reserve, reroute only to compliant candidates |

The design does not assume linear scale from a single database, cluster, broker, or observability tenant.

## 17.6 Failure-domain and recovery decisions

| Failure domain | Must continue | May degrade/stop | Recovery authority |
|---|---|---|---|
| Valkey unavailable | canonical API/runtime, authorization from source, durable quota | cache speed, precise burst rate/fairness estimate | rebuild/warm cache |
| search/vector/graph unavailable | execution and canonical CRUD | retrieval/search; allowed canonical fallback only | projection cursor/backfill |
| ClickHouse unavailable | execution, billing ledger, audit | timelines/cohort analytics freshness | outbox replay/backfill |
| telemetry backends unavailable | execution within local buffer, audit/cost | diagnostics/sampling | collector WAL and backend recovery |
| JetStream unavailable | committed current executions remain known | new dispatch/cancel wakeups; DB reconciliation/polling may run in protected degraded mode | DB/outbox + stream restore |
| PostgreSQL write unavailable | reads allowed by policy | admissions, claims, state/effects stop; never promote cache/broker | database failover/PITR/home-cell DR |
| policy/secret system unavailable | already-authorized effect class `PURE` compute may finish within its separate determinism contract | new governed effects, secrets, deploys fail closed | last valid signed policy where allowed; HA recovery |
| model provider unavailable | platform/control and non-AI nodes | affected node unless compliant fallback exists | route policy/breaker; no ad-hoc provider |
| execution region unavailable | other cells/regions | home-cell tenant until DR promotion | single failover authority + epoch/fencing |

## 17.7 Operational complexity budget

The baseline mandatory stateful services are PostgreSQL, NATS JetStream, object storage, Valkey, identity/policy/secrets, and observability. ClickHouse is mandatory at full production analytical scale but may be omitted in a small development installation. OpenSearch, Qdrant, and Neo4j are conditional.

Before adding any new stateful distributed system, its ADR must provide:

- a workload and SLO that existing systems cannot meet, with measured evidence;
- data authority classification and a complete rebuild/export path;
- tenant isolation model and deletion/retention handling;
- HA, backup, restore, upgrade, and capacity runbooks with named owner;
- failure injection and disaster-recovery tests;
- security patch/support/licensing plan;
- 12-month infrastructure and on-call cost;
- removal criteria and migration path.

“Future scale” is not sufficient evidence.

## 17.8 Revisit triggers

| Decision | Revisit only when measured evidence shows |
|---|---|
| PostgreSQL canonical/cells | an invariant-preserving workload cannot meet SLO after indexing/partitioning/cell isolation, or cell count/operations becomes dominant cost |
| JetStream without Kafka | independent long-retention consumer ecosystems/cross-domain streams cannot be served by outbox replay and JetStream within SLO |
| pgvector -> Qdrant | filtered ANN recall/latency or index maintenance harms canonical DB at representative tenant scale |
| optional Neo4j | required traversals are operationally/materially worse in relational/search projections and have a stable ontology/query workload |
| custom runtime | external engine prototype meets all graph semantics/invariants with lower total ownership cost |
| Rust core | staffing/tooling or measured runtime constraints outweigh safety/resource benefits across multiple services |
| Kubernetes | target deployment constraints cannot support it or a simpler substrate meets isolation/autoscale/release requirements across environments |
| asynchronous regional DR | tenant contract requires lower RPO and accepts measured WAN latency/cost of synchronous tier |
| proposal-only AI change | a formally bounded transformation class proves semantic/effect/authority equivalence and policy explicitly allows auto-promotion outside production |

## 17.9 ADR change procedure

Every future ADR uses this record:

```yaml
id: ADR-040
title: concise irreversible decision
status: proposed | accepted | superseded | rejected
owners: [runtime, security, sre]
date: "2026-08-06"
supersedes: []
context:
  problem: ...
  constraints: [...]
  measuredEvidence: [...]
decision:
  statement: ...
  invariants: [...]
alternatives:
  - option: ...
    reasonRejected: ...
consequences:
  benefits: [...]
  tradeoffs: [...]
  performance: ...
  scalability: ...
  failureModes: [...]
  operationalComplexity: ...
securityPrivacyCompliance: ...
migrationRollback: ...
verification:
  tests: [...]
  slos: [...]
  observability: [...]
revisitTriggers: [...]
```

Process:

1. author includes a prototype/benchmark or failure evidence for costly/irreversible changes;
2. runtime, security, data, SRE, and affected product owners review explicit invariants;
3. threat model, data authority, tenant boundary, compatibility, migration, and rollback are mandatory sections;
4. simulate and canary where possible; record measured result rather than predicted adjectives;
5. accept with owners and follow-up work; link code/config/schema changes to the ADR;
6. supersede—never edit away—the prior rationale when the decision changes.

## 17.10 Architectural anti-patterns

- **Two sources of truth “temporarily”:** temporary dual authority becomes unrecoverable divergence.
- **Exactly-once by assertion:** hides ambiguous external effects and causes unsafe retries.
- **Queue-depth autoscaling without downstream budgets:** shifts overload to PostgreSQL or providers.
- **Global active-active mutable execution state:** introduces conflicts into leases, timers, effects, and cost for little benefit.
- **Projection/caches on the authorization path as authority:** revocation and deletion become eventually secure.
- **Every technology from the inspiration list:** a platform is cohesive only when each system has a unique authority and failure role.
- **Generic JSON between trusted components:** postpones contract errors until production and enables confused-deputy fields.
- **Plugin convenience over sandbox boundary:** in-process tenant code makes the entire runtime its capability.
- **Observability as a database backup:** sampling/retention/redaction make it intentionally incomplete.
- **AI score as proof:** evaluation is evidence with uncertainty, not authorization or semantic equivalence.
- **Architecture by average latency:** ignores p99, queueing, failure retries, noisy neighbors, cold starts, and recovery time.
- **Managed service absolves operations:** restore, identity, quota, outage, region, cost, and exit remain engineering decisions.
