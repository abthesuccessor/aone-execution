# 2. Runtime Architecture

## 2.1 Runtime contract

The runtime executes an immutable **CompiledPlan**, never a mutable authoring document. A **GraphVersion** is the immutable GraphSpec source snapshot; a **Compilation** is one compiler attempt against that source; a successful Compilation produces an immutable CompiledPlan. `plan_hash` is the canonical semantic digest of that plan. Editing creates a new GraphVersion and compiling creates a new Compilation/CompiledPlan; neither changes an admitted execution. PostgreSQL is canonical for their manifests and for execution state, dependency satisfaction, state versions, checkpoints, leases, idempotency records, audit records, and the transactional outbox. Encrypted object storage owns large immutable source/plan bytes referenced by those manifests. Queue messages, Redis entries, search indexes, and analytical stores are derived accelerators and may be discarded and rebuilt.

The implementation MUST preserve these invariants:

1. **Immutable plan:** an execution pins exactly one `graph_version_id`/`source_hash`, `compilation_id`, `compiled_plan_id`/`plan_hash`/`envelope_hash`, compiler version, dependency lock, worker compatibility set, policy snapshot, deployment binding snapshot, and input hash.
2. **Monotonic lifecycle:** terminal execution and attempt states never become non-terminal. Recovery creates a new attempt; it does not reopen an old attempt.
3. **Authoritative claim:** a trusted WorkerSupervisor may run an attempt only after WorkerGateway compare-and-sets the ExecutionToken in PostgreSQL. Receiving a queue message grants no authority; on the worker execution path, only WorkerGateway has runtime write access to PostgreSQL.
4. **Fenced ownership:** every lease acquisition increments an attempt `fencing_token`. Claim, heartbeat, completion, state/effect writes, checkpoint contributions, and budget settlement carry and validate the execution `routing_epoch`, the owning `scheduler_fence` where applicable, the attempt fence, unexpired lease, and pinned `plan_hash`.
5. **Atomic scheduling:** a transition and the outbox record that announces newly runnable work commit in the same transaction.
6. **At-least-once orchestration:** dispatch and attempts may repeat. One logical Activation terminal transition commits at most once. An external effect is effectively-once only when a destination enforces the same deterministic idempotency key for the same canonical request hash, or through a transactional adapter; otherwise it can be `UNKNOWN` and must reconcile.
7. **Deterministic decisions:** branch choice, join membership, loop continuation, expansion identity, and retry policy outcome are persisted before downstream work is scheduled.
8. **Durable nondeterminism:** time, randomness, external responses, model output, human decisions, and signal order are history events or artifacts. Replay consumes the recorded values.
9. **Versioned state:** shared-state updates are compare-and-set operations against a base version. A silent last-writer-wins overwrite is forbidden.
10. **Bounded execution:** every execution and every loop has time, cost, token, expansion, concurrency, and iteration limits.
11. **Cancellation propagation:** cancellation prevents new side effects, propagates through descendants, and records whether an already-started external effect could not be revoked.
12. **Tenant isolation:** tenant, environment, namespace, execution, and policy identity accompany every database query, queue payload, cache key, artifact path, and trace. Shared queue subjects contain bounded routing dimensions, not tenant-specific subjects.

“Execution completed” means the graph reached a terminal runtime state. It does not imply that a business outcome occurred or that a stakeholder accepted the result.

## 2.2 Components and trust boundaries

~~~mermaid
flowchart LR
    API["Control API\nadmit, signal, cancel"] --> PG[("PostgreSQL\ncanonical state + outbox")]
    Compiler["Graph compiler"] --> PG
    Scheduler["Scheduler shards"] <--> PG
    Outbox["Outbox relay"] --> JS["JetStream\nwork notifications"]
    PG --> Outbox
    JS --> Supervisor["Trusted WorkerSupervisor\ncapability pool"]
    Supervisor --> Gateway["WorkerGateway\nclaim + fenced commits"]
    Gateway <--> PG
    Supervisor <--> Runner["Sandboxed runner\nno grant, broker, DB, or ambient egress"]
    Gateway --> Adapter["Effect adapters\nHTTP, DB, tool, model"]
    Supervisor --> Blob[("Object store\nimmutable artifacts")]
    PG --> Projector["Event projectors"]
    Projector --> CH[("ClickHouse\nrebuildable analytics")]
    Projector --> Cache[("Redis\nnon-authoritative cache")]
~~~

| Component | Responsibility | Must not do |
|---|---|---|
| Control API | Authenticate; authorize; validate; create executions, signals, and cancellation requests | Execute user code or infer scheduler state from the queue |
| Compiler | Resolve imports and packages; type-check; lower source graph to typed IR; compute stable hashes | Read mutable runtime state |
| Scheduler shard | Advance state machines; calculate readiness; allocate budgets and permits; create execution tokens | Invoke external side effects |
| Outbox relay | Publish committed work/event notifications; retry until acknowledged | Invent work not represented in PostgreSQL |
| WorkerSupervisor | Pull compatible JetStream hints; ask WorkerGateway to claim; invoke a sandbox; relay heartbeat/result intents | Access canonical PostgreSQL directly or treat message delivery as ownership |
| WorkerGateway | Compare-and-set ExecutionTokens; mint/validate ExecutionGrants; enforce routing, scheduler, attempt, lease, and plan predicates; commit outcomes | Execute untrusted node code or accept caller-supplied authority fields without checking them |
| Sandboxed runner | Execute one implementation with a sanitized context and opaque capability handles | Receive an ExecutionGrant; connect to JetStream/PostgreSQL/adapters; mint grants; or choose state conflict policy |
| Effect adapter | Enforce destination-specific authentication, idempotency, timeout, and result capture | Hide ambiguous completion |
| Checkpoint service | Materialize consistent execution snapshots and validate their manifests | Delete history required by retention policy |
| Projector | Build logs, metrics, search, and analytics views | Become an authorization or recovery authority |

The control plane and data plane can scale independently. Scheduler shards are lightweight state-machine processors. Trusted WorkerSupervisors form capability-specific pools for sandboxed Python, browser automation, GPU inference, outbound HTTP, or private-network adapters. This is **multi-worker scheduling**: WorkerGateway and PostgreSQL retain authority while heterogeneous supervisors compete only for compatible hints. Sandboxed runners have neither broker credentials nor database connectivity.

## 2.3 Runtime entities

### 2.3.1 Execution

An **execution** is one admitted run of one immutable CompiledPlan. Its entity identity is a UUIDv7 generated by the control API. Admission pins:

- tenant, environment, namespace, deployment revision, GraphVersion, Compilation, CompiledPlan, `plan_hash`, compiler, and runtime versions;
- package/plugin digests and node implementation digests;
- dependency lock, worker compatibility set, effective PolicySnapshot, secret-reference versions, model-routing policy, and resource class;
- canonical input artifact/hash and caller idempotency key;
- budget envelope, deadline, priority, routing epoch, scheduler shard/fence, and the home cell selected for `(tenant_id, environment_id)`;
- parent execution, subgraph call site, and root execution when nested.

### 2.3.2 Execution token

An **ExecutionToken** is one stable, non-secret schedulable row for a particular logical Activation. It is not a bearer credential and is not an LLM token. Its stable uniqueness key is:

~~~text
(execution_id, activation_id)
activation_id = digest(
  "activation",
  "urn:ege:activation-identity:v1",
  canonical_json({plan_hash, logical_node_id,
                  expansion_path, loop_path, input_set_hash})
)
~~~

Entity IDs—including Execution, GraphVersion, Compilation, CompiledPlan, ExecutionToken, and Attempt IDs—are UUIDv7 stored as UUIDs. Deterministic identities such as `activation_id`, `effect_id`, and canonical content hashes are SHA-256 values with explicit domain separators; they are not ULIDs or UUIDs.

The token carries required scheduling capability metadata, not credentials. Credentials are resolved just in time from authorized secret references. A logical Activation has exactly one token and may have multiple Attempts keyed by `(execution_token_id, attempt_ordinal)`; only the current non-terminal Attempt may own the token fence. An **ExecutionGrant** is the short-lived, proof-of-possession and mTLS-bound signed capability minted for that claimed Attempt.

A dispatch hint contains the outbox ID, token ID, monotonic `readiness_generation`, routing tuple, capability pool, priority band, shard, and a non-secret trace link. It contains no ExecutionGrant or input value.

### 2.3.3 Execution context

WorkerGateway returns the following full read-only lease envelope to the trusted WorkerSupervisor. It is never passed wholesale to node code; `sandbox.proto` narrows it to invocation identity, declared inputs/state projection, budgets, deterministic clock/seed, replay axes, and opaque capability handles:

~~~json
{
  "execution": {
    "id": "019...uuidv7",
    "root_id": "019...uuidv7",
    "graph_version_id": "019...uuidv7",
    "source_hash": "sha256:...",
    "compilation_id": "019...uuidv7",
    "compiled_plan_id": "019...uuidv7",
    "plan_hash": "sha256:...",
    "envelope_hash": "sha256:...",
    "activation_id": "sha256:...",
    "execution_token_id": "019...uuidv7",
    "attempt_id": "019...uuidv7",
    "attempt_ordinal": 2,
    "routing_epoch": 42,
    "scheduler_fence": 17,
    "fencing_token": 9
  },
  "scope": {
    "tenant_id": "019...uuidv7",
    "namespace": "payments/prod",
    "subgraph_path": ["root", "fraud_check"],
    "loop_path": [{"loop": "repair", "iteration": 3}],
    "expansion_path": ["accounts", "000042"]
  },
  "state": {
    "snapshot_version": 481,
    "read_set": ["case", "policy"],
    "write_capabilities": ["case.assessment"]
  },
  "budgets": {
    "deadline": "2026-08-06T08:00:00Z",
    "remaining_cost_microunits": 280000,
    "remaining_model_tokens": 92000,
    "remaining_effect_calls": 8
  },
  "pins": {
    "policy_snapshot_id": "019...uuidv7",
    "policy_snapshot_hash": "sha256:...",
    "dependency_lock_hash": "sha256:...",
    "implementation_digest": "sha256:...",
    "input_hash": "sha256:..."
  },
  "replay": {
    "operation": null,
    "execution_mode": "LIVE",
    "effect_mode": "REEXECUTE_AUTHORIZED_EFFECT"
  }
}
~~~

The supervisor may add attempt-local telemetry but may not mutate this envelope. State changes are returned as typed write intents. The sandbox never receives routing/scheduler/fencing fields, the raw ExecutionGrant, provider credentials, or direct adapter authority.

### 2.3.4 Metadata and history

**Execution metadata** is query-oriented current state: status, timestamps, counters, owners, parent links, pinned versions, and terminal summary. **Execution history** is the ordered, append-only record of decisions and observations. Metadata may be repaired by folding history plus current token rows; history may not be reconstructed from metadata.

Each history event has an execution-local sequence allocated in the same transaction as the represented transition. Ordering across executions is partial, represented by parent event ids, signal ids, and trace links. Wall-clock timestamps are diagnostic, not causality.

## 2.4 Runtime flow and sequence diagram

~~~mermaid
sequenceDiagram
    participant C as Client
    participant A as Control API
    participant P as PostgreSQL
    participant S as Scheduler
    participant Q as JetStream
    participant W as WorkerSupervisor
    participant G as WorkerGateway
    participant R as Sandboxed runner
    participant X as Effect adapter

    C->>A: Start(deployment revision, input, idempotency key)
    A->>P: resolve + pin GraphVersion, Compilation, CompiledPlan, policy, placement
    A->>P: insert execution/history/outbox atomically
    P-->>A: existing or new execution id
    A-->>C: accepted(execution id)
    S->>P: lock execution; reduce events; create READY tokens + outbox
    P->>Q: relay publishes outbox-id hint
    Q-->>W: token-ready(token id, readiness generation)
    W->>G: ClaimExecutionToken(token, generation, routing epoch, plan hash)
    G->>P: CAS claim; validate scheduler fence; increment attempt fence
    P-->>G: current token + Attempt
    G-->>W: lease + supervisor-held PoP ExecutionGrant
    W->>R: invoke(sanitized context, opaque handles, deadline)
    R->>W: brokered capability request(handle, arguments)
    W->>G: capability request + PoP ExecutionGrant
    G->>X: policy-checked adapter call
    X-->>G: typed result + effect receipt
    G-->>W: opaque brokered result
    W-->>R: brokered result
    R-->>W: result + state intents
    W->>G: Complete(result, intents, gateway-issued receipt evidence, full fence tuple)
    G->>P: lock complete activation effect ledger; classify terminal outcome
    G->>P: fenced completion + state + event + outbox transaction
    S->>P: satisfy dependencies; schedule successors
~~~

Admission is a transaction, not a queue publish. Schema, authentication, authorization, policy, quota/capacity, or infeasible-deadline rejection is persisted in the admission/idempotency decision and returned as an API error; it creates no Execution row. The Execution lifecycle begins at `ADMITTED` only after the durable admission transaction commits:

1. Resolve the active DeploymentRevision to a GraphVersion, successful Compilation, selected CompiledPlan, PolicySnapshot, and `(tenant_id, environment_id)` placement assignment.
2. Authorize the caller for the graph and every statically declared capability.
3. Validate input against the pinned input schema.
4. Validate `plan_hash`, package digests, worker compatibility set, and policy snapshot; reject revoked or incompatible dependencies.
5. Check tenant quota, concurrency, deadline, and budget minima.
6. Insert-or-return by (tenant_id, caller_idempotency_key).
7. Persist execution, initial input artifact, ExecutionAdmitted history event, root activation, and outbox message atomically.

Dynamic capabilities introduced by expansion are authorized again before activation.

## 2.5 Lifecycle state machines

### 2.5.1 Execution state diagram

~~~mermaid
stateDiagram-v2
    [*] --> ADMITTED
    ADMITTED --> RUNNING: root token committed
    RUNNING --> SUSPENDED: waiting for signal/timer/approval
    SUSPENDED --> RUNNING: durable wake condition
    RUNNING --> CANCELLING: cancel requested
    SUSPENDED --> CANCELLING: cancel requested
    RUNNING --> SUCCEEDED: terminal output committed
    RUNNING --> FAILED: unrecoverable failure
    RUNNING --> TIMED_OUT: execution deadline
    RUNNING --> QUARANTINED: ambiguous effect or integrity violation
    QUARANTINED --> RUNNING: authorized reconciliation committed
    QUARANTINED --> FAILED: reconciliation proves terminal failure
    CANCELLING --> CANCELLED: descendants quiesced
    CANCELLING --> CANCELLED_WITH_EFFECTS: non-revocable effect recorded
    ADMITTED --> CANCELLED: cancelled before dispatch
    SUCCEEDED --> [*]
    FAILED --> [*]
    TIMED_OUT --> [*]
    CANCELLED --> [*]
    CANCELLED_WITH_EFFECTS --> [*]
~~~

`ADMITTED` means the request has already passed admission and its execution, pins, initial state/history, and root scheduling intent are durable. `SUSPENDED` carries a typed reason such as timer, signal, approval, child, debugger breakpoint, operator pause, or rate wait. `QUARANTINED` is non-terminal, not scheduler-claimable, and may leave only through an authorized reconciliation event. Allowed transitions are represented in code as an exhaustive table and duplicated as a database constraint/transition function. An execution is terminal only after no token is claimable or leased, all child cancellations have resolved according to policy, terminal state and output manifest are committed, and an ExecutionTerminal event exists.

### 2.5.2 Activation and attempt states

Logical activation states:

~~~text
BLOCKED -> READY -> RUNNING -> {SUCCEEDED | RETRY_WAIT | FAILED | TIMED_OUT | CANCELLED | SKIPPED}
RETRY_WAIT -> READY
BLOCKED -> SKIPPED              (untaken branch or impossible join)
RUNNING -> UNKNOWN_EFFECT       (ambiguous external completion requiring reconciliation)
UNKNOWN_EFFECT -> {SUCCEEDED | RETRY_WAIT | FAILED}
~~~

Attempt states are immutable after terminalization:

~~~text
CLAIMED -> STARTED -> {COMPLETED | ERROR | TIMED_OUT | CANCELLED | LEASE_LOST | UNKNOWN_EFFECT}
~~~

The activation becomes SUCCEEDED only when result artifacts, state intents, usage, attempt terminal event, and successor wakeups commit. A worker crash before that transaction leaves the attempt reclaimable after lease expiry.

## 2.6 Scheduler

### 2.6.1 Sharding and serialization

The scheduler partitions by hash(tenant_id, execution_id) into virtual shards. One scheduler process may own many shards under short leases. Within an execution, state-machine reduction is serialized using a PostgreSQL advisory lock or a row lock on the execution. Work across executions remains parallel.

Shards are virtual so they can be reassigned without moving canonical data. A scheduler lease has owner, expiry, and fence. Scheduler writes include the fence, preventing a paused process from acting after reassignment.

### 2.6.2 Readiness algorithm

The scheduler maintains dependency counters as an optimization, but verifies readiness from canonical dependency rows before changing BLOCKED to READY.

~~~text
function advance_execution(execution_id, scheduler_fence):
    begin transaction
    execution = lock execution row
    require execution.scheduler_fence == scheduler_fence
    events = load history after execution.reduced_through_seq
    state = deterministic_reduce(execution.metadata, events)

    if deadline_passed(state):
        request_cancellation(TIMED_OUT)

    for activation in affected_blocked_activations(events):
        deps = lock dependency rows for activation
        decision = evaluate_join_policy(deps, activation.join_policy)

        if decision == IMPOSSIBLE:
            mark activation SKIPPED with persisted reason
        else if decision == SATISFIED:
            require type_and_policy_guards_hold(activation)
            reservation = reserve_budget_and_concurrency(activation)
            if reservation.granted:
                compare-and-set activation BLOCKED -> READY
                insert token if this Activation has none; otherwise reuse it
                append TokenReady history event
                increment token.readiness_generation
                insert outbox message with a new outbox UUIDv7

    update reduced_through_seq
    commit
~~~

Join policies are explicit:

- **ALL:** all selected upstream activations must succeed; an unrecoverable required failure makes the join impossible.
- **ANY:** first successful upstream commits the winner; remaining optional branches receive cancellation.
- **QUORUM(k):** k successes; impossible when successes plus remaining candidates is less than k.
- **COLLECT:** wait for every branch terminal state and pass a typed success/error collection.
- **REDUCE:** fold results in persisted deterministic order using an associative reducer; non-associative reducers must declare a strict order and sacrifice parallel reduction.

Priority combines service class, tenant fair-share deficit, explicit execution priority, deadline urgency, age, and retry penalty. User input cannot directly set system or emergency priority.

### 2.6.3 Dispatch and claim

The outbox relay publishes each committed readiness transition on:

~~~text
dispatch.<cell>.<pool>.<priority_band>.<shard>
Nats-Msg-Id = outbox_message.id
payload = {outbox_id, execution_token_id, readiness_generation,
           tenant_id, environment_id, home_cell_id, routing_epoch, scheduler_fence,
           plan_hash, trace_link}
~~~

Relay retries reuse the same outbox ID. A later retry/readiness transition creates a new outbox row and increments `readiness_generation`, so JetStream deduplication cannot suppress legitimate reuse of the stable ExecutionToken. The trusted WorkerSupervisor pulls compatible hints and calls `WorkerGateway.ClaimExecutionToken`. Inside one canonical claim transaction, WorkerGateway locks the relevant rows, verifies worker build/contract/capability compatibility, budget/deadline/cancellation state and the outbox payload binding, then performs this core compare-and-set:

~~~sql
UPDATE execution_token AS t
SET status = 'RUNNING',
    lease_owner = :worker_id,
    lease_expires_at = clock_timestamp() + :lease_duration,
    fencing_token = t.fencing_token + 1,
    attempt_ordinal = t.attempt_ordinal + 1
FROM execution AS e
JOIN execution_pin AS ep
  ON ep.tenant_id = e.tenant_id
 AND ep.execution_id = e.id
JOIN outbox_message AS o
  ON o.tenant_id = e.tenant_id
WHERE t.tenant_id = :tenant_id
  AND t.id = :token_id
  AND e.tenant_id = t.tenant_id
  AND e.id = t.execution_id
  AND e.environment_id = :environment_id
  AND e.home_cell_id = :home_cell_id
  AND e.routing_epoch = :routing_epoch
  AND e.scheduler_fence = :scheduler_fence
  AND ep.plan_hash = :plan_hash
  AND t.routing_epoch = :routing_epoch
  AND t.scheduler_fence = :scheduler_fence
  AND t.plan_hash = :plan_hash
  AND t.readiness_generation = :readiness_generation
  AND t.last_dispatch_outbox_id = :outbox_message_id
  AND o.id = :outbox_message_id
  AND o.message_type = 'ExecutionTokenReady.v1'
  AND o.payload IS NOT NULL
  AND o.payload->>'tenant_id' = :tenant_id
  AND o.payload->>'environment_id' = :environment_id
  AND o.payload->>'home_cell_id' = :home_cell_id
  AND (o.payload->>'routing_epoch')::bigint = :routing_epoch
  AND (o.payload->>'scheduler_fence')::bigint = :scheduler_fence
  AND o.payload->>'execution_token_id' = :token_id
  AND (o.payload->>'readiness_generation')::bigint = :readiness_generation
  AND o.payload->>'plan_hash' = :plan_hash_text
  AND e.status IN ('ADMITTED', 'RUNNING')
  AND e.cancellation_requested_at IS NULL
  AND e.deadline_at > clock_timestamp()
  AND t.status IN ('READY', 'RETRY_WAIT')
  AND t.available_at <= clock_timestamp()
  AND (t.lease_expires_at IS NULL
       OR t.lease_expires_at < clock_timestamp())
RETURNING t.id, t.fencing_token, t.attempt_ordinal, t.lease_expires_at,
          e.routing_epoch, e.scheduler_fence, ep.plan_hash;
~~~

The gateway inserts the UUIDv7 Attempt row and mints an audience-bound ExecutionGrant in the same authority flow. No returned row means no authority. The WorkerSupervisor acknowledges the hint after gateway-confirmed stale/non-claimable state or after fenced completion is accepted; redelivery while an Attempt is active is harmless. A database reconciler creates new outbox rows for READY tokens whose notification was lost; JetStream retention remains non-authoritative.

### 2.6.4 Leases and fencing

Lease duration is capability-specific and much shorter than the attempt timeout. WorkerSupervisors heartbeat through WorkerGateway at no more than one-third of the lease duration. Claim, heartbeat, and completion include `routing_epoch`, `scheduler_fence` where the transition depends on scheduler ownership, `attempt_ordinal`, `fencing_token`, and `plan_hash`. The gateway extends or commits only when the authenticated supervisor owns the Attempt and this complete predicate holds:

~~~text
execution.routing_epoch       == request.routing_epoch
execution.scheduler_fence     == request.scheduler_fence   # when applicable
execution_pin.plan_hash       == request.plan_hash
token.status                  == RUNNING
token.lease_owner             == authenticated_worker_id
token.attempt_ordinal         == request.attempt_ordinal
token.fencing_token           == request.fencing_token
token.lease_expires_at        > database_now()
~~~

There is no implicit post-expiry commit grace period. A result produced during a bounded local grace period may be uploaded as an immutable artifact, but accepting it still requires a current lease and fence; otherwise a newly claimed Attempt must reconcile or recompute it.

Every completion, state write, checkpoint contribution, effect receipt, and budget charge is conditional on the full predicate, not merely the attempt fence. For an external system:

- pass activation id plus attempt-independent effect idempotency key;
- when supported, pass fencing token and require the destination to reject lower tokens;
- otherwise use a platform-owned transactional effect adapter;
- when neither is possible, classify the effect as non-idempotent and require reconciliation after ambiguous failure.

Leases alone do not prevent a paused supervisor from writing; routing, scheduler, attempt, expiry, and plan fencing are all mandatory. The sandbox cannot bypass this protocol because it has neither PostgreSQL nor JetStream credentials.

## 2.7 Control-flow semantics and parallel execution

### 2.7.1 Parallel, fork, fan-out, and fan-in

A **fork** has statically known outgoing branches. A **fan-out** maps a bounded collection to dynamic child activations. A **parallel** group is a concurrency and cancellation scope. A **fan-in** is a join with an explicit policy.

Fan-out assigns each item a stable key:

~~~text
child_activation_id =
  digest("activation", "urn:ege:activation-identity:v1",
         canonical_json({parent_activation_id, expansion_spec_hash,
                         canonical_item_key, child_logical_node_id}))
~~~

Array position is not a stable key unless the contract declares order immutable. Duplicate item keys fail validation. The scheduler writes the expansion manifest before child tokens, including item-key hashes, count, child ids, and source state version. Re-execution loads that manifest instead of regenerating children.

Large fan-outs are paged. A parent may have at most max_expansion_items and max_inflight_children; additional pages remain BLOCKED. This prevents a million-item input from creating a million immediately runnable tokens.

### 2.7.2 Conditional branching

Conditions execute against a pinned snapshot and produce a typed BranchDecision event:

~~~json
{
  "predicate_id": "risk-route",
  "predicate_version": "sha256:...",
  "input_state_version": 481,
  "selected_edge_ids": ["edge-manual-review"],
  "decision_hash": "sha256:...",
  "evaluated_at": "2026-08-06T06:41:12.212Z"
}
~~~

Only selected edges satisfy dependencies. Non-selected paths become SKIPPED when no other reachable predecessor can activate them. Conditions must be deterministic expressions or recorded node results; a live model call cannot be hidden inside an edge predicate.

### 2.7.3 Loops

A loop compiles into a controller activation plus an iteration subgraph. The controller owns the loop counter, budget slice, stopping-rule version, and last progress fingerprint. Each iteration path is explicit in activation identity. The decision to continue or stop is a history event committed before the next iteration is materialized. Detailed loop policy is defined in [Chapter 6](./06-loop-engineering.md).

### 2.7.4 Subgraphs and nested graphs

Subgraphs have typed input/output ports and an explicit state boundary:

- **inline:** compiler namespaces child logical ids into the parent plan; one execution and transaction domain;
- **child execution:** runtime creates a child execution pinned to its resolved GraphVersion, Compilation, CompiledPlan, and PolicySnapshot; cancellation, budget, trace, and audit lineage propagate;
- **remote child:** child runs in another cell/region through a durable command and returns a signed result manifest.

Recursion is disabled unless the package declares it. Recursive depth, total descendants, and inherited budget are bounded. A parent waiting for a child is SUSPENDED, not RUNNING. Child success does not become visible to the parent until a ChildCompleted event and result manifest commit.

### 2.7.5 Dynamic graph generation and expansion

Dynamic generation never executes arbitrary graph text directly. A generator returns a proposed IR fragment that passes:

1. schema validation and canonicalization;
2. node/edge/port type checking;
3. package resolution to allowed immutable digests;
4. capability and policy authorization;
5. cycle and loop-controller validation;
6. maximum nodes, edges, depth, fan-out, and estimated-budget checks;
7. deterministic fragment hashing.

The runtime stores DynamicExpansionAccepted(fragment_hash, parent_activation_id, source_state_version, policy_snapshot_hash), then materializes deterministic activation ids. Replay uses the accepted fragment artifact. Policy rejection is a normal typed node failure, not a partial expansion.

Dynamic expansion may append descendants behind the expansion point; it may not rewrite completed history, change an active node implementation, or introduce an incoming edge to an already runnable activation.

## 2.8 Node execution protocol

### 2.8.1 Worker algorithm

~~~text
WorkerSupervisor on dispatch hint:
    claim = WorkerGateway.ClaimExecutionToken(
        token_id, readiness_generation, outbox_message_id,
        routing_epoch, scheduler_fence, plan_hash
    )
    if claim absent: acknowledge gateway-confirmed stale hint; return

    require claim.attempt_id is UUIDv7
    require claim.ExecutionGrant audience is WorkerGateway
    require claim.ExecutionGrant presenter is this supervisor's mTLS identity
    context = claim.immutable_context_and_state_snapshot
    validate plan hash, implementation digest, policy snapshot, and grant expiry

    start WorkerGateway.HeartbeatExecutionToken loop(
        routing_epoch, scheduler_fence, token_id, attempt_ordinal,
        fencing_token, lease_expires_at, plan_hash
    )
    try:
        result = sandbox.run(sanitized_context, opaque_capability_handles,
                             cancellation_token)
        validate result schema
        result_ref = persist immutable result artifact
        write_intents = validate worker intent vocabulary and declared paths

        WorkerGateway.CompleteExecutionToken(
            routing_epoch, scheduler_fence, token_id, attempt_ordinal,
            fencing_token, plan_hash,
            result_ref, write_intents, effect_receipts, usage
        )
        # Gateway rechecks database time and every fence, then atomically applies
        # terminal policy from the complete locked effect ledger (request receipts
        # are consistency evidence and omissions do not assert "no effects"),
        # MVCC state, budget settlement, attempt/Activation transition, events,
        # successor readiness_generation, and outbox rows.
    catch observed runtime error or nonterminal effect receipt:
        WorkerGateway.FailExecutionToken(full_fence_tuple, runtime_error, receipts)
        # Gateway, not the supervisor or sandbox, derives retry, stop, or
        # reconciliation disposition from trusted policy and every canonical
        # effect_operation row for the Activation under the terminal transaction.
    finally:
        stop heartbeat
~~~

The implementation receives a cooperative cancellation token. Sandboxed processes also receive a hard wall-clock deadline, CPU/memory limits, file/network policy, and an output-size limit. They return data and intents to the supervisor; only WorkerGateway can write canonical runtime state.

### 2.8.2 Idempotency and effects

Three ids are distinct:

| Identifier | Scope | Purpose |
|---|---|---|
| activation_id | logical work across retries | Stable graph identity |
| attempt_id | one worker attempt | Diagnostics and resource accounting |
| effect_id | one declared external intention | Sink deduplication and reconciliation |

An effect ID is `digest("effect", "urn:ege:effect-identity:v1", canonical_json({tenant_id, execution_id, activation_id, effect_name, effect_ordinal}))`. It is stable for one logical call and deliberately excludes request bytes. WorkerGateway always derives a platform-only operation key from the effect ID and binds it to `canonical_request_hash` in the effect ledger. For `NATIVE` or `ADAPTER` idempotency it additionally evaluates the CompiledPlan `idempotencyKey`, reserves the destination-scoped hash, and sends only the adapter-defined representation. For `NONE`, that destination key is absent—the operation key is never presented as destination idempotency. Retrying one logical effect or destination key with different canonical bytes is rejected and audited. Adapter outcomes are:

- COMMITTED with destination receipt;
- REJECTED with stable error;
- NOT_COMMITTED, safe to retry;
- UNKNOWN, requiring destination-specific reconciliation before retry.

The ledger also has transient `RESERVED` and `STARTED` states, which are never legal terminal receipts. Wire `OUTCOME_NOT_STARTED` means trusted adapter processing reserved the effect but proved that the external destination operation boundary was not crossed; the terminal transaction normalizes a matching `RESERVED` row to canonical `NOT_COMMITTED`. Wire `OUTCOME_NOT_COMMITTED` also projects to canonical `NOT_COMMITTED`, but a `STARTED` row requires trusted adapter proof. Without that proof it becomes `UNKNOWN`. Terminal success/retry is rejected while any row remains transient, and success is forbidden while any row is ambiguous.

Do not advertise “exactly once” for arbitrary HTTP calls. The runtime provides an at-most-once logical Activation terminal transition under the full fence predicate; effect semantics depend on the destination contract.

## 2.9 Checkpointing and recovery

### 2.9.1 Checkpoint contents

A checkpoint is an immutable manifest, not a mutable row dump. It contains:

- execution ID, GraphVersion ID/source hash, Compilation ID, CompiledPlan ID/semantic plan hash/envelope hash, PolicySnapshot, runtime/compiler versions;
- history sequence covered and prior checkpoint hash;
- state snapshot version and state-manifest hash;
- activation/token summaries, dependency counters, loop controllers, timers, signals, and child links;
- outstanding effect ids with known receipts or UNKNOWN status;
- budget ledger position and artifact references;
- encryption key version, creation reason, and checksum.

Large state and node outputs are content-addressed artifacts. The PostgreSQL checkpoint row owns their references and hashes. A checkpoint is valid only after every artifact is durable and the manifest commits.

Checkpoints occur at safe points: after a node transition, before/after an external effect when supported, at loop boundaries, before suspension, after a configurable event count, and before planned migration. They do not snapshot a running process heap.

### 2.9.2 Recovery procedure

~~~text
recover(execution_id):
    acquire scheduler lease and fence
    load newest checkpoint whose manifest and artifacts verify
    if none: start from ExecutionAdmitted
    fold ordered history events after checkpoint.history_seq
    compare folded state with canonical token/dependency rows
    repair derived counters transactionally and emit RecoveryRepair event
    expire stale worker leases
    for each incomplete effect:
        reconcile by effect_id; never blindly repeat UNKNOWN
    republish runnable tokens through outbox
    restore durable timers/signals
~~~

Recovery is idempotent. A reconciliation mismatch quarantines the execution rather than guessing. Periodic restore drills must rebuild a random sample using only PostgreSQL, object storage, pinned artifacts, and KMS-accessible keys.

## 2.10 Replay

Replay uses three independent axes; implementations must not overload a single `replay_mode` field:

- `operation`: `STATE_REBUILD`, `EXACT_REPLAY`, or `FORKED_REPLAY`;
- `execution_mode`: `LIVE`, `REPLAY`, or `SIMULATION`;
- adapter `effect_mode`: `SUBSTITUTE_RECORDED`, `REEXECUTE_READ_ONLY`, `REEXECUTE_AUTHORIZED_EFFECT`, or `FORBID`.

The allowed combinations are:

| Operation | Execution mode | Default effect mode | Writes | Use |
|---|---|---|---|---|
| none (ordinary start) | LIVE | REEXECUTE_AUTHORIZED_EFFECT | canonical execution | Normal admitted execution under CompiledPlan policy |
| STATE_REBUILD | REPLAY | FORBID | repair derived runtime state only | Disaster recovery and invariant checks |
| EXACT_REPLAY | REPLAY | SUBSTITUTE_RECORDED | isolated replay namespace | Debugging and deterministic verification |
| EXACT_REPLAY | SIMULATION | REEXECUTE_READ_ONLY | isolated simulation namespace | Compare current pure/read-only adapters without effects |
| FORKED_REPLAY before cut | REPLAY | SUBSTITUTE_RECORDED | new fork history | Reuse original history through the selected event |
| FORKED_REPLAY after cut | LIVE or SIMULATION | FORBID by default; approval may select REEXECUTE_AUTHORIZED_EFFECT | new execution/fork only | What-if analysis or governed regression |

`REEXECUTE_AUTHORIZED_EFFECT` never means “repeat everything”: admission reauthorizes the fork, the CompiledPlan must declare the effect, the adapter must satisfy its idempotency/reconciliation contract, and high-risk policy may require approval. `FORBID` fails closed before adapter invocation. Recovery-time reconciliation is a distinct operator operation, not a replay effect mode.

An exact replay verifies, for each deterministic node, CompiledPlan semantic hash, implementation digest, canonical input hash, output hash, state delta hash, branch decision, and expansion hash. A mismatch produces DeterminismViolation and halts verification. It does not overwrite the original.

Recorded history must include:

- logical clock reads and random seeds;
- external response body hash, status, headers permitted by policy, and artifact reference;
- model provider/model/version, request hash, response artifact, usage, and routing decision;
- signal/approval content and accepted ordering;
- package, schema, policy, prompt, tool, secret-reference, and implementation versions.

Secrets themselves are not recorded. Exact replay normally returns the recorded result without resolving the secret again.

## 2.11 Retry, timeout, cancellation, and dead letters

### 2.11.1 Error classification and retry

Node implementations return only a stable error code, closed error category, sanitized safe message, and an optional detail-artifact reference. Worker and sandbox output never declares retryability or effect safety. WorkerGateway derives the retry disposition from the pinned node/effect policy, trusted receipt outcome, remaining budgets, and PolicySnapshot; arbitrary exception text is not policy input.

~~~text
delay(attempt) =
  min(max_delay, base_delay * 2^(attempt - 1))
jitter =
  deterministic_uniform(execution_id, activation_id, attempt, 0, delay)
retry_at = first_failure_time + delay/2 + jitter/2
~~~

Persist retry_at so recovery and replay do not recalculate against a new clock. A retry requires all of:

- policy permits the error category and attempt count;
- execution deadline and retry budget allow another attempt;
- effect is confirmed absent or destination-idempotent;
- implementation/package has not been revoked;
- cancellation has not been requested.

Retries consume a separate retry budget and do not reset loop budgets.

### 2.11.2 Timeouts

Four timeouts are independent:

1. **Queue delay limit:** latest acceptable start; violation may escalate priority or fail admission policy.
2. **Attempt timeout:** maximum wall time for one attempt.
3. **Idle timeout:** no heartbeat/progress for a capability-specific duration.
4. **Execution deadline:** absolute end-to-end deadline inherited by descendants.

The effective attempt deadline is the minimum of all enclosing deadlines. Timeout marks the orchestration state; it cannot prove an external effect stopped. Such attempts enter UNKNOWN_EFFECT until reconciled.

### 2.11.3 Cancellation

Cancellation is a durable request with requester, reason, policy, and sequence. The scheduler:

1. changes execution to CANCELLING;
2. blocks unpublished/new tokens and removes budget reservations;
3. emits cancellation notices for leased attempts;
4. propagates to child executions and parallel scopes according to policy;
5. waits a bounded grace period, then terminates sandboxed processes;
6. reconciles in-flight external effects;
7. commits CANCELLED or CANCELLED_WITH_EFFECTS.

Compensation is an explicit graph, not rollback magic. Compensation nodes have their own retries, permissions, and audit trail and may themselves fail.

### 2.11.4 Dead-letter queue

The DLQ is a canonical dead_letter_entry table plus a notification stream. Entries are created for:

- exhausted safe retries;
- poison payload/schema mismatch;
- missing or revoked implementation;
- repeated worker crash;
- unreconciled ambiguous effect;
- invariant or determinism violation;
- policy quarantine.

Each entry records the original token/event reference, immutable payload artifact, error classification, attempt history, pins, last fence, recommended action, and redrive count. Redrive always creates a new attempt or forked execution with an audit record; it never mutates a terminal attempt. Bulk redrive requires tenant scope, rate limits, and policy approval.

## 2.12 Timers, signals, and human waits

Timers are rows keyed by execution and activation with an absolute fire time and a unique wake id. A regional timer service scans indexed time buckets, creates TimerFired plus outbox in one transaction, and tolerates duplicates. Long waits consume no worker.

Signals and approval responses use caller idempotency keys and expected-state/version preconditions. Early signals may be buffered only if the graph declares that signal name. Multiple acceptable signals use a persisted selection policy such as first accepted sequence, quorum, or latest-before-deadline.

## 2.13 Distribution and placement

The placement directory maps `(tenant_id, environment_id, routing_epoch)` to exactly one writable home runtime cell. A tenant may have different residency-approved environments in different cells. Every execution pins the resolved `environment_id`, `home_cell_id`, and `routing_epoch` at admission, and its active execution tree remains in that cell unless a fenced checkpoint/export/import migration is performed. A cell contains PostgreSQL shards, scheduler shards, JetStream, WorkerGateway, trusted WorkerSupervisors, object-store access, and projectors. The global control plane routes to the pinned home cell; it does not coordinate individual nodes.

Placement considers:

- tenant data residency and graph deployment region;
- worker capability, resource class, accelerator, and private-network reachability;
- secret residency and egress policy;
- queue depth, predicted duration, deadline, and tenant fair share;
- artifact locality and allowed cross-region transfer.

Remote execution uses a child-execution contract with signed input and result manifests. It does not stretch a database transaction across regions. Each `(tenant_id, environment_id)` placement has one writer region at a time; failover increments its routing epoch before the replacement cell accepts claims or completions.

## 2.14 Event contract

Every canonical runtime event conforms to the sole shared machine contract,
[`execution-history-event.schema.json`](../contracts/execution-history-event.schema.json).
It requires UUIDv7 entity IDs, the domain-prefixed activation/payload hashes,
`schema_version`, classification, actor, occurrence/recording times, and exactly one
inline or artifact-backed payload. Chapter 14 maps the same fields to PostgreSQL, and
the REST history operation references this exact schema rather than maintaining a copy.

Producers use additive versioning within a schema version. Breaking changes require a new version and an upcaster retained for at least the maximum replay retention. Consumers persist their projection offset and must be idempotent by event_id.

## 2.15 Design decisions and rejected shortcuts

| Decision | Why | Alternative | Trade-off / operational impact |
|---|---|---|---|
| PostgreSQL canonical state plus transactional outbox | Atomic lifecycle and dispatch intent; strong constraints and recovery | Queue-first orchestration | More write pressure and careful partitioning; avoids orphan messages and invisible work |
| Queue messages as hints | Duplicate/lost notifications cannot corrupt state | Queue owns token state | Workers add a claim round trip; recovery is substantially simpler |
| Per-execution serialized reduction | Deterministic branch/join/state decisions | Fully optimistic global scheduling | A single giant execution has a control-plane throughput ceiling; node work still runs in parallel |
| Leases plus fencing | Handles process pause and network partition | Lease expiry alone | Every adapter/write path must carry the fence |
| Typed immutable IR | Reproducibility, static validation, safe packages | Interpret mutable canvas JSON | Compilation adds latency at publish time, not run time |
| Explicit effect semantics | Truthful handling of ambiguous external calls | Claim universal exactly-once | Adapter engineering and reconciliation are required |
| Checkpoint plus history | Fast recovery and auditable replay | Snapshot-only or event-only | More storage; retention and compaction need policy |
| Single writer per tenant environment | Prevent split brain and cross-region consensus on every transition | Active-active writes for one placement | Regional failover needs routing epochs; normal execution stays low latency |

Anti-patterns:

- publishing work before committing the corresponding state transition;
- using Redis locks as the only execution authority;
- acknowledging a queue message before a successful claim or terminal-state check;
- retrying a timed-out non-idempotent effect without reconciliation;
- recomputing a branch, random seed, model response, or dynamic expansion during replay;
- treating a process heartbeat as proof that an external effect did not occur;
- serializing an entire fan-out into one oversized queue message;
- mutating a GraphVersion or CompiledPlan, collapsing Compilation into either entity, or resolving “latest” packages at run time.

## 2.16 Failure-mode matrix

| Failure | Detection | Correct response | Evidence retained |
|---|---|---|---|
| Worker dies before effect | Lease expires; no receipt | Reclaim and retry | attempt, fence, heartbeat trail |
| Worker dies after idempotent effect | Lease expires; sink receipt found | Reconcile and commit result | effect id and destination receipt |
| Worker dies after non-idempotent effect | Lease expires; outcome unknown | Quarantine or adapter-specific reconciliation | request hash, timestamps, UNKNOWN_EFFECT |
| Queue unavailable | Outbox backlog and publish SLO alarm | Continue canonical commits within admission limit; replay outbox | outbox attempts and lag |
| PostgreSQL primary unavailable | connection/failover alarms | Stop claims; promote only through fenced HA process | database and routing epochs |
| Scheduler split brain | stale scheduler fence rejected | Current owner continues; old owner exits | shard lease history |
| Object write succeeds, DB commit fails | unreferenced artifact | retry by content hash; garbage collect after grace | object checksum and upload id |
| DB commits artifact ref, object missing | manifest verifier fails | block transition; restore/re-upload | checkpoint validation event |
| Poison graph expansion | compiler/policy rejection | fail activation without materializing children | proposed fragment and rejection |
| Projector lag/corruption | offset/consistency checks | rebuild from canonical event/outbox data | projection generation and offset |

## 2.17 Build order and acceptance gates

1. Implement immutable GraphVersion/Compilation/CompiledPlan admission, execution/Activation state machines, transactional outbox, WorkerGateway claims, leases, and fences.
2. Add typed state writes, dependency evaluation, branches, static parallelism, retries, and deterministic timers.
3. Add effect adapters with idempotency/reconciliation, checkpoints, exact replay, cancellation, and DLQ redrive.
4. Add bounded fan-out, child executions, loops, dynamic expansion, and remote placement.
5. Prove recovery and scale with fault injection before enabling user plugins.

Runtime acceptance requires executable tests for:

- duplicate queue delivery and duplicate completion;
- stable-token retry delivery with distinct outbox IDs and readiness generations;
- worker pause beyond lease followed by stale write;
- stale routing epoch, scheduler fence, plan hash, lease expiry, and attempt fence rejection on every gateway mutation;
- crash before and after every transaction boundary;
- outbox publish loss and reordering;
- branch, join, retry, loop, and expansion replay equivalence;
- cancellation during queueing, computation, state commit, and external effect;
- checkpoint corruption and recovery from the prior checkpoint;
- regional routing-epoch failover without two writers for one tenant/environment placement;
- bounded fan-out and backpressure under a hot tenant;
- reconstruction without Redis, JetStream history, ClickHouse, or search indexes.
