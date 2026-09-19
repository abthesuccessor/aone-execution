# 10. Security, Authorization, and Governance

The platform executes untrusted graphs, code, prompts, tools, plugins, and third-party responses on behalf of mutually distrusting tenants. The security model therefore assumes that graph authors make mistakes, model output is attacker-influenced, plugins may be malicious, provider credentials are high-value targets, workers can be compromised, and internal networks are not trusted. A successful model response is not evidence that an action was authorized.

Security is enforced at graph publication, execution admission, node dispatch, secret resolution, network egress, tool invocation, output release, and audit export. Client-side visibility checks are usability features only; every protected operation is authorized server-side against a concrete principal, action, resource, and context.

## 10.1 Security objectives and invariants

1. Every human, service, worker, plugin, and execution has a verifiable identity. Identity authentication is distinct from authorization.
2. The runtime grants only the capabilities needed for one node attempt. `WorkerGateway` mints the proof-of-possession/mTLS-bound `ExecutionGrant`, persists its hash/constraints, and validates it when `WorkerSupervisor` presents it on gateway RPCs. The supervisor has no direct database/effect/broker authority, and neither component forwards the grant, a human token, or a provider credential to arbitrary node code.
3. Authorization combines tenant-scoped roles (RBAC) with resource, environment, data, risk, network, and request attributes (ABAC). Explicit deny and required approval override allow.
4. Authorization is checked at the last responsible enforcement point. An allow at graph compilation does not authorize a future production effect.
5. PostgreSQL is the canonical authorization-aware store. Tenant predicates and row-level security provide defense in depth; caches, queues, search, vector, graph, object, and telemetry projections never grant access.
6. Tenant identifiers are derived from the authenticated context, never trusted from request bodies, graph state, model output, queue payloads, or object paths.
7. Secret values are resolved just in time, kept out of graph/state/event/log payloads, and scoped by tenant, environment, tool, and node attempt.
8. Arbitrary code and untrusted plugins run in a sandbox selected by risk tier, with no NATS, PostgreSQL, `ExecutionGrant`, secret value, ambient network, host filesystem, cloud metadata, Kubernetes API, or control-plane access.
9. Tool and external side effects require a typed permission manifest, policy decision, bounded arguments, idempotency semantics, and—where configured—a human approval tied to the exact effect digest.
10. Content controls reduce prompt-injection risk but never replace authorization or isolation. Model-generated instructions are data until validated by a trusted controller.
11. Security-relevant failures fail closed. Availability fallbacks may not silently widen authority, remove tenant filters, use stale revoked grants, or disable output policy.
12. All governed decisions are attributable, replay-resistant, time bounded, and auditable.

## 10.2 Threat model and trust boundaries

### 10.2.1 Assets

Critical assets include tenant graph definitions and state, prompts and model output, knowledge and memory records, provider/tool credentials, plugin packages, execution capability grants, source code, customer data, billing data, audit records, model-routing policy, signing keys, worker images, and the authority to cause external effects.

### 10.2.2 Adversaries and failure assumptions

- an unauthenticated internet attacker;
- a malicious or compromised tenant user;
- one tenant attempting cross-tenant access;
- a graph author with more design authority than production-deploy authority;
- malicious input embedded in documents, web pages, tool output, memory, or model output;
- a compromised plugin, package, worker, browser session, CI identity, or provider account;
- a curious operator or support engineer;
- accidental policy/configuration errors and stale replicas;
- denial-of-service through graph expansion, loops, tokens, tool calls, payloads, telemetry, or expensive queries;
- data remanence in logs, caches, object versions, indexes, backups, and model-provider retention.

### 10.2.3 Trust-boundary diagram

```text
 UNTRUSTED INTERNET / TENANT DEVICE
 +------------------------------------------+
 | Browser, CLI, SDK, webhook caller        |
 +--------------------+---------------------+
                      | TLS, OIDC/OAuth, request limits
======================| BOUNDARY A: EDGE =============================
                      v
 +--------------------+---------------------+
 | WAF/API Gateway -> Identity -> PEP        |
 +--------------------+---------------------+
                      | principal/action/resource/context
======================| BOUNDARY B: CONTROL PLANE =====================
                      v
 +--------------------+---------------------+
 | Command API | Policy PDP | Graph Registry|
 | Secret Broker | Audit | Scheduler        |
 +--------------------+---------------------+
                      | transactional outbox -> JetStream dispatch hint
======================| BOUNDARY C: EXECUTION CELL ====================
                      v
 +--------------------+       +--------------------+
 | WorkerSupervisor   |------>| WorkerGateway      |
 | trusted consumer   |       | trusted authority  |
 +--------------------+       +----+-----------+---+
                                   |           |
                       sanitized   |           | fenced claim/commit
                       invocation  |           v
                                   v        PostgreSQL / object store
                            +-------------+
                            | sandbox     |--local host RPC--> tool/model/
                            | untrusted   |                    egress brokers
                            +-------------+                         |
                                                         allow-listed TLS
                                                                 v
                                                    Models, tools, customer APIs
====================== BOUNDARY D: EXTERNAL PROVIDERS =================

 Separate security domains:
 [tenant A cell data] [tenant B cell data] [platform admin] [telemetry]
```

The trusted computing base includes edge identity validation, policy enforcement points (PEPs), the policy decision point (PDP), scheduler lease/fencing logic, `WorkerSupervisor`, `WorkerGateway`, secret broker, egress proxy, canonical database, artifact verifier, KMS, and audit pipeline. `WorkerSupervisor` consumes JetStream, manages sandbox lifecycle, and may hold/present a proof-of-possession/mTLS-bound `ExecutionGrant`. `WorkerGateway` alone claims and commits canonical work in PostgreSQL, mints the grant, persists its hash/constraints, validates supervisor RPCs and fencing, and mediates artifact, secret, model, tool, and effect operations. The supervisor cannot use the grant for direct database or broker access. Node code, model output, fetched content, and plugin logic are always outside the TCB.

### 10.2.4 Threat-to-control matrix

| Threat | Prevent/detect controls | Residual risk/response |
|---|---|---|
| Cross-tenant IDOR | tenant from token; object ownership check; RLS; tenant-bound object keys; negative tests | compromised platform identity; isolate cell and rotate credentials |
| Prompt injection causes tool call | trust labels; no ambient tools; schema; tool PEP; capability/approval; egress proxy | authorized but harmful intent; approval and anomaly detection |
| Sandbox escape | gVisor/Kata tier; rootless; seccomp; read-only image; no host mounts; patched hosts | runtime/kernel zero-day; quarantine node pool/cell |
| Secret exfiltration | handle-only state; just-in-time broker; response redaction; destination binding; short TTL | permitted destination may leak; provider isolation and rotation |
| Queue message forgery/replay | mTLS workload identity; signed envelope; DB-authoritative claim; nonce/expiry; fencing token | compromised scheduler identity; revoke trust domain and cell |
| Stale policy allows revoked action | revisioned bundles; bounded decision cache; revocation epoch; recheck at effect | PDP outage; fail closed for governed effects |
| Malicious plugin update | publisher identity; signature; digest pin; review; canary; revocation | trusted publisher compromise; kill switch and fleet scan |
| Resource exhaustion | admission quota; graph bounds; token/cost/deadline caps; cgroups; rate limits; backpressure | distributed low-rate abuse; tenant suspension |
| Audit tampering | append-only outbox; separation of duties; KMS-signed roots; WORM archive | signing authority compromise; independent external anchoring |
| Data leaked to model provider | classification/residency policy; provider contract flags; DLP; routing constraints | provider breach; incident and tenant notification policy |

## 10.3 Identity and authentication

### 10.3.1 Human identities

Enterprise login uses OpenID Connect over OAuth authorization code with PKCE. SAML 2.0 identity providers are brokered to an internal OIDC session. Password authentication, if offered for small/self-hosted deployments, uses phishing-resistant WebAuthn as the preferred MFA and memory-hard password hashing. OAuth implementation follows current security best practice, including exact redirect URI matching, PKCE, sender constraints where available, and no implicit grant ([OAuth 2.0 Security Best Current Practice, RFC 9700](https://datatracker.ietf.org/doc/html/rfc9700)).

Session properties:

- access token audience is one API surface and lifetime is 5-10 minutes;
- refresh tokens are rotated, reuse-detected, encrypted, and bound to the session/device;
- browser tokens live in secure, HTTP-only, same-site cookies; never local storage;
- CSRF tokens protect cookie-authenticated mutations; state-changing APIs reject `GET`;
- authentication strength (`amr`/`acr`), identity-provider tenant, session ID, and auth time are preserved;
- step-up authentication is required for production deployment, secret reveal, policy change, audit export, and destructive tenant actions;
- SCIM provisioning/deprovisioning and group sync are idempotent; group removal increments a tenant authorization epoch to invalidate cached decisions;
- emergency local accounts are disabled by default, hardware-key protected, monitored, and tested under a break-glass process.

### 10.3.2 Service and workload identities

Workloads use short-lived X.509 identities issued through SPIFFE/SPIRE and mTLS. SPIFFE SVIDs are cryptographically verifiable workload identities; X.509 SVIDs are preferred over bearer-style JWT SVIDs where possible ([SPIFFE concepts](https://spiffe.io/docs/latest/spiffe/concepts/)). Example:

```text
spiffe://prod.ege.dev/cell/apne1-03/ns/runtime/sa/scheduler
spiffe://prod.ege.dev/cell/apne1-03/ns/runtime/sa/worker-supervisor
spiffe://prod.ege.dev/global/ns/control/sa/policy-bundle-publisher
```

Attestation selectors bind identity to cluster, namespace, service account, signed workload digest, and node pool. A Kubernetes service-account token alone is not accepted as cross-service identity. Trust domains are federated only through an explicit, audited bundle.

### 10.3.3 API keys and webhooks

- API keys are generated with at least 256 bits of entropy, shown once, stored as keyed hashes, prefixed for scanning, and scoped to tenant/project/actions/environment/IP/time.
- Key metadata—not the secret—includes owner, creation/last-used timestamps, expiry, scopes, network constraints, and rotation predecessor.
- Webhook signatures use per-endpoint HMAC or asymmetric keys, include timestamp and event ID, reject replay outside a 5-minute window, and preserve raw-body bytes for verification.
- Inbound webhooks enter an untrusted-input boundary and cannot select tenant/project through payload data.

### 10.3.4 Authentication is not delegation

A user starting an execution does not make every later worker request “the user.” Admission creates an immutable delegation record. `ExecutionToken` is the durable schedulable database record, not a bearer credential. For each claimed attempt, the runtime issues a restricted `ExecutionGrant` to `WorkerGateway`; audit records both the workload actor and the original `on_behalf_of` subject. User session expiry does not necessarily cancel an already-approved run, but permission revocation and configured continuous-access policies can.

## 10.4 Resource hierarchy and authorization model

### 10.4.1 Resource hierarchy

```text
Organization/Tenant
  +-- Project
      +-- Environment (development | staging | production)
          +-- DraftBranch
          +-- GraphVersion (immutable)
          +-- Deployment
          +-- Execution
          +-- SecretBinding
          +-- KnowledgeCollection / MemoryNamespace
          +-- PluginInstall / ModelProfile / ToolBinding
```

Ownership never implies unrestricted production authority. Environment boundaries are first-class resources, not tags.

### 10.4.2 Roles

RBAC provides understandable baseline permissions. Roles are tenant-scoped assignments; custom roles are sets of versioned actions.

| Role | Representative rights | Explicit exclusions |
|---|---|---|
| Organization Owner | tenant administration, billing, break-glass nomination | cannot read secret values by default |
| Security Administrator | policy, identity, audit, secret metadata, incident controls | cannot alter billing or approve own request |
| Project Administrator | project members/settings, non-production resources | no org policy override |
| Graph Author | draft/edit/test, create candidate GraphVersion | no production deploy or unapproved production tool |
| Release Manager | promote signed GraphVersion and roll back | cannot change candidate contents |
| Operator | inspect/cancel/retry authorized executions | no graph editing or secret reveal |
| Approver | approve assigned risk classes | cannot approve own authored/requested change |
| Auditor | read/export scoped audit and compliance evidence | no mutation; sensitive fields separately gated |
| Billing Administrator | budgets, invoices, cost exports | no prompt/state access |
| Service Principal | enumerated API actions | no interactive login, inheritance, or wildcard by default |

### 10.4.3 ABAC inputs

ABAC narrows or conditions RBAC. Inputs include:

- principal: tenant, groups, role bindings, auth strength, device posture, employment status, service identity, delegation chain;
- resource: tenant/project/environment, owner, classification, residency, risk, graph/plugin digest, model/tool profile;
- action: operation, effect class, data access mode, requested fields;
- execution: original requester, graph revision, node type, grant ID, budget, approval, replay operation, execution mode, and adapter effect mode;
- request: source network, region, time, session age, reason/ticket, API client;
- system: incident mode, policy revision, revocation epoch, provider health, deployment ring.

The engine uses Open Policy Agent (OPA) because it evaluates structured input against declarative policy and separates policy decisions from enforcement ([OPA documentation](https://www.openpolicyagent.org/docs)). OPA is a PDP; APIs, schedulers, workers, secret brokers, and proxies remain PEPs.

### 10.4.4 Authorization decision contract

```json
{
  "$schema": "https://schemas.ege.dev/security/authz-decision-1.0.json",
  "decision_id": "0197f3c2-8100-7111-b399-a80bc0000009",
  "result": "require_approval",
  "reason_codes": ["PRODUCTION_EFFECT", "HIGH_VALUE_TOOL"],
  "obligations": {
    "approval_policy": "two-person-finance",
    "redact_fields": ["$.customer.ssn"],
    "max_result_bytes": 65536,
    "allowed_egress": ["api.payments.example:443"],
    "recording": "audit_and_effect_journal"
  },
  "policy_revision": "sha256:9c4...",
  "authorization_epoch": 418,
  "expires_at": "2026-08-06T12:40:00Z"
}
```

Decision results are `deny`, `require_approval`, or `allow`; absence/undefined is `deny`. Obligations are executable constraints, not UI advice. A PEP that does not understand an obligation denies the request. Decisions are cached only by a hash of all relevant inputs and for the shorter of 30 seconds, token expiry, or policy TTL. Secret access, high-risk effects, and production replay are not positively cached.

### 10.4.5 Example policy

```rego
package ege.tool

import rego.v1

default decision := {
  "result": "deny",
  "reason_codes": ["NO_MATCHING_ALLOW"],
  "obligations": {}
}

decision := {
  "result": "allow",
  "reason_codes": ["SCOPED_GRANT"],
  "obligations": {
    "max_result_bytes": grant.max_result_bytes,
    "allowed_egress": grant.destinations,
    "recording": "audit_and_effect_journal"
  }
} if {
  input.principal.tenant_id == input.resource.tenant_id
  input.workload.spiffe_id == input.grant.bound_workload
  input.execution.graph_revision_id == input.grant.graph_revision_id
  input.execution.activation_id == input.grant.activation_id
  input.action == "tool.invoke"
  input.resource.tool_id == input.grant.tool_id
  time.now_ns() < input.grant.expires_at_ns
  not input.grant.revoked
  grant := input.grant
  input.resource.effect_class != "NON_IDEMPOTENT_WRITE"
}

decision := {
  "result": "require_approval",
  "reason_codes": ["NON_IDEMPOTENT_WRITE"],
  "obligations": {"approval_policy": "effect-owner"}
} if {
  input.resource.effect_class == "NON_IDEMPOTENT_WRITE"
  input.principal.tenant_id == input.resource.tenant_id
}
```

Real policy packages have schema validation, unit tests, decision fixtures, coverage, performance budgets, signed bundles, staged rollout, and rollback. `time.now_ns()` is supplied consistently for deterministic policy tests.

### 10.4.6 Enforcement sequence

```text
User -> API: Execute GraphVersion in production
API -> Identity: validate issuer/audience/session/tenant/auth strength
API -> PDP: graph.execute(principal, GraphVersion, environment, context)
PDP -> API: allow + obligations + policy_snapshot_id
API -> DB: TX create Execution + admission decision + outbox
Outbox relay -> JetStream: dispatch hint (Nats-Msg-Id=outbox_message.id)
JetStream -> WorkerSupervisor: deliver opaque hint
WorkerSupervisor -> WorkerGateway: request local claim
WorkerGateway -> DB: conditional claim; increment fencing_token=N
WorkerGateway -> WorkerGateway: mint grant; persist hash + constraints
WorkerGateway -> WorkerSupervisor: PoP/mTLS-bound ExecutionGrant
WorkerGateway -> PDP: node.execute(current resource/context)
WorkerSupervisor -> Sandbox: sanitized InvocationEnvelope + local host channel
Sandbox -> WorkerSupervisor: opaque-handle host operation request
WorkerSupervisor -> WorkerGateway: RPC + PoP/mTLS-bound grant
WorkerGateway -> Secret/Tool proxy: validate grant; derive permit; invoke
Tool proxy -> PDP: tool.invoke(re-evaluate current policy)
Tool proxy -> external tool: bounded request + idempotency key
Tool proxy -> Audit: effect outcome and decision ID
Sandbox -> WorkerSupervisor: typed result
WorkerSupervisor -> WorkerGateway: result RPC + PoP/mTLS-bound grant
WorkerGateway -> DB: conditional commit WHERE fencing_token=N
WorkerSupervisor -> JetStream: ACK only after accepted commit
```

The second tool decision closes the time-of-check/time-of-use gap. Only `WorkerGateway` can exercise database/effect authority: it mints the grant, persists its hash/constraints, and validates the supervisor's proof of possession on each RPC. Possession does not give the supervisor a direct DB, broker, or secret path. A stale attempt cannot write because every mutation and effect handoff is fenced. The sandbox has no NATS or database client, receives no grant or secret, and can request only schema-bounded opaque-handle operations.

## 10.5 Execution capabilities and tool permissions

### 10.5.1 Effect and requirement contracts

Every node and tool declares exactly one of six effect classes:

| Effect class | Security consequence |
|---|---|
| `PURE` | No external read or write; may be recomputed only within its determinism contract. |
| `READ_ONLY` | External observation only; requires scoped read authority and freshness/privacy policy. |
| `IDEMPOTENT_WRITE` | External write with a destination-supported durable idempotency key. |
| `COMPENSATABLE_WRITE` | External write with a declared, authorized compensation contract; compensation is a new effect, not rollback. |
| `NON_IDEMPOTENT_WRITE` | External write that may repeat or become ambiguous; approval/reconciliation policy applies. |
| `HUMAN_EFFECT` | A human decision or action with identity, expiry, separation-of-duty, and evidence requirements. |

Effect class does not encode determinism. Determinism is independently `PURE`, `RECORDED_NONDETERMINISTIC`, or `EFFECTFUL`; retry, caching, replay, and authorization evaluate both fields.

All requested authority uses one structured shape rather than colon-delimited permission strings:

```typescript
type CapabilityRequirement = {
  action: string;
  resource: { kind: string; id: string; version_digest?: string };
  constraints: Record<string, unknown>;
};
```

The compiler collects these objects from node, plugin, tool, and graph manifests. Admission narrows them against the installed package, tenant/environment policy, initiating delegation, approvals, and the pinned `PolicySnapshot`; neither a string parser nor the sandbox may widen them.

### 10.5.2 ExecutionGrant

```json
{
  "$schema": "https://schemas.ege.dev/security/capability-grant-1.0.json",
  "grant_id": "0197f3c2-8200-7222-84aa-b91cd0000010",
  "tenant_id": "0197f3c2-5000-7555-8066-75d890000005",
  "environment_id": "0197f3c2-5000-7555-8066-75d890000006",
  "home_cell_id": "apne1-03",
  "routing_epoch": 7,
  "execution_id": "0197f3c2-7b10-7a11-8c22-31f450000001",
  "activation_id": "sha256:4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a1a4a",
  "execution_token_id": "0197f3c2-8300-7333-95bb-ca2de000000f",
  "attempt_id": "0197f3c2-8300-7333-95bb-ca2de0000011",
  "attempt_ordinal": 2,
  "scheduler_fence": 11,
  "fencing_token": 19,
  "graph_version_id": "0197f3c2-6a00-7b22-9d33-42a560000002",
  "compiled_plan_id": "0197f3c2-6a00-7b22-9d33-42a560000003",
  "plan_hash": "sha256:4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f4f6f",
  "audience": "spiffe://prod.ege.dev/cell/apne1-03/ns/runtime/sa/worker-gateway",
  "presenter": "spiffe://prod.ege.dev/cell/apne1-03/ns/runtime/sa/worker-supervisor",
  "confirmation": {"x5t#S256": "sha256:6b2..."},
  "capability_requirements": [
    {
      "action": "tool.invoke",
      "resource": {
        "kind": "tool",
        "id": "payments.lookup",
        "version_digest": "sha256:2c8..."
      },
      "constraints": {
        "destinations": ["api.payments.example:443"],
        "arg_schema": "sha256:a84...",
        "max_calls": 3,
        "max_result_bytes": 65536
      }
    }
  ],
  "not_before": "2026-08-06T12:34:00Z",
  "expires_at": "2026-08-06T12:39:00Z",
  "nonce": "pAd5...",
  "policy_snapshot_id": "0197f3c2-8400-7444-a6cc-db3ef0000012",
  "policy_snapshot_hash": "sha256:9c4..."
}
```

The signed token carries only immutable identifiers and compact constraints; mutable revocation/usage state is checked by grant ID at the PEP. It is audience-bound to `WorkerGateway`, presenter-bound to the supervisor's mTLS identity/key, and never serialized into the sandbox invocation. The supervisor may present it only to the gateway. After verification, the gateway uses a narrower derived operation permit with trusted PEPs and brokers; possession alone cannot bypass the gateway.

### 10.5.3 Canonical ToolDefinition security projection

Every tool version declares security semantics before installation through the same closed `tools.ege.dev/v1` `ToolDefinition` contract defined in Chapter 13. This is a complete canonical instance, not a second security-only wire format:

```yaml
apiVersion: tools.ege.dev/v1
kind: ToolDefinition
metadata:
  id: 019fd4b4-5a00-7f11-8cb0-7b5600000031
  name: payments/refund
  version: 3.2.1
  digest: sha256:11c3e38145e0398f6eec3e4112b8deeb6cc8e69be8b94100a68a075332c7bc2c
spec:
  transport:
    kind: openapi
    connection: connections/payments-production
    operationId: createRefund
    documentDigest: sha256:847d0c53e08c2ca5a3aa45836b50f2bbcc9589257d5493d115dd2cda23e80df1
  inputSchema: {$ref: "schemas/RefundRequest@3"}
  outputSchema: {$ref: "schemas/RefundReceipt@3"}
  effect:
    class: HUMAN_EFFECT
    deliveryContract: STOP_ON_AMBIGUITY
    approvalPolicy: policy://payments/refund-approval@3
    reconciliationProcedure: tool://payments/refunds-status@3
    allowedAdapterEffectModes: [SUBSTITUTE_RECORDED, REEXECUTE_AUTHORIZED_EFFECT, FORBID]
  determinism: EFFECTFUL
  capabilityRequirements:
    - action: secret.use
      resource: {kind: secret_binding, id: payments.production.api}
      constraints: {delivery: broker_injected, reveal: false}
    - action: network.connect
      resource: {kind: network_destination, id: payments-api}
      constraints: {scheme: https, host: api.payments.example, ports: [443]}
  limits:
    timeout: PT10S
    maxInputBytes: 32768
    maxOutputBytes: 65536
    maxCalls: 1
  dataPolicy:
    acceptedLabels: [CONFIDENTIAL]
    outputLabel: CONFIDENTIAL
```

`effect.approvalPolicy` selects the immutable approval policy; environment conditions, bound fields, residency allowlists, and regional routing are resolved into the pinned PolicySnapshot rather than copied into an alternate manifest vocabulary. Tool execution uses a platform adapter, not arbitrary model-generated HTTP. URL, method, headers, destination, and credential binding come from the signed definition and administrator-approved connection; model output supplies only schema-valid arguments. Redirects, DNS rebinding, private/link-local IPs, cloud metadata, alternate ports, and Unicode hostname ambiguity are rejected by the egress proxy.

### 10.5.4 Approval binding

An approval references `tenant_id`, `execution_id`, `activation_id`, tool/version digest, canonical argument digest, effect summary, amount/scope, policy snapshot, requester, approver(s), expiry, and nonce. Any change to bound fields invalidates it. Authors/requesters cannot satisfy separation-of-duty policies with their own approval. `SUBSTITUTE_RECORDED` does not manufacture a new approval; `REEXECUTE_AUTHORIZED_EFFECT` requires a fresh approval unless policy explicitly permits a bounded replay window whose bound fields still match.

## 10.6 Secret management and cryptography

### 10.6.1 Secret lifecycle

The baseline secret system is Vault integrated with cloud KMS/HSM. Vault Transit provides encryption/signing operations and envelope-encryption support ([Vault Transit](https://developer.hashicorp.com/vault/docs/secrets/transit)). Managed-cloud secret managers may implement the same broker interface.

1. A tenant administrator creates a named secret binding; the platform stores a handle and metadata, not a value in GraphVersion.
2. The value is written through the secret service over mTLS and encrypted under a tenant/environment key hierarchy.
3. Graph compilation verifies the handle exists and that the node/tool declares its need; it cannot read the value.
4. At node attempt, `WorkerSupervisor` presents the proof-of-possession/mTLS-bound `ExecutionGrant` to `WorkerGateway`; the gateway validates it and presents only a narrower derived permit to the secret broker.
5. The broker authorizes `(tenant, environment, graph revision, node, tool, destination, secret, attempt)` and injects a short-lived credential or secret value directly into a trusted adapter. It does not return secret material to the sandbox.
6. Access is audited. The secret is zeroized after use and never enters state, events, telemetry, crash dumps, command-line arguments, or reusable container layers.
7. Rotation creates a new version. Deployments can pin a version or use an audited “current” alias. Revocation immediately blocks new resolutions.

Dynamic database/cloud credentials are preferred. Static provider API keys are scoped to a tenant/provider/project where supported and have rotation SLOs. A secret value may be returned to a user only under a separate `secret.reveal` permission, step-up authentication, reason, and audit; most users never need reveal.

### 10.6.2 Key hierarchy

```text
Cloud HSM/KMS customer/platform root key
  -> tenant key-encryption key (KEK, region + residency bound)
      -> environment data-encryption key (DEK)
          -> object/checkpoint/payload DEK (random per object or segment)
```

- TLS 1.3 is preferred for public and internal transport; mTLS authenticates workloads.
- Storage volumes and managed services use provider encryption, plus application envelope encryption for confidential/restricted state, prompts, artifacts, credentials, and audit exports.
- Keys have immutable IDs/version, usage purpose, tenant/region, creation/activation/retirement, algorithm, and rotation policy.
- AEAD associated data includes tenant ID, resource type/ID, environment, schema version, and key version to prevent ciphertext relocation.
- Signing and encryption keys are separate. Audit-root, artifact-signing, session, capability, and data-encryption keys are separate trust domains.
- Rotation is online: new writes use the active key, reads accept allowed retired versions, and asynchronous rewrap changes encrypted DEKs without rewriting payload data.
- Crypto erasure is allowed only when retention/legal-hold policy permits it and is itself approved/audited.

Do not claim “encrypted at rest” solely because a cloud disk is encrypted; that does not isolate a compromised database/service identity from sensitive application data.

## 10.7 Execution isolation and sandboxing

### 10.7.1 Isolation tiers

| Tier | Workload | Runtime | Network | Filesystem | Startup/performance |
|---|---|---|---|---|---|
| T0 trusted native | signed platform Rust workers | containerd, restricted pod | service allow-list | read-only image, scoped volumes | lowest overhead |
| T1 WASM | compatible plugins/functions | Wasmtime with fuel/epoch limits | host functions only | capability mounts only | fast/cold-start efficient |
| T2 untrusted language | Python/JS/custom binaries | gVisor `runsc` per tenant/node attempt group | default deny via proxy | ephemeral root, no host paths | moderate syscall/IO overhead |
| T3 high assurance | sensitive arbitrary code/strong tenants | Kata/Firecracker microVM on dedicated pool | dedicated vNIC/proxy | encrypted ephemeral disk | highest isolation/cost/cold start |

Kubernetes `RuntimeClass` selects the runtime and accounts for its overhead, enabling isolation/performance tiers ([Kubernetes RuntimeClass](https://kubernetes.io/docs/concepts/containers/runtime-class/)). gVisor interposes a userspace application kernel and reduces direct host-kernel exposure, but does not protect against every side channel or resource-exhaustion attack; cgroups and network policy remain required ([gVisor security architecture](https://gvisor.dev/docs/architecture_guide/security/)).

### 10.7.2 Sandbox baseline

- non-root UID/GID, rootless where supported; no privilege escalation;
- all Linux capabilities dropped; restricted seccomp/AppArmor/SELinux; no privileged devices;
- read-only root filesystem; empty ephemeral workspace with byte/inode quota; no hostPath or container socket;
- no service-account token mounted; no Kubernetes API, node metadata, cloud metadata, host PID/IPC/network namespace;
- CPU quota, memory hard limit, process/file-descriptor/thread limits, wall-clock deadline, stdout/stderr byte cap;
- network `none` unless the signed manifest grants egress through a proxy; raw sockets and listener ports denied;
- image by digest, verified signature/provenance/SBOM, vulnerability policy, immutable base, no package install at runtime;
- one tenant per sandbox boundary; high-risk nodes get one sandbox per attempt;
- random/time/network only through controlled host functions, with nondeterministic values journaled under the node's separate determinism contract;
- `WorkerSupervisor` consumes JetStream, owns process lifecycle, and may hold/present the proof-of-possession/mTLS-bound grant, but has no direct database, broker, or secret authority;
- `WorkerGateway` alone claims/commits database work, mints the grant, persists its hash/constraints, validates supervisor RPCs/fencing, and invokes trusted brokers;
- the sandbox communicates over a narrow local RPC with schema and size limits and receives only opaque capability handles—no NATS, database, grant, or secret access.

Sandbox reuse is permitted only for the same tenant, runtime profile, graph trust class, and cleared secret/data class. Before reuse, terminate processes, replace the writable layer, clear memory-backed volumes and language caches, rotate local channels, and issue a new capability. T3 is never reused across executions.

### 10.7.3 Network egress

Egress requires `(tool/plugin digest, tenant, environment, destination, protocol, port, data class)` policy. The proxy resolves DNS itself, pins validated addresses for the request, blocks private/link-local/metadata ranges unless explicitly internal, revalidates redirects, terminates TLS with normal certificate verification, enforces body limits, and logs only safe metadata. Generic HTTP nodes cannot smuggle arbitrary destinations through user-controlled proxies or headers.

## 10.8 Tenant isolation

### 10.8.1 Home-cell model

Each tenant/environment has one write-authoritative home cell. Cell placement incorporates residency and isolation tier. Cross-region services route to the home cell; they do not create multi-writer execution state. Enterprise tenants may receive dedicated databases, clusters, keys, worker pools, or entire cells.

### 10.8.2 Isolation by data plane

| Plane | Required isolation |
|---|---|
| PostgreSQL | `tenant_id NOT NULL` in every tenant row and composite key; RLS; transaction-local tenant context; separate owner/migration/runtime roles; no bypass role in app |
| Object storage | tenant/environment prefix derived server-side; scoped access point/credential; object encryption AAD; inventory/purge checks |
| JetStream | cell-internal subjects, no end-user or sandbox publish/subscribe; opaque IDs; trusted `WorkerSupervisor` consumes hints; per-pool accounts/permissions |
| Cache | tenant in binary key prefix; short TTL; no canonical authorization; cache miss on uncertainty; namespace epoch on deletion |
| Search/vector/graph | mandatory tenant/resource ACL filter produced by trusted service; post-filter verification; projection cursor tied to source authorization epoch |
| ClickHouse/telemetry | tenant-aware ingestion credential; row policy/query gateway; no user-selected tenancy header; result-cache key includes tenant/policy |
| Worker | `WorkerGateway` alone performs tenant-bound DB/effect operations and validates the supervisor-held PoP/mTLS-bound grant; supervisor has no direct DB/broker/secret route; one tenant per sandbox; no shared writable volume, NATS/DB client, grant, or secret |
| Backups | encrypted, region-bound, tenant deletion index, audited restore into isolated account/project |

Example PostgreSQL defense in depth:

```sql
ALTER TABLE execution ENABLE ROW LEVEL SECURITY;
ALTER TABLE execution FORCE ROW LEVEL SECURITY;

CREATE POLICY execution_tenant_policy ON execution
USING (tenant_id = current_setting('ege.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('ege.tenant_id', true)::uuid);

-- Transaction wrapper, never a pooled-session SET:
BEGIN;
SET LOCAL ege.tenant_id = '018f0000-0000-7000-8000-000000000001';
SET LOCAL ege.subject_id = '00u123';
SELECT ... FROM execution WHERE tenant_id = $1 AND execution_id = $2;
COMMIT;
```

Application queries still include the tenant predicate for index use and reviewability. RLS is the second control. Connection-pool tests prove `SET LOCAL` cannot leak across requests. Table owners and roles with `BYPASSRLS` are not used by services.

### 10.8.3 Tenant canaries

Every store contains synthetic canary records that should never be returned outside their tenant. Continuous probes attempt cross-tenant reads through APIs, exports, search, vector retrieval, graph traversal, caches, telemetry, and support tooling. A canary hit pages security and disables the implicated projection/query path.

## 10.9 Rate limits, quotas, and abuse controls

Limits are hierarchical and multi-dimensional:

```text
global safety ceiling
  -> cell/provider/dependency protection
    -> tenant subscription quota
      -> project/environment budget
        -> principal/API key rate
          -> execution graph bounds
            -> node attempt limits
```

| Limit | Algorithm/enforcement | Failure response |
|---|---|---|
| API requests | local token bucket + distributed tenant counter | `429`, `Retry-After`, no mutation |
| concurrent executions | durable admission reservation in PostgreSQL | queue or reject by plan |
| ready nodes/worker slots | weighted fair scheduler and pool budget | backpressure |
| graph expansion/loops | compiled maximum plus runtime monotonic counter | cancel with limit code |
| tokens/model calls/cost | pre-reservation plus streamed debit | stop/fallback only if policy permits |
| tool calls/effects | capability `max_calls` and durable usage counter | deny and audit |
| payload/state/checkpoint | edge/schema/sandbox/storage byte caps | reject before allocation |
| logs/traces | per-tenant byte/token bucket at collector | sample/drop diagnostics; preserve audit |
| expensive queries/exports | query complexity, rows/bytes/time, async export quota | cancel job |

Valkey/Redis may accelerate token buckets and fairness, but durable quotas and money limits reconcile to PostgreSQL. A cache outage never becomes unlimited access. Provider breakers protect dependencies, while tenant fairness prevents a single tenant from consuming all recovered capacity.

Limits return machine-readable `limit_id`, scope, current value where safe, reset/retry time, and remediation. They do not reveal another tenant's usage.

## 10.10 Input and output validation

### 10.10.1 Input path

1. Edge rejects invalid content type/encoding, decompression bombs, oversized headers/body, duplicate ambiguous fields, invalid Unicode, and unsupported schema versions.
2. JSON/YAML is parsed with depth, scalar, alias, collection, and total-size limits. YAML custom tags and object deserialization are disabled.
3. JSON Schema validates shape with `additionalProperties: false` for control contracts. Numeric ranges, regex complexity, URL/DNS/IP, identifiers, and enum values receive semantic validation.
4. Graph compiler checks port types, reachability, loop/expansion bounds, effect declarations, secret/tool/model bindings, data classifications, residency, and policy.
5. Untrusted text receives origin and trust labels; it is never interpolated into code, SQL, shell, policy, URLs, headers, or prompt control sections without a typed encoder/builder.
6. Files are type-sniffed, archive-bomb limited, malware scanned where required, normalized to inert internal forms, and isolated until scan verdict.

Parameterized database queries and typed HTTP/tool adapters are mandatory. Shell command construction from graph values is prohibited; a sandbox process API receives an executable digest and argument array.

### 10.10.2 Output path

1. Validate node output against the pinned schema before committing state.
2. Label output with source, classification, provenance, policy revision, and validation status.
3. For model output, parse structured data with a strict decoder; never execute partially parsed text.
4. Apply tenant DLP/content policy before external release, logs, model-provider forwarding, memory writes, or tool arguments.
5. Encode for the target sink (HTML, SQL parameter, URL component, header, CSV formula, shell argument prohibition). Validation is not output encoding.
6. Truncate only where the schema declares truncation semantics; otherwise fail rather than silently change meaning.
7. Store large/sensitive output as encrypted artifacts with capability-checked references.

## 10.11 Prompt-injection and AI-specific controls

Prompt injection is a confused-deputy problem: untrusted content attempts to make a model use authority held by the application. No classifier can prove content safe. The platform applies layered controls consistent with the risk classes catalogued by the OWASP LLM application project ([OWASP Top 10 for LLM applications](https://owasp.org/www-project-top-10-for-large-language-model-applications/)).

### 10.11.1 Trust-labelled context

Context fragments are represented as data:

```json
{
  "fragment_id": "0197f3c2-8500-7555-b7dd-ec4f00000013",
  "origin": {"type": "retrieved_document", "resource_id": "doc:731", "version": "sha256:9ea..."},
  "trust": "untrusted_external",
  "classification": "CONFIDENTIAL",
  "tenant_id": "0197f3c2-5000-7555-8066-75d890000005",
  "allowed_uses": ["summarize", "answer_with_citation"],
  "content_ref": "artifact://sha256:0bf...",
  "integrity": "sha256:0bf..."
}
```

The prompt compiler uses separate, typed sections for platform policy, developer instructions, tool specifications, trusted tenant instructions, retrieved evidence, and user input. It clearly delimits and quotes untrusted content, but delimiters are not considered a security boundary.

### 10.11.2 Required defenses

- retrieve only resources the principal/execution may access; apply ACL filters before ranking and verify after retrieval;
- minimize context and tools; a summarization node does not receive payment tools;
- forbid model-controlled tool names, endpoints, credentials, scopes, policy, approval, and maximum-call values;
- validate tool arguments, reauthorize at invocation, enforce egress and capability constraints outside the model;
- require approval for high-impact effects and bind it to the effect digest;
- treat tool output, webpages, documents, memory, and other agents' messages as untrusted unless provenance policy elevates them;
- scan for instruction-like attacks and secret-exfiltration patterns to add risk signals, not to grant authority;
- use canary secrets/tokens that have no value but alert on attempted exfiltration;
- prevent model output from writing durable memory unless a memory-write policy validates namespace, provenance, classification, TTL, and poisoning checks;
- cap recursive retrieval, agent messaging, tool loops, token usage, time, and cost;
- evaluate model/provider data-retention and training settings before routing classified data;
- test indirect injection, multilingual/encoded attacks, tool-response injection, data exfiltration, and memory poisoning in release gates.

### 10.11.3 Security-node anti-pattern

Adding an LLM “Security Node” after an LLM call does not secure the workflow. It may contribute a risk score, but deterministic schema, policy, authorization, egress, sandbox, approval, and output encoding controls remain authoritative.

## 10.12 Policy lifecycle and governance gates

```text
author policy -> lint/schema -> unit/property tests -> impact simulation
       -> security review -> sign bundle -> canary PDP/PEPs
       -> compare shadow decisions -> staged activation -> monitor -> promote
                                                        \-> rollback
```

Policy bundles are immutable, content-addressed, signed, and carry compatible input/output schema versions. A change report lists newly allowed/denied action-resource pairs using recent anonymized decision inputs. Widening production permissions requires security approval; emergency denies may use an expedited path with retrospective review.

Every runtime decision records its exact policy revision. PEPs keep the last known valid signed bundle for bounded availability. If no compatible valid bundle exists:

- public reads of non-sensitive metadata may follow an explicit fail-open rule;
- tenant data, secrets, deployments, model/tool calls, effects, replays, exports, and administrative actions fail closed;
- already-admitted computation with effect class `PURE` may finish within its separately declared determinism contract, but cannot cross a new governed boundary.

## 10.13 Compliance and privacy engineering

The architecture supports controls; it does not by itself confer certification. A control owner, test, evidence source, cadence, exception, and remediation SLA are assigned for each requirement.

| Concern | Platform implementation evidence |
|---|---|
| SOC 2 / ISO 27001-style access control | IdP/MFA configuration, role/policy revisions, access reviews, joiner/mover/leaver logs, break-glass tests |
| Change management | signed artifacts, protected CI, approvals, SBOM/provenance, deployment audit, rollback drill |
| Availability/DR | SLOs, backups, restore/failover evidence, capacity and incident records |
| GDPR/privacy | data inventory/classification, purpose/retention, DSR workflow, export/delete tombstones, processor/provider routing, residency |
| HIPAA-eligible mode | BAA-gated providers, dedicated configuration, PHI classification, minimum necessary access, audit/retention controls |
| PCI scope reduction | tokenized payment data, no card data in prompts/state/logs, isolated payment tool, network and access evidence |
| Data residency | home-cell placement, region-bound keys/storage/providers, cross-region policy denial and audited exceptions |

### 10.13.1 Data subject and tenant deletion

The data inventory maps a subject/tenant to canonical rows, objects, search/vector/graph projections, logs, model-provider artifacts, exports, and backups. Deletion:

1. authenticates and authorizes the request; applies legal-hold/contract policy;
2. writes an auditable deletion job and blocks new processing;
3. deletes/crypto-erases canonical online data and credentials;
4. emits tombstones with authorization epoch so projections/caches purge and cannot resurrect data;
5. verifies each projection and object inventory by count/digest;
6. records backup expiry behavior and prevents ordinary restoration into production;
7. produces a completion certificate without exposing deleted content.

Audit records retain the fact of deletion with minimal identifiers where lawful; they do not retain the deleted payload.

### 10.13.2 Support and operator access

Support access is just-in-time, ticket-bound, tenant-scoped, time-limited, approved where required, and visible to the tenant. Production database shell access is exceptional. Sensitive payload access requires a stronger separate grant than metadata diagnosis. Every query/export is audited; bulk access triggers anomaly detection.

## 10.14 Security telemetry and objectives

Required metrics include authentication failures, token replay/reuse, authorization decisions by result/action class, PDP latency/errors, stale policy age, secret resolution/denial, approval wait/expiry, egress denial, sandbox violations/termination, capability replay, cross-tenant canary attempts, DLP findings, audit pipeline lag, and key/certificate expiry.

Initial objectives:

| Objective | Target |
|---|---:|
| Governed actions with durable decision + actor/resource/outcome audit | 100% |
| Secret resolution with valid node-attempt capability | 100% |
| Capability lifetime | <= node deadline, normally <= 5 min |
| Critical identity/capability revocation propagation | p99 <= 60 s |
| Policy bundle rollback | <= 10 min |
| Critical credential rotation after confirmed exposure | begin <= 15 min; complete per credential runbook |
| Internet/API TLS and internal workload mTLS coverage | 100% for production paths |
| Cross-tenant isolation test suite | every build; continuous canaries in production |

These are control objectives, not a claim that compromise is impossible.

## 10.15 Incident runbooks

### 10.15.1 Suspected credential exposure

1. Identify credential ID/version, scope, destinations, last access, and dependent graph deployments without printing the value.
2. Disable/revoke the version and mint a replacement; if rotation would cause unsafe partial effects, stop affected admissions first.
3. Query audit/effect journals for use outside expected identities, regions, tools, and time.
4. Purge credential-bearing telemetry/artifacts if any, preserving legally required evidence in an isolated incident vault.
5. Redeploy/rebind affected workloads, verify old credential rejection, and notify affected tenants/providers under policy.

### 10.15.2 Sandbox escape signal

1. Cordon the worker node and stop new dispatch; do not run investigation tools inside the suspect sandbox.
2. Revoke its workload identity/capabilities and isolate network at the cell boundary.
3. Snapshot allowed forensic state, runtime logs, image digest, kernel/runtime versions, and audit trail.
4. Identify every tenant/node attempt on the host and rotate exposed credentials conservatively.
5. Rebuild nodes from trusted images; do not return the host to service through process restart alone.

### 10.15.3 Cross-tenant access indication

1. Disable the implicated API/projection/cache route; preserve canonical service for unaffected paths when safe.
2. Determine source tenant, target tenant, records/fields, actor, and exposure window from audit and query traces.
3. Invalidate sessions, capabilities, caches, and projection credentials as appropriate.
4. Verify canonical RLS/predicates and check whether the issue is read, write, inference, or metadata leakage.
5. Follow incident/breach notification, remediate, and add a two-tenant regression fixture and canary.

### 10.15.4 Policy distribution failure

1. Compare active bundle digest and schema compatibility across PDPs/PEPs.
2. Stop production governed actions if any PEP has no valid bundle; do not bypass the PDP.
3. Roll back to the last signed compatible bundle and increment policy/revocation epoch.
4. Rerun policy decision fixtures through the non-enforcing shadow evaluator and verify audit completeness before reopening.

## 10.16 Security verification program

- Threat-model every new node/tool/provider/plugin boundary and material graph IR change.
- Property-test authorization: explicit deny wins, tenant mismatch always denies, missing attribute denies, approval digest changes invalidate approval, expired/revoked/fenced grants fail.
- Run two-tenant tests for every repository, API, projection, export, subscription, cache, object path, and telemetry query.
- Fuzz all parsers and protocol boundaries, especially YAML/JSON, graph packages, plugin manifests, model structured output, webhooks, archive/file ingestion, and streaming frames.
- Test SSRF with redirects, DNS rebinding, IPv4/IPv6 variants, encoded addresses, metadata endpoints, proxy variables, and alternate schemes.
- Escape-test each sandbox/runtime version; verify limits under fork bombs, memory bombs, disk/inode exhaustion, log floods, and syscall probes.
- Build prompt-injection suites across direct, indirect, encoded, multilingual, retrieved, tool-output, cross-agent, and durable-memory attacks.
- Generate SBOM and signed provenance, scan dependencies/images/IaC/secrets, and enforce patch SLAs by exposure/risk.
- Restore encrypted backups into an isolated account and verify key, RLS, audit, deletion tombstone, and residency behavior.
- Commission independent penetration tests and tenant-isolation reviews before general availability and after boundary changes.

## 10.17 Anti-patterns

- **Frontend-only role checks:** hidden buttons do not authorize APIs.
- **One `admin` role:** destroys separation of duties and least privilege.
- **Role exceptions embedded in handlers:** create inconsistent, unauditable policy.
- **Tenant ID from request JSON or model output:** enables direct-object-reference attacks.
- **Service database role with `BYPASSRLS`:** removes the intended defense in depth.
- **Long-lived user JWT forwarded to workers:** grants excessive, replayable ambient authority.
- **Secrets in environment variables for arbitrary code:** leak through process inspection, crash dumps, child processes, and logs.
- **Allow-listing an HTTP node while letting the model choose the URL:** not an allow-list.
- **Container equals sandbox:** ordinary containers share a host kernel and are insufficient for adversarial code alone.
- **Network policy by DNS name only:** vulnerable to resolution/redirect/rebinding mistakes without an egress proxy.
- **Prompt injection detector as an authorization layer:** probabilistic classification cannot grant deterministic authority.
- **Retrieval ACL only after top-k:** can leak through ranking and omit authorized results.
- **Approval not bound to arguments/version:** permits post-approval substitution.
- **Fail-open when PDP/cache is unavailable:** converts an outage into privilege escalation.
- **Logging denied payloads for debugging:** turns defenses into an exfiltration store.
- **Claiming compliance from encryption and audit checkboxes:** ignores operating evidence, ownership, testing, and exceptions.
