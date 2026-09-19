# 4. Node System

## 4.1 Scope and invariants

A node is a typed, versioned execution boundary. It is not an arbitrary callback embedded in the control plane. Every built-in and third-party node obeys the same admission, invocation, result, policy, telemetry, and serialization contracts.

The runtime MUST preserve these invariants:

1. A graph version pins every node definition by immutable content digest. A marketplace tag such as `latest` is resolved before publication and never stored in an executable plan.
2. Ports are the only data-plane interface between nodes. Worker-executed nodes may propose only canonical state operations and effect receipts; events, child executions, graph expansion, timers, and human tasks are explicit coordinator-owned control nodes.
3. A worker may run an attempt more than once, but only the attempt holding the current lease epoch may commit. Side-effecting nodes additionally use a stable idempotency key.
4. Inputs and outputs are validated against JSON Schema 2020-12 at graph publication and again at trust boundaries. Validation is not delegated to prompt text.
5. Secrets are opaque handles. The scheduler, graph document, logs, checkpoints, and output envelopes never contain resolved secret bytes.
6. Capabilities are deny-by-default and bounded by the intersection of node declaration, graph grant, environment policy, and caller authority.
7. Large or sensitive values are content-addressed artifacts. Envelopes carry typed references rather than unbounded inline payloads.
8. A node cannot directly mutate execution state. It proposes ordered `StateWriteIntent` values; WorkerGateway validates and atomically commits worker completions, while the coordinator owns separate control-node transitions.

## 4.2 Definition, instance, and invocation contracts

Three objects are deliberately separate:

- `NodeDefinition` describes code, schemas, capabilities, determinism, and an executor. It is installed once and immutable.
- `NodeInstance` is graph-owned configuration: stable ID, bindings, policies, and UI metadata.
- `NodeInvocation` is the bounded attempt-scoped command a trusted supervisor sends to a sandbox. `NodeResult` is the corresponding sandbox proposal that the supervisor validates and binds to its hidden WorkerGateway lease.

### 4.2.1 Node definition schema

The control plane validates definitions with this strict JSON Schema. It is standalone except for its intentional reference to the canonical GraphSpec effect definition, which CI supplies as a pinned schema dependency.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://schemas.ege.dev/node-definition/v1.json",
  "$defs": {
    "portMap": {
      "type": "object",
      "propertyNames": { "pattern": "^[A-Za-z][A-Za-z0-9_-]{0,63}$" },
      "additionalProperties": { "$ref": "#/$defs/port" },
      "maxProperties": 128
    },
    "port": {
      "type": "object",
      "additionalProperties": false,
      "required": ["schema", "cardinality", "classification"],
      "properties": {
        "schema": { "type": "object" },
        "cardinality": { "enum": ["one", "optional", "many", "stream"] },
        "classification": {
          "enum": ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]
        },
        "storage": { "enum": ["inline", "artifact"] }
      }
    },
    "resourceEnvelope": {
      "type": "object",
      "additionalProperties": false,
      "required": ["default", "maximum"],
      "properties": {
        "default": { "$ref": "#/$defs/resourceLimit" },
        "maximum": { "$ref": "#/$defs/resourceLimit" }
      }
    },
    "resourceLimit": {
      "type": "object",
      "additionalProperties": false,
      "required": ["cpuMillis", "memoryMiB", "timeout"],
      "properties": {
        "cpuMillis": { "type": "integer", "minimum": 1 },
        "memoryMiB": { "type": "integer", "minimum": 1 },
        "timeout": { "type": "string", "format": "duration" }
      }
    },
    "errorDefinition": {
      "type": "object",
      "additionalProperties": false,
      "required": ["code", "category", "gatewayRetryClass"],
      "properties": {
        "code": {
          "type": "string",
          "pattern": "^[A-Z][A-Z0-9]*(_[A-Z0-9]+){0,7}$",
          "minLength": 3,
          "maxLength": 128
        },
        "category": {
          "enum": [
            "RUNTIME_ERROR_CATEGORY_USER", "RUNTIME_ERROR_CATEGORY_TRANSIENT",
            "RUNTIME_ERROR_CATEGORY_PROVIDER", "RUNTIME_ERROR_CATEGORY_POLICY",
            "RUNTIME_ERROR_CATEGORY_RESOURCE", "RUNTIME_ERROR_CATEGORY_BUG",
            "RUNTIME_ERROR_CATEGORY_CANCELLED"
          ]
        },
        "gatewayRetryClass": {
          "description": "Trusted definition input to gateway policy; never a worker-selected final retry decision.",
          "enum": ["DO_NOT_RETRY", "RETRY_CONDITIONALLY", "RECONCILE_REQUIRED"]
        }
      }
    }
  },
  "type": "object",
  "required": ["apiVersion", "kind", "metadata", "spec"],
  "additionalProperties": false,
  "properties": {
    "apiVersion": { "const": "ege.dev/v1" },
    "kind": { "const": "NodeDefinition" },
    "metadata": {
      "type": "object",
      "additionalProperties": false,
      "required": ["name", "version", "digest"],
      "properties": {
        "name": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9.-]{0,62}(?:/[a-z0-9][a-z0-9.-]{0,62}){1,7}$",
          "maxLength": 256
        },
        "version": {
          "type": "string",
          "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$"
        },
        "digest": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "displayName": { "type": "string", "minLength": 1, "maxLength": 256 },
        "categories": {
          "type": "array",
          "items": { "type": "string", "minLength": 1, "maxLength": 64 },
          "uniqueItems": true,
          "maxItems": 32
        }
      }
    },
    "spec": {
      "type": "object",
      "additionalProperties": false,
      "required": ["ports", "configSchema", "executor", "effect", "capabilities", "resources", "determinism"],
      "properties": {
        "ports": {
          "type": "object",
          "additionalProperties": false,
          "required": ["inputs", "outputs"],
          "properties": {
            "inputs": { "$ref": "#/$defs/portMap" },
            "outputs": { "$ref": "#/$defs/portMap" }
          }
        },
        "configSchema": { "type": "object" },
        "executor": {
          "type": "object",
          "additionalProperties": false,
          "required": ["kind", "artifact"],
          "properties": {
            "kind": { "enum": ["builtin", "wasm", "oci", "remote-grpc"] },
            "artifact": { "type": "string" },
            "entrypoint": { "type": "string" }
          }
        },
        "effect": {
          "allOf": [
            { "$ref": "https://schemas.execution-graph.example/v1/graph-spec.schema.json#/$defs/effect" },
            {
              "type": "object",
              "required": ["allowedAdapterEffectModes"],
              "properties": {
                "allowedAdapterEffectModes": true
              }
            }
          ]
        },
        "capabilities": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "required": ["action", "resource", "constraints"],
            "properties": {
              "action": { "type": "string", "pattern": "^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$", "maxLength": 128 },
              "resource": {
                "type": "object",
                "additionalProperties": false,
                "required": ["kind", "id"],
                "properties": {
                  "kind": { "type": "string", "pattern": "^[a-z][a-z0-9_]{0,63}$" },
                  "id": { "type": "string", "minLength": 1, "maxLength": 768 },
                  "version_digest": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" }
                }
              },
              "constraints": { "type": "object", "maxProperties": 64 }
            }
          },
          "uniqueItems": true
        },
        "resources": { "$ref": "#/$defs/resourceEnvelope" },
        "determinism": { "enum": ["PURE", "RECORDED_NONDETERMINISTIC", "EFFECTFUL"] },
        "errors": {
          "type": "array",
          "items": { "$ref": "#/$defs/errorDefinition" },
          "uniqueItems": true,
          "maxItems": 256
        }
      }
    },
    "authoring": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "docs": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "icon": { "type": "string", "minLength": 1, "maxLength": 1024 },
        "form": { "type": "string", "minLength": 1, "maxLength": 1024 }
      }
    }
  }
}
```

A NodeDefinition digest is not self-referential:

```text
metadata.digest = SHA-256(
  "ege-node-definition-v1\0"
  || RFC8785_JCS(definition with metadata.digest omitted)
)
```

The projection includes `authoring`; changing docs, icon, or form therefore creates a new immutable definition digest even when execution semantics are unchanged. Referenced executor/package artifacts retain their own independent content digests. Installation, registry read, and compilation all recompute and compare this digest before trusting the definition; a version may not be rebound to different canonical bytes.

A port contains a `schema`, cardinality (`one`, `optional`, `many`, or `stream`), required closed `classification`, and whether the value is inline or an artifact reference. Port names are semantic API and require a major node version to remove or narrow. Definition error entries are trusted compiler inputs only: WorkerGateway still derives the final retry disposition after policy, budgets, and effect-receipt evaluation.

The GraphSpec `effect` definition is the single canonical field vocabulary for NodeDefinition, ToolDefinition, graph authoring, compilation, policy, runtime, and telemetry. NodeDefinition and ToolDefinition must declare a non-empty, unique `allowedAdapterEffectModes` list; a graph-owned node may omit that field or provide only a class-compatible narrowing. The compiler verifies that graph `class` and `deliveryContract` match the resolved definition, then intersects definition modes, graph narrowing, and policy. An empty intersection is a publication error. `PURE` permits only `FORBID`; `READ_ONLY` permits `SUBSTITUTE_RECORDED`, `REEXECUTE_READ_ONLY`, or `FORBID`; write and human effects permit `SUBSTITUTE_RECORDED`, `REEXECUTE_AUTHORIZED_EFFECT`, or `FORBID`. `compensationPort` is the only compensation field: a `COMPENSATABLE_WRITE` definition exposes that port and the graph connects it through a `COMPENSATION` edge. `idempotencyKey` is the compiler-validated restricted expression, `reconciliationProcedure` is a non-empty procedure reference/description required for write and human effects, and `approvalPolicy` is required only for `HUMAN_EFFECT`.

Determinism is orthogonal: `PURE`, `RECORDED_NONDETERMINISTIC`, and `EFFECTFUL` describe how results are reproduced, while `allowedAdapterEffectModes` restricts which runtime replay actions an adapter can perform. Capability requests use the same structured `action`/`resource`/`constraints` record as GraphSpec, not a colon-delimited permission string. `action` names the operation; `resource` is `{kind, id, version_digest?}`; and `constraints` carries destinations, methods, data classifications, call/byte limits, and other narrowing conditions. Policy may only narrow this record.

### 4.2.2 Graph-owned node instance

The following is a **non-standalone NodeInstance diagnostic projection**, not a complete GraphSpec node object. A complete authoring document must satisfy `docs/contracts/graph-spec.schema.json`.

```yaml
id: summarize_evidence
type: builtin://llm@2.3.1
definitionDigest: sha256:8d91e9c1c88c0e4a662aaf9ac0b9a79d86658721b703ea0d1da79949be2c75aa
bindings:
  prompt: ${nodes.render_prompt.outputs.text}
  documents: ${state.case.documents}
config:
  modelRoute: routes/quality-balanced@4
  responseSchema: ${schemas.CaseSummary}
  temperature: 0.1
policies:
  timeout: 45s
  retry: { maxAttempts: 3, backoff: exponential, retryOn: [provider_429, provider_5xx] }
  grants:
    - action: model.invoke
      resource: { kind: model_route, id: routes/quality-balanced@4 }
      constraints: { maxCalls: 1, acceptedClassifications: [INTERNAL, CONFIDENTIAL] }
    - action: artifact.read
      resource: { kind: artifact_set, id: execution-input/* }
      constraints: { maxBytes: 1048576 }
metadata:
  title: Summarize evidence
  tags: [casework, pii]
  editor: { x: 880, y: 320, width: 280, collapsed: false }
```

`metadata.editor` is preserved in graph versions but excluded from the executable-plan digest. Moving a box therefore creates a document revision without invalidating the compiled runtime plan.

### 4.2.3 Two-layer worker protocol

The worker boundary has two explicit layers. They are not interchangeable APIs:

1. **Gateway to trusted supervisor.** `docs/contracts/executiongraph/runtime/v1/runtime.proto` is the sole normative `WorkerGatewayService` contract. A supervisor calls `ClaimExecutionToken`, `HeartbeatExecutionToken`, `CompleteExecutionToken`, or `FailExecutionToken`. It holds the returned attempt-scoped `ExecutionGrant` only in trusted memory and presents it using its proof-of-possession/mTLS-bound WorkerGateway identity. That grant authorizes only the bound WorkerGateway RPCs; it is not database or provider authority. The gateway validates and persists the grant hash/constraints and is the sole canonical authority for worker-originated completion, state, budget, and effect mutations; the Coordinator separately owns control-node transitions through the shared transition library.
2. **Trusted supervisor to sandbox.** A private bidirectional NodeInvocation/NodeFrame stream carries only the materialized inputs and bounded execution context needed by node code. The supervisor may implement this stream over local gRPC, a Unix socket, or an in-process Wasm host ABI, but all implementations share the same generated node-protocol types. Progress frames are tentative; one terminal `NodeResult` is translated by the supervisor into the normative `CompleteExecutionToken` or `FailExecutionToken` request.

The sandbox never receives a NATS subject or credential, a PostgreSQL connection or row key, the raw `ExecutionGrant`, provider/tenant credentials, the WorkerGateway lease object, or authority to acknowledge/commit work. It receives opaque artifact/effect handles; calls through those handles return to the gateway, which revalidates the bound grant and policy before access or effect execution.

The JSON below is an illustrative diagnostic projection of the **supervisor-to-sandbox** `NodeInvocation`; it is not a second coordinator/worker wire contract. 64-bit integers and timestamps are strings to avoid JavaScript loss.

```json
{
  "invocationId": "019fd4b4-2000-7000-8000-000000000101",
  "nodeId": "summarize_evidence",
  "definitionDigest": "sha256:8d91e9c1c88c0e4a662aaf9ac0b9a79d86658721b703ea0d1da79949be2c75aa",
  "deadline": "2026-08-06T02:14:15.120Z",
  "idempotencyKey": "019fd4b4-2000-7000-8000-000000000001/summarize_evidence/semantic-attempt-1",
  "inputs": {
    "prompt": { "mediaType": "text/plain", "inline": "Summarize...", "sensitivity": "INTERNAL" },
    "documents": { "mediaType": "application/json", "artifact": "019fd4b4-2000-7000-8000-000000000201", "size": "483291" }
  },
  "stateView": { "version": "19", "projection": "019fd4b4-2000-7000-8000-000000000202" },
  "context": {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    "locale": "en-US",
    "logicalTime": "2026-08-06T02:13:45.120Z",
    "seed": "1783138978231"
  },
  "handles": ["handle://artifact/documents", "handle://effect/model-route/quality-balanced"]
}
```

```ts
export type NodeResult =
  | {
      status: "completed";
      outputs: Record<string, ValueEnvelope>;
      stateWriteIntents?: StateWriteIntentProjection[];
      effectReceiptHandles?: OpaqueHandle[];
      usage?: { inputTokens?: bigint; outputTokens?: bigint; costMicrounits?: bigint };
    }
  | {
      status: "failed";
      error: NodeError;
      partialOutputs?: Record<string, ValueEnvelope>;
    };

export interface NodeError {
  code: string;                         // stable machine-readable taxonomy
  category:
    | "RUNTIME_ERROR_CATEGORY_USER"
    | "RUNTIME_ERROR_CATEGORY_TRANSIENT"
    | "RUNTIME_ERROR_CATEGORY_PROVIDER"
    | "RUNTIME_ERROR_CATEGORY_POLICY"
    | "RUNTIME_ERROR_CATEGORY_RESOURCE"
    | "RUNTIME_ERROR_CATEGORY_BUG"
    | "RUNTIME_ERROR_CATEGORY_CANCELLED";
  safeMessage: string;                  // non-empty, bounded, and operator-safe
  detailArtifactId?: string;            // encrypted, access-controlled diagnostic detail
}
```

These categories are the exact closed `RuntimeErrorCategory` vocabulary in `runtime.proto`; adapters map provider-specific failures into it and unknown categories are rejected. A sandbox reports only the observed code, category, safe message, and optional diagnostic artifact. It never reports `retryable`, retry delay, or effect safety. Trusted WorkerGateway code alone produces `GatewayClassifiedError` after intersecting that observation with the pinned definition's retry-safe code catalog, attempt policy, budgets, policy snapshot, and mandatory effect receipt/outcome; `UNKNOWN` or ambiguous effects classify as reconciliation, not blind retry.

`StateWriteIntentProjection` is the generated diagnostic projection of `runtime.proto`; it is not an independent operation vocabulary. Effect receipt handles are opaque references to receipts already created by the gateway's effect ledger—the sandbox cannot assert an authoritative effect outcome. Durable waits, child execution creation, graph expansion, and coordinator control nodes are scheduled by the coordinator; an arbitrary sandbox result cannot manufacture them.

The supervisor binds the terminal result to the hidden execution token, attempt, fencing token, plan hash, workload identity, and definition digest before submitting it through WorkerGateway. WorkerGateway rejects any mismatch before its canonical completion transaction; the coordinator later consumes the committed event to schedule control successors. Replay is resolved before sandbox dispatch: recorded-result substitution does not invoke the sandbox; state rebuild invokes no node; a fork invokes normally only after its recorded-history boundary; simulation invokes with deterministic clock/random and mock effect proxies that deny real effects. Consequently the sandbox does not receive or reinterpret a competing replay-mode enum.

## 4.3 Compilation and execution lifecycle

```text
Draft instance
    |
    v
Resolve definition digest --> bind ports --> type/schema check --> capability check
    |                                                   |
    | invalid                                           +--> publication denied
    v
Compile expressions --> effect/replay analysis --> resource admission --> plan digest
    |
    v
Activation: BLOCKED -> READY -> RUNNING -> {SUCCEEDED | FAILED | TIMED_OUT | CANCELLED | SKIPPED}
                                  |
                                  +--> RETRY_WAIT -> READY
                                  |
                                  +--> UNKNOWN_EFFECT -> {SUCCEEDED | RETRY_WAIT | FAILED}

ExecutionToken: READY -> RUNNING (fence N) -> TERMINAL
                         |
                         +-- lease lost --> READY (fence N+1 on next claim)

Attempt: CLAIMED -> STARTED -> {COMPLETED | ERROR | TIMED_OUT | CANCELLED | LEASE_LOST | UNKNOWN_EFFECT}
```

`UNKNOWN_EFFECT` is terminal for the Attempt and its ExecutionToken, but nonterminal for the Activation: its `terminal_at` remains null while the reconciler establishes the destination outcome. Resolution moves the Activation to `SUCCEEDED`, `RETRY_WAIT`, or `FAILED`; `RETRY_WAIT` creates a new token rather than reopening the ambiguous one.

A timer, signal, approval, child wait, or debugger breakpoint completes or parks the relevant activation and moves the containing Execution to `SUSPENDED` with a typed reason; it does not invent a separate `WAITING` activation state. These names match the canonical schema in Chapter 14.

1. **Resolve.** The compiler resolves exact definitions, schemas, model routes, secret names, subgraph versions, and plugin digests. Missing or revoked artifacts fail publication.
2. **Bind.** It checks port existence, cardinality, schema assignability, stream/batch compatibility, expression types, and that every required input has exactly one producer or default.
3. **Authorize.** It computes effective capabilities and data-label flow. A `RESTRICTED` value cannot enter an external model, email, log, or unrestricted plugin unless an explicit policy transformer declassifies it.
4. **Plan.** It lowers control nodes to runtime instructions, records effect and replay policy, calculates resource classes, and emits one content-addressed plan.
5. **Admit.** At run time the scheduler checks quotas, concurrency keys, provider capacity, and environment grants before making a fenced token claimable through WorkerGateway.
6. **Prepare.** The trusted supervisor calls `ClaimExecutionToken`, retains the returned proof-of-possession-bound grant, asks the gateway to materialize permitted artifact/effect handles, starts the sandbox, and records `AttemptStarted`. Raw tokens remain in the supervisor.
7. **Execute.** Heartbeats renew the lease. Progress and stream chunks are non-authoritative events; only a committed result changes execution state.
8. **Commit.** WorkerGateway validates outputs and canonical state intents, appends attempt/activation facts and outbox messages, advances state version, settles budgets, and marks the attempt/token terminal in one fenced database transaction. The coordinator schedules successors from that committed state.
9. **Finalize.** The outbox publishes events and artifacts are retained according to policy. Cleanup is safe after lease loss and never performs business compensation implicitly.

### 4.3.1 Exactly-once effects are not assumed

Worker delivery is at least once. For an idempotent write, the stable key is derived from execution, node instance, and semantic iteration—not the transport attempt. For non-idempotent effects, the node must use one of:

- provider-supported idempotency;
- a transactional outbox owned by the target adapter;
- a durable prepare/commit protocol with reconciliation;
- a human-confirmed `unknown_outcome` path.

Retrying a timed-out email, payment, or arbitrary REST POST without such a mechanism is forbidden. A retry policy may only select error codes declared safe by the definition.

## 4.4 Value and serialization rules

- Canonical interchange is Protobuf for transport and deterministic CBOR for artifact hashing. Canonical JSON is the human/API projection.
- Inline values are limited to 64 KiB after encoding. Larger values, binary data, tabular batches, model transcripts, and plugin diagnostics become encrypted object-store artifacts.
- Values carry `mediaType`, schema URI plus digest, sensitivity, provenance, and either `inline` or `artifact`. A digest mismatch is a terminal integrity error.
- JSON forbids `NaN`, infinity, duplicate keys, and implementation-defined numbers. Decimal and 64-bit integer schemas use strings. Timestamps are RFC 3339 UTC with nanosecond precision; durations are ISO 8601 in documents and integer nanoseconds on the wire.
- Streams are ordered frames `{streamId, sequence, watermark, payloadRef}`. The consumer acknowledges a contiguous sequence; replay resumes from the last committed acknowledgement.
- State proposals use the exact `StateWriteIntent.Operation` vocabulary in `docs/contracts/executiongraph/runtime/v1/runtime.proto`, including optional expected path versions/value hashes. RFC 6902 is not a worker wire format. The persistence mapping and conflict behavior are defined in Chapter 5; a mismatch becomes `STATE_CONFLICT`, never silent last-writer-wins.
- Schema evolution is additive within a major version. Old payloads remain readable; migrations create new artifacts and retain provenance rather than rewriting historical checkpoints.

## 4.5 Node catalog

Abbreviations in the table: `cfg` is graph-owned configuration; `in/out` are typed ports; `life` calls out behavior beyond the common lifecycle; `ser` is serialization; `err` names mandatory error distinctions; `sec/iso` states special capability and isolation requirements. All rows also inherit Sections 4.1–4.4. Compact capability notation such as `{action: model.invoke, resource: {kind: model_route, id: route/*}, constraints: {...}}` denotes the structured record from Section 4.2.1; it is not a colon-delimited identifier.

| Node type | Inputs | Outputs | Configuration | Lifecycle and validation | Serialization and error handling | Security and isolation |
|---|---|---|---|---|---|---|
| **LLM** | messages, optional tools, response schema, attachments | structured response, tool calls, usage, provider receipt | model route, sampling, token ceiling, safety profile, cache policy | Resolve route and schema; record exact provider/model; stream chunks are provisional until final schema validation | OpenAI-compatible message IR; distinguish rate limit, context overflow, safety refusal, malformed structured output, unknown provider outcome | `{action: model.invoke, resource: {kind: model_route, id: <id>}, constraints: {dataClasses, tokenLimit}}`; provider credentials brokered; external egress only through model gateway |
| **Prompt** | typed variables, template fragments | rendered text or messages, provenance | immutable template version, engine, missing-variable policy | Pure; compile AST and check variables; render with deterministic locale | UTF-8 plus template digest; syntax and missing-variable errors are user errors | No secret interpolation; HTML/shell/SQL contexts require typed escaping; in-process audited builtin |
| **Function** | JSON values | JSON values | registry function digest, arguments | Pure or declared effect class; signature checked at publish time | Function ABI envelope; distinguish domain rejection from implementation panic | Only signed registered functions; pure functions in process, effectful functions isolated by capability |
| **Python** | JSON, Arrow, artifact refs | JSON, Arrow, artifacts | OCI/Wasm digest, entrypoint, packages lock, resource limits | Start clean sandbox per attempt or warm digest-pinned pool; validate lock and ABI | JSON/Arrow/artifacts; capture redacted stdout; timeout, OOM, import, and user exception are distinct | No host mounts; seccomp, read-only root, non-root, network deny; short-lived scoped credentials |
| **JavaScript** | JSON, byte streams, artifacts | JSON, artifacts | runtime version, module digest, lockfile, entrypoint | Frozen globals and clock/seed shim in replay; reject dynamic unpinned imports | Structured clone subset mapped to ValueEnvelope; promise rejection, OOM, timeout separated | V8 isolate or microVM; disable native addons/eval unless separately granted; network deny by default |
| **Rust Worker** | Protobuf/Arrow, artifact refs | Protobuf/Arrow, artifacts | worker service and OCI digest, protocol range, resource class | Remote lease/heartbeat; worker proves digest and protocol; native compute can checkpoint explicitly | Protobuf with backward-compatible fields; gRPC status translated to stable NodeError taxonomy | mTLS workload identity; Kubernetes sandbox or microVM; namespace, cgroup, egress, and service-account isolation |
| **Database** | query ID, typed parameters, optional transaction token | row stream, affected count, cursor | connection secret ref, statement registry, read/write mode, timeout | Prepare registered statement; stream with backpressure; transaction scope cannot cross untrusted nodes | Arrow record batches or typed JSON; classify constraint, deadlock, serialization, timeout, connectivity | `{action: db.read, resource: {kind: registered_statement, id: <connection>/<statement>}, constraints: {rows, timeout}}`; writes request a separate `db.write` action; no raw connection strings |
| **REST API** | method, path params, query, headers allowlist, body | status, allowed headers, parsed body, receipt | connection profile, OpenAPI operation ID, retry/idempotency policy | Validate against pinned OpenAPI; sign and send; record response before downstream scheduling | Body by declared media type; separate DNS/TLS/connect, HTTP status, schema, timeout, unknown outcome | `{action: network.http, resource: {kind: http_operation, id: <connection>/<operation>}, constraints: {method, bytes}}`; SSRF-safe egress proxy |
| **Webhook** | registration data or inbound request event | acknowledgement, verified payload, response command | route, signature scheme, replay window, response deadline | Registration at deploy; ingress verifies then persists before waking execution; response after deadline is async | Raw bytes artifact plus normalized headers; invalid signature, replay, decode, route-missing errors | Public ingress isolated from workers; tenant-scoped route entropy, WAF/rate limit; signature secret in ingress broker |
| **Email** | recipients, template data/body, attachments | provider message ID, delivery receipt | verified sender, template version, provider route, idempotency policy | Render, policy scan, enqueue via transactional adapter; delivery/bounce events arrive asynchronously | MIME artifact plus provider receipt; invalid recipient, policy block, rate limit, ambiguous send outcome | `{action: email.send, resource: {kind: verified_sender, id: <id>}, constraints: {recipientDomains, dataClasses}}`; no direct SMTP from arbitrary code |
| **MCP Tool** | tool name and schema-bound arguments | MCP content/result and resource refs | server registration/version, transport, tool allowlist | Negotiate protocol/capabilities; verify tool schema digest; record call/result for replay | MCP wire types normalized to envelopes; distinguish server protocol, tool, transport, and policy errors | `{action: mcp.call, resource: {kind: mcp_tool, id: <server>/<tool>, version_digest: <digest>}, constraints: {maxCalls}}`; brokered auth and taint retained |
| **Agent** | objective, messages, tools, context, budget | answer, plan, actions, transcript, usage | agent policy, model route, tool set, max steps/cost/time | Coordinator runs a bounded child loop; each tool call is a child invocation; checkpoint after each step | Transcript and decisions as append-only artifacts; budget, no-progress, tool, model, and policy failures distinct | Effective grants are intersection, never union, of graph and agent tools; untrusted content cannot grant tools |
| **Memory** | operation, subject key, content/query, scope | memories, version, write receipt | memory store, retention, extraction and ranking policy | Authorization before retrieval; compare-and-set on writes; record selected IDs and versions for replay | Versioned memory records and artifact refs; conflict, retention, permission, and backend errors | `{action: memory.read, resource: {kind: memory_subject, id: <id>}, constraints: {purpose, retention}}`; writes request a separate `memory.write` action; tenant isolation and tombstones |
| **Cache** | namespace, key, optional value and TTL | hit/value/version or write receipt | backend, mode, TTL bounds, stampede policy | Reads are advisory; writes occur after source commit; lease/single-flight for fill | Deterministic key encoding and value schema digest; miss is output, not error; corrupt entry evicted and reported | Namespace derived server-side; no secrets in keys; sensitivity controls encryption and shared-cache eligibility |
| **Human Approval** | request, choices/schema, assignees, due date | decision, actor, comment, signed evidence | assignment policy, quorum, expiry/escalation, separation of duties | Create task and suspend; resume only on authenticated, version-matched decision; late decisions retained but not applied | Approval record is append-only signed event; expired, revoked, conflicting, unauthorized decisions distinct | `{action: approval.request, resource: {kind: approval_policy, id: <id>}, constraints: {assignees, quorum}}`; ABAC, CSRF/replay defense, scanning |
| **Delay** | optional duration | wake timestamp | duration expression and maximum | Coordinator persists timer and suspends; no worker remains allocated | Duration plus absolute computed wake time; invalid/over-limit duration is user error | No capabilities; scheduler-owned, not `sleep` in a worker |
| **Timer** | optional schedule context | scheduled occurrence and missed-count | timezone, cron/calendar rule, start/end, misfire policy | Deployment creates versioned schedule; each occurrence starts or wakes once by dedupe key | RFC 5545/cron document plus UTC occurrence; DST ambiguity and misfire explicitly represented | `{action: schedule.manage, resource: {kind: deployment, id: <id>}, constraints: {frequency}}`; tenant quotas and scheduler isolation |
| **Condition** | expression operands | boolean branch token and evaluated facts | typed expression AST | Pure; compiler type-checks; runtime records operands' digests and result | Canonical AST, not source string alone; null/type/evaluation errors are user errors | No arbitrary code or I/O; constant-time sensitive comparisons where applicable |
| **Switch** | discriminator | exactly one named branch token, optional default | ordered cases as typed expressions, exhaustiveness | Pure; compile overlap/unreachable analysis; first-match semantics are explicit | AST and selected case ID; no-match without default is a domain error | Same expression sandbox as Condition; policy may forbid branching on protected attributes |
| **Loop** | initial accumulator, item/feedback | per-iteration value, final accumulator, iteration metrics | body subgraph digest, stop expression, max iterations/time/cost, concurrency | Runtime owns iteration index and checkpoint; every iteration invokes pinned subgraph; hard bounds required | Iteration events and accumulator artifacts; bound exceeded, no progress, body failure, cancellation distinct | Child grants cannot exceed parent; per-loop budgets and artifact quotas; no worker-resident while-loop |
| **Merge** | named optional branch values | merged value and provenance map | merge strategy, required branches, conflict resolver | Waits for declared arrivals; cancellation/skip counts as explicit terminal input; deterministic merge | Envelopes plus source branch IDs; missing, conflict, resolver failure differentiated | Resolver is pure/sandboxed; sensitivity is maximum of inputs unless policy declassifies |
| **Fork** | one value/control token | named cloned values/control tokens | branch names and copy/reference policy | Coordinator emits branch-ready facts atomically; no worker | References shared immutable artifacts; branch creation failure is coordinator error | Grants are narrowed per branch; mutable state is not copied implicitly |
| **Parallel** | collection or branch inputs | ordered result set and per-item status | body subgraph, max concurrency, fail-fast/collect, ordering | Scheduler creates bounded child invocations and joins them; backpressure applies | Results keyed by stable item ID, not completion order; aggregate exposes partial failures | Per-node and tenant concurrency ceilings; each child gets narrowed context and budget |
| **Event** | topic and payload for emit, or persisted event for await | event receipt or matched event | schema/version, correlation expression, timeout, consume mode | Emit uses outbox; await registers durable subscription then suspends; dedupe event ID | CloudEvents-compatible envelope plus schema digest; duplicate is ignored fact, poison payload quarantined | `{action: event.publish, resource: {kind: event_topic, id: <id>}, constraints: {schema}}`; subscriptions request `event.subscribe`; tenant-prefixed routing |
| **Queue** | enqueue message or dequeued delivery | receipt or message/ack token | queue binding, delivery mode, visibility timeout, DLQ | Adapter owns ack after node commit; lease extension bounded; redelivery expected | Message body artifact and broker metadata; poison, visibility loss, unavailable, quota errors | `{action: queue.send, resource: {kind: queue_binding, id: <id>}, constraints: {bytes, rate}}`; consumers request `queue.receive`; no arbitrary broker names |
| **Embedding** | text/image/document chunks | vectors, dimensions, model/version, usage | embedding route, batch/chunk policy, normalization | Batch with provider limits; cache only by model digest and canonical input digest | Float32/quantized vector artifact, never JSON number arrays at scale; dimension/provider errors | `{action: model.embed, resource: {kind: model_route, id: <id>}, constraints: {dataClasses, tokens}}`; vectors inherit sensitivity |
| **Retriever** | query, filters, principal context | ranked documents with provenance | retriever pipeline version, top-k, score floor | Authorization filter is applied before/during retrieval; record candidate set/version | Result IDs, snippets/artifact refs, scores, index epoch; stale index and permission errors distinct | `{action: knowledge.retrieve, resource: {kind: knowledge_corpus, id: <id>}, constraints: {topK, ACL}}`; fail closed; content remains untrusted |
| **Reranker** | query and candidates | reordered candidates and scores | model/function digest, top-n, batch size | Preserve candidate IDs; enforce output permutation/subset; record exact model | Compact score vector plus IDs; malformed, missing candidate, provider limit errors | `{action: model.rerank, resource: {kind: model_route, id: <id>}, constraints: {topN, dataClasses}}`; cannot add unauthorized candidates |
| **Vector Search** | vector or embeddable query, filters | neighbor IDs, distances, index epoch | index binding, metric, ef/search probes, top-k | Check dimensions/metric; query versioned projection; optionally wait for minimum epoch | Binary vector plus typed hits; dimension, index-lag, unavailable errors | `{action: vector.search, resource: {kind: vector_index, id: <id>}, constraints: {topK, ACL}}`; authorization filters are in-plan |
| **Knowledge Graph** | parameterized query/traversal and bindings | typed rows/subgraph, graph epoch | graph binding, registered query ID, limits | Compile registered Cypher/Gremlin subset; enforce row/path/time caps; record projection epoch | Arrow rows or graph exchange artifact; syntax, limit, stale projection, permission errors | `{action: graph.read, resource: {kind: graph_query, id: <graph>/<query>}, constraints: {rows, paths}}`; mutations request `graph.write`; predicates injected before traversal |
| **Validation** | value | validated/coerced value, violations | schema/rules digest, mode `reject` or `report`; coercion policy | Pure; validate before sensitive sinks; coercions are explicit provenance events | JSON Schema/SHACL/rule violations with stable paths/codes; violation may be normal output | No I/O; regex/time limits prevent DoS; never place secret values in violation messages |
| **Security** | content, provenance, destination context | allow/deny/quarantine, labels, findings | scanner/policy bundle digests, fail mode | Mandatory gate cannot be bypassed by graph edges; scanners run with bounded resources | Finding schema with redacted evidence refs; scanner unavailable fails closed for protected sinks | `{action: security.scan, resource: {kind: scanner, id: <name>, version_digest: <digest>}, constraints: {dataClasses}}`; isolated scanner and quarantine |
| **Policy** | principal, resource, action, context | decision, obligations, policy version | immutable policy bundle and decision point | Evaluate immediately before effect and again if suspended grant expires; record inputs' digests | Cedar/OPA-style decision envelope; deny is normal result, indeterminate is fail-closed error | Trusted control-plane evaluator; graph authors cannot supply policy code unless authorized |
| **Logging** | structured fields and optional artifact refs | accepted receipt | event name/schema, level, sampling | Redact/label before append; logging failure does not erase business failure but emits telemetry gap | Structured event only; size/schema violations dropped to quarantine with counter | `{action: telemetry.log, resource: {kind: telemetry_schema, id: <id>}, constraints: {rate, bytes}}`; redaction and tenant retention |
| **Metrics** | metric name, numeric value, dimensions | accepted receipt | registered instrument, unit, aggregation | Validate low-cardinality labels; batch export asynchronously | OTLP metric form; invalid names/labels counted, exporter outage buffered within bound | `{action: telemetry.metric, resource: {kind: metric_instrument, id: <id>}, constraints: {labels, rate}}`; per-tenant cardinality quotas |
| **Custom Plugin** | manifest-declared typed ports | manifest-declared typed ports and commands | signed plugin digest, node kind, schema-bound config | Resolve installed version; verify signature, ABI, grants, resource envelope; run via plugin host | Plugin ABI uses Protobuf envelopes and artifact handles; traps, ABI, policy, timeout, OOM mapped distinctly | Capabilities granted explicitly; Wasm or microVM/OCI sandbox; no control-plane process loading; see Chapter 13 |

## 4.6 Control-node lowering

Condition, Switch, Fork, Merge, Loop, Parallel, Delay, Timer, Event-await, and Human Approval are semantic nodes in the graph document but compile primarily to coordinator instructions. They MUST NOT occupy a worker while waiting. The compiler emits explicit join and cancellation rules:

```yaml
instruction:
  op: parallel_map
  sourcePort: nodes.chunk.outputs.items
  bodyPlan: sha256:633c...b013
  itemBinding: local.item
  concurrency: 32
  completion: collect_all
  ordering: input
  join:
    required: all_terminal
    cancelOutstandingOn: execution_cancelled
```

For a merge, every inbound branch reaches exactly one of `value`, `skipped`, `cancelled`, or `failed`. Treating absence as completion causes permanently waiting joins.

## 4.7 Built-in node implementation pattern

Built-ins implement a narrow adapter. Business state, retries, and event publication remain runtime responsibilities.

```rust
#[async_trait]
pub trait NodeExecutor: Send + Sync {
    fn definition(&self) -> &'static NodeDefinition;

    async fn invoke(
        &self,
        ctx: InvocationContext<'_>,
        inputs: ValidatedPorts,
        config: ValidatedConfig,
    ) -> Result<NodeOutcome, NodeFailure>;
}

pub async fn dispatch(
    registry: &Registry,
    invocation: AuthenticatedInvocation,
) -> WorkerResultProposal {
    invocation.verify_digest_and_lease()?;
    let executor = registry.exact(&invocation.definition_digest)?;
    let inputs = executor.definition().ports.validate_inputs(invocation.inputs)?;
    let outcome = tokio::time::timeout(
        invocation.remaining(),
        executor.invoke(invocation.context(), inputs, invocation.config()?),
    ).await.map_err(NodeFailure::deadline)??;
    executor.definition().ports.validate_outcome(outcome)?.into_proposal()
}
```

The adapter cannot commit state because `WorkerResultProposal` is authenticated and submitted through WorkerGateway, which owns the fenced worker-completion state-version compare-and-set and outbox transaction. The coordinator owns control-node transitions but does not create a second worker-completion authority path.

## 4.8 Graph authoring example

```yaml
apiVersion: executiongraph.io/v1
kind: Graph
metadata:
  namespace: claims
  name: evidence-review
  version: 1.0.0
spec:
  inputs:
    - name: claim
      schema: registry://schemas/Claim@3
      classification: CONFIDENTIAL
  outputs:
    - name: recommendation
      schema: registry://schemas/ClaimRecommendation@2
      classification: CONFIDENTIAL
  state:
    schema:
      type: object
      additionalProperties: false
      properties:
        recommendation: { $ref: "registry://schemas/ClaimRecommendation@2" }
    paths:
      - path: /recommendation
        mutability: SINGLE_ASSIGNMENT
        writers: [decide]
        classification: CONFIDENTIAL
  nodes:
    - id: retrieve
      type: builtin://retriever@2.1.0
      inputs:
        - { name: query, schema: { type: string }, classification: CONFIDENTIAL }
      outputs:
        - { name: documents, schema: "registry://schemas/DocumentSet@2", classification: CONFIDENTIAL }
      config: { pipeline: claims-evidence@8, topK: 20, querySource: "$graph.inputs.claim.description" }
      effect: { class: READ_ONLY, deliveryContract: READ_ONLY_REPEATABLE }
    - id: screen
      type: builtin://security@1.4.0
      inputs:
        - { name: content, schema: "registry://schemas/DocumentSet@2", classification: CONFIDENTIAL }
      outputs:
        - { name: allowed, schema: "registry://schemas/ScreenedDocuments@1", classification: CONFIDENTIAL }
      config: { policyBundle: evidence-ingress@12, failMode: closed }
      effect: { class: PURE, deliveryContract: NO_EFFECT }
    - id: decide
      type: builtin://llm@2.3.1
      inputs:
        - { name: messages, schema: "registry://schemas/ScreenedDocuments@1", classification: CONFIDENTIAL }
      outputs:
        - { name: recommendation, schema: "registry://schemas/ClaimRecommendation@2", classification: CONFIDENTIAL }
      config:
        modelRoute: quality-balanced@4
        responseSchema: registry://schemas/ClaimRecommendation@2
        prompt: prompts.claim-decision@11
      effect: { class: READ_ONLY, deliveryContract: READ_ONLY_REPEATABLE }
      retry: { maxAttempts: 2, backoff: EXPONENTIAL, retryOn: [provider_429, provider_5xx] }
  edges:
    - id: retrieve_to_screen
      kind: DATA
      from: { node: retrieve, port: documents }
      to: { node: screen, port: content }
    - id: screen_to_decide
      kind: DATA
      from: { node: screen, port: allowed }
      to: { node: decide, port: messages }
      when: "$nodes.screen.outputs.decision == 'allow'"
  budgets:
    timeout: PT2M
    maxCostMicrounits: 250000
    maxStateBytes: 1048576
    maxChildren: 64
```

Publication resolves every `@version`, compiles the prompt reference rather than evaluating the expression at edit time, and rejects the graph if the retrieved document sensitivity is incompatible with the selected model route.

## 4.9 Error, retry, cancellation, and compensation rules

The stable categories do not themselves determine retry. A node definition publishes a code-level retry safety map, and the environment narrows it. The runtime applies, in order:

1. cancellation or deadline;
2. policy deny/revocation;
3. attempt and execution budgets;
4. node retry code allowlist;
5. exponential backoff with full jitter and provider `retry-after` floor;
6. retry quota/circuit-breaker admission.

Cancellation is cooperative during execution and fenced at commit. A late success after cancellation is recorded as `discarded_late_result`; its outputs and state operations are not committed. If an external side effect may have occurred, the attempt becomes `cancelled_unknown_effect` and enters reconciliation. Compensation is an explicit graph path with its own authorization, retries, and audit—not an automatic callback hidden in the worker.

Errors exposed to graph logic are intentionally limited to declared domain outcomes. Allowing a graph to branch on raw stack traces, hostnames, or provider messages couples it to infrastructure and leaks data.

## 4.10 Security profiles

| Profile | Eligible code | Boundary | Network | Filesystem | Typical nodes |
|---|---|---|---|---|---|
| `trusted-inproc` | audited, shipped built-ins only | runtime process/module boundary | none unless adapter-owned | none | Condition, Switch, Prompt, Fork |
| `wasm` | signed WASI component | Wasmtime component instance; fuel and memory limits | capability proxy only | ephemeral preopened scratch | pure Function, validators, small plugins |
| `container` | signed OCI workload | user namespace, seccomp, AppArmor, cgroup; preferably gVisor | egress proxy allowlist | read-only root plus bounded scratch | Python, JavaScript, data adapters |
| `microvm` | high-risk native/untrusted code | Firecracker/Kata VM | dedicated namespace and proxy | ephemeral encrypted volume | marketplace native plugins, customer code |
| `remote` | registered enterprise service | mTLS service boundary and protocol policy | service-specific | service-owned | Rust Worker, on-prem connector |

Warm pools are keyed by tenant, definition digest, dependency digest, and security profile. They never cross tenants or secret grants. A revoked digest or policy epoch drains its pool immediately.

## 4.11 Decisions and trade-offs

| Decision | Why | Rejected alternative | Trade-off and failure mode |
|---|---|---|---|
| WorkerGateway commits worker outcomes; coordinator commits control transitions; sandboxes only propose | Gives one canonical database authority path for each transition class while preserving one fenced worker boundary | Sandboxes/supervisors writing shared state directly, or two services racing to commit one worker result | Extra gateway round trip and database load; shard by execution/token ID and keep shared transition logic in one runtime library. If gateway/database is unavailable, supervisors retry but cannot claim success |
| At-least-once attempts plus fencing | Survives worker loss without claiming impossible generic exactly-once execution | Exactly-once worker delivery | Adapters need idempotency/reconciliation. Fencing prevents stale commits but cannot undo an external effect |
| Schema-first ports | Enables compilation, safe UI generation, compatibility checks, and data policy | Untyped key/value bags | Schema evolution discipline and conversion nodes are required; ambiguous unions should be avoided |
| Content-pinned definitions | Makes history, rollback, and replay reproducible | Mutable tags at execution time | More artifact retention and upgrade workflow; revocation requires policy denial rather than mutation |
| Control nodes lower to coordinator instructions | Durable waits do not consume workers and joins have explicit semantics | Implementing loops/timers as code-node processes | Coordinator is more sophisticated; compiler/runtime IR must be versioned |
| Capability intersection | A nested graph, agent, or plugin cannot escalate authority | Plugin-declared or graph-declared authority alone | More setup for authors; denial diagnostics must show which layer narrowed the grant without exposing policy secrets |
| Artifact references for large values | Bounded queues/checkpoints and independent retention | Inline every payload | Object-store fetch latency; use locality-aware caches and prefetch while preserving digest verification |

## 4.12 Patterns and anti-patterns

**Use:** adapter nodes around provider gateways; registered parameterized database/API operations; immutable subgraph and plugin digests; explicit domain error ports; short worker attempts with durable coordinator suspension; stable item IDs for fan-out; authorization filters inside retrieval; state compare-and-set preconditions.

**Do not use:** arbitrary code in condition expressions; raw secrets or connection strings in config; `sleep()` for delay; polling loops for human approval; retries of unknown external writes; post-filter-only authorization; unbounded node output; plugin code loaded into the API server; mutable `latest` dependencies; logging prompts or tool results by default; a Merge that waits for branches that can disappear without a terminal marker.

## 4.13 Acceptance criteria

- Publishing a graph validates exact node digests, all port bindings, data-label flows, effect/retry compatibility, capability grants, and bounded loops/resources.
- Killing a worker after an external adapter call but before commit cannot produce two committed state transitions; the attempt is retried or reconciled with the same semantic idempotency key.
- A stale lease result, revoked plugin digest, unauthorized tool, cross-tenant artifact reference, oversized inline value, and schema-invalid output are each rejected with stable, audited codes.
- Replaying a historical execution never silently re-invokes a `RECORDED_NONDETERMINISTIC` or effectful node: `SUBSTITUTE_RECORDED` uses the journal, while `FORBID` stops with an explicit replay gap.
- Every catalog node emits the common attempt, result, usage, trace, provenance, and audit envelopes, including nodes lowered to coordinator instructions.
- Suspending Delay, Timer, Event, Loop boundary, or Human Approval nodes consumes no execution worker.
