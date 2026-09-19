# Normative Contract Examples

These files are implementation-starting contracts for the architecture. They are intentionally smaller than a future generated production API surface, but their semantics are normative:

- [graph-spec.schema.json](graph-spec.schema.json): source graph interchange schema;
- [control-plane.openapi.yaml](control-plane.openapi.yaml): graph publication and execution control API;
- [execution-events.asyncapi.yaml](execution-events.asyncapi.yaml): public lifecycle event envelope and delivery contract;
- [execution-history-event.schema.json](execution-history-event.schema.json): canonical PostgreSQL-backed execution-history event envelope used by replay and the REST history API;
- [runtime.proto](executiongraph/runtime/v1/runtime.proto): internal WorkerSupervisor-to-WorkerGateway claim, lease, heartbeat, completion, and failure protocol;
- [sandbox.proto](executiongraph/sandbox/v1/sandbox.proto): supervisor-to-isolated-runner invocation, brokered capability, progress, result, and cancellation protocol; it intentionally contains no database/broker credential or ExecutionGrant.
- [buf.yaml](buf.yaml): Protobuf linting and breaking-change policy for the documented contract layout.
- [buf.lock](buf.lock): pinned Protovalidate schema dependency used by generated clients and gateways.

Production builds MUST pin contract versions, generate clients in CI, run compatibility checks, and reject unknown major versions. Authentication, authorization, tenant isolation, quotas, and policy enforcement are required even when omitted from a short example response.

Every WorkerGateway RPC runs over mutually authenticated workload identity. Claim derives and returns a short-lived proof-of-possession ExecutionGrant bound to the supervisor certificate and Attempt; subsequent RPCs carry that grant in authenticated gRPC metadata. WorkerGateway validates it against the persisted claim hash and request fence tuple. The grant authorizes only gateway methods—it is not a database, NATS, secret-broker, provider, or general network credential—and it is never forwarded across the sandbox protocol.

A sandbox capability request selects an opaque handle and supplies schema-validated argument bytes/artifact reference only. Trusted WorkerGateway code constructs canonical destination/request bytes and reserves the deterministic effect ID plus platform-only operation key. For `NATIVE` or `ADAPTER` modes it also evaluates the CompiledPlan's destination idempotency-key expression; for `NONE` it sends no destination idempotency key. It then returns an effect receipt. Sandbox-supplied request hashes, idempotency keys, destinations, credentials, or effect outcomes are never authoritative inputs.

## Validation

Run the pinned release gate from the repository root. Docker is required for the PostgreSQL 18 DDL transaction:

```sh
npm ci --ignore-scripts
npm run validate
```

The checked-in locks pin `@bufbuild/buf@1.72.0`, `@redocly/cli@2.44.2`, `@asyncapi/parser@3.6.1`, `ajv@8.20.0`, `ajv-formats@3.0.1`, `yaml@2.9.0`, and the PostgreSQL 18.4 validation image by immutable manifest digest. The gate checks that version lock against the executable validator, architecture coverage/links/fences, all standalone and embedded Draft 2020-12 schemas, GraphSpec/CompiledPlan/plugin/NodeDefinition/ToolDefinition fixtures and digests, OpenAPI, semantically parsed AsyncAPI with resolved references and zero diagnostics, Buf formatting/lint/build, and every Chapter 14 SQL fence in that disposable PostgreSQL container with `ON_ERROR_STOP`.

Individual gates are available as `npm run validate:versions`, `validate:architecture`, `validate:schemas`, `validate:openapi`, `validate:asyncapi`, `validate:protobuf`, and `validate:ddl`.

Normal validation consumes the checked-in `buf.lock` and `package-lock.json` without rewriting either. Run `buf dep update` or `npm install` only in an explicit dependency-upgrade change, then review and commit the lockfile diff with compatibility and supply-chain evidence.

`ajv-formats` is required because GraphSpec uses the JSON Schema `duration` format for retry delays and execution timeouts. The metadata version pattern is the SemVer 2.0.0 grammar: it rejects leading zeroes in numeric identifiers and accepts independently composed prerelease and build sections. Graph names use the 128-character `identifier` definition; port names use the narrower 64-character `portIdentifier` definition.

Buf compiles the Protovalidate annotations as part of the module. Services MUST also execute generated Protovalidate validation at every trust boundary; compiling annotations without invoking validation at runtime is insufficient. Entity fields whose architecture type is UUIDv7 and deterministic/content fields whose type is SHA-256 are constrained at field level. Opaque infrastructure identifiers remain bounded or are validated by their owning registry rather than being mislabeled as UUIDs.

## Lease and sandbox projection

`ExecutionTokenLease` is the complete immutable envelope delivered by WorkerGateway to the trusted WorkerSupervisor. In addition to its fence tuple it carries separate GraphVersion, Compilation, and CompiledPlan identities; source, semantic-plan, and signed-envelope hashes; policy and dependency pins; implementation/configuration/input/read-set pins; remaining effect calls; and structured subgraph/loop/expansion lineage. Same-named fields are copied without reinterpretation into `StartInvocation`.

Admission caps one attempt slice at 4,096 effect calls, and both lease projections enforce that hard maximum. A graph requiring more must checkpoint across activations or bounded child executions. Complete/Fail may carry up to the full receipt set as consistency evidence, but receipt presence is not authoritative: WorkerGateway locks and reads every canonical `effect_operation` for the Activation in the terminal transaction. It rejects mismatched supplied receipts, normalizes or rejects every `RESERVED`/`STARTED` row, permits success only when every effect is terminal and the pinned node policy accepts the handled outcome, and forces reconciliation for `UNKNOWN`/`RECONCILING`. Retry/stop/reconciliation are derived from the complete normalized ledger set. Empty or partial request receipts can never hide an effect.

The projection deliberately omits `execution_grant`, `home_cell_id`, `routing_epoch`, `scheduler_fence`, and `fencing_token`. `StartInvocation` IDs and hashes provide deterministic provenance, not authority. The sandbox cannot use an artifact ID to read an object store. The supervisor resolves authorized input artifacts and streams only the permitted bytes in `InputChunk`; `port` is either a declared graph port or a supervisor-reserved logical channel such as `$configuration`, `$input-manifest`, or `$read-set-manifest`.

## Bounded artifact transfer

Sandbox output uses this protocol:

1. `StartInvocation.artifact_transfer_limits` supplies per-chunk, per-upload, aggregate, concurrent-upload, inline-state-value, state-intent-count, and result-frame limits. Protovalidate caps every wire chunk and inline state value at 65,536 bytes, intents at 1,024, and the sandbox-to-supervisor result frame at 4 MiB.
2. The sandbox sends sequenced `SandboxUploadChunk` frames. An upload ID is only a stream correlation value and conveys no storage authority.
3. The trusted supervisor enforces sequence and limits, computes the content hash, validates the declared purpose/media type, persists the bytes in the correct tenant scope, and then returns `SupervisorUploadReceipt.accepted` with a `TrustedArtifactReference`. On any failure it returns `rejected` and discards or quarantines incomplete bytes.
4. `BrokeredCapabilityRequest.arguments_artifact_id`, `InvocationProgress.artifact_id`, `InvocationResult.output_artifact_id`, and `StateWriteIntent.value_artifact_id` are accepted only when they match an accepted receipt for the current invocation and declared purpose. Arbitrary sandbox-supplied IDs fail closed.

The supervisor configures the gRPC inbound-message ceiling to the advertised result-frame limit, rejects more than the advertised intent count, canonical-serializes each `google.protobuf.Value`, and rejects an inline state value above the advertised byte limit before forwarding anything to WorkerGateway. Larger state values must use an accepted `PURPOSE_STATE_VALUE` upload receipt. The gateway repeats the count, canonical-byte, CompiledPlan path `maxBytes`, and aggregate budget checks; protobuf parsing is never an unbounded allocation path.

Capability arguments are a required `oneof`: at most 65,536 schema-validated inline bytes, or a supervisor-minted artifact ID from the upload protocol. The gateway still canonicalizes the destination request and treats neither representation as authoritative request identity.

## Capability outcomes

`InvokeCapabilityResponse.pre_invocation_rejection` means grant, fence, policy, schema, or budget checks rejected the call before trusted adapter/replay processing or effect reservation began; it therefore has no effect receipt. `CapabilityInvocationResult` means trusted adapter/replay processing began—including reservation or adapter preflight—and contains a required `oneof` of result artifact or runtime error plus a mandatory `ExternalEffectReceipt`. This does not assert that an external destination operation was invoked. Destination `REJECTED` and `UNKNOWN` are invocation-level receipt outcomes, not top-level policy rejection. `BrokeredCapabilityResult` preserves the same distinction and Protovalidate enforces receipt presence/absence.

Receipt outcomes project to the canonical ledger as follows: `COMMITTED`, `REJECTED`, `UNKNOWN`, and `RECONCILING` map one-to-one; `NOT_STARTED` and `NOT_COMMITTED` both normalize to canonical `NOT_COMMITTED`. `NOT_STARTED` is accepted only as trusted gateway evidence that adapter processing reserved the effect but the external destination operation boundary was never crossed, allowing a locked `RESERVED` row to terminalize. A locked `STARTED` row becomes `NOT_COMMITTED` only with trusted adapter proof; otherwise it becomes `UNKNOWN`. `RESERVED` and `STARTED` never appear as receipt outcomes and may not survive an Activation terminal transaction.

## State write intent rules

The sandbox proposes operations; it never selects path mutability, conflict policy, or reducer identity. WorkerGateway obtains those from the pinned CompiledPlan and validates authority, schema, artifact commitment, and the MVCC guard before commit.

| Operation | Value rule | Expectation rule | Additional rule |
| --- | --- | --- | --- |
| `OPERATION_PUT` | exactly one inline value or trusted artifact ID | optional on wire; pinned `COMPARE_AND_SET` requires `expected_path_version` | path must be an absolute JSON Pointer |
| `OPERATION_DELETE` | no value | optional on wire; pinned `COMPARE_AND_SET` requires `expected_path_version` | path must be an absolute JSON Pointer |
| `OPERATION_REDUCE` | exactly one inline value or trusted artifact ID | forbidden | reducer identity/digest comes only from the CompiledPlan |
| `OPERATION_BIND_ARTIFACT` | trusted artifact ID only | optional on wire; pinned `COMPARE_AND_SET` requires `expected_path_version` | inline value is forbidden |
| `OPERATION_CLOSE_SCOPE` | no value | forbidden | requires deterministic `scope_id` and an absolute canonical scope-state path; worker dedupe key is forbidden |

For PUT, DELETE, or BIND_ARTIFACT, `expected_value_hash` is legal only with `expected_path_version`. The `StateWriteIntent.value` Protobuf `oneof` enforces representation exclusivity, and message-level Protovalidate CEL enforces the operation-dependent shape. Plan-dependent authorization and conflict rules remain mandatory gateway checks because an untrusted worker cannot declare the path policy that would select them.
