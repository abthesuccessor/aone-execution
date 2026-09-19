# 5. Shared State Protocol

Shared state is a typed, versioned materialization of an execution's accepted history. It is not an unstructured dictionary passed by reference between workers. Sandboxes receive a bounded input snapshot and propose intents. WorkerGateway alone commits worker-result state transitions; the coordinator commits control-node transitions through the same canonical transition library and never races the gateway for one worker result.

## 5.1 State classes and ownership

| State class | Lifetime | Mutability | Authority | Typical contents |
|---|---|---|---|---|
| Graph constants | graph version | immutable | GraphSpec/Plan IR | compile-time constants, schemas, prompt refs |
| Deployment configuration | deployment revision | immutable for an execution | deployment snapshot | model route, endpoint refs, feature flags |
| Execution input | execution lifetime | immutable | execution initialization event | validated trigger payload |
| Execution shared state | execution lifetime | versioned | WorkerGateway for worker completion; coordinator for control transitions; canonical state rows | workflow variables, accumulated results |
| Scope-local state | block/loop/subgraph lifetime | versioned | owning scope reducer | iteration values, branch accumulators |
| Node-attempt state | attempt lifetime | append-only progress, one terminal result | leased worker with fence | cursor, partial artifact refs, usage |
| Context | one scheduling/invocation decision | immutable view | coordinator | identity, budgets, trace, deadline, capabilities |
| Durable memory | across executions | versioned external resource | memory service/database policy | conversation/business/user memory |
| Cache | configured TTL | replaceable | cache implementation | derived lookup/model/tool result |
| Global mutable resource | across executions | transactional external resource | owning service/database | inventory, customer record, quota |

“Global state” MUST be qualified:

- **graph-global constants** are pinned and safe for deterministic replay;
- **execution-global state** is shared only among scopes in one execution;
- **tenant/global mutable data** is an external resource accessed through a database, memory, or service node with its own concurrency and authorization contract.

A process-global variable in a coordinator or worker is never execution state. A cross-execution mutable value cannot be read implicitly because replay at a later time would observe a different value.

## 5.2 Typed state definition

GraphSpec declares a state schema and path policies. JSON Schema 2020-12 is the interchange schema; the compiler lowers it to a compact internal type table. Protobuf types MAY be referenced for code-first graphs, but the published plan contains a canonical JSON-compatible representation and descriptor hash.

The following is a **non-standalone `spec.state` excerpt**. Its shape is exactly the `state` member of `docs/contracts/graph-spec.schema.json`; a complete GraphSpec also includes the required envelope, ports, nodes, edges, and budgets.

```yaml
state:
  schema:
    type: object
    additionalProperties: false
    required: [request, candidates, decision]
    properties:
      request:
        $ref: "registry://schemas/RefundRequest@3"
        x-eg-classification: CONFIDENTIAL
      candidates:
        type: array
        items: { $ref: "registry://schemas/RefundCandidate@2" }
        default: []
      decision:
        anyOf:
          - { $ref: "registry://schemas/RefundDecision@4" }
          - { type: "null" }
      metrics:
        type: object
        additionalProperties: { type: number }
        default: {}
  paths:
    - path: /request
      mutability: IMMUTABLE
      writers: ["$initializer"]
      classification: CONFIDENTIAL
    - path: /candidates
      mutability: REDUCER
      reducer: "builtin://append-unique@1"
      writers: [retrieve_primary, retrieve_secondary]
      classification: CONFIDENTIAL
    - path: /decision
      mutability: SINGLE_ASSIGNMENT
      writers: ["decide"]
      classification: CONFIDENTIAL
    - path: /metrics
      mutability: REDUCER
      reducer: "builtin://numeric-sum-map@1"
      writers: [critic, decide]
      classification: INTERNAL
```

Each state path policy compiles to:

```text
path_id, type_id, mutability, permitted_writer_set,
reducer_id?, classification, retention, size_limit,
redaction_policy, index_policy, default_value_hash
```

State writers are node instance patterns resolved at compile time. Dynamic fragments receive an explicit scoped capability; they do not inherit wildcard write access automatically.

## 5.3 Immutable, single-assignment, mutable, and reduced variables

### Immutable

Written during initialization or scope creation and never changed. Attempts to replace or remove the path are compile errors when statically visible and runtime policy violations otherwise.

### Single-assignment

Initially absent or null, then set exactly once. It is useful for final decisions, approval results, and effect receipts. Duplicate writes with the same canonical value are idempotent; a different value is a conflict.

### Mutable with compare-and-swap

The node proposes an operation with `expected_path_version`. The commit succeeds only if that version is current. This is appropriate when one logical owner updates the path and retries can recompute safely.

### Reducer-managed

Multiple branches emit deltas. The coordinator applies a pinned deterministic reducer in a canonical order. Reducers MUST be pure, total for valid inputs, bounded, versioned, and replay compatible.

Built-in reducers include:

- append preserving event order;
- append-unique by stable key with explicit duplicate policy;
- set union over canonical scalar values;
- numeric sum/min/max;
- last writer by deterministic graph order, never wall-clock arrival;
- map merge with a reducer per child path;
- top-k with a stable score and tie-break key;
- bounded event/window aggregate.

“Last worker to finish wins” is forbidden because scheduling timing is nondeterministic.

## 5.4 Scope tree

Every execution owns a scope tree.

```text
execution scope /                         parent: none
  subgraph scope /calls/enrich#1          parent: /
    parallel scope /parallel/providers    parent: /calls/enrich#1
      branch /branches/openai             parent: /parallel/providers
      branch /branches/anthropic          parent: /parallel/providers
    loop scope /loops/repair              parent: /calls/enrich#1
      iteration /iterations/000003        parent: /loops/repair
```

A scope contains:

```json
{
  "scope_id": "sha256:5e2f000000000000000000000000000000000000000000000000000000000011",
  "kind": "LOOP_ITERATION",
  "parent_scope_id": "sha256:5e2f000000000000000000000000000000000000000000000000000000000001",
  "owner_node_instance_id": "ni_repair_loop",
  "ordinal": 3,
  "created_event_seq": 184,
  "closed_event_seq": null,
  "read_prefixes": ["/request", "/draft", "/policy"],
  "write_prefixes": ["/loops/repair/iterations/000003"],
  "budget_slice_id": "019fd4b4-3000-7000-8000-000000000021",
  "cancellation_scope_id": "sha256:5e2f000000000000000000000000000000000000000000000000000000000031"
}
```

Scope identifiers are domain-separated SHA-256 digests over tenant, execution, parent scope, canonical scope kind, compiled logical path, and deterministic ordinal. They are not entity UUIDs and never depend on scheduling time. The root scope is coordinator-owned; all child scopes are owned by their creating activation. Reads resolve from the current scope outward to the execution scope unless a binding shadows the name. Writes target an explicit scope and never implicitly mutate a parent. A subgraph maps selected caller paths to callee inputs and selected callee outputs back through declared reducers.

## 5.5 Execution context

Context is immutable invocation metadata, separate from user state:

```typescript
interface ExecutionContext {
  tenantId: string;
  projectId: string;
  environmentId: string;
  executionId: string;
  activationId: string;
  executionTokenId: string;
  attempt: number;
  fencingToken: bigint;
  planHash: string;
  graphVersionId: string;
  policySnapshotId: string;
  capabilityHandles: readonly string[];
  trace: { traceparent: string; tracestate?: string };
  deadline: string;
  budget: BudgetSlice;
  cancellation: { scopeId: string; requested: boolean };
  executionMode: ExecutionMode;
  replayOperation: ReplayOperation;
  adapterEffectMode: AdapterEffectMode;
  logicalTime: string;
  deterministicSeed: string;
}
```

This is the trusted coordinator/supervisor context. The supervisor retains the proof-of-possession/mTLS-bound `ExecutionGrant` returned in its lease, but that grant authorizes only the bound WorkerGateway RPCs. The gateway persists and validates its hash and constraints and remains the sole authority for worker-originated completion, state, budget, and effect database mutations. The Coordinator separately owns control-node transitions through the shared transition library. Sandboxed node code receives only a narrowed projection and opaque capability handles; it never receives the raw grant, fencing authority, database identity, or queue credentials. Neither supervisor nor sandbox can alter the context. A child task receives a newly signed context derived by narrowing parent permissions, budget, and deadline.

The three replay axes above are generated directly from the canonical enums in `runtime.proto`; this chapter does not define another mode set. The coordinator maps behavior as follows:

| Operation | `execution_mode` | `replay_operation` | Legal adapter effect mode |
|---|---|---|---|
| Normal execution | `EXECUTION_MODE_LIVE` | `REPLAY_OPERATION_NONE` | `ADAPTER_EFFECT_MODE_REEXECUTE_AUTHORIZED_EFFECT` under the admitted plan/policy |
| Direct isolated simulation | `EXECUTION_MODE_SIMULATION` | `REPLAY_OPERATION_NONE` | `ADAPTER_EFFECT_MODE_FORBID` or `ADAPTER_EFFECT_MODE_REEXECUTE_READ_ONLY` |
| State rebuild | `EXECUTION_MODE_REPLAY` | `REPLAY_OPERATION_STATE_REBUILD` | `ADAPTER_EFFECT_MODE_FORBID`; no adapter invocation |
| Exact replay | `EXECUTION_MODE_REPLAY` | `REPLAY_OPERATION_EXACT_REPLAY` | `ADAPTER_EFFECT_MODE_SUBSTITUTE_RECORDED` |
| Exact isolated comparison | `EXECUTION_MODE_SIMULATION` | `REPLAY_OPERATION_EXACT_REPLAY` | `ADAPTER_EFFECT_MODE_REEXECUTE_READ_ONLY` |
| Fork through the selected boundary | `EXECUTION_MODE_REPLAY` | `REPLAY_OPERATION_FORKED_REPLAY` | `ADAPTER_EFFECT_MODE_SUBSTITUTE_RECORDED` |
| Forked simulation after the boundary | `EXECUTION_MODE_SIMULATION` | `REPLAY_OPERATION_FORKED_REPLAY` | `ADAPTER_EFFECT_MODE_FORBID` or `ADAPTER_EFFECT_MODE_REEXECUTE_READ_ONLY` |
| Forked live continuation | `EXECUTION_MODE_LIVE` | `REPLAY_OPERATION_FORKED_REPLAY` | `ADAPTER_EFFECT_MODE_FORBID`, or `ADAPTER_EFFECT_MODE_REEXECUTE_AUTHORIZED_EFFECT` only with fresh policy pins and content-bound approval |

The supervisor uses these fields to decide whether a sandbox invocation is needed, but it cannot broaden the adapter effect mode. The gateway remains authoritative and rejects an effect handle call inconsistent with the lease.

## 5.6 Snapshot and state-operation protocol

The sandbox does not issue arbitrary updates. The coordinator authorizes a bounded projection; the gateway validates the lease/grant and materializes authorized data and opaque handles; the trusted supervisor passes that projection to the sandbox without exposing its WorkerGateway lease or raw grant:

```json
{
  "snapshot": {
    "execution_id": "019fd4b4-3000-7000-8000-000000000101",
    "state_version": 42,
    "history_seq": 184,
    "scope_id": "sha256:5e2f000000000000000000000000000000000000000000000000000000000011",
    "values": {
      "/request": {"artifact_ref": "019fd4b4-3000-7000-8000-000000000302"},
      "/draft": "..."
    },
    "path_versions": {"/request": 1, "/draft": 8}
  },
  "read_set_hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "write_capability": ["/loops/repair/iterations/000003", "/metrics"]
}
```

The supervisor translates a terminal sandbox proposal into the exact `CompleteExecutionTokenRequest` and `StateWriteIntent` messages defined by `docs/contracts/executiongraph/runtime/v1/runtime.proto`. This diagnostic ProtoJSON-style projection uses the same field and enum semantics:

```json
{
  "executionTokenId": "019fd4b4-3000-7000-8000-000000000201",
  "attemptId": "019fd4b4-3000-7000-8000-000000000202",
  "attemptOrdinal": 2,
  "routingEpoch": "7",
  "schedulerFence": "19",
  "fencingToken": "9",
  "planHash": "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "baseStateVersion": "42",
  "stateWriteIntents": [
    {
      "operation": "OPERATION_PUT",
      "path": "/loops/repair/iterations/000003/critique",
      "inlineValue": {"score": 0.82, "issues": ["missing citation"]}
    },
    {
      "operation": "OPERATION_REDUCE",
      "path": "/metrics",
      "dedupeKey": "critique:000003",
      "inlineValue": {"critic_tokens": 812}
    }
  ],
  "outputArtifactId": "019fd4b4-3000-7000-8000-000000000301",
  "usage": {"inputTokens": "2500", "outputTokens": "812", "costMicrounits": "1900"}
}
```

The only worker-wire operations are `OPERATION_PUT`, `OPERATION_DELETE`, `OPERATION_REDUCE`, `OPERATION_BIND_ARTIFACT`, and `OPERATION_CLOSE_SCOPE`. PUT/DELETE become compare-and-set when `expected_path_version` or `expected_value_hash` is present; single-assignment and reducer identity come from the compiled path policy. RFC 6902 JSON Patch is not used directly because it cannot express writer authority, reducers, typed artifact binding, or deterministic conflict policy.

Persistence uses the broader state-intent vocabulary in Chapter 14. The coordinator performs this one-way lowering; workers never send persistence enum names:

| WorkerGateway `StateWriteIntent.Operation` | Persisted intent/control representation |
|---|---|
| `OPERATION_PUT` without an expectation | `PUT` under the compiled path policy, including single-assignment; duplicate canonical value is idempotent |
| `OPERATION_PUT` with an expectation | `PUT` with the supplied expected path version/value hash; `COMPARE_AND_SET` is the pinned mutability, not a worker operation |
| `OPERATION_DELETE` | `DELETE` with the required path-policy/expectation checks |
| `OPERATION_REDUCE` | `REDUCE` with the reducer digest pinned in the plan; append and set-union behavior are named reducers |
| `OPERATION_BIND_ARTIFACT` | `BIND_ARTIFACT` of a typed artifact reference under the declared path policy |
| `OPERATION_CLOSE_SCOPE` | `CLOSE_SCOPE` with no value; the gateway also commits the scope lifecycle transition atomically |

`PATCH`, `APPEND`, `ADD`, and `REMOVE` are authoring/compiler sugar, not additional worker-wire or persisted operations. The compiler lowers a declared patch to ordered canonical operations and lowers append/set behavior to a pinned reducer before dispatch. This is a mapping to the normative runtime contract, not a competing mutation protocol.

## 5.7 Atomic commit algorithm

```text
commit_completion(result):
  BEGIN
  token = SELECT ... FOR UPDATE
          WHERE execution_token_id = result.execution_token_id
  attempt = SELECT ... FOR UPDATE
            WHERE id = result.attempt_id AND token_id = token.id
  assert token.status == RUNNING
  assert attempt.id == result.attempt_id
  assert token.attempt_ordinal == result.attempt_ordinal
  assert execution.routing_epoch == result.routing_epoch
  assert execution.scheduler_fence == result.scheduler_fence
  assert token.fencing_token == result.fencing_token
  assert token.plan_hash == execution_pin.plan_hash
  assert token.lease_expires_at > database_now()

  effects = SELECT * FROM effect_operation
            WHERE tenant_id = token.tenant_id
              AND execution_id = token.execution_id
              AND activation_id = token.activation_id
            FOR UPDATE
  validate supplied receipt evidence against every referenced ledger row
  normalize trusted NOT_STARTED/NOT_COMMITTED evidence to canonical NOT_COMMITTED
  assert no effect remains RESERVED or STARTED
  if any effect is UNKNOWN or RECONCILING:
      reject result output and every StateWriteIntent
      settle only trusted metering and budget facts
      append EffectOutcomeAmbiguous and AttemptUnknownEffect events
      terminalize attempt UNKNOWN_EFFECT and token TERMINAL
      park Activation UNKNOWN_EFFECT with terminal_at NULL
      create reconciliation wakeup/outbox record; create no ordinary successor
      COMMIT
      return UNKNOWN_EFFECT
  derive success/retry/stop only from the complete normalized ledger and pinned policy

  state = SELECT ... FOR UPDATE WHERE execution_id = token.execution_id
  validate result.state_write_intents against compiled path capabilities and types
  for intent in stable intent order:
      if intent can merge at current version:
          apply pinned reducer or assignment policy
      else:
          classify conflict and apply node conflict policy

  append NodeCompleted or NodeFailed at next monotonic history sequence
  append one StatePatched event containing canonical operations and hashes
  update materialized state and increment state_version
  create newly-ready activations, ExecutionTokens, and outbox records
  settle attempt budget and release unused reservation
  mark ExecutionToken terminal
  COMMIT
```

The history append, state materialization, successor scheduling, budget settlement, and outbox creation happen in one database transaction. Object uploads finish before this transaction; the commit binds verified immutable artifact IDs. Unbound uploads are garbage-collected after a retention window.

## 5.8 State versioning

The runtime maintains:

- `history_seq`: monotonic event position within an execution;
- `state_version`: monotonic committed patch number;
- `path_version`: last state version that changed a path;
- `schema_version`: state schema/migration identity;
- `snapshot_version`: checkpoint materialization version;
- `reducer_version`: semantic version/hash of each reducer.

State patches are hash chained:

```text
patch_hash[n] = SHA256(
  patch_hash[n-1] || execution_id || state_version ||
  canonical_operations || event_seq || plan_hash
)
```

The chain detects corruption and supports audit export; it does not replace database access control or signed/WORM audit retention.

## 5.9 Conflict detection and resolution

Two proposals conflict if they modify overlapping non-reducer paths from incompatible base versions. The compiler prevents most conflicts by proving single-writer ownership or requiring a merge gateway.

Runtime policy per node is explicit:

| Policy | Use | Behavior |
|---|---|---|
| `FAIL_CONFLICT` | protected decisions/effects | fail node with typed `STATE_CONFLICT` |
| `RECOMPUTE` | pure/read-only calculation | issue new snapshot and retry without counting as infrastructure retry |
| `APPLY_REDUCER` | accumulator | merge deterministic delta at current state |
| `SERIALIZE_SCOPE` | ordered critical section | schedule only one writer in scope |

Conflict resolution cannot invoke an LLM inside the commit transaction. If semantic reconciliation is needed, the coordinator schedules a dedicated merge/decision node whose input includes both versions and whose output is then committed under normal policy.

### 5.9.1 Parallel branch example

```mermaid
sequenceDiagram
    participant C as Coordinator
    participant A as Branch A
    participant B as Branch B
    participant DB as State store
    C->>A: snapshot v20; write /results with append reducer
    C->>B: snapshot v20; write /results with append reducer
    B-->>C: delta B
    C->>DB: commit delta B -> v21
    A-->>C: delta A based on v20
    C->>DB: reducer is commutative? apply in canonical branch order at fan-in
    Note over C,DB: arrival order is recorded but semantic order is plan branch ordinal
    C->>DB: finalize fan-in aggregate -> v22
```

For order-sensitive reducers, branch outputs remain isolated until fan-in and are reduced by stable branch ordinal. For proven associative and commutative reducers, incremental application is allowed but replay still records the logical order.

## 5.10 Synchronization primitives

Graph authors do not manipulate mutexes. The runtime exposes declarative constructs:

- **fan-in barrier:** wait for `ALL`, `ANY`, `QUORUM(n)`, or predicate over terminal branch outcomes;
- **scope serialization:** at most one active writer in a scope;
- **resource semaphore:** limit concurrent calls to a provider/tenant/resource;
- **signal wait:** suspend until a correlated external event;
- **condition version wait:** resume when a state path reaches a predicate after a given version;
- **lease:** time-bounded worker authority, always fenced by epoch;
- **distributed rate reservation:** token bucket allocation, used for admission rather than correctness.

Redis locks MUST NOT protect canonical state transitions. Coordinator ownership and database fences provide correctness; Redis may accelerate rate limits or presence.

## 5.11 Incremental and streaming updates

Streaming has three planes:

1. **ephemeral transport chunks** for low-latency UI/provider flow;
2. **durable progress events** at configured byte/time/semantic boundaries;
3. **terminal typed result** used for graph data flow.

Model tokens are not committed as one state version per token. The worker batches chunks into immutable stream segments in object storage and appends `NodeProgressRecorded` metadata under rate limits. The final result references an ordered segment manifest and optionally a consolidated artifact.

```json
{
  "type": "execution.node.progress.v1",
  "execution_id": "019fd4b4-3000-7000-8000-000000000101",
  "activation_id": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "attempt": 1,
  "progress_seq": 12,
  "kind": "MODEL_OUTPUT_SEGMENT",
  "artifact_id": "019fd4b4-3000-7000-8000-000000000312",
  "content_sha256": "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "byte_range": [45056, 49151],
  "observed_at": "2026-08-06T10:00:03.120Z",
  "redaction": "CONFIDENTIAL_VALUE_OMITTED"
}
```

Clients subscribe with a cursor. The gateway sends ephemeral chunks when available, then durable progress/state events. On reconnect, it resumes from the last durable cursor; it never promises recovery of chunks that policy chose not to persist.

Backpressure propagates from client to gateway buffers, but a slow UI cannot block the execution. The gateway drops/coalesces ephemeral progress and instructs the client to fetch durable segments. Terminal state changes are never dropped.

## 5.12 Checkpoints and execution snapshots

A checkpoint contains:

```text
execution_id
checkpoint_seq
history_seq_inclusive
state_version
state_schema_version
root_state_artifact_hash
open_scope descriptors
active node/task descriptors (without live worker authority)
outstanding timers/signals/children
budget ledger watermark
plan_hash and policy_snapshot_id
previous_checkpoint_hash
```

Checkpoints are created on durable suspension, before optional history compaction, after a configurable event/byte threshold, and before a state migration. Creation is copy-on-write: the coordinator commits a checkpoint manifest pointing to immutable state chunks. It does not stop independent executions.

Recovery loads the newest verified checkpoint and replays subsequent history events. A checkpoint is an optimization, not the sole history. If its hash or object is missing, recovery falls back to the prior checkpoint.

## 5.13 Serialization strategy

### Canonical form

- API and graph source: JSON/YAML using JSON Schema 2020-12.
- Internal RPC: Protobuf with unknown-field preservation and explicit schema IDs.
- Canonical history payload: deterministic Protobuf serialization or RFC 8785 JSON canonicalization; the choice is fixed per event schema.
- Large/binary values: immutable encrypted object artifact referenced by ID and SHA-256.
- Time: UTC RFC 3339 with nanosecond-capable logical representation; database time controls leases.
- Decimal/currency: decimal string plus ISO currency, never binary floating point.
- IDs: opaque time-sortable identifiers; business idempotency keys are separate.

### Inline limits

Default limits are policy-configurable:

```text
queue envelope             <= 256 KiB
history event inline body  <= 64 KiB
state cell inline value    <= 16 KiB
task input projection      <= 1 MiB
larger value               => artifact reference
```

The canonical commit path—WorkerGateway for worker results or the coordinator for control transitions—rejects an intent set that exceeds state size or path cardinality budgets. It does not silently spill a value in a way that changes its schema; `ValueRef<T>` is explicit in the type.

### Schema evolution

Event schemas use additive evolution within a major version. Required-field removal, semantic reinterpretation, numeric narrowing, or enum reuse requires a new event major version and an upcaster. Upcasters are pure, versioned, and tested against retained fixtures.

Execution state does not auto-migrate because a graph was edited. An in-flight migration declares:

```yaml
from_plan_hash: sha256:old
to_plan_hash: sha256:new
preconditions:
  allowed_status: [SUSPENDED]
  no_active_effects: true
state_transform: package://migrations/refund-v3-to-v4@1.0.2
node_mapping:
  old_wait: new_wait
validation_schema: registry://state/refund@4
rollback_until_next_effect: true
```

The migration output, code hash, actor, validation, and lineage are recorded. Migration cannot rewrite old history.

## 5.14 Memory management

“Memory” is not a magic state field. The platform separates:

| Memory form | Storage | Access |
|---|---|---|
| working memory | execution state | typed paths and scopes |
| episodic memory | canonical memory records + temporal metadata | memory node with tenant/user/purpose policy |
| semantic retrieval | rebuildable vector/search/graph projection | authorized candidate generation, canonical re-read |
| model context | per-call context manifest | context builder with token/classification budget |
| cache | key/value or object cache | explicit cache node and TTL |

Durable memory writes use `Source -> Candidate -> Policy/Review -> CommittedMemoryVersion`. Model output is a proposal, not automatically authoritative memory. Originals and superseded revisions remain addressable under retention policy. Embeddings and graph relationships are versioned projections; a retrieval result is reauthorized and re-read from canonical records before entering context.

Execution state retention is independent from memory retention. Promoting an execution output to durable memory requires an explicit node, purpose, subject/tenant scope, provenance, expiry, and policy result.

## 5.15 Read consistency

| Reader | Consistency |
|---|---|
| canonical commit path | serialized per execution / locked current row; gateway and coordinator share one transition repository and disjoint transition ownership |
| worker input snapshot | immutable versioned projection |
| execution inspector | read-your-writes when routed to home shard; cursor watermark otherwise |
| analytics/dashboard | eventual, with displayed ingestion watermark |
| search/vector/graph retrieval | eventual candidates followed by canonical authorization/read |
| audit export | committed audit sequence with integrity watermark |

The UI shows `state_version` and `history_seq`. It never presents an eventually consistent analytical view as the live canonical execution status without a freshness indicator.

## 5.16 Failure behavior

| Failure | Required behavior |
|---|---|
| worker submits against stale lease | reject mutation; record late completion metadata |
| concurrent CAS conflict | follow declared conflict policy; never silently overwrite |
| reducer crashes | fail transition before commit; retry pinned deterministic reducer; quarantine if reproducible |
| object upload succeeds, DB commit fails | artifact remains unbound and is garbage-collected |
| DB commit succeeds, event publish fails | outbox relay retries; canonical state remains correct |
| stream connection breaks | execution continues; reconnect from durable cursor |
| checkpoint corrupt/missing | verify hash, fall back, replay more history |
| projection is ahead/behind canonical read | use watermark; canonical read wins |
| state schema unknown to worker | worker rejects before claim or coordinator routes to compatible build |
| mutable external data changes before replay | recorded activity result is substituted; a new fork may explicitly re-read |

## 5.17 Validation and test requirements

- Property-test every reducer for determinism, totality, bounds, and declared algebraic laws.
- Randomize branch completion order and prove identical final state and patch hashes.
- Submit every task completion zero, one, and many times, before and after lease expiry.
- Fuzz state paths, classification labels, artifact references, schema evolution, and unknown fields.
- Replay from every checkpoint and from history origin; compare state root hash after every event.
- Prove the gateway materializes only paths authorized by the bound `ExecutionGrant`, the supervisor cannot broaden that projection, and the sandbox can access only the resulting opaque handles.
- Load-test high-frequency progress without allowing it to starve terminal events.
- Delete every rebuildable projection and recreate it from canonical outbox/history.

## 5.18 Anti-patterns

- Passing a mutable in-memory object among nodes.
- Allowing arbitrary JSON state without a published schema and size policy.
- Using completion time as merge order.
- Letting workers write database state directly.
- Treating Redis, a queue, a vector store, or a graph database as canonical state.
- Storing every streamed token as a transaction.
- Hiding cross-execution reads inside “context” so replay changes.
- Automatically writing model output to durable memory.
- Using distributed locks without fencing tokens.
- Migrating running executions when their graph definition changes without explicit lineage.
