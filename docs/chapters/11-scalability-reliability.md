# 11. Scalability and Reliability

## 11.1 Capacity envelope and non-negotiable guarantees

“Support 1 million graphs and 100 million executions” is a storage and traffic envelope, not one benchmark number. The initial production design must be load-tested against at least:

| Dimension | Design point | Burst / skew case |
|---|---:|---:|
| Stored graph identities | 1,000,000 | 100 revisions for a hot graph |
| Immutable GraphVersions | 10,000,000 | 50 MiB source/artifact bundle |
| Immutable CompiledPlans | 20,000,000 | multiple compiler/toolchain results for a hot GraphVersion |
| Retained execution summaries | 100,000,000 | 1 tenant owns 10% |
| Execution starts | 2,000/s sustained platform-wide | 10,000/s for 15 minutes |
| Runnable node activations | 20,000/s sustained | 100,000/s for 10 minutes |
| Concurrent executions | 1,000,000 waiting/running | 100,000 active for one tenant |
| Concurrent worker attempts | 200,000 | one capability pool saturates |
| Node activations per execution | p50 20, p95 500 | bounded 1,000,000 expansion descendants |
| Canonical runtime events | 2 billion retained online or tiered | 1,000 events/s for one execution |
| State/checkpoint/artifact bytes | workload-dependent | single value and execution limits enforced |

These are starting assumptions for sizing tests, not promises detached from hardware or tenant quotas. Capacity plans MUST substitute measured bytes per row/event, transactions per activation, provider latency, artifact sizes, retention, and regional traffic.

The system preserves correctness under overload:

1. accepted work is durable before acknowledgement;
2. queue delivery does not grant execution authority;
3. one tenant cannot consume every scheduler, worker, database, or egress permit;
4. overload increases admission/queue latency or yields explicit 429/503 responses; it does not bypass policy or drop canonical events;
5. worker/scheduler scale-out never creates an unfenced second owner;
6. PostgreSQL remains canonical; caches, JetStream consumers, ClickHouse, search, and graph projections are rebuildable;
7. regional failover never permits two writable home cells for one `(tenant_id, environment_id, routing_epoch)` placement;
8. every execution pins its GraphVersion/source hash, successful Compilation, selected CompiledPlan/plan and envelope hashes, dependency lock, PolicySnapshot, deployment binding, and worker compatibility set for its lifetime.

## 11.2 Cell architecture

The platform is divided into self-contained runtime **cells**. A cell limits blast radius and provides a horizontal unit for capacity. The cell directory and tenant home-region policy implement **geo distribution** without stretching a node transaction across regions.

~~~mermaid
flowchart TB
    Global["Global control plane\nidentity, placement directory, deployment catalog"] --> Router["Geo/API routing\ntenant + environment + routing epoch"]
    Router --> A
    Router --> B

    subgraph A["Region A / Cell A-03"]
        APIA["Cell API"] --> PGA[("PostgreSQL shard set")]
        SA["Scheduler shards"] <--> PGA
        OA["Outbox relays"] --> QA["JetStream cluster"]
        PGA --> OA
        QA --> WSA["Trusted WorkerSupervisors"]
        WSA --> GWA["WorkerGateway"]
        GWA <--> PGA
        WSA --> RA["Sandboxed runners\nno broker or DB"]
        WSA --> OBJ[("Regional object storage")]
        PGA --> PA["Projectors"]
    end

    subgraph B["Region B / Cell B-02"]
        APIB["Cell API"] --> PGB[("PostgreSQL shard set")]
        SB["Scheduler shards"] <--> PGB
        OB["Outbox relays"] --> QB["JetStream cluster"]
        PGB --> OB
        QB --> WSB["Trusted WorkerSupervisors"]
        WSB --> GWB["WorkerGateway"]
        GWB <--> PGB
        WSB --> RB["Sandboxed runners\nno broker or DB"]
        WSB --> OBJB[("Regional object storage")]
    end

    PA --> CH[("ClickHouse analytics projection")]
    OBJ -. replicated backups .-> OBJB
~~~

A cell owns:

- a bounded set of `(tenant_id, environment_id)` home assignments, each with a routing epoch;
- PostgreSQL primary/standbys and logical runtime shards;
- scheduler, timer, outbox, and reconciliation services;
- JetStream work subjects;
- WorkerGateway replicas and capability-specific WorkerSupervisor/sandbox pools;
- regional artifact buckets/access points;
- telemetry/projector pipelines.

The global control plane never schedules individual nodes. Its placement directory maps `(tenant_id, environment_id, routing_epoch)` to exactly one writable home cell. A tenant may place separate residency-approved environments in different cells. Every execution pins `environment_id`, `home_cell_id`, and `routing_epoch`; its active execution tree does not straddle writable cells. Cell capacity thresholds trigger placement in a new cell rather than indefinite vertical scaling.

Suggested initial cell envelope, validated by benchmark:

- 50,000 tenant namespaces;
- 100,000 graph identities and 10 million retained executions;
- 2,000 runnable activations/s sustained, 10,000/s burst;
- 20,000 concurrent attempts;
- database utilization below 60% steady and 75% burst;
- at least 30% worker and scheduler headroom during one-zone loss.

Ten cells meet the design point with headroom only if measured workloads match these bounds; a capacity controller adds cells earlier based on storage, WAL, connection, and hot-shard limits.

## 11.3 Workload and storage sizing

### 11.3.1 Activation transaction budget

Approximate canonical transaction rate:

~~~text
T_start    = execution_starts_per_second
A          = mean activations per execution
R          = mean extra attempts per activation
C          = mean controller transitions per activation
T_runtime  = T_start * A * (claim_tx + completion_tx) * (1 + R)
             + T_start * A * C
             + timer_signal_effect_transactions
~~~

At 2,000 starts/s and 20 mean activations, even two core transactions per activation implies 80,000 transactions/s before retries and controller work. This exceeds a single ordinary PostgreSQL primary. The platform therefore partitions tenants across cells and database shards and reduces unnecessary transactions without combining unrelated tenant work into unsafe giant transactions.

Do not size from execution-start rate alone; node activation and state-write amplification dominate.

### 11.3.2 Byte model

~~~text
canonical_bytes_per_execution =
    execution_row
  + activations * (token + attempt + dependency + state_delta + event_index)
  + checkpoints
  + artifact_manifests
  + logs_manifests
  + audit/outbox/idempotency overhead

object_bytes_per_execution =
    node_outputs + large_state + checkpoint_snapshots + log_chunks + model/tool payloads

retained_bytes =
    daily_executions * retention_days * bytes_per_execution
    / compression_ratio
    * replication_and_backup_factor
~~~

The benchmark suite records p50/p95/p99 bytes for each component. A capacity decision using averages alone is rejected because fan-out, logs, and model artifacts are heavy-tailed.

### 11.3.3 Retention tiers

- **hot canonical:** active executions and recent terminal metadata/events in PostgreSQL;
- **warm canonical:** partitioned PostgreSQL terminal summaries plus immutable history/artifact manifests;
- **cold canonical archive:** signed, checksummed export bundles in object storage, indexed by retained PostgreSQL archive manifests;
- **analytics projection:** ClickHouse, rebuildable from canonical event exports/outbox;
- **cache:** Redis/Valkey, disposable.

Archiving is a state transition with manifest, checksum, schema versions, encryption key id, object retention policy, and restore test. Dropping a PostgreSQL partition before the archive manifest is verified is forbidden.

## 11.4 PostgreSQL scale strategy

### 11.4.1 Partitioning

Tenant routing selects a database shard. Within a shard:

- GraphVersion/Compilation/CompiledPlan tables use tenant hash partitioning where row count requires it;
- high-volume execution, token, attempt, event, log-manifest, metric-rollup, and audit tables include tenant_id and time/UUIDv7 locality;
- terminal history uses time subpartitions for retention and archive;
- active tokens have partial indexes only for READY, RUNNING, RETRY_WAIT, and BLOCKED states;
- JSONB is used for bounded typed payloads, not unindexed arbitrary query workloads;
- large bodies are object artifacts, not TOAST-heavy rows.

All unique constraints for partitioned runtime records include the partition key. Cross-shard foreign keys are not attempted. A tenant and its active execution tree remain on one database shard.

All entity IDs are UUIDv7 stored as PostgreSQL UUIDs so high-volume indexes retain time locality. Deterministic identities—Activation, effect, source, semantic plan, envelope, and value hashes—are domain-separated SHA-256 values. ULID text and mixed UUID/ULID encodings are not permitted in canonical rows or messages.

### 11.4.2 Connection and transaction discipline

- use a transaction-pooling proxy for stateless APIs/projectors;
- reserve session connections for advisory-lock users only;
- keep scheduler/WorkerGateway transactions short and never hold a lock during model/tool execution;
- use prepared statements and bounded statement/lock timeouts;
- enforce per-service connection budgets;
- batch append-only event/outbox inserts when they share an execution transaction, not across authority boundaries;
- monitor WAL bytes/activation, replication lag, vacuum debt, bloat, buffer hit rate, lock waits, and oldest transaction.

Autovacuum is tuned per high-churn table. Token current-state rows may be separated from immutable attempts/events to reduce update bloat. Periodic partition creation and safe detach/archive are automated and rehearsed.

### 11.4.3 Shard placement and hot tenants

Consistent hashing with virtual placement buckets maps tenant environments to shards, but the directory stores an explicit `(tenant_id, environment_id)` assignment so a hot placement can move independently. New executions route to the destination after a fenced routing epoch. Existing execution trees either drain in the source or move through a checkpoint/export/import process; they never straddle writable shards.

A whale tenant can receive a dedicated cell/database shard. A single execution with extreme state-write frequency remains serialized by design; it should split parallel work into child executions rather than forcing platform-wide weakened consistency.

## 11.5 Queue system and scheduler scalability

### 11.5.1 Queue topology

JetStream dispatch subjects use one bounded taxonomy segmented by cell, WorkerSupervisor pool, coarse priority, and virtual shard:

~~~text
dispatch.<cell>.<pool>.<priority_band>.<shard>
control.<cell>.<execution_bucket>
reconcile.<cell>.<adapter>
project.<cell>.<event_family>
~~~

Tenant ID, environment ID, execution-token ID, routing epoch, plan hash, and monotonic readiness generation remain message fields. Creating an internal runtime subject per tenant or execution would be operationally unbounded. Consumers are durable per WorkerSupervisor pool, not per individual supervisor or sandbox.

The public lifecycle-export edge is a deliberate, separately scaled exception: one regional JetStream stream matches `tenants.*.execution.lifecycle.v1`, while an exact tenant subject and quota-bounded consumer exist only for an authorized subscription and expire after inactivity. Broker credentials restrict the exact subject. The export projector derives channel tenant, header tenant, and payload tenant from one authenticated projection context and rejects any mismatch. This edge never dispatches work or determines execution state; backpressure, retention, consumer count, and per-tenant delivery quotas are isolated from runtime streams.

Queue messages are small notifications. Inputs/results stay in PostgreSQL/object storage. `Nats-Msg-Id` is exactly `outbox_message.id`; relay retries reuse it. Each later readiness/retry transition creates a fresh outbox UUIDv7 and increments `readiness_generation`, while the payload retains the stable `execution_token_id`. WorkerGateway's PostgreSQL compare-and-set is the final duplicate defense.

### 11.5.2 Scheduler virtual shards

Scheduler virtual shard:

~~~text
scheduler_shard = hash(tenant_id, execution_id) mod N_virtual
~~~

N_virtual is much larger than scheduler replicas, for example 16,384 per cell. A coordinator assigns ranges under fenced leases. Rebalancing moves virtual shards without rewriting executions.

Scheduler replicas consume dirty-execution notifications and also scan canonical indexes using cursors. Notifications reduce latency; scans guarantee recovery. Per-execution reduction is serialized, while different executions advance concurrently.

The scan pattern is bounded:

~~~sql
SELECT tenant_id, execution_id
FROM execution_wakeup
WHERE scheduler_shard = ANY(:owned_shards)
  AND available_at <= clock_timestamp()
ORDER BY available_at, execution_id
FOR UPDATE SKIP LOCKED
LIMIT :batch;
~~~

Wakeups are coalesced by execution. Ten node completions for one execution should normally cause one reduction pass, not ten simultaneous scheduler transactions.

### 11.5.3 Fair scheduling

Each tenant/service class has a token bucket and deficit counter. The dispatcher uses hierarchical deficit round robin:

~~~text
for service_class in weighted_round_robin(classes):
    for tenant in deficit_round_robin(active_tenants[class]):
        tenant.deficit += tenant.quantum
        while next_work.cost_units <= tenant.deficit
              and tenant has concurrency/budget permit:
            dispatch next_work
            tenant.deficit -= next_work.cost_units
~~~

Cost units approximate scarce resources: worker seconds, GPU slices, outbound calls, or model-provider quota. Estimates are corrected with actual usage. Age/deadline affects order within a tenant but cannot bypass tenant limits.

## 11.6 Worker and execution scaling

Trusted WorkerSupervisors are stateless between claimed attempts. Separate pools by capability, isolation, region, resource class, and trust:

- deterministic Rust/function workers;
- sandboxed Python/JavaScript;
- network-restricted and network-enabled pools;
- model-provider adapters;
- GPU/embedding pools;
- private tenant connector pools;
- human/timer nodes, which suspend without workers.

Placement uses required capability plus labels, not graph/node kind alone. A Python node requesting a private database and high-sensitivity secret cannot run in the generic public-egress pool.

Large input artifacts are fetched from regional object storage using short-lived references scoped by WorkerGateway/ExecutionGrant. They do not pass through the scheduler or queue. A sandbox may receive a single-purpose artifact credential but never broker or PostgreSQL credentials.

WorkerSupervisors advertise capacity leases. The scheduler does not reserve a named pod far in advance; it publishes to a capability pool after obtaining tenant and global permits. A trusted supervisor consumes the hint and calls `WorkerGateway.ClaimExecutionToken`; the gateway alone compare-and-sets PostgreSQL, creates the Attempt, and returns a lease plus audience-bound ExecutionGrant. The sandbox has neither broker nor database access.

Every claim, heartbeat, failure, and completion carries and validates `routing_epoch`, `attempt_ordinal`, `fencing_token`, unexpired `lease_expires_at`, and `plan_hash`; transitions depending on scheduler ownership also validate `scheduler_fence`. The gateway checks authenticated supervisor identity and database time. A stale epoch, plan, scheduler fence, attempt fence, owner, or expired lease fails closed.

## 11.7 Backpressure

Backpressure is applied at multiple boundaries:

~~~mermaid
flowchart LR
    Client -->|admission quota| API
    API -->|durable accepted executions| DB
    DB -->|scheduler wakeup cap| Scheduler
    Scheduler -->|tenant + capability permits| Queue
    Queue -->|max in-flight / credits| Supervisor["WorkerSupervisor"]
    Supervisor -->|claim / heartbeat / complete| Gateway["WorkerGateway"]
    Gateway -->|fenced state/event write budget| DB
    Supervisor -->|isolated invocation| Sandbox
    Sandbox -->|adapter rate limit| Provider
    DB -->|projection lag budget| Projector
~~~

### 11.7.1 Admission states

The admission controller returns:

- **ACCEPTED:** durable execution created;
- **DEFERRED:** durable execution admitted in a delayed priority lane where contract allows it;
- **429 QUOTA_EXCEEDED:** tenant rate/concurrency/budget limit, with retry-after;
- **503 CAPACITY_UNAVAILABLE:** cell safety threshold reached before durability;
- **4xx/REJECTED admission decision (no Execution):** schema, authentication, authorization, policy, capacity, or deadline is infeasible; record the idempotency/admission decision and return the typed API error without creating an Execution status row.

`ADMITTED` is therefore the first Execution status and exists only after ACCEPTED durability. Once ACCEPTED is returned, capacity pressure cannot silently delete the execution. It may remain queued within its declared latest-start/deadline policy.

### 11.7.2 Signals

Backpressure decisions use:

- ready-token age and depth by capability and service class;
- predicted drain time, not depth alone;
- tenant inflight/reserved resource units;
- database CPU, WAL, lock time, connection utilization, replica lag, and storage headroom;
- queue consumer lag and redelivery;
- worker saturation and startup time;
- provider quotas/rate-limit windows;
- object-store and egress throttling;
- projector lag only when retention pressure threatens canonical storage.

### 11.7.3 Fan-out control

Fan-out controllers page expansion manifests and maintain max_inflight_children. Child completion returns a permit that allows materializing/publishing another page. Limits exist per loop, execution, tenant, capability, and cell.

A fan-in with 1 million children stores paged dependency summaries and incremental counts. It does not lock or load all child rows on every completion. Counts are treated as projections and verified before the join transitions.

### 11.7.4 Load shedding

Allowed shedding:

- reject new best-effort admission;
- delay best-effort scheduling;
- sample non-audit debug logs before canonical ingestion according to declared policy;
- pause rebuildable projectors;
- disable speculative cache warming and prefetch;
- reduce optional parallel candidates.

Forbidden shedding:

- drop accepted canonical transitions, audit records, or budget charges;
- skip authorization/policy validation;
- acknowledge work that was neither claimed nor terminal;
- evict the only copy of a result/checkpoint;
- execute above tenant/global safety limits.

## 11.8 Autoscaling

### 11.8.1 Worker pools

Autoscaling targets **predicted seconds of work**, not CPU alone:

~~~text
backlog_work_seconds =
    sum(ready_tokens_by_class * EWMA_or_quantile_duration_by_node_class)

desired_workers =
    ceil(backlog_work_seconds / target_drain_seconds)
    + running_tokens_needing_slots

desired_workers =
    clamp(min_replicas, max_replicas,
          min(desired_workers, provider_quota_slots, db_safe_claim_rate_slots))
~~~

Use p70–p90 duration for burst planning when distributions are heavy-tailed. Separate scale-up and scale-down windows. Keep warm capacity for slow-starting GPU/sandbox pools. Maximum replicas are constrained by database claim/completion capacity and downstream provider quotas; scaling pods beyond those points makes overload worse.

### 11.8.2 Scheduler, API, and projectors

- API scales on request rate, latency, and connection budget.
- Scheduler scales on dirty-execution rate, reduction CPU, and oldest runnable age; virtual shards rebalance.
- Outbox relay scales on unpublished rows and oldest outbox age, capped by queue publish capacity.
- Projectors scale on event lag bytes/time and destination write capacity.
- Timer service scales on due-timer scan latency.

Database scaling is primarily cell/shard placement, read replicas for authorized read paths, partition maintenance, and carefully benchmarked vertical headroom. Autoscaling a primary database is not treated as instant.

### 11.8.3 Scale stability

Every autoscaler includes:

- minimum/maximum and change-rate limits;
- cooldown and stabilization windows;
- missing-metric behavior that fails safe;
- per-capability SLO and cold-start model;
- zone-spread constraints;
- load test validating that scale-out does not exhaust DB connections;
- override with expiry and audit.

## 11.9 Caching

Cache hierarchy:

| Cache | Key requirements | Authority / invalidation |
|---|---|---|
| CompiledPlan/package | immutable semantic plan or artifact digest | Safe until artifact revoked; revocation checked separately |
| Policy/authorization | tenant, actor, operation, resource version, policy version | Short TTL and explicit invalidation; never used after expiry |
| Node pure result | implementation, config, canonical input, declared state reads, policy/model pins | Optional optimization; result schema/hash revalidated |
| Model response | exact request/model/route/policy hash, tenant scope | Only when policy permits; sensitive payload encrypted |
| Artifact edge cache | content hash and tenant/key scope | Object hash verified |
| Query/read model | projection generation and offset | UI/read optimization only |

Redis/Valkey contains no sole copy of a lease, token, budget, state version, idempotency decision, or authorization grant. Cache stampedes are controlled with request coalescing and bounded stale-while-revalidate only for non-authoritative reads.

Cross-tenant cache sharing is forbidden unless the value is explicitly public, content-addressed, unclassified, and policy allows it. Hash equality does not prove sharing authorization.

## 11.10 Load balancing and locality

External requests use latency-aware geo routing constrained by data residency, then the placement directory resolves `(tenant_id, environment_id, routing_epoch)` to the home cell. Admission pins the result on the execution. Requests carrying an old routing epoch receive a redirect/retry response; they are not written in both cells.

Within a cell:

- API uses zone-aware least-request/load balancing;
- scheduler work uses virtual-shard assignment;
- queue consumers use capability pools;
- private connectors use tenant/region placement;
- artifact reads prefer regional replicas;
- provider adapters route by allowed model/provider, quota, health, cost policy, and residency.

Sticky sessions are unnecessary for API correctness. WebSocket/UI streams can reconnect using event/state cursors.

## 11.11 Availability model

### 11.11.1 In-region high availability

Each production cell spans at least three zones where the region supports them:

- PostgreSQL synchronous standby across zones with automated, fenced promotion;
- odd-sized JetStream quorum across zones;
- API/scheduler/outbox/timer/projector replicas spread across zones;
- worker disruption budgets and spare capacity for one-zone loss;
- object storage with regional durability and versioning;
- no single-zone NAT, secret, KMS, registry, or DNS dependency.

A component restart may duplicate notifications or attempts but cannot violate token fencing. During database failover, claims and completions pause. WorkerSupervisors may retain/upload immutable result artifacts within a bounded grace period, but WorkerGateway accepts canonical completion only before database-observed lease expiry and under the current routing epoch, scheduler fence where applicable, attempt fence, owner, and plan hash. A stale result must be reconciled or recomputed by a new Attempt.

### 11.11.2 Multi-region model

The default is active-active **across tenant environments**, active-passive **for one `(tenant_id, environment_id)` placement**:

~~~text
tenant T / production, routing epoch 41 -> Region A writable, Region B recovery replica
tenant T / development, routing epoch 12 -> Region B writable, Region A recovery replica
~~~

This avoids synchronous cross-region consensus on every node transition. Cross-region reads of sensitive current state route to the home region or an explicitly authorized lagging replica.

Failover protocol:

1. incident controller proves or declares the old region fenced from writes;
2. stop/expire the global route for the old `(tenant, environment, cell, epoch)`;
3. verify replication/archive position and choose recovery point;
4. promote recovery database/object access;
5. increment the placement routing epoch in a strongly controlled directory;
6. start cell services with the new epoch;
7. recover checkpoints/history and reconcile outstanding effects;
8. publish traffic gradually and audit data-loss window;
9. old region may rejoin only as a new non-writer replica.

If the old region cannot be proven fenced, failover requires an explicit risk decision; automatic dual writers are worse than temporary unavailability.

### 11.11.3 Optional synchronous premium tier

Tenants requiring cross-region RPO 0 may use a synchronously replicated consensus database or dual-region PostgreSQL-compatible service validated for the workload. This adds write latency, provider dependency, cost, and correlated-control-plane risk. The runtime invariants remain the same; marketing must not claim RPO 0 without end-to-end effect/artifact replication evidence.

## 11.12 Disaster recovery

Service tiers must be contractual and tested:

| Tier | Example target | Architecture | Trade-off |
|---|---|---|---|
| Regional standard | RPO ≤ 5 min, RTO ≤ 30 min | async cross-region WAL/archive plus replicated object artifacts | recent committed work may require reconciliation or be lost within stated RPO |
| Regional enhanced | RPO ≤ 1 min, RTO ≤ 15 min | tighter replication, pre-warmed cell | higher cost |
| Multi-region synchronous | RPO 0 target, RTO ≤ 10 min | synchronous consensus data plane and dual-region artifact commit | higher latency/complexity; effects still destination-dependent |

Backups:

- continuous WAL/archive and point-in-time recovery;
- daily full/base backups with immutable retention;
- object versioning, cross-region replication, and inventory checks;
- tenant-directory, KMS metadata, package/plugin artifacts, schemas, policy revisions, and deployment bindings included;
- encryption keys protected by independently recoverable KMS process;
- backup credentials separated from runtime credentials;
- deletion/retention controls resistant to the same administrator compromise.

A backup is not accepted until an isolated restore verifies checksums, schema migration level, random execution replay, checkpoint recovery, object references, audit-chain continuity, and application queries. Restore drills occur at least quarterly and after material storage/schema changes.

## 11.13 Reliability objectives and error budgets

Initial objectives, refined from measurements and customer tier:

| Indicator | Target |
|---|---|
| Authenticated control/read API availability | 99.95% monthly per region |
| Accepted execution durability under single-zone failure | no acknowledged canonical work loss |
| Admission latency excluding artifact upload | p99 ≤ 500 ms under quota |
| READY-to-claimed scheduler latency | p99 ≤ 2 s under quota and available capability |
| Durable cancellation request acknowledgement | p99 ≤ 500 ms |
| Runtime state-transition error caused by platform | < 0.01% activations |
| Outbox oldest age | p99 ≤ 2 s normal; alert at capability-specific threshold |
| Projection freshness | p99 ≤ 60 s, explicitly non-authoritative |
| Standard regional DR | RPO ≤ 5 min, RTO ≤ 30 min, proven by drills |

Provider/model/tool latency and failures are reported separately from platform overhead. An unavailable requested capability is not counted as successful platform scheduling simply because the token stayed queued.

Error-budget policy gates risky releases, cell migrations, and new plugin enablement. SLO burn is segmented by platform, tenant configuration, provider, and user code without hiding shared-platform causes.

## 11.14 Failure containment and recovery matrix

| Failure | Blast radius | Automatic behavior | Escalation |
|---|---|---|---|
| Worker pod/node/zone | pool/zone | lease expires; fenced retry; spare workers scale | UNKNOWN effects reconcile |
| Scheduler replica | virtual shards | leases reassign; canonical scan resumes | alarm on oldest wakeup |
| JetStream unavailable | cell dispatch latency | canonical outbox grows; DB scans preserve visibility; admission throttles before unsafe WAL/storage | recover quorum and replay outbox |
| Redis unavailable | cache/rate-assist latency | fall back to PostgreSQL/policy service and conservative quotas | disable cache-dependent optimizations |
| ClickHouse unavailable | analytics/observability projection | canonical execution continues; retain/project later | shed nonessential telemetry before canonical data |
| PostgreSQL standby failover | database shard | claims pause; fenced promotion | reconcile connections, leases, effects |
| PostgreSQL shard loss | affected tenants | regional DR restore/failover | execute runbook and disclose RPO |
| Object store regional outage | artifact-dependent work | stop transitions requiring unavailable durable artifact; retry reads | fail over verified replicas |
| Provider quota collapse | provider/capability | circuit break, route allowed fallback, backpressure | customer-visible capability incident |
| Hot tenant/fan-out | tenant and possibly shard | tenant permits, paging, fair scheduling | move/dedicate shard/cell |
| Bad graph/plugin version | selected executions | deployment kill switch; stop new attempts; rollback deployment for new executions | fork/recover affected runs |
| Control-plane directory partition | affected routing | cached epoch may serve reads; writes fail closed after bounded lease | restore quorum; never accept competing epochs |

## 11.15 Deployment and schema reliability

Application rollout:

- immutable images and signed artifacts;
- canary by internal tenant/cell, then low-risk production tenants;
- compatibility with current and previous event/IR/schema versions;
- max unavailable respects one-zone-loss headroom;
- automatic rollback on SLO burn, invariant errors, DLQ growth, or recovery mismatch;
- no rollout simultaneously removes old consumers and starts new producers for a breaking event.

Database migration:

1. expand schema with backward-compatible nullable/default-safe objects;
2. deploy dual-read/write or backfill code where required;
3. backfill in bounded, pausable batches with tenant/time cursors;
4. verify counts, hashes, constraints, replica lag, and replay;
5. switch reads using a versioned feature gate;
6. wait through rollback window;
7. contract old schema in a later release.

DDL that rewrites a high-volume table is rehearsed on production-scale copies. Partition/index creation uses online/concurrent methods where supported and explicit lock timeout.

## 11.16 Observability for scale and reliability

Required cell dashboards:

- admission rate/rejections/deferred by service class and reason;
- execution start, activation ready/claim/complete, and attempt retry rates;
- queue depth, oldest age, predicted drain time, redelivery, and ack latency by capability;
- scheduler reduction latency, dirty-execution backlog, shard ownership churn, and DB conflicts;
- worker slots, utilization, cold starts, lease loss, fence rejection, and UNKNOWN effects;
- PostgreSQL transactions, WAL, locks, vacuum, bloat, connections, replication lag, storage growth, and partition horizon;
- outbox age/publish attempts and projector lag/generation;
- object upload/read integrity and orphan/missing-reference counts;
- tenant fairness, top resource-unit consumers, and fan-out throttling;
- SLO/error-budget burn by cell and dependency;
- backup age, restore-test age, DR lag, routing epoch, and recovery readiness.

High-cardinality execution/graph/tenant ids belong in traces/logs with controlled access, not Prometheus labels. Metrics aggregate by cell, capability, tier, outcome, and bounded reason code.

Capacity forecasts use at least 30 days of p95 and peak trends for storage, WAL, starts, activations, duration, artifact bytes, and provider demand. Alerts include time-to-exhaustion, not only current percentage.

## 11.17 Chaos and scale qualification

Before a cell is production-ready, automated tests must demonstrate:

1. 10,000 execution starts/s burst and 100,000 activations/s burst without lost accepted work;
2. 1 million concurrent waiting/running executions with bounded scheduler scan latency;
3. hot tenant and million-child fan-out remain within their fair-share/concurrency limits;
4. worker duplication, pause, crash, and network partition are contained by claim/fence logic;
5. scheduler replica and whole-zone loss preserve readiness and p99 targets within documented degradation;
6. JetStream and Redis can be erased and rebuilt without canonical state loss;
7. projector pause for the retention design window does not block runtime correctness;
8. PostgreSQL failover rejects stale writes and recovers leases/outbox;
9. object-store partial failure cannot commit a checkpoint referencing missing bytes;
10. autoscaler scale-out does not exhaust PostgreSQL/provider capacity;
11. region evacuation meets measured RPO/RTO and leaves one writer per tenant/environment placement;
12. point-in-time restore plus artifact inventory replays sampled executions;
13. load test with p99-sized graphs/state/artifacts, not only tiny fixtures;
14. sustained soak exposes vacuum, partition, memory, connection, and redelivery leaks;
15. retrying one stable ExecutionToken uses a new outbox ID/readiness generation and is not suppressed by JetStream deduplication;
16. stale routing epoch, scheduler fence where applicable, attempt fence, owner, lease expiry, or plan hash is rejected at WorkerGateway;
17. network policy proves sandboxes cannot reach JetStream or PostgreSQL directly.

Fault injection occurs at transaction boundaries, during external effects, during checkpoint upload, and while routing epochs change. Passing happy-path throughput alone is not scalability proof.

## 11.18 Decisions and trade-offs

| Decision | Why chosen | Alternative | Performance/scalability/operations |
|---|---|---|---|
| Cell-based architecture | Bounded blast radius and repeatable horizontal unit | One global cluster | More fleet automation and tenant routing; incidents and scaling are bounded |
| Tenant-environment home cell / single writer | Prevent split brain and cross-region transaction latency | Active-active writes for one placement | Failover is deliberate; normal path is simpler and faster |
| PostgreSQL tenant sharding | Strong canonical transactions and familiar operations | Globally distributed KV as primary | Shard placement/migration needed; relational invariants retained |
| JetStream as notification transport | Durable low-latency dispatch with DB authority | Queue as ledger | Extra DB claim; safe rebuild and duplicate handling |
| Virtual scheduler shards | Fine-grained rebalance without data movement | One scheduler leader | Lease/fence coordination; high parallelism |
| Hierarchical fair-share permits | Tenant isolation under heterogeneous workloads | FIFO | Scheduling accounting; avoids noisy-neighbor starvation |
| Work-seconds autoscaling | Tracks I/O/model-heavy tasks better than CPU | CPU-only HPA | Requires duration models and safeguards |
| Object storage for large payloads | Cheap durable scale, avoids DB/queue bloat | Inline all values | Artifact availability/integrity becomes a first-class SLO |
| Rebuildable ClickHouse/cache projections | Protects canonical authority | Analytics/cache as truth | Event projection lag and rebuild tooling required |
| Async regional DR by default | Low normal-path latency and cost | Synchronous every write | Nonzero stated RPO; premium tier available for justified cases |

## 11.19 Rejected anti-patterns

- a single global scheduler leader;
- one internal runtime queue subject/topic per graph, execution, or tenant; public tenant-isolated export subjects are permitted only through the bounded edge model in Section 11.5.1;
- scaling worker replicas without considering database/provider bottlenecks;
- queue depth alone as an autoscaling signal;
- storing model inputs/results inside queue messages;
- using Redis as the only token, lease, budget, or idempotency store;
- unpaged dynamic fan-out;
- cross-region active-active writes without a conflict-free execution-state proof;
- calling replicas “RPO 0” without measuring commit and artifact durability;
- backups without isolated restore and replay;
- archiving by deleting partitions before checksum/manifests verify;
- metric labels containing tenant, graph, execution, activation, prompt, or arbitrary error text;
- allowing best-effort analytics traffic to compete unboundedly with runtime commits.
