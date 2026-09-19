# 16. Production Technology Stack

This chapter specifies the reference production baseline for the platform as of 2026-08-06. It is an implementation decision, not a list of interchangeable products. The checked-in machine-readable [versions.lock](../../versions.lock) is the architecture-level version-lock location; release automation must replace its blueprint placeholders with exact versions and image digests before declaring a build deployable. SBOMs and deployment manifests bind those pins to each artifact. The architecture document names version families only where compatibility materially changes the design. Every deployed artifact is digest-pinned and promoted through compatibility, security, load, restore, and rollback tests.

The stack intentionally keeps four truths distinct:

- PostgreSQL/object storage hold canonical control, execution, state, cost, audit, and source records.
- NATS JetStream provides durable dispatch/wakeup and event-delivery hints; a consumer must claim canonical work in PostgreSQL with a fencing token.
- Valkey, OpenSearch, Qdrant/pgvector, Neo4j, and ClickHouse are caches or rebuildable projections; none authorizes or decides execution state.
- OpenTelemetry metrics/logs/traces diagnose the system; they are not execution history or billing truth.

## 16.1 Selection criteria

Each baseline technology must meet the following criteria:

1. horizontal or cell-level scale compatible with millions of graphs and high concurrent execution;
2. explicit failure and consistency semantics that can be tested;
3. mature operational tooling, backup/restore, metrics, and rolling-upgrade path;
4. strong tenant/security primitives or an enforceable platform boundary;
5. protocol/data portability and no proprietary format in the canonical path;
6. first-class Rust support for the control/runtime plane and supported Python/TypeScript SDKs for workers/users;
7. deployable on Kubernetes in major clouds and self-hosted environments;
8. a credible maintenance/community or commercial support path;
9. acceptable total operational complexity—technology is not added solely because it benchmarks well;
10. a documented exit/rebuild path for every non-canonical subsystem.

## 16.2 Stack at a glance

```text
Developer surface
  React + TypeScript + Vite + React Flow + Monaco + Yjs
         | HTTPS/REST, SSE/WebSocket; projection-only GraphQL optional
         v
Edge/API
  Envoy Gateway -> Rust/Axum control services -> OPA -> PostgreSQL
                              | gRPC/Protobuf
                              v
Runtime
  Rust/Tokio scheduler + execution engine -> NATS JetStream -> WorkerSupervisor
                                                           -> WorkerGateway -> PostgreSQL
                                                                    |
                                                                    +-> Python/Node/WASM/gVisor sandboxes
Storage
  PostgreSQL 18 | S3-compatible object store | Valkey
  OpenSearch | pgvector/Qdrant | optional Neo4j | ClickHouse
Observability/security
  OTel Collector -> Prometheus/Mimir + Tempo + Loki + Grafana
  Keycloak/external IdP | SPIFFE/SPIRE | Vault + cloud KMS | OPA
Platform
  Kubernetes 1.36 | containerd | Cilium | gVisor/Kata | Helm + Argo CD
  OpenTofu | GitHub Actions + Bazel | OCI registry | Cosign/Sigstore | SBOM/provenance
```

## 16.3 Frontend and collaboration

| Layer | Baseline | Why | Important boundary/alternative |
|---|---|---|---|
| Language | TypeScript in strict mode | typed graph/API contracts and mature web tooling | generated types do not replace runtime validation |
| UI | React 19 family | component ecosystem and concurrent UI primitives ([React reference](https://react.dev/reference/react)) | Vue/Svelte are viable but split hiring/components |
| Build/dev | Vite | fast local HMR, explicit production build, library/plugin ecosystem ([Vite guide](https://vite.dev/guide/)) | framework SSR is unnecessary for the authenticated editor |
| Graph canvas | React Flow | node/edge interaction, viewport, selection, custom renderers ([React Flow docs](https://reactflow.dev/learn)) | custom rendering/virtualization is required for very large graphs; library state is not canonical |
| Code/schema editor | Monaco Editor | familiar language services, JSON/YAML diagnostics, diff editor | load in a web worker; sandbox language providers |
| Server state | TanStack Query | cache/invalidation/retry around API resources | mutations remain command APIs with idempotency keys |
| Navigation | TanStack Router | type-safe route/search params | route permissions are not authorization |
| Local editor command state | Zustand or reducer command store | small predictable command/undo layer | graph draft CRDT/document is separate |
| Collaboration | Yjs CRDT + dedicated collaboration gateway | offline/live draft convergence and awareness ([Yjs documentation](https://docs.yjs.dev/)) | CRDT draft is not an executable GraphVersion; publish compiles a snapshot |
| Visualization | Canvas/WebGL renderer when node count threshold is crossed; SVG for normal graphs | performance without sacrificing accessible detail view | React Flow interaction model remains; render strategy is adaptive |
| Testing | Vitest, React Testing Library, Playwright | component, contract, and browser workflows | visual snapshots supplement semantic assertions |

Frontend rules:

- Browser receives projection DTOs, never database rows, secret values, worker capabilities, or provider credentials.
- OpenAPI/JSON Schema generates clients, but all network input is validated at the boundary.
- SSE is the default one-way execution stream; WebSocket is reserved for bidirectional collaboration/debug sessions. Both resume with a cursor and reauthorize on reconnect.
- Draft collaboration uses stable `DraftBranch` IDs and CRDT updates. Publishing freezes a snapshot, normalizes it, compiles typed Graph IR, and produces a content-addressed `GraphVersion`.
- Large execution payloads are lazy-loaded by authorized artifact reference; the timeline uses windowed queries and rendering.

## 16.4 Backend and execution runtime languages

### 16.4.1 Rust control and runtime plane

The API, graph compiler, scheduler, execution state machine, policy clients, model/tool gateways, `WorkerSupervisor`, `WorkerGateway`, outbox relay, and high-throughput services are Rust. Tokio supplies the async runtime and networking primitives ([Tokio tutorial](https://tokio.rs/tokio/tutorial)); Axum is the external/internal HTTP framework; tonic implements gRPC over Protobuf.

| Component | Crates/approach | Notes |
|---|---|---|
| HTTP API | `axum`, `tower`, `tower-http`, `hyper` | middleware for identity, request IDs, limits, tracing, deadlines |
| Async/runtime | `tokio`, `tokio-util` | cancellation tokens, bounded channels; never hold DB locks across network calls |
| gRPC | `tonic`, `prost` | worker/control contracts, deadlines, mTLS, bounded messages |
| Database | `sqlx` with checked SQL | explicit transactions; migrations; typed numeric/JSON/UUIDv7/SHA-256 wrappers |
| Serialization | `serde`, `serde_json`, `prost` | reject unknown control fields where contracts require it; size/depth limits |
| Error model | typed domain errors + stable wire codes | provider strings do not drive retries |
| Telemetry | `tracing`, OTel SDK/export | semantic allow-list; no payloads by default |
| Crypto | audited standard crates plus KMS/Vault APIs | application code does not invent algorithms |

Why Rust: predictable memory/CPU, no stop-the-world garbage collector in scheduler/streaming hot paths, strong types for state transitions and schemas, and deployable static-ish service artifacts. Trade-offs are longer compile times, a stricter learning curve, and smaller library coverage for some AI providers; provider REST adapters therefore use generated/hand-reviewed HTTP contracts instead of pulling every vendor SDK into the trusted runtime.

### 16.4.2 Polyglot worker plane

| Workload | Baseline | Isolation |
|---|---|---|
| trusted high-throughput built-in nodes | Rust worker library | restricted container |
| data/ML/user functions | Python current supported minor(s), isolated virtual environment/image | gVisor or microVM by risk |
| JavaScript/TypeScript functions | Node.js current active LTS | gVisor or microVM by risk |
| portable plugins/`PURE` transforms | WebAssembly component via Wasmtime | WASI capability host, fuel/epoch/memory limits |
| custom enterprise images | OCI image contract | signed image, SBOM, dedicated gVisor/Kata profile |

The sole normative language-neutral sandbox wire contract is [sandbox.proto](../contracts/executiongraph/sandbox/v1/sandbox.proto). Its `SandboxNodeService` exposes bidirectional `Invoke(stream InvokeRequest)` plus `CancelInvocation`; `StartInvocation` carries only correlation/attempt identity, content digests and artifact references, declared state projection, opaque `CapabilityHandle` values, budget, replay axes, deterministic seed/logical time, and trace context. It deliberately contains no ExecutionGrant, routing/scheduler/fencing authority, NATS/PostgreSQL credential, provider secret, or ambient endpoint.

`WorkerSupervisor` is the trusted JetStream consumer and owns sandbox lifecycle/resource isolation. It passes each opaque dispatch hint to local `WorkerGateway`. The gateway alone claims and commits PostgreSQL work, mints the proof-of-possession/mTLS-bound `ExecutionGrant`, persists its hash/constraints, validates fencing and supervisor RPCs, and brokers artifact, secret, model, tool, clock, random, and effect operations. The supervisor may hold/present the grant but cannot use it for direct DB/broker/secret access. A sandbox receives only opaque capability handles—no NATS or database connection, grant token, provider credential, or secret—and returns a typed result through the supervisor/gateway path for fenced commit.

## 16.5 API and contract stack

| Surface | Technology | Decision |
|---|---|---|
| Public commands/resources | REST/HTTP JSON, OpenAPI 3.1 | stable, cacheable reads and explicit idempotent command endpoints |
| Execution event stream | SSE with cursor; WebSocket for interactive debugger | simpler one-way reconnection for normal monitoring |
| Worker/internal synchronous | gRPC + Protobuf | compact typed streaming and deadlines |
| Async event envelope | CloudEvents 1.0-style metadata + Protobuf/JSON payload schema | consistent event identity/type/source/time/schema |
| Graph/data schemas | JSON Schema 2020-12 subset + platform annotations | user-facing validation and structured model output |
| Graph DSL | YAML/JSON parsed to one typed Graph IR | text and visual paths converge before execution |
| Projection exploration | optional GraphQL read/subscription gateway | no command mutation or authorization bypass |
| Package/artifact distribution | OCI registry and content digests | existing signing, pull, cache, provenance tooling |

Contract source is owned in one schema repository/module and code-generated in CI. Compatibility checks prohibit removing/renaming fields, changing semantics, or reusing enum numbers in a supported version. Events and Graph IR have explicit upcasters/migrators; “accept arbitrary JSON for forward compatibility” is prohibited on security/runtime control paths.

Shared contracts use one effect enum—`PURE`, `READ_ONLY`, `IDEMPOTENT_WRITE`, `COMPENSATABLE_WRITE`, `NON_IDEMPOTENT_WRITE`, `HUMAN_EFFECT`—and the independent determinism enum `PURE`, `RECORDED_NONDETERMINISTIC`, `EFFECTFUL`. Requested authority is always `CapabilityRequirement { action, resource, constraints }`; colon-delimited permission strings are not a wire contract. Replay uses three separate axes: operation `STATE_REBUILD | EXACT_REPLAY | FORKED_REPLAY`, `execution_mode=LIVE | REPLAY | SIMULATION`, and adapter `effect_mode=SUBSTITUTE_RECORDED | REEXECUTE_READ_ONLY | REEXECUTE_AUTHORIZED_EFFECT | FORBID`.

## 16.6 Canonical database: PostgreSQL

PostgreSQL is canonical for tenants/projects, DraftBranch metadata, GraphVersion manifests, immutable `CompiledPlan` metadata/typed IR references, immutable `PolicySnapshot` bindings, deployments, executions, activations/attempts, dependencies, state versions/deltas, checkpoints, leases/fencing, execution events, outbox, dead letters, idempotency, approvals, authorization metadata, audit manifests, cost ledger, source/memory records, registry metadata, and projection cursors. Every admitted execution pins `compiled_plan_id`, `plan_hash`, `policy_snapshot_id`, and `policy_snapshot_hash`; aliases are resolved before admission and cannot drift mid-run.

PostgreSQL 18 is the reference major at the document date; production supports a tested major and N-1 during migrations, with exact patch pinning. PostgreSQL's current documentation covers declarative partitioning used for high-volume event tables ([PostgreSQL partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)) and logical replication used selectively for read/DR/export patterns ([PostgreSQL logical replication](https://www.postgresql.org/docs/current/logical-replication.html)).

Why PostgreSQL:

- strong transactions make state transition + event + outbox + idempotency atomic;
- constraints, conditional updates, and row-level security enforce invariants close to data;
- JSONB supports versioned Graph IR/configuration without abandoning relational identity/indexes;
- range/hash partitioning, read replicas, and cell-level sharding provide a credible scale path;
- mature backup/PITR/managed offerings reduce bespoke consensus/storage work.

Production layout:

```text
one write-authoritative PostgreSQL cluster per execution cell
  primary across 3 AZs + synchronous in-region standby/managed equivalent
  read replicas for inspector/reporting where stale reads are allowed
  WAL archive + encrypted base backups + tested PITR
  PgBouncer transaction pooling (or managed proxy) with SET LOCAL tenant context
  partitions: execution_event, node_attempt, cost_ledger, audit_manifest, outbox
  archive worker: old partitions -> Parquet/object storage -> detached/drop by policy
```

Avoid a single global writable cluster. The placement catalog is keyed by `(tenant_id, environment_id, routing_epoch)` and resolves exactly one write-authoritative home cell. Every routed command carries the observed epoch; a stale epoch is rejected or redirected rather than creating a second writer. Regional DR defaults to RPO <= 5 minutes/RTO <= 30 minutes; a premium synchronous dual-region option is an explicit latency/cost trade-off, not a hidden default.

Database conventions:

- persisted entity IDs are UUIDv7 stored as PostgreSQL `uuid`; deterministic identities such as activation, semantic, plan, and content IDs are SHA-256 digests, never ULIDs or ad hoc prefixed strings;
- every tenant table includes `tenant_id` in primary/unique/foreign keys;
- UTC `timestamptz`, monotonic logical sequence for runtime ordering;
- `numeric` for money/usage calculations; never floating point;
- database enum evolution is avoided on fast-changing external values; use lookup/check domains;
- large payloads go to object storage before the transaction, referenced by digest and finalized through a manifest protocol;
- `sqlx` queries set statement/lock/idle-in-transaction timeouts; migrations are expand/migrate/contract.

Rejected as the canonical runtime store: Cassandra/DynamoDB complicate multi-record state/outbox invariants; MongoDB encourages opaque graph/state documents and weaker relational constraints; a graph database optimizes traversal but not scheduler leases/ledgers; Redis/Valkey is not strongly durable enough for acknowledged state.

## 16.7 Messaging, queueing, and streaming

### 16.7.1 NATS JetStream

NATS JetStream is the sole reference durable dispatch/wakeup transport. Durable pull consumers support horizontal workers, explicit acknowledgments, backoff, redelivery, and flow control; JetStream's base consumer behavior is at-least-once ([JetStream consumers](https://docs.nats.io/nats-concepts/jetstream/consumers)).

```text
DB transaction: mark execution activation READY + outbox_message
    -> outbox relay publishes {token_id, readiness_generation}
       with Nats-Msg-Id=outbox_message.id
    -> trusted WorkerSupervisor durable pull consumer receives hint
    -> WorkerSupervisor asks local WorkerGateway to claim DB row:
       UPDATE ... SET lease_owner=?, fencing_token=fencing_token+1
       WHERE token_id=? AND readiness_generation=?
         AND status='READY' AND lease expired
    -> WorkerGateway mints grant, persists hash/constraints, returns PoP/mTLS-bound grant
    -> supervisor starts sandbox with opaque capability handles only
    -> sandbox returns typed result/host calls to supervisor
    -> supervisor presents grant on WorkerGateway RPC
    -> WorkerGateway validates grant and performs effect/fenced DB operation
    -> WorkerSupervisor ACKs hint only after accepted/already-accepted commit
```

The NATS message is not the work record. Duplicate/lost/expired hints are repaired by an outbox sweeper and ready-work reconciler. A `WorkerSupervisor` never starts a sandbox solely because a message says so; `WorkerGateway` must win the canonical claim. Sandboxes have no broker credentials or client.

Reference streams:

| Stream | Subjects | Retention | Purpose |
|---|---|---|---|
| `RUNTIME_DISPATCH` | `dispatch.<cell>.<pool>.<priority_band>.<shard>` | work queue, bounded age/bytes | ready-node wakeup; exact subject derived by trusted placement/scheduler code |
| `RUNTIME_CONTROL` | `control.<cell>.<execution>` | limits, short retention | cancellation/pause/resume wakeup |
| `PROJECTION_HINTS` | `project.<cell>.<event_type>` | limits, replay window | wake rebuildable projections |
| `WEBHOOK_DELIVERY` | `webhook.<cell>.<tenant_bucket>` | work queue + DLQ workflow | outbound integration delivery |

Use file storage, three replicas across zones, `DiscardNew` for streams where silent eviction is unacceptable, maximum message size well below the server default, explicit `MaxDeliver`, and DLQ advisories. Pull consumers provide application-controlled backpressure. The official stream documentation describes work-queue/limits retention and deduplication windows ([JetStream streams](https://docs.nats.io/nats-concepts/jetstream/streams)).

Why not Kafka initially: a second durable log adds partitions, brokers, schema registry, client behavior, security, and on-call load while PostgreSQL already holds canonical events and ClickHouse serves analytics. Add Kafka/Redpanda only via ADR when independently replayable external event volume, consumer count, or cross-domain streaming demonstrably exceeds the outbox + JetStream design. RabbitMQ is mature but does not improve the chosen replay/subject model enough to justify another broker. Redis Streams are not selected because the cache failure domain must not become dispatch authority.

### 16.7.2 Browser streaming

Execution events are projected into a cursor store/query service. SSE gateways fetch authorized batches and subscribe to projection hints; clients resume with the last durable cursor. Gateways coalesce high-frequency token/state updates, cap per-session bytes, and fall back to polling. Browser connections never subscribe directly to NATS.

## 16.8 Cache and coordination assist

Valkey (Redis-protocol compatible) is used for response/session metadata caches, short-lived authorization-decision caches, rate-limit accelerators, provider-health hints, distributed UI presence, and scheduler fairness estimates. Valkey supports clustering but uses asynchronous replication and can lose acknowledged writes during some failures; therefore it cannot hold canonical execution, lock, quota, authorization, approval, or billing state ([Valkey cluster consistency](https://valkey.io/topics/cluster-tutorial/)).

Rules:

- keys begin with binary `tenant_id`/environment namespace and schema version;
- every entry has TTL; negative authorization results have short TTL, sensitive positive decisions often none;
- cache key includes resource version, policy/authorization epoch, classification, and principal scope;
- cache stampede protection uses single-flight and bounded stale-while-revalidate only for safe reads;
- durable money/concurrency reservation commits in PostgreSQL, then cache updates best-effort;
- a cache outage degrades performance/rate-limit precision under a conservative local/global ceiling; it never becomes unlimited or authorized.

## 16.9 Object and archival storage

Use the cloud provider's S3-compatible object service in managed deployments and Ceph Object Gateway as the reference self-hosted production implementation. Ceph RGW exposes an S3-compatible interface, but its documented feature matrix must be checked against every required API rather than assuming perfect S3 equivalence ([Ceph Object Gateway S3 API](https://docs.ceph.com/en/latest/radosgw/s3/)). MinIO remains a convenient local emulator, not the production reference. Objects hold large immutable GraphVersion packages, plugin/OCI artifacts, state/checkpoint blobs, prompt/model payload artifacts allowed by policy, code packages, logs/trace blocks, eval datasets/results, exports, backups, and Parquet archives.

Object contract:

```text
key = tenants/<server-derived-tenant-id>/<environment>/<type>/<digest-prefix>/<digest>
metadata = content digest, size, media/schema type, tenant, classification,
           encryption key version, source record, retention/legal hold, created time
write = upload temporary -> checksum/scan/encrypt -> DB manifest transaction -> finalize
read = authorized short-lived signed request or trusted service stream
```

Enable versioning only where it supports recovery; versioning is not deletion. Audit/export buckets use object lock/WORM retention. Lifecycle transitions old data to archival tiers. Multi-part uploads, orphan temporary objects, failed manifest commits, and delete markers have reconciliation jobs. Do not expose a shared bucket credential to workers or browsers.

## 16.10 Search, vector, and graph projections

### 16.10.1 Text and operational search: OpenSearch

OpenSearch indexes graph/project metadata, execution/log search fields, documentation, plugin marketplace metadata, and keyword retrieval documents. It is chosen for inverted-index search, filters, aggregations, highlighting, and scalable read projections ([OpenSearch documentation](https://docs.opensearch.org/latest/)). Index aliases implement blue/green generations.

The query gateway injects tenant and canonical ACL predicates; users never submit unrestricted Query DSL. Sensitive text is indexed only when policy permits. Source version and authorization epoch accompany each document. Index templates bound field counts and reject uncontrolled dynamic mapping. PostgreSQL/object storage can rebuild every index.

### 16.10.2 Vector search: pgvector first, Qdrant at dedicated scale

- `pgvector` is the default for early/small collections and transactional metadata proximity. It supports exact search and HNSW indexes ([pgvector project documentation](https://github.com/pgvector/pgvector)).
- Qdrant is the reference dedicated vector projection for high-volume/latency-isolated tenants. It supports payload filters and tenant-oriented sharding; payload indexes are required for filter performance ([Qdrant filtering](https://qdrant.tech/documentation/search/filtering/), [Qdrant multitenancy](https://qdrant.tech/documentation/manage-data/multitenancy/)).

Both store vector projections keyed by canonical source/chunk version, tenant, ACL epoch, embedding profile, and index generation. PostgreSQL retains source/projection manifests. Do not dual-write synchronously from a request; outbox workers build projections and advance verified cursors.

Promotion threshold from pgvector to Qdrant is measured, not ideological: collection/vector count, filtered recall/latency, index build/vacuum impact on canonical DB, memory/storage footprint, noisy-neighbor isolation, and operational cost. A tenant can remain on pgvector if it meets its SLO.

### 16.10.3 Knowledge graph storage: optional Neo4j projection

Neo4j is used only for knowledge/ontology traversals that materially benefit from a property graph. Static execution topology remains typed Graph IR/PostgreSQL; runtime activation/dependency history remains PostgreSQL/ClickHouse. Neo4j clustering provides transactional primaries and read-scaling secondaries with explicit causal-consistency mechanisms ([Neo4j cluster architecture](https://neo4j.com/docs/operations-manual/current/clustering/introduction/)).

Neo4j records carry tenant, source record/version, validity/system time where applicable, classification, ACL epoch, and projection generation. The query service supplies parameterized, allow-listed Cypher/templates and canonical authorization. Enterprise clustering/licensing is required for production HA; deployments that do not need graph traversal should not run Neo4j.

## 16.11 Analytical and observability data

### 16.11.1 ClickHouse

ClickHouse is the rebuildable analytical projection for execution timelines, node/profile latency, cost analytics, activation graphs, failure cohorts, evaluation results, and product usage. It is optimized for append-heavy columnar queries that should not burden canonical PostgreSQL ([ClickHouse documentation](https://clickhouse.com/docs/en/intro)).

Data arrives from partitioned outbox readers in idempotent batches. Tables use event/ledger IDs for deduplication semantics, tenant and time partition/order keys, explicit schema versions, and materialized views for bounded rollups. Corrections append new versions/adjustments; billing truth remains PostgreSQL. Query gateways enforce tenant predicates, row/byte/time limits, and authorization-aware result caches.

### 16.11.2 OpenTelemetry and Grafana stack

| Signal | Collection | Backend | Role |
|---|---|---|---|
| metrics | OTel SDK/Collector, Prometheus scrape/remote write | Prometheus locally, Mimir at multi-cell scale | SLO/alerts/capacity |
| traces | OTel SDK/Collector OTLP | Tempo + object storage | request/execution diagnosis |
| logs | structured stdout -> collector/agent | Loki + object storage for large artifacts | diagnostics |
| dashboards/alerts | Grafana | Grafana | correlated operational UI |
| execution analytics | outbox projection | ClickHouse | timeline, heatmap, critical path, cost/failure cohorts |

OTel supplies a vendor-neutral signal contract and semantic conventions ([OpenTelemetry specifications](https://opentelemetry.io/docs/specs/)). Tempo persists trace blocks to object storage and scales components independently in microservice mode ([Tempo architecture](https://grafana.com/docs/tempo/latest/introduction/architecture/)).

The collector is mandatory between services and backends for redaction, attribute allow-listing, memory limits, batching, sampling, and bounded WAL. Tenant IDs/execution IDs never become metrics labels. Diagnostic signal loss is allowed within documented bounds; audit/cost/execution events use their own durable path.

## 16.12 Identity, policy, secrets, and supply chain

| Capability | Baseline | Rationale |
|---|---|---|
| Human auth/SSO | Keycloak reference broker/server; external managed IdP via OIDC/SAML; platform SCIM provisioning | standards boundary avoids embedding authentication in application services ([Keycloak documentation](https://www.keycloak.org/documentation)) |
| Workload identity | SPIFFE/SPIRE X.509 SVID | short-lived attestable service identity and mTLS ([SPIFFE standard](https://spiffe.io/docs/latest/spiffe-specs/)) |
| Authorization | OPA/Rego bundles, local/sidecar PDP where latency critical | structured RBAC+ABAC decisions separated from PEPs ([OPA documentation](https://www.openpolicyagent.org/docs)) |
| Secrets/crypto | Vault + cloud KMS/HSM; External Secrets/CSI only for trusted platform workloads | dynamic credentials, lease/revocation, transit/envelope encryption ([Vault Transit](https://developer.hashicorp.com/vault/docs/secrets/transit)) |
| Artifact signing | Sigstore Cosign, OCI registry, transparency log/private equivalent | digest signatures, attestations, keyless CI identities |
| SBOM/provenance | Syft or equivalent SPDX/CycloneDX; SLSA-style provenance | dependency/image inventory and build traceability |
| Admission | Kubernetes admission policies plus signature/provenance/vulnerability policy | block untrusted images/config before runtime |

Keycloak is a replaceable identity implementation; platform services consume verified standards claims and an internal principal model. OPA decisions never authenticate identity. Vault is not queried from arbitrary sandbox code. `WorkerSupervisor` presents the PoP/mTLS-bound `ExecutionGrant` only to `WorkerGateway`; after validation, the gateway presents a narrower derived permit to the trusted secret broker, which may inject credentials directly into a tool adapter without revealing them to the supervisor or sandbox.

## 16.13 Container, sandbox, and Kubernetes stack

Kubernetes 1.36 is the reference family at the document date; support follows tested Kubernetes minors, not “latest” automatically. Kubernetes uses CRI-compatible runtimes and `RuntimeClass` to select alternate isolation with declared overhead ([Kubernetes container runtimes](https://kubernetes.io/docs/setup/production-environment/container-runtimes/), [RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/)).

| Layer | Baseline | Purpose |
|---|---|---|
| orchestration | Kubernetes managed service or conformant self-host | scheduling, service discovery, rollout, quotas, AZ placement |
| OCI/CRI | containerd | standard trusted platform containers |
| network | Cilium CNI/network policy; Envoy Gateway at edge | default-deny L3/L4, identity-aware policy/observability, L7 ingress |
| untrusted Linux | gVisor `runsc` | userspace kernel boundary; security/performance compromise |
| high-assurance Linux | Kata Containers/Firecracker-class microVM pool | hardware-virtualized boundary for sensitive custom code |
| portable functions | Wasmtime component runtime | capability host, memory/fuel/epoch limits |
| workload identity | SPIRE agents/server | short-lived SVID delivery/rotation |
| autoscaling | HPA/KEDA-style metrics plus custom capacity controller | API/queue scaling; DB/provider budgets remain gates |

Namespaces are primarily service/cell boundaries, not the only tenant boundary. Kubernetes `Restricted` Pod Security is the floor for trusted workloads; Kubernetes notes that sandboxed runtimes have distinct properties and no universal sandbox API/profile ([Pod Security Standards](https://kubernetes.io/docs/concepts/security/pod-security-standards/)).

Reference cell:

```text
Region
 +-- global/edge cluster services (routing, identity federation, catalog replicas)
 +-- cell-01 Kubernetes cluster or hard node/namespace boundary
 |    +-- api/control services (3+ replicas across AZs)
 |    +-- scheduler shards (leased leaders, 3+ replicas)
 |    +-- trusted WorkerSupervisor + WorkerGateway pools
 |    +-- gVisor sandbox pools by size/risk
 |    +-- microVM sandbox pools (optional/dedicated)
 |    +-- NATS JetStream 3-node AZ cluster
 |    +-- PostgreSQL HA cluster/service
 |    +-- OTel collectors and local gateways
 +-- regional shared projections (policy-dependent)
      OpenSearch, Qdrant, ClickHouse, Grafana backends, object storage
```

Stateful systems use operators only when the operator's failure/upgrade/backup behavior has been qualified; managed services are preferred where they meet residency/portability requirements. An operator is software in the trusted control plane and receives the same security/reliability scrutiny as an application service.

## 16.14 Deployment, infrastructure, and CI/CD

| Concern | Baseline |
|---|---|
| Cloud infrastructure | OpenTofu modules with cloud-specific implementations and a common cell interface |
| Kubernetes packaging | Helm charts with JSON Schema values; Kustomize only for thin environment overlays |
| GitOps deployment | Argo CD, protected environment repositories, sync windows/health hooks |
| CI/build | GitHub Actions using OIDC workload identity orchestrates a hermetic [Bazel](https://bazel.build/about/intro) release graph; Cargo and pnpm remain canonical dependency declarations and fast local workflows; self-hosted isolated runners handle sensitive builds |
| Registry | OCI registry for images, plugins, GraphVersion packages, SBOMs, provenance, signatures |
| Database changes | `sqlx` migrations; expand/backfill/dual-read if necessary/contract; separate migration identity |
| Feature release | OpenFeature-compatible flag interface backed by an approved provider; flags are not authorization |
| Load/chaos | k6/Vegeta-style API load, custom execution generator, fault injection in staging/canary |

Pipeline:

```text
PR
 -> format/lint/unit/property/fuzz-contract tests
 -> graph/schema/API compatibility
 -> security/SCA/secret/IaC/container scans
 -> Bazel reproducible build in isolated runner from checked Cargo/pnpm translation locks
 -> SBOM + provenance + sign image/artifacts
 -> ephemeral integration cell
 -> migration/restore/tenant-isolation tests plus replay matrix:
    STATE_REBUILD | EXACT_REPLAY | FORKED_REPLAY
    x LIVE | REPLAY | SIMULATION where valid
    x SUBSTITUTE_RECORDED | REEXECUTE_READ_ONLY | REEXECUTE_AUTHORIZED_EFFECT | FORBID
 -> performance and AI EvalGates
 -> deploy staging by digest
 -> canary cell/tenant cohort + automated guardrails
 -> signed promotion to production rings
 -> progressive rollout; automatic halt/rollback
```

Production deploy identities cannot write source and CI identities cannot directly administer clusters. A release is the same signed digest in every ring. Rollback compatibility is declared for code, Graph IR, DB schema, event schema, and policy bundle; a database contract migration cannot proceed until all rollback windows close.

## 16.15 Local development and test environment

Local development must exercise real contracts without pretending to prove production HA:

```text
docker compose / kind:
  PostgreSQL + NATS JetStream + Valkey + MinIO
  OTel Collector + Prometheus + Tempo + Loki + Grafana
  optional profiles: ClickHouse, OpenSearch, Qdrant, Neo4j, Keycloak, Vault dev
  Rust API/scheduler/worker + web app
```

- Provider/tool emulators reproduce streaming, rate limits, timeouts, partial frames, usage, and idempotency.
- Testcontainers integration tests start isolated dependencies by digest.
- A deterministic fake model is the default for CI. Live provider tests run in a restricted scheduled job with budget and no customer data.
- `kind`/local clusters validate manifests and RuntimeClass selection, but not cloud load balancers, managed identity, multi-AZ durability, or production sandbox guarantees.
- Seed data always contains at least two tenants to make isolation bugs visible.

## 16.16 Version and upgrade policy

The repository-root [versions.lock](../../versions.lock) is the machine-readable architecture lock. In blueprint state it records version families and null release pins with `deployable: false`; a production release must generate and review exact toolchain, package, chart, image, and digest pins and set no floating value.

```yaml
versionPolicy:
  artifacts: exact_digest
  rust:
    channel: pinned_stable
    minimumSupport: current_and_previous_toolchain_during_rollout
  kubernetes:
    supportedMinors: 2
    skew: follow_upstream_and_managed_provider
  postgresql:
    supportedMajors: 2
    upgrade: logical_or_in_place_after_restore_rehearsal
  wireContracts:
    backwardCompatibilityWindow: 2_release_trains
  graphIr:
    readers: current_plus_2_prior
    writers: current_only
  plugins:
    apiCompatibility: semver_plus_capability_contract
```

Dependency automation may open updates but cannot auto-merge runtime, crypto, parser, sandbox, database, broker, provider adapter, or policy-engine changes. Upgrade qualification includes mixed-version operation, rollback, data/schema compatibility, performance, security, and state restore. Preview/experimental database or cross-region features do not enter the production critical path.

## 16.17 Scaling boundaries and triggers

| Component | Primary shard/scale key | Trigger to scale/change |
|---|---|---|
| API | stateless replicas by request/CPU; route to home cell | p95/SLO burn, connection saturation |
| Scheduler | cell + hash shard/tenant fairness; placement by `(tenant_id, environment_id, routing_epoch)` | ready queue/decision latency/DB contention |
| Worker | `WorkerSupervisor`/`WorkerGateway` pool by node type, risk, region, resource shape and priority band | queue residence and slot utilization with provider/DB budgets |
| PostgreSQL | cell; table partitions by time/hash | write IOPS, WAL, lock/CPU, partition size, restore time |
| NATS | cell; `dispatch.<cell>.<pool>.<priority_band>.<shard>` subjects/consumers | storage/replication/ack latency, consumer lag |
| ClickHouse | tenant/time sharding and replicas | ingest/query concurrency, part count, storage |
| OpenSearch | index generation + routing by tenant bucket | shard size/count, heap, query SLO |
| Qdrant | collection/shard key by tenant cohort/dedicated tenant | vector count, filtered latency/recall, memory |
| Object store | provider-native | request rate/prefix hot spot/lifecycle backlog |
| OTel/Grafana | regional gateway/backend sharding | accepted bytes, series/cardinality, query SLO |

Cells are the principal blast-radius and horizontal-scaling unit. Scaling a shared global database/broker indefinitely is not the strategy.

## 16.18 Failure and operational characteristics

| Technology | Expected failure | Platform behavior |
|---|---|---|
| PostgreSQL | primary failover, lock/connection saturation, corrupt/slow replica | stop/queue state transitions if write unavailable; no cache promotion; PITR/restore drills |
| NATS JetStream | duplicate/redelivery, consumer lag, quorum loss | idempotent DB claim; reconciler republishes hints; execution truth remains in DB |
| Valkey | eviction, failover loss, cluster partition | cache miss/conservative limits; never recover execution from cache |
| Object store | timeout, partial upload, delayed delete/list | checksum + manifest/finalize protocol; orphan reconciliation |
| OpenSearch/Qdrant/Neo4j | projection lag/loss/wrong generation | deny stale-sensitive queries or fall back to canonical authorized path; rebuild |
| ClickHouse | ingest duplication/lag, unavailable analytics | idempotent projection/backfill; runtime and billing continue from canonical stores |
| OTel backend | backpressure/outage | bounded collector WAL/sample diagnostics; preserve separate audit/cost path |
| Kubernetes | node/AZ/control-plane disruption | PDB/topology spread/anti-affinity, lease expiry + fencing, capacity degradation |
| gVisor/microVM | incompatibility/cold-start overhead | compatible pool selection; fail node rather than fall back to weaker isolation |
| Vault/KMS/OPA | unavailable/revoked/stale policy | cached bounded signed material where allowed; secrets/effects/governed actions fail closed |

## 16.19 Technology anti-patterns

- **A distributed database because the target number sounds large:** ignores transactional invariants and cell sharding.
- **JetStream message equals work ownership:** permits duplicate/stale workers; PostgreSQL claim/fence is required.
- **Redis/Valkey distributed lock for runtime correctness:** cache failover semantics are insufficient.
- **Kafka plus NATS “for future scale” without distinct workloads:** doubles operational surface before evidence.
- **Graph database for static execution graphs:** typed IR/relational versions are simpler and safer.
- **Vector index as knowledge source:** embedding/index changes are lossy projections.
- **GraphQL mutations for every command:** obscures idempotency, workflow state, and audit semantics.
- **Direct browser subscription to infrastructure buses:** breaks isolation, schema control, and backpressure.
- **One Kubernetes cluster/namespace as the sole tenant boundary:** excessive blast radius and weak defense in depth.
- **Falling back from gVisor/microVM to ordinary containers:** silently weakens a security promise.
- **Latest floating image tags/toolchains:** deployments become irreproducible and rollback-unsafe.
- **Managed service means no runbook:** quotas, failover, restore, identity, and regional outage remain platform responsibilities.
- **Every projection enabled for every deployment:** optional OpenSearch/Qdrant/Neo4j/ClickHouse components must be justified by workload and operated intentionally.
