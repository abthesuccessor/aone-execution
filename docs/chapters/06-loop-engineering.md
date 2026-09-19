# 6. Loop Engineering

## 6.1 Loops are governed control regions

An AI loop is not “call the model until it looks good.” It is a typed control-flow region with:

- an immutable loop specification and body subgraph;
- explicit loop-carried state and per-iteration inputs/outputs;
- deterministic accounting and persisted decisions;
- hard iteration, time, cost, token, tool-call, and expansion ceilings;
- independently versioned evaluators and stop rules;
- cycle/stagnation detection;
- checkpoint, cancellation, retry, and replay semantics.

Together, its hard bounds and cycle/stagnation rules provide **infinite loop prevention**; no heuristic evaluator can waive them.

Every control-flow cycle in the Graph IR MUST cross one loop controller. Hidden recursion in an agent, plugin, tool callback, or dynamic graph generator is rejected or counted against the same root budget.

The runtime distinguishes three mechanisms:

1. **Attempt retry:** repeat the same logical activation after a classified infrastructure/transient failure.
2. **Semantic loop:** execute another graph iteration because a persisted stop rule says the result is not yet adequate.
3. **Execution replay:** reconstruct or fork an execution from durable history.

Combining them into one “retry count” makes cost, safety, and debugging unmanageable.

## 6.2 Loop region model

~~~mermaid
flowchart LR
    Enter["Enter\nvalidate + reserve"] --> Body["Iteration body\npath i"]
    Body --> Eval["Evaluator(s)\nversion pinned"]
    Eval --> Observe["Progress + cycle detector"]
    Observe --> Decide{"Persisted\nstop decision"}
    Decide -->|continue| Commit["Commit carried state\ncheckpoint boundary"]
    Commit --> Body
    Decide -->|success| Output["Loop output"]
    Decide -->|limit/unsafe| Limit["Typed terminal outcome"]
    Decide -->|cancel| Cancel["Cancelled"]
~~~

The controller is the only component allowed to create the next iteration. Each iteration has a stable identity:

~~~text
iteration_id = H(
  execution_id,
  loop_controller_activation_id,
  nested_loop_path,
  iteration_ordinal,
  loop_spec_hash
)
~~~

The loop controller persists LoopIterationCommitted and LoopDecision before scheduling the next iteration. A worker crash therefore cannot create two distinct iteration N+1 regions.

### 6.2.1 Loop-carried state

Loop state is split into:

- **carried variables:** typed values exported by iteration N and imported by N+1;
- **iteration-local variables:** discarded from the live view after the iteration but retained in history/artifacts;
- **best-so-far candidate:** optional value plus evaluator evidence and stable tie-breaking key;
- **accounting:** consumed/reserved cost, tokens, duration, tool calls, child activations, and retries;
- **detection window:** bounded fingerprints, score history, repeated effect signatures, and progress features;
- **controller metadata:** current ordinal, start time, stop-rule version, and latest checkpoint.

Only declared carried variables may cross the boundary. The next iteration reads a committed state version, not the mutable process memory of the prior attempt.

## 6.3 Loop specification

~~~json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:execution-platform:loop-spec:v1",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "id", "mode", "body_subgraph", "carried_state",
    "budgets", "stopping", "detection", "on_exhaustion"
  ],
  "properties": {
    "id": {"type": "string", "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,127}$"},
    "mode": {
      "enum": [
        "RETRY", "REFLECTION", "CRITIC", "SELF_IMPROVEMENT",
        "PLANNING", "TOOL", "REPAIR", "EVALUATION", "CUSTOM"
      ]
    },
    "body_subgraph": {"type": "string"},
    "carried_state": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name", "type_ref", "merge"],
        "properties": {
          "name": {"type": "string"},
          "type_ref": {"type": "string"},
          "merge": {
            "enum": ["REPLACE", "CAS", "APPEND", "BEST_BY_EVALUATOR", "REDUCE"]
          }
        }
      }
    },
    "budgets": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "max_iterations", "max_elapsed_ms", "max_cost_microunits",
        "max_model_tokens", "max_tool_calls", "max_child_activations"
      ],
      "properties": {
        "max_iterations": {"type": "integer", "minimum": 1},
        "max_elapsed_ms": {"type": "integer", "minimum": 1},
        "max_cost_microunits": {"type": "integer", "minimum": 0},
        "max_model_tokens": {"type": "integer", "minimum": 0},
        "max_tool_calls": {"type": "integer", "minimum": 0},
        "max_child_activations": {"type": "integer", "minimum": 1},
        "max_parallel_candidates": {"type": "integer", "minimum": 1, "default": 1},
        "max_retry_attempts_inside_loop": {"type": "integer", "minimum": 0}
      }
    },
    "stopping": {
      "type": "object",
      "additionalProperties": false,
      "required": ["success_expression", "evaluators"],
      "properties": {
        "success_expression": {"type": "object"},
        "evaluators": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["id", "version", "weight", "required"],
            "properties": {
              "id": {"type": "string"},
              "version": {"type": "string"},
              "weight": {"type": "number"},
              "required": {"type": "boolean"},
              "quality_threshold": {"type": ["number", "null"]},
              "confidence_threshold": {"type": ["number", "null"]}
            }
          }
        },
        "minimum_iterations": {"type": "integer", "minimum": 0, "default": 0},
        "patience": {"type": "integer", "minimum": 0, "default": 0},
        "minimum_improvement": {"type": "number", "minimum": 0, "default": 0}
      }
    },
    "detection": {
      "type": "object",
      "additionalProperties": false,
      "required": ["window", "max_period", "repeat_limit", "stagnation_limit"],
      "properties": {
        "window": {"type": "integer", "minimum": 2},
        "max_period": {"type": "integer", "minimum": 1},
        "repeat_limit": {"type": "integer", "minimum": 2},
        "stagnation_limit": {"type": "integer", "minimum": 1},
        "fingerprint_paths": {
          "type": "array",
          "items": {"type": "string"}
        },
        "numeric_epsilon": {"type": "number", "minimum": 0}
      }
    },
    "on_exhaustion": {
      "enum": ["FAIL", "RETURN_BEST", "ROUTE_LIMIT_EDGE", "REQUEST_HUMAN"]
    },
    "checkpoint_every": {"type": "integer", "minimum": 1, "default": 1},
    "parallel_selection": {
      "enum": ["BEST_SCORE", "FIRST_PASSING", "PARETO", "CONSENSUS"]
    }
  }
}
~~~

The compiler fills explicit defaults and includes them in the loop-spec hash. A zero/unset limit never means unlimited in a published production graph.

## 6.4 Loop types and contracts

| Type | Carried state | Typical stop evidence | Specific risk and control |
|---|---|---|---|
| Retry loop | same request, classified error context | successful effect/result | Do not retry UNKNOWN non-idempotent effects; use runtime attempt retry when semantics are identical |
| Reflection loop | candidate plus structured critique | evaluator verifies acceptance rubric | Reflection text is not evidence; independent validator gates success |
| Critic loop | candidate, critique, defect set | no blocking defects and score threshold | Critic and generator should not share hidden state; pin both prompts/models |
| Self-improvement loop | candidate implementation/config and test results | deterministic tests plus policy gate | Cannot self-modify loop policy, permissions, evaluator, or budget |
| Planning loop | plan, unresolved goals, observations | goal coverage and executable plan validator | Bound plan size/depth; tool execution remains separate and authorized |
| Tool loop | messages, tool observations, remaining goal | explicit final output passes schema/evaluator | Enforce allowlist, per-tool budget, repeated-call detection, and effect ids |
| Repair loop | failing artifact, diagnostics, patch | previously failing and regression tests pass | Run in sandbox; cap patch size; retain each diff and test evidence |
| Evaluation loop | candidates and evaluation matrix | sample quota/confidence reached | Avoid optional stopping bias; pin sampling plan and aggregation |

### 6.4.1 Retry loop

Use a semantic retry loop only when each iteration may intentionally alter inputs or strategy. A transient network retry belongs to the node attempt policy. The loop must record the mutation strategy and request hash per iteration. Repeating the same unsafe request after an ambiguous effect is forbidden.

### 6.4.2 Reflection and critic loops

The generator produces a candidate. The reflector/critic emits a structured defect list with rubric ids and evidence spans. A separate deterministic validator or pinned evaluator decides whether defects are resolved.

Self-reported phrases such as “I am confident” or “the answer is correct” never satisfy a confidence or quality threshold. Confidence must be calibrated output of a versioned evaluator with a known population/metric, or the field is labeled heuristic.

### 6.4.3 Self-improvement and repair loops

The loop may modify a candidate artifact in an isolated workspace but may not modify:

- its own budget or stopping rule;
- evaluator tests, policy, or approval requirements;
- plugin permissions or secret scope;
- the immutable source artifact;
- production state before a separate deployment/approval gate.

Each patch is content-addressed. Test selection, environment image, test results, and coverage delta are pinned. A candidate that improves the target test while failing a guardrail test is not “better.”

### 6.4.4 Planning and tool loops

A planning loop produces a typed plan with goal ids, dependencies, preconditions, required capabilities, and completion checks. A tool loop executes only currently authorized plan steps. Replanning cannot erase completed effects; it references their receipts.

Repeated tool calls are fingerprinted from tool id, version, canonical arguments after secret redaction, and relevant state version. A call with the same fingerprint and no intervening relevant state change is a likely cycle.

### 6.4.5 Evaluation loops

Evaluation loops pin dataset/sample revision, seed, evaluator versions, aggregation, confidence method, and stopping plan. Sequential evaluation must account for repeated looks; it cannot stop on the first favorable sample unless that rule was specified before execution.

## 6.5 Hierarchical budgets

Budgets form a tree:

~~~text
tenant quota
└── execution budget
    ├── non-loop nodes
    └── outer loop reservation
        ├── iteration 1
        ├── iteration 2
        │   └── nested loop reservation
        └── remaining unreserved allowance
~~~

A child limit is always at most the remaining parent limit. Creating a child or parallel candidate reserves an upper bound atomically; unused reservation is released after terminalization. Actual usage is charged from provider receipts or trusted worker meters.

Before starting an iteration, the controller computes a conservative minimum next-iteration reservation:

~~~text
can_start =
    next_iteration <= max_iterations
and now + minimum_predicted_duration <= effective_deadline
and consumed_cost + reserved_cost + minimum_cost <= max_cost
and consumed_tokens + reserved_tokens + minimum_tokens <= max_tokens
and consumed_tool_calls + reserved_calls + minimum_calls <= max_tool_calls
and child_activations + planned_children <= max_child_activations
~~~

If actual provider usage arrives late, the reservation remains held. Reconciliation adjusts actuals but cannot authorize work beyond a hard cap. Provider billing corrections may make reported final cost exceed the execution cap after the fact; this is recorded as an accounting adjustment, not concealed.

Cost uses integer microunits of the tenant billing currency and a pinned price-book version. Floating-point money is forbidden. Token counts distinguish input, cached input, output, reasoning, embedding, and provider-specific units.

## 6.6 Stopping conditions and decision precedence

At an iteration boundary, exactly one LoopDecision is committed. Conditions are evaluated in this precedence:

1. authorization/policy revocation or safety violation;
2. cancellation request;
3. execution or loop deadline reached;
4. hard cost/token/tool/activation budget exhausted;
5. maximum iteration reached;
6. invariant/determinism error;
7. exact cycle detected;
8. stagnation/no-progress limit reached;
9. required evaluator veto;
10. success expression satisfied after minimum iterations;
11. patience rule selects best-so-far;
12. continue.

Safety and hard limits therefore cannot be overridden by a high quality score. **Maximum iterations**, each **cost limit** and **time limit**, every **quality threshold**, and every **confidence threshold** are compiled into the decision inputs. The persisted decision contains every evaluated signal, threshold, evaluator version, budget snapshot, selected reason, and next action.

~~~json
{
  "loop_id": "repair",
  "iteration": 4,
  "decision": "STOP_SUCCESS",
  "reason_code": "QUALITY_AND_TESTS_MET",
  "spec_hash": "sha256:...",
  "input_state_version": 519,
  "budgets": {
    "cost_consumed_microunits": 42100,
    "model_tokens_consumed": 18342,
    "elapsed_ms": 92118
  },
  "evaluations": [
    {
      "evaluator": "compile-and-regression",
      "version": "sha256:...",
      "score": 1,
      "confidence": 1,
      "required": true,
      "passed": true,
      "evidence_artifact_id": "019...uuidv7"
    }
  ],
  "fingerprint": "sha256:...",
  "selected_candidate_hash": "sha256:..."
}
~~~

## 6.7 Quality and confidence

Quality is a vector, not necessarily one score. A rubric may include correctness, policy compliance, groundedness, completeness, latency, cost, and style. Required dimensions are gates; optional dimensions may be weighted.

Evaluator outputs contain:

- evaluator id, immutable implementation/prompt/model digest, and calibration revision;
- candidate and evidence hashes;
- per-dimension score and pass/fail;
- calibrated confidence with method and applicable population;
- citations/evidence artifact;
- failure/abstention status;
- deterministic aggregation rule.

The controller treats evaluator timeout, malformed output, or abstention according to an explicit policy, normally “not passed.” It never substitutes a perfect score.

For nondeterministic model judges, the response is recorded. Optional consensus uses a fixed panel and rule, such as two-of-three passing; the controller does not keep sampling judges until one agrees.

Best-so-far selection uses a stable tuple:

~~~text
(required_gates_passed, quality_vector, lower_cost, lower_iteration, candidate_hash)
~~~

The final candidate hash provides a deterministic tie-breaker.

## 6.8 Loop and stagnation detection

### 6.8.1 Fingerprint

The detector computes a semantic fingerprint from normalized loop-carried state paths, unresolved goal/defect ids, planned next action, recent effect fingerprints, evaluator vector rounded only as declared, and the loop-spec version. It excludes timestamps, trace ids, volatile prose formatting, and attempt ids.

~~~text
fingerprint_i = H(
  spec_hash,
  canonical(project(carried_state_i, fingerprint_paths)),
  sorted(unresolved_goal_ids_i),
  next_action_signature_i,
  relevant_effect_signature_i
)
~~~

Exact canonical state is retained for the bounded window so a hash match can be verified and hash collision does not alone stop execution.

### 6.8.2 Detectors

1. **Fixed point:** fingerprint_i equals fingerprint_(i-1) and no required score improved.
2. **Periodic cycle:** for period p from 2 through max_period, the latest repeat_limit periods have equal fingerprints.
3. **Repeated effect:** the same effect/tool fingerprint recurs without a relevant state-version change.
4. **Stagnation:** no quality dimension improves by minimum_improvement for stagnation_limit committed iterations.
5. **Plan churn:** unresolved-goal set is unchanged while plan hash changes repeatedly.
6. **Oscillation:** mutually exclusive state values alternate while the aggregate objective does not improve.
7. **Expansion recursion:** the dynamic fragment ancestry contains the same generator/spec/input fingerprint beyond its recursion limit.

~~~text
detect(history, spec):
    current = history.last
    if verified_equal(current, history[-2]):
        return FIXED_POINT

    for p in 2..min(spec.max_period, floor(history.length / spec.repeat_limit)):
        periods = last p * spec.repeat_limit fingerprints
        if every consecutive period equals the first:
            return PERIODIC_CYCLE(period=p)

    if repeated_effect_without_relevant_change(history):
        return REPEATED_EFFECT

    if no_material_progress(history.last(spec.stagnation_limit)):
        return STAGNATION

    return NONE
~~~

Approximate semantic similarity may raise a warning or request human review, but it cannot by itself declare an exact cycle. Model-based detectors are advisory and consume loop budget.

## 6.9 Controller algorithm

~~~text
run_loop(controller_activation, fence):
    begin transaction
    loop = lock loop_runtime row
    require loop.fence == fence
    require parent execution is runnable

    if loop.current_iteration == 0:
        validate spec and initialize carried state
        reserve minimum first-iteration budget
        materialize iteration 1
        emit LoopEntered and commit
        return

    result = load terminal iteration result and evaluator outputs
    require result hashes and state version match iteration manifest
    actuals = reconcile iteration reservations with metered usage
    candidate = update_best_so_far(result, pinned selection rule)
    detection = run_detectors(loop.detection_window + result)
    decision = evaluate_in_precedence_order(actuals, detection, result)

    persist iteration summary, candidate, detection evidence, and LoopDecision

    if decision == CONTINUE:
        next_input = apply typed carried-state merge
        require no unresolved state conflict
        reserve next minimum budget atomically from parent
        create deterministic next iteration region and outbox work
        checkpoint if policy requires
    else:
        release unused reservations
        publish selected result or typed exhaustion/failure outcome
        terminalize controller
    commit
~~~

The loop database row is a projection optimized for locking; LoopEntered, IterationCommitted, EvaluationRecorded, and LoopDecision events are the durable history used for replay.

## 6.10 Parallel candidate loops

Some loops evaluate k candidates per iteration. The controller:

1. reserves budget for all k before dispatch;
2. assigns candidate ids from iteration id plus candidate ordinal/seed;
3. runs candidates in one cancellation scope;
4. applies FIRST_PASSING, BEST_SCORE, PARETO, or CONSENSUS only after the rule's required evidence exists;
5. cancels losing candidates only when their future results cannot affect the rule;
6. charges effects already started even when a candidate loses;
7. commits a SelectionDecision before using the winner.

FIRST_PASSING is determined by canonical completion-event sequence, not network arrival time. BEST_SCORE waits for all non-failed candidates unless a mathematically valid upper bound proves the current winner unbeatable.

Candidate parallelism is capped independently of tenant worker concurrency to prevent loop multiplication.

## 6.11 Checkpoint, recovery, and replay

A loop safe-point checkpoint includes:

- loop-spec and body-subgraph hashes;
- current committed iteration;
- carried-state version and hash;
- best-so-far candidate/evaluation references;
- consumed and reserved budget ledger positions;
- detection window and exact comparison values;
- child activation summary and outstanding effects;
- controller lease/fence metadata excluding ephemeral owner.

Recovery never resumes inside uncommitted controller logic. It:

1. loads the latest valid checkpoint;
2. folds loop events after it;
3. reclaims or reconciles the current iteration;
4. verifies that at most one next iteration was materialized;
5. restores timers and reservations;
6. continues from the last committed LoopDecision.

Exact replay consumes recorded evaluator results and nondeterministic body outputs, then recomputes fingerprints and stop decisions. A different decision under the same pins is a determinism violation. Forked replay may use new evaluator/model/spec versions, but it is a new execution with lineage.

## 6.12 Cancellation, timeout, and failure

Cancellation first marks the loop controller CANCELLING and prevents new iterations. It propagates to active candidates and nested loops. Completed iteration state remains history. Depending on the enclosing edge contract, the loop returns CANCELLED, routes a cancellation error, or lets a compensation subgraph run.

An attempt timeout may be retried without advancing the semantic iteration only if effect safety permits. A completed body followed by evaluator timeout remains the same iteration; the evaluator activation may retry. The loop deadline includes all retries and waits.

Exhaustion outcomes:

- FAIL returns LOOP_LIMIT_EXCEEDED with the exact limiting dimension;
- RETURN_BEST returns the best candidate plus passed/failed gates and exhausted status, never plain success;
- ROUTE_LIMIT_EDGE emits a typed limit payload;
- REQUEST_HUMAN suspends only if deadline and human-wait policy allow it.

An unhandled loop failure sends the controller activation to the ordinary runtime DLQ. The DLQ record includes the loop checkpoint, detection window, budget ledger, best candidate, and outstanding effects.

## 6.13 Loop events and loop metrics

### 6.13.1 Event payload

~~~json
{
  "event_type": "LoopIterationCommitted",
  "schema_version": 1,
  "payload": {
    "loop_id": "critic",
    "controller_activation_id": "sha256:...",
    "iteration_id": "sha256:...",
    "iteration": 3,
    "candidate_count": 2,
    "input_state_version": 773,
    "output_state_version": 779,
    "input_hash": "sha256:...",
    "output_hash": "sha256:...",
    "quality": {"correctness": 0.94, "groundedness": 1.0},
    "usage": {
      "elapsed_ms": 18482,
      "cost_microunits": 12200,
      "model_input_tokens": 9412,
      "model_output_tokens": 1803,
      "tool_calls": 1
    },
    "progress_fingerprint": "sha256:...",
    "best_candidate_hash": "sha256:..."
  }
}
~~~

### 6.13.2 Metrics

Low-cardinality metrics:

- loop_started_total{tenant_tier, namespace_class, loop_mode};
- loop_terminal_total{loop_mode, outcome, reason_code};
- loop_active{cell, worker_class};
- loop_iterations histogram{loop_mode};
- loop_elapsed_seconds histogram{loop_mode, outcome};
- loop_cost_microunits histogram{loop_mode};
- loop_model_tokens_total{loop_mode, token_class};
- loop_tool_calls_total{loop_mode, tool_class, outcome};
- loop_quality_delta histogram{loop_mode, evaluator_class};
- loop_cycle_detected_total{loop_mode, detector};
- loop_stagnation_total{loop_mode};
- loop_budget_utilization_ratio histogram{budget_dimension};
- loop_recovery_total{reason};
- loop_state_conflict_total{path_class, policy}.

Execution id, graph id, loop id, candidate hash, model response, and user-defined tag are trace/log attributes, not metric labels. This prevents cardinality collapse of the metrics backend.

Derived operational views should show:

- iteration count and cost percentile by loop revision;
- probability of success by iteration ordinal;
- marginal quality improvement per cost and second;
- top termination reasons;
- repeated-effect/cycle signatures;
- evaluator disagreement and abstention;
- best candidate found earlier than final stop;
- retries hidden inside each iteration;
- queue versus compute versus evaluator time.

## 6.14 Operational controls

The platform supports:

- namespace and tenant maximum loop ceilings stricter than graph-declared limits;
- emergency kill switch by plugin, tool, model route, graph revision, or tenant;
- per-loop concurrency and spend circuit breakers;
- canary deployment of new loop/evaluator revisions;
- alerts for rising median iterations, cost without quality gain, cycle rate, evaluator failure, and UNKNOWN_EFFECT;
- a dry-run estimator using historical duration/usage distributions;
- human-readable termination evidence in the execution inspector;
- policy to disallow RETURN_BEST for regulated/high-risk decisions.

Changing a limit affects new iterations only if the admitted policy explicitly permits live tightening. Limits may always be tightened for safety; they are never relaxed beyond the admitted envelope without a new execution or approved policy event.

## 6.15 Design decisions and trade-offs

| Decision | Why | Alternative | Cost / operational effect |
|---|---|---|---|
| Explicit controller and iteration regions | Deterministic materialization, replay, and cancellation | Worker-local while loop | More scheduler records; survives crashes and exposes progress |
| Multiple hard budgets | Iterations alone do not bound cost or fan-out | max_iterations only | Accounting/reservation complexity |
| Persist stop decision | Replay cannot depend on changed evaluator or clock | Re-evaluate on recovery | More history; exact reasoning is auditable |
| Independent evaluator evidence | Generator confidence is not correctness | Self-declared confidence | Added latency/cost; fewer false successes |
| Exact plus progress detection | Stops fixed/periodic loops without trusting a model | Semantic-model detector only | Requires careful fingerprint design |
| Hierarchical reservations | Prevents nested/parallel overspend | Charge after use | May underutilize capacity until reservation release |
| Return-best as typed exhaustion | Useful partial result without lying | Convert exhaustion to success | Consumers must handle a richer outcome |
| Pinned price/evaluator/model versions | Reproducible accounting and decisions | Resolve current versions | Old versions require retention/revocation policy |

## 6.16 Anti-patterns

- unbounded while-true agent loops;
- counting only successful iterations while retries and evaluator calls are free;
- trusting an LLM's self-reported confidence;
- increasing max_iterations automatically when a loop fails;
- letting a repair loop edit its tests, policy, or stop rule;
- treating small text changes as progress while goals/effects repeat;
- retrying an ambiguous side effect as a new semantic iteration;
- generating all parallel candidates before reserving their budgets;
- hiding nested agent/tool loops inside a plugin;
- recalculating a historical stop decision during exact replay;
- exporting RETURN_BEST as an ordinary successful result without exhaustion metadata.

## 6.17 Verification suite

The loop engine requires deterministic and fault-injection tests:

1. crash before and after LoopDecision commit creates at most one next iteration;
2. retry attempts do not increment semantic iteration;
3. nested/parallel loops cannot exceed the root budget under concurrent reservations;
4. deadline, cost, token, tool, activation, and iteration limits each stop independently;
5. safety veto wins over a passing quality threshold;
6. fixed-point, period-2, period-N, repeated-effect, and stagnation fixtures produce stable reasons;
7. randomized candidate completion order preserves selection results;
8. model-evaluator timeout, abstention, malformed output, and disagreement follow declared policy;
9. cancellation during body, evaluator, checkpoint, and external effect produces correct terminal evidence;
10. recovery from every iteration checkpoint yields the same decision and best candidate;
11. exact replay recomputes identical fingerprints and decisions;
12. RETURN_BEST retains failed gates and exhaustion reason;
13. a self-improvement loop cannot modify immutable controls;
14. metrics remain bounded-cardinality under one million unique loop ids.
