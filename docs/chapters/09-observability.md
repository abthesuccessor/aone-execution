# 9. Observability, Diagnostics, and Replay

This chapter defines observability as part of execution correctness, not as an operations add-on. Every graph run must be explainable from admission through terminal state, including which artifact versions ran, what state each node observed, which external effects occurred, why a route was selected, how much it cost, and which authorization decisions allowed it. Telemetry may be sampled; the execution ledger, cost ledger, and audit trail may not.

## 9.1 Goals and non-negotiable invariants

The implementation must satisfy these invariants:

1. Persisted entity identifiers such as `execution_id`, `graph_version_id`, `compiled_plan_id`, and `attempt_id` are UUIDv7. `activation_id` is the deterministic SHA-256 identity of one logical node activation across retries. Retries create new UUIDv7 `attempt_id` values without changing `activation_id`.
2. Runtime truth is the committed execution event/checkpoint stream in PostgreSQL and object storage. Metrics, logs, traces, search indexes, and analytical tables are rebuildable projections.
3. A state transition and its outbox record commit in the same database transaction. No dashboard may claim a transition that the runtime did not commit.
4. Every asynchronous command carries W3C `traceparent`/`tracestate`, but causally related work that is not a strict call child uses a span link. Trace parentage must not lie about queue time or fan-in.
5. Tenant, project, environment, graph version, execution, node, model, provider, region, and deployment revision are queryable dimensions. Unbounded identifiers are forbidden as Prometheus labels.
6. Prompt text, tool arguments, model output, state values, secrets, access tokens, end-user content, and raw database statements are denied from telemetry by default.
7. Financial usage is an append-only decimal ledger based on provider usage and an effective-dated price version. A floating-point dashboard estimate is never the billing source.
8. Replay cannot repeat an external side effect unless an explicit, authorized replay policy permits it.
9. Audit records are logically separate from diagnostic logs, append-only, tenant-scoped, integrity protected, and retained according to policy or legal hold.
10. A telemetry-backend outage must not stop graph execution until the bounded local buffer is exhausted. Audit persistence and budget enforcement fail closed where policy requires them.

## 9.2 Signal and storage architecture

OpenTelemetry (OTel) is the instrumentation and transport contract. The platform extends the official semantic conventions under the `ege.*` namespace and pins the convention schema version in each resource. The official convention model spans traces, metrics, logs, events, and resources; extensions must follow its naming and cardinality rules ([OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/otel/semantic-conventions/)).

```text
 Browser/CLI/SDK
      | traceparent + request_id
      v
 API Gateway -> Control Plane -> Scheduler -> JetStream -> WorkerSupervisor
      |              |              |            |             |
      |              |              |            |      WorkerGateway -> Sandbox
      +--------------+--------------+------------+-------------+---------+
                                     OTLP/gRPC
                                         |
                             node-local OTel Collector
                             (memory limiter, batch, WAL)
                                         |
                              regional telemetry gateway
                              +----------+----------+
                              |                     |
                          Prometheus             Tempo/Loki
                            /Mimir              traces + logs
                              |                     |
                              +------- Grafana -----+
                                         |
                                         v
                                  Execution Inspector

 Runtime transaction:
 PostgreSQL execution_event + outbox_event
              |                    |
              |           outbox relay -> JetStream projection hints
              |                                  |
              |                         projection workers -> ClickHouse
              |                                  timeline/cost/failure
              +-> checkpoint/object references -> audit archive (WORM)
```

The node-local collector protects applications from backpressure and performs only deterministic transformations: resource enrichment, attribute allow-listing, secret-pattern redaction, batching, and tail-sampling handoff. Regional gateways perform tenant-aware quotas and tail sampling. They never receive credentials that grant access to runtime state.

The telemetry topology follows the authority topology: `WorkerSupervisor` is the trusted JetStream consumer, while `WorkerGateway` is the sole authority for worker-originated completion/effect database mutations. The Coordinator separately persists control-node transitions through the shared transition library. The gateway mints each proof-of-possession/mTLS-bound `ExecutionGrant`, persists its hash and constraints, and validates it when the supervisor presents it on gateway RPCs. The supervisor cannot use the grant for direct database, broker, or secret access. Sandboxes emit bounded telemetry through their local host channel but receive only opaque capability handles—never NATS or database connectivity, the grant token, or secret material.

### 9.2.1 Signal ownership

| Signal | Truth/guarantee | Primary backend | Typical retention | Loss policy |
|---|---|---|---|---|
| Execution events/checkpoints | Runtime source of truth | PostgreSQL + S3-compatible object storage | hot 30-90 days; archive per tenant | no acknowledged loss |
| Audit events | Compliance evidence | PostgreSQL outbox -> immutable object archive + indexed projection | 1-7 years/configured legal hold | fail closed for governed actions |
| Cost ledger | Billing and budget truth | PostgreSQL, replicated to ClickHouse | life of account + finance policy | no acknowledged loss |
| Metrics | Aggregate health/SLOs | Prometheus/Mimir | 15 months aggregate | bounded loss acceptable |
| Traces | Request/run diagnosis | Tempo/object storage | 7-30 days, selected traces longer | sampled except error/security traces |
| Diagnostic logs | Search and debugging | Loki; large payload refs in object storage | 7-30 days | bounded loss acceptable |
| Profiles | Opt-in CPU/heap diagnosis | profile backend/object storage | 3-7 days | sampled; never tenant payloads |
| Timeline/failure projection | UI analytics | ClickHouse | 90-400 days | rebuild from ledger/outbox |

Retention is a policy per tenant and data class. Deletion writes a tombstone and projection purge job; it never silently edits an audit record. Legal hold overrides normal expiry.

## 9.3 Correlation and semantic conventions

### 9.3.1 Resource attributes

Every process emits stable resource attributes:

```yaml
service.name: execution-worker
service.namespace: ege
service.version: "${IMAGE_DIGEST}"
service.instance.id: "${POD_UID}"
deployment.environment.name: prod
cloud.region: ap-northeast-1
k8s.cluster.name: prod-apne1-cell-03
ege.cell.id: cell-03
ege.semconv.version: 1.0.0
```

`service.instance.id`, pod UID, commit SHA, and image digest belong on resources/spans and logs, not metrics labels. A deployment manifest records exact collector and semantic-convention versions so queries can bridge migrations.

### 9.3.2 Execution attributes

The following attributes are allowed on spans and structured logs. Only the bounded subset marked **metric** may appear on metrics.

| Attribute | Meaning | Metric? | Sensitivity |
|---|---|---:|---|
| `ege.tenant.id_hash` | HMAC-derived stable tenant bucket key | no | confidential |
| `ege.plan.tier` | `free`, `team`, `enterprise`, `internal` | yes | internal |
| `ege.project.id` | project UUID | no | confidential |
| `ege.environment` | `dev`, `staging`, `prod` | yes | internal |
| `ege.graph.id`, `ege.graph.version` | immutable graph artifact identity | no | confidential |
| `ege.compiled_plan.id`, `ege.plan.hash` | immutable compiled runtime identity | no | confidential |
| `ege.execution.id`, `ege.attempt.id` | logical run and admission attempt | no | confidential |
| `ege.node.id`, `ege.node.type` | node artifact identity and bounded type enum | type only | internal |
| `ege.activation.id`, `ege.node.attempt_id`, `ege.node.attempt_ordinal` | logical activation, concrete attempt, and attempt number | no | confidential |
| `ege.runtime.status` | bounded state enum | yes | internal |
| `ege.queue.class` | interactive/batch/system | yes | internal |
| `ege.failure.class` | bounded failure taxonomy | yes | internal |
| `ege.model.provider`, `ege.model.family` | bounded provider and model family | yes | internal |
| `ege.policy.decision` | allow/deny/require_approval | yes | confidential |
| `ege.execution.mode` | `LIVE`, `REPLAY`, or `SIMULATION` | yes | internal |
| `ege.replay.operation` | `STATE_REBUILD`, `EXACT_REPLAY`, or `FORKED_REPLAY`; absent outside replay | yes | internal |
| `ege.replay.effect_mode` | `SUBSTITUTE_RECORDED`, `REEXECUTE_READ_ONLY`, `REEXECUTE_AUTHORIZED_EFFECT`, or `FORBID`; absent when no adapter is involved | yes | internal |

Raw UUIDs, user IDs, graph names, node labels, URLs, tool arguments, exception messages, and model names controlled by users are never metric labels. The collector drops unknown `ege.*` attributes in production; new attributes require a semantic-convention review and cardinality estimate.

### 9.3.3 Context propagation

- Synchronous HTTP/gRPC calls propagate `traceparent` and `tracestate`.
- Queue envelopes copy trace context into headers. The trusted `WorkerSupervisor` that consumes JetStream creates a `CONSUMER` span linked to the producer span and records queue residence separately. A sandbox is a child invocation behind `WorkerGateway`; it never consumes the broker directly.
- Fan-out children link to the dispatch span. Fan-in links to every completed branch but chooses the merge activation as its single parent.
- A resumed checkpoint starts a new trace if the original trace is past retention; it links to the persisted prior span context and always shares `execution_id`.
- `baggage` is limited to bounded routing hints (`ege.environment`, `ege.cell.id`, sampling flag). Tenant or user identifiers, authorization claims, secrets, and data classification do not travel in baggage.
- Browser trace context is accepted only after the gateway validates format and starts a new trusted server span; externally supplied sampling and tenant attributes are ignored.

## 9.4 Distributed tracing model

### 9.4.1 Canonical spans

```text
ege.execution {execution_id, graph_version_id, compiled_plan_id, plan_hash} SERVER/INTERNAL
  ege.admission                                               INTERNAL
    policy.evaluate                                            CLIENT
    quota.reserve                                              CLIENT
  ege.compile_or_load_plan                                    INTERNAL
  ege.schedule                                                PRODUCER
    [link] ege.node.consume                                   CONSUMER
      ege.node.execute                                        INTERNAL
        ege.context.assemble                                  INTERNAL
        ege.model.invoke / ege.tool.invoke / ege.code.run     CLIENT
        ege.output.validate                                   INTERNAL
        ege.checkpoint.commit                                 CLIENT
        ege.next.schedule                                     PRODUCER
  ege.finalize                                                INTERNAL
```

Span names are operations, not identifiers. `ege.node.execute` is correct; `run node customer-42/summarize` is forbidden. Each span records `error.type` and a bounded platform failure code; exception stack traces are emitted only to an access-controlled log event and are stripped of values.

The root execution span is a convenience trace view, not the durable execution record. Runs lasting longer than backend trace limits are represented as trace segments (`segment_seq`) linked by persisted span context. The UI stitches segments using execution events, never by assuming one infinitely long trace.

### 9.4.2 Sampling

Head sampling preserves predictable baseline volume; tail sampling preserves diagnostic value:

| Class | Policy |
|---|---|
| failed, timed out, policy denied, suspected security event | 100% |
| SLO-violating latency or cost | 100% |
| replay, approval, production deployment canary | 100% |
| new graph/model/plugin revision during first 24h | 25%, budget capped |
| successful production execution | adaptive 0.1-5% per tenant/tier |
| development execution with debug grant | up to 100%, short retention |

The regional gateway enforces a per-tenant byte budget so a noisy tenant cannot evict everyone else's traces. Sampling decisions are recorded as metrics. Unsampled traces still produce the execution/cost/audit ledgers.

## 9.5 Metrics and SLOs

Prometheus native histograms are preferred where the deployed client/server versions support them because they aggregate across replicas and time windows; otherwise use classic histograms with reviewed buckets. Summaries are forbidden for fleet-wide SLOs because client-side quantiles cannot be aggregated ([Prometheus histogram guidance](https://prometheus.io/docs/practices/histograms/)).

### 9.5.1 Required metric catalog

All duration metrics use seconds and all byte/token/currency counters state their unit.

| Metric | Type | Required bounded labels | Purpose |
|---|---|---|---|
| `ege_api_requests_total` | counter | route template, method, status class, cell | traffic/errors |
| `ege_api_request_duration_seconds` | histogram | route template, method, cell | API SLO |
| `ege_execution_admitted_total` | counter | environment, queue class, plan tier | demand |
| `ege_execution_terminal_total` | counter | status, failure class, environment | success/reliability |
| `ege_execution_duration_seconds` | histogram | environment, graph class | end-to-end latency |
| `ege_execution_active` | gauge | cell, queue class | concurrency |
| `ege_scheduler_decision_duration_seconds` | histogram | decision type, cell | scheduler health |
| `ege_scheduler_ready_nodes` | gauge | queue class, cell | backlog |
| `ege_queue_residence_seconds` | histogram | queue class, worker pool | queue latency |
| `ege_worker_slots` | gauge | pool, status | capacity |
| `ege_node_attempts_total` | counter | node type, outcome, failure class | node reliability |
| `ege_node_duration_seconds` | histogram | node type, outcome, pool | performance |
| `ege_retry_total` | counter | node type, failure class, policy | retry pressure |
| `ege_checkpoint_commit_duration_seconds` | histogram | size class, cell | persistence |
| `ege_checkpoint_bytes_total` | counter | storage tier, cell | volume |
| `ege_outbox_lag_seconds` | gauge | shard, consumer | projection freshness |
| `ege_model_requests_total` | counter | provider, model family, outcome | provider health |
| `ege_model_first_token_seconds` | histogram | provider, model family | streaming latency |
| `ege_model_duration_seconds` | histogram | provider, model family, outcome | generation latency |
| `ege_model_tokens_total` | counter | provider, model family, direction | token volume |
| `ege_tool_calls_total` | counter | tool class, outcome, approval class | tool health |
| `ege_budget_rejections_total` | counter | budget type, plan tier | governance |
| `ege_cost_microunits_total` | counter | provider, model family, currency | coarse ops estimate |
| `ege_policy_decisions_total` | counter | action class, decision, policy revision | policy posture |
| `ege_sandbox_terminations_total` | counter | reason, runtime class | isolation health |
| `ege_telemetry_dropped_items_total` | counter | signal, reason, collector tier | observability integrity |

`graph class` and `tool class` are administrator-controlled bounded categories, not customer names. Cost metrics are approximate operational aggregates; invoices use the ledger in section 9.7.

### 9.5.2 Service-level objectives

Initial objectives are explicit engineering targets and must be recalibrated with measured workloads, never weakened to hide failures.

| Surface | SLI | Target over rolling 30 days | Measurement boundary |
|---|---|---:|---|
| Control API availability | non-5xx valid requests / valid requests | 99.95% | gateway server spans |
| Interactive admission | p99 request-to-durable-admission | <= 500 ms | API receipt -> execution row + outbox commit |
| Ready-node dispatch | p99 ready-to-worker-lease, capacity available | <= 2 s | scheduler event timestamps |
| Runtime durability | acknowledged transitions recoverable after cell failover | 100%; RPO 0 in-region | restore/failover tests |
| Runtime recovery | cell scheduler RTO | <= 10 min | synthetic executions |
| Execution event projection | p99 outbox-to-inspector visibility | <= 5 s | event and projection clocks |
| Policy enforcement | governed actions with a recorded decision | 100% | audit/runtime join |
| Cost completeness | terminal executions with balanced cost ledger | 99.99% within 15 min; 100% within 24 h | reconciliation job |
| Telemetry pipeline | accepted OTLP items not dropped unexpectedly | >= 99.9% | collector counters |

End-to-end graph latency is not a universal platform SLO because user code and providers dominate it. The platform reports decomposed latency (`queue`, `platform`, `provider`, `user_code`, `approval_wait`) and lets graph owners set workload SLOs.

Example recording rules:

```yaml
groups:
  - name: ege-slo
    interval: 30s
    rules:
      - record: ege:scheduler_dispatch_latency:p99_5m
        expr: histogram_quantile(0.99, sum by (le, cell) (rate(ege_queue_residence_seconds_bucket[5m])))
      - record: ege:api_error_ratio:30m
        expr: |
          sum(rate(ege_api_requests_total{status_class="5xx"}[30m]))
          /
          sum(rate(ege_api_requests_total[30m]))
      - alert: SchedulerDispatchSLOBurn
        expr: ege:scheduler_dispatch_latency:p99_5m > 2
        for: 10m
        labels: {severity: page}
        annotations:
          runbook: docs/runbooks/scheduler-dispatch-latency.md
```

Use multi-window, multi-burn-rate alerts for availability and error-budget SLOs. Page only for symptoms that require immediate human action; ticket capacity trends and single-tenant errors.

## 9.6 Structured logging

Logs are JSON objects written to stdout/stderr and collected over the node runtime. A log line has a 64 KiB limit; larger diagnostic artifacts are encrypted in object storage and referenced by content digest.

```json
{
  "$schema": "https://schemas.ege.dev/telemetry/log-event-1.0.json",
  "timestamp": "2026-08-06T12:34:56.123456Z",
  "severity": "ERROR",
  "service": "execution-worker",
  "event_name": "node_attempt_failed",
  "message_template": "node attempt failed with {failure_code}",
  "failure_code": "PROVIDER_RATE_LIMIT",
  "retryable": true,
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "span_id": "00f067aa0ba902b7",
  "execution_id": "0197f3c2-7b10-7a11-8c22-31f450000001",
  "activation_id": "sha256:4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a",
  "attempt_ordinal": 2,
  "tenant_id_hash": "hmac:v1:9d2...",
  "graph_version_id": "0197f3c2-6a00-7b22-9d33-42a560000002",
  "compiled_plan_id": "0197f3c2-6a00-7b22-9d33-42a560000003",
  "plan_hash": "sha256:4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f",
  "deployment_revision": 7,
  "safe_details": {"provider": "provider_a", "retry_after_ms": 2000},
  "redaction_count": 1
}
```

Rules:

- Use a stable `event_name`, `failure_code`, and `message_template`; free-form interpolation is not searchable contract data.
- Never log whole request/response objects. Debug payload capture requires a time-bounded grant, an allowed data class, envelope encryption, audit, and automatic deletion.
- Hash identifiers only for cross-event correlation. Low-entropy PII must not be unsafely hashed; use keyed HMAC with rotation metadata.
- Normalize provider errors into platform failure codes while retaining the encrypted original error as a restricted artifact when contractually permitted.
- Stack traces are deduplicated by fingerprint. The UI shows symbolized traces only to `diagnostics.read_sensitive` principals.
- A collector redaction hit emits `ege_telemetry_redactions_total`; repeated hits from one code path block promotion.

## 9.7 Cost tracking, token, and quota accounting

### 9.7.1 Append-only cost ledger

Each billable observation creates one immutable entry. Corrections are compensating entries, never updates.

```sql
CREATE TABLE cost_ledger_entry (
  tenant_id          uuid        NOT NULL,
  entry_id            uuid        NOT NULL,
  execution_id        uuid        NOT NULL,
  activation_id       text,
  attempt_id          uuid,
  provider_request_id text,
  usage_kind          text        NOT NULL CHECK (usage_kind IN
                       ('input_token','cached_input_token','output_token',
                        'embedding_token','tool_unit','compute_ms','storage_byte_day')),
  quantity            numeric(38,9) NOT NULL,
  unit_price_micros   numeric(38,9) NOT NULL,
  amount_micros       numeric(38,0) NOT NULL,
  currency            char(3)     NOT NULL,
  price_version       text        NOT NULL,
  source              text        NOT NULL CHECK (source IN
                       ('provider_reported','metered','estimated','reconciled','adjustment')),
  observed_at         timestamptz NOT NULL,
  idempotency_key     text        NOT NULL,
  metadata            jsonb       NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, entry_id),
  UNIQUE (tenant_id, idempotency_key)
) PARTITION BY RANGE (observed_at);
```

`amount_micros = round(quantity * unit_price_micros)` uses decimal arithmetic. Price records have `valid_from`, `valid_to`, region, provider contract, and model revision. The entry keeps the effective price version so later price changes do not rewrite history.

### 9.7.2 Reservation and reconciliation

1. Admission estimates worst-case model, tool, compute, and loop cost from graph bounds.
2. The quota service atomically reserves budget at tenant and project levels.
3. Each node debits measured usage and releases unused reservation.
4. Streaming model calls update a soft counter; a hard stop is sent when the remaining token/cost bound is reached.
5. Terminalization writes final measured entries. A provider-usage importer later reconciles request IDs and writes adjustment entries.
6. Missing usage becomes `estimated`, raises a reconciliation alert, and cannot silently become zero.

The execution inspector shows estimate, reserved amount, measured amount, reconciled amount, cache savings, and variance. Cost attribution follows causal node ownership; shared batch requests allocate by actual tokens when available or an explicitly versioned allocation rule.

## 9.8 Timeline, heatmaps, and critical path

### 9.8.1 Execution timeline and node timeline event model

The UI timeline is built from committed runtime events, augmented by spans:

```json
{
  "event_id": "0197f3c2-7d30-7d44-bf55-64c780000004",
  "tenant_id": "0197f3c2-5000-7555-8066-75d890000005",
  "execution_id": "0197f3c2-7b10-7a11-8c22-31f450000001",
  "activation_id": "sha256:4a1...",
  "attempt": 2,
  "event_type": "NODE_ATTEMPT_FINISHED",
  "logical_sequence": 184,
  "occurred_at": "2026-08-06T12:34:56.123456Z",
  "recorded_at": "2026-08-06T12:34:56.130001Z",
  "monotonic_offset_ns": 8432921012,
  "duration_ns": 412300000,
  "phase_durations_ns": {
    "queue": 22000000,
    "context": 31000000,
    "provider": 340000000,
    "validation": 9000000,
    "checkpoint": 10300000
  },
  "status": "FAILED_RETRYABLE",
  "failure_code": "PROVIDER_RATE_LIMIT",
  "trace_id": "4bf92f..."
}
```

`logical_sequence` orders committed events. Wall clocks support cross-service visualization but cannot establish causality. Workers record monotonic durations; clock-skew monitoring flags hosts outside the allowed 100 ms envelope.

Timeline lanes show scheduler, queue, each node activation/attempt, provider/tool calls, checkpoints, streaming output, human waits, and cancellation propagation. Collapsed retry/loop groups expose totals without hiding individual attempts.

### 9.8.2 Heatmaps

Heatmaps aggregate histogram observations by bounded node type/model family and time. They answer distribution questions that averages hide:

- queue residence by worker pool and hour;
- node execution duration by node type and version cohort;
- provider first-token latency by region;
- retry count and failure class by graph release;
- cost per successful execution by graph version;
- sandbox CPU/memory throttling by runtime class.

The UI never generates a metric series per graph. Per-graph and per-node drill-down uses ClickHouse over event projections with tenant predicates.

### 9.8.3 Critical path and performance bottlenecks

The critical path is computed on the **activation graph**, not the static graph definition. Loops and dynamic expansion create distinct activation vertices. Each vertex weight excludes intentional external waits when the user selects “platform critical path”; the “wall-clock critical path” includes them.

For each completed activation `v`:

```text
ready(v)  = max(finish(p) for p in causal_predecessors(v))
work(v)   = finish(v) - start(v)
queue(v)  = start(v) - ready(v)
cp(v)     = work(v) + max(cp(p) for p in causal_predecessors(v))
slack(v)  = execution_finish - earliest_start(v) - downstream_longest(v)
```

Pseudocode:

```rust
fn critical_path(events: &[Activation]) -> Path {
    let dag = collapse_retry_attempts_and_validate_causality(events);
    let order = topological_sort(&dag)?;
    let mut score = Map::new();
    let mut previous = Map::new();

    for v in order {
        let best_parent = dag.predecessors(v)
            .max_by_key(|p| score.get(p).unwrap_or(&0));
        score[v] = duration(v) + best_parent.map(|p| score[p]).unwrap_or(0);
        previous[v] = best_parent;
    }
    backtrack(previous, argmax(score))
}
```

If recorded causality contains a cycle outside an explicit loop activation boundary, analysis marks the trace corrupt rather than inventing an ordering. The profiler reports critical work, queue delay, fan-in wait, retry amplification, and avoidable serialization separately.

## 9.9 Failure analysis

### 9.9.1 Failure taxonomy

Every terminal or retry event carries one stable platform code and optional provider code.

| Class | Examples | Retry default | Owner |
|---|---|---:|---|
| `USER_INPUT` | schema violation, missing port | no | graph author |
| `GRAPH_DEFINITION` | invalid type, impossible merge | no | compiler/author |
| `POLICY` | denied tool, data-residency conflict | no until policy/context change | security/owner |
| `CAPACITY` | no compatible worker, quota exhausted | delayed | platform/tenant |
| `DEPENDENCY_TRANSIENT` | timeout, 429, connection reset | bounded | provider/platform |
| `DEPENDENCY_PERMANENT` | invalid provider request, removed model | no/fallback | author/platform |
| `SANDBOX` | OOM, CPU limit, prohibited syscall | policy-specific | author/security |
| `STATE_CONFLICT` | stale version, merge conflict | bounded deterministic retry | runtime |
| `PLATFORM_BUG` | invariant violation, panic | no automatic side-effect retry | platform |
| `CANCELLED` | user, parent, budget, deadline | no | initiator |

Provider strings never drive retry directly. A versioned classifier maps `(provider, status, code, operation)` to platform codes. Unknown errors default to non-retryable for `NON_IDEMPOTENT_WRITE`, `COMPENSATABLE_WRITE`, and `HUMAN_EFFECT`; `READ_ONLY` may use only a bounded policy-approved retry. Determinism is evaluated separately and never changes the declared effect class.

### 9.9.2 Causal failure bundle

Selecting “Analyze failure” returns a generated, immutable bundle:

- graph artifact digest and deployment revision;
- node configuration with secrets represented by versioned handles;
- attempt chain and retry policy evaluation;
- input/output **schemas**, hashes, sizes, classifications, and restricted artifact links—not values by default;
- state/checkpoint version read and written;
- authorization and approval decision IDs;
- provider/tool request IDs, normalized error, latency, and breaker state;
- correlated logs, trace segments, host/sandbox resource events;
- preceding anomalies and downstream cancellations;
- nearest successful cohort and deployment/config diffs;
- a machine-generated hypothesis clearly labeled as a hypothesis.

Fingerprinting uses `failure_code + node_type + sanitized_stack_top + dependency_operation + graph_revision_cohort`; it excludes tenant payloads. Clusters are suggestions, not proof of a common root cause.

## 9.10 Governed replay

Replay never mutates the original history. Its vocabulary has three independent axes; telemetry and audit records must not collapse them into one ambiguous `mode`.

| Axis | Values | Meaning |
|---|---|---|
| Replay operation | `STATE_REBUILD`, `EXACT_REPLAY`, `FORKED_REPLAY` | Rebuild derived runtime state; verify an original run from its journal; or create a lineage-linked execution from a selected event/checkpoint. |
| Execution mode | `LIVE`, `REPLAY`, `SIMULATION` | Execute current authorized dependencies; consume retained history; or run against mocks/isolated resources with production effects prohibited. |
| Adapter effect mode | `SUBSTITUTE_RECORDED`, `REEXECUTE_READ_ONLY`, `REEXECUTE_AUTHORIZED_EFFECT`, `FORBID` | Return the journaled result; make a new read; make a freshly authorized effect; or stop before the adapter. |

`STATE_REBUILD` uses `execution_mode=REPLAY` with effects forbidden. `EXACT_REPLAY` normally uses `REPLAY` plus `SUBSTITUTE_RECORDED`; an isolated comparison may pair the same operation with `SIMULATION` and `REEXECUTE_READ_ONLY` without changing the original. A `FORKED_REPLAY` creates a new execution and may continue after its fork boundary in `SIMULATION` or, with normal admission and current authority, `LIVE`. Each adapter call records its chosen effect mode. A new live call is never described as deterministic merely because its inputs were replayed.

Effect class and determinism are separate contracts. The only effect classes are `PURE`, `READ_ONLY`, `IDEMPOTENT_WRITE`, `COMPENSATABLE_WRITE`, `NON_IDEMPOTENT_WRITE`, and `HUMAN_EFFECT`. Determinism remains `PURE`, `RECORDED_NONDETERMINISTIC`, or `EFFECTFUL`; for example, a `READ_ONLY` model invocation is normally `RECORDED_NONDETERMINISTIC`, while a deterministic transformation is both effect class `PURE` and determinism `PURE`.

### 9.10.1 Side-effect fence

Every effectful adapter implements:

```rust
trait EffectAdapter {
    fn effect_class(&self) -> EffectClass; // one of the six canonical effect classes
    fn determinism(&self) -> Determinism;  // PURE, RECORDED_NONDETERMINISTIC, EFFECTFUL
    fn idempotency_key(&self, ctx: &NodeContext) -> Option<String>;
    async fn invoke(&self, request: Value, permit: EffectPermit) -> Result<Value>;
    async fn replay(
        &self,
        journal: EffectJournalEntry,
        execution_mode: ExecutionMode,
        effect_mode: AdapterEffectMode,
        permit: Option<EffectPermit>,
    ) -> Result<Value>;
}
```

The runtime records canonical request/response hashes, result artifact reference, provider request ID, idempotency key, policy decision, and effect status before scheduling successors. `SUBSTITUTE_RECORDED` returns the journaled result and performs no external call. `REEXECUTE_READ_ONLY` is limited to `READ_ONLY` and needs current policy. `REEXECUTE_AUTHORIZED_EFFECT` requires a fresh `ExecutionGrant`, current policy decision, any approval required by the declared effect class, and a new idempotency namespace. `FORBID` halts before invocation. `HUMAN_EFFECT` is never silently synthesized or reused as current consent.

Nondeterminism—time, random bytes, UUIDs, environment values, model responses, tool responses, and dynamic graph expansion—is obtained through journaled runtime services. Direct clock/network/random access from sandboxed code is denied. If a trusted legacy implementation bypasses the journal, replay compatibility fails explicitly and its adapter `effect_mode` is `FORBID`; the platform does not invent a fourth determinism class.

### 9.10.2 Replay compatibility

The compiler produces a replay-compatibility report between graph versions. Safe changes include metadata and observer-only nodes. Port/schema changes require an explicit state migrator. A changed effectful node is never automatically replayed. Replay provenance records original execution, fork checkpoint, target graph version, migrator digest, policy decisions, and operator reason.

## 9.11 Audit trail

Diagnostic logs explain what software did; audit records prove who or what requested and authorized a governed action.

Required audited actions include authentication changes, authorization/policy decisions, secret access, graph/version/deployment changes, production runs/cancellations/replays, approvals, tool grants, plugin installation, model configuration, retention/legal hold, export, billing adjustment, tenant administration, and audit access itself.

```json
{
  "$schema": "https://schemas.ege.dev/audit/event-1.0.json",
  "event_id": "0197f3c2-7e40-7e55-8066-75d890000006",
  "tenant_id": "0197f3c2-5000-7555-8066-75d890000005",
  "occurred_at": "2026-08-06T12:35:00.100000Z",
  "actor": {
    "type": "workload",
    "subject": "spiffe://ege.dev/cell-03/execution-worker",
    "on_behalf_of": "user:00u...",
    "session_id": "0197f3c2-7f50-7f66-9177-86e9a0000007"
  },
  "action": "tool.invoke",
  "resource": {"type": "tool", "id": "payments.refund", "tenant_id": "0197f3c2-5000-7555-8066-75d890000005"},
  "context": {"execution_id": "0197f3c2-7b10-7a11-8c22-31f450000001", "activation_id": "sha256:4a1...", "region": "ap-northeast-1"},
  "decision": {"result": "allow", "policy_revision": "sha256:7ab...", "decision_id": "0197f3c2-8050-7066-a288-97fab0000008"},
  "request_hash": "sha256:ce1...",
  "outcome": "succeeded",
  "reason_code": "APPROVAL_PRESENT",
  "previous_hash": "sha256:3b0...",
  "record_hash": "sha256:bbe..."
}
```

Hash chains are scoped by tenant and daily segment so verification is parallelizable. A daily Merkle root is signed by KMS and written to object storage with retention lock. Chain integrity detects alteration; database authorization, WORM retention, backups, and independent export prevent deletion. Read access is a separate permission, field-level redaction applies, and exports are signed and auditable.

## 9.12 Collector configuration

Illustrative regional gateway configuration:

```yaml
receivers:
  otlp:
    protocols:
      grpc: {endpoint: "0.0.0.0:4317"}
      http: {endpoint: "0.0.0.0:4318"}

processors:
  memory_limiter:
    check_interval: 1s
    limit_percentage: 75
    spike_limit_percentage: 15
  attributes/allowlist:
    actions:
      - {key: enduser.id, action: delete}
      - {key: db.statement, action: delete}
      - {key: gen_ai.prompt, action: delete}
      - {key: gen_ai.completion, action: delete}
  tail_sampling:
    decision_wait: 15s
    num_traces: 500000
    policies:
      - name: errors
        type: status_code
        status_code: {status_codes: [ERROR]}
      - name: security
        type: string_attribute
        string_attribute: {key: ege.security.event, values: ["true"]}
      - name: baseline
        type: probabilistic
        probabilistic: {sampling_percentage: 1.0}
  batch: {send_batch_size: 8192, timeout: 2s}

exporters:
  otlp/tempo: {endpoint: "tempo-distributor.observability.svc:4317"}
  prometheusremotewrite: {endpoint: "https://mimir.example/api/v1/push"}
  otlphttp/logs: {endpoint: "https://loki.example/otlp"}
  file/wal: {path: /var/lib/otel/wal/failed.jsonl}

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, attributes/allowlist, tail_sampling, batch]
      exporters: [otlp/tempo, file/wal]
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [prometheusremotewrite]
    logs:
      receivers: [otlp]
      processors: [memory_limiter, attributes/allowlist, batch]
      exporters: [otlphttp/logs, file/wal]
```

Production configuration must also include mTLS, tenant authentication, queue limits, retry, and exporter-specific secret references. The file exporter example represents a bounded encrypted failure buffer, not indefinite local retention.

## 9.13 Dashboards and investigation workflow

The minimum operational dashboard set is:

1. **Platform overview:** request/admission/terminal rates, SLO burn, active runs, queue delay, worker saturation, cell health.
2. **Scheduler:** ready queue by class, lease age, decision latency, fairness deficit, backpressure, DLQ.
3. **Persistence:** transaction latency, lock waits, partition growth, checkpoint size/latency, outbox lag, object errors.
4. **AI providers:** success/429/5xx, first-token and total latency, tokens, fallback rate, breaker state, cost variance.
5. **Sandboxes/tools:** cold start, CPU/memory/IO throttling, denied syscalls, egress denials, approval wait.
6. **Tenant health:** authorized tenant-scoped SLO/cost/quota data with no cross-tenant comparison leakage.
7. **Telemetry integrity:** rejected attributes, dropped spans/logs, sampling rates, collector queue/WAL, clock skew.

An operator starts from a symptom metric, jumps via exemplar to a trace, opens the execution timeline, selects the causal failure bundle, and then verifies committed events/checkpoints. Trace data alone is insufficient to modify or replay a run.

## 9.14 Runbooks

### 9.14.1 Dispatch latency SLO burn

1. Confirm the burn is regional/cell-wide, not a single tenant workload SLO.
2. Compare `ready_nodes`, `worker_slots{status="free"}`, queue residence, NATS consumer pending/ack age, and scheduler transaction latency.
3. If capacity is exhausted, enable the pre-approved pool scale policy; do not raise concurrency beyond database/provider budgets.
4. If leases are stuck, inspect lease heartbeat age and worker revision. Quarantine the bad revision. Let a lease expire or revoke it only after checking the canonical effect class, effect-journal status, and whether the selected adapter effect mode permits safe recovery; “replay-safe” is not a standalone class.
5. If PostgreSQL is the bottleneck, inspect lock waits, connection-pool saturation, and hot partitions. Shed low-priority admissions before affecting running production work.
6. Validate recovery with synthetic executions and annotate the incident timeline.

### 9.14.2 Telemetry pipeline dropping data

1. Determine signal, collector tier, tenant, and reason from self-metrics.
2. Preserve audit/cost paths; reduce debug trace sampling and log verbosity first.
3. Check gateway exporter errors, backend ingestion quotas, memory limiter, and WAL disk.
4. If sensitive-attribute rejection spikes, block the offending deployment and rotate exposed credentials if a secret may have entered telemetry.
5. Reprocess the bounded WAL only after backend health and tenant routing are verified.

### 9.14.3 Cost ledger mismatch

1. Compare platform request IDs with provider usage export for the same price version and UTC window.
2. Classify missing, duplicate, unit conversion, cache-discount, and late-reporting differences.
3. Stop invoice finalization if the completeness SLO is breached; do not edit ledger rows.
4. Write idempotent adjustment entries with the source evidence digest and approval ID.
5. Backfill the analytical projection and rerun balance checks (`sum(debits) == invoice usage`).

### 9.14.4 Suspected cross-tenant telemetry leak

1. Treat as a security incident; suspend affected telemetry query access and preserve evidence.
2. Identify whether ingestion, labels, backend tenancy headers, dashboard variables, or cache keys crossed boundaries.
3. Rotate backend credentials and invalidate query caches.
4. Enumerate exposed fields and tenants from audit logs; follow breach-notification policy.
5. Add a regression test using tenant canaries before restoring access.

## 9.15 Verification and load tests

- Unit-test semantic attributes against an allow-list and cardinality budget.
- Golden-test log redaction with API keys, bearer tokens, connection strings, PII, prompt content, and malicious newline/control characters.
- Inject collector/backend outages and prove execution continues within the buffer while audit policy behaves as configured.
- Generate 10 million unique executions and prove Prometheus series growth is bounded.
- Skew worker clocks, drop queue acknowledgments, duplicate events, and reorder projection delivery; timelines must retain logical ordering.
- Exercise every permitted replay-operation, execution-mode, and adapter-effect-mode combination and prove no external write occurs without a fresh permit.
- Restore execution, audit, and cost partitions from backup and verify hashes, counts, and projection rebuilding.
- Compare critical-path output with known fork/fan-in/loop fixtures and malformed-causality fixtures.
- Reconcile synthetic provider invoices with the cost ledger, including cached tokens, fallback, cancellation, and partial streams.

## 9.16 Anti-patterns

- **Execution IDs as metric labels:** creates unbounded series and an observability outage.
- **One giant span for a multi-day run:** exceeds backend limits and obscures queue/resume causality.
- **Treating traces as runtime history:** sampling and retention make that false.
- **Logging prompts “temporarily”:** temporary production logs become durable sensitive stores.
- **Average latency dashboards:** hide tail latency, bimodality, cold starts, and throttling.
- **Provider strings as retry policy:** unstable text becomes control flow.
- **Updating cost rows after reconciliation:** destroys financial provenance.
- **Replay by resubmitting the original request:** may duplicate emails, charges, tickets, or database writes.
- **Hash chain without protected roots:** detects some edits but not wholesale deletion.
- **A single global telemetry tenant:** makes one authorization or query bug a platform-wide data breach.
- **Paging on every failed graph:** customer logic failures are not necessarily platform incidents.
- **Sampling before security/error classification:** discards the exact evidence needed during an incident.
