# 15. Repository Structure

## 15.1 Repository strategy

Use one product monorepo for contracts, control-plane services, runtime libraries, workers, web applications, CLI, first-party SDKs, built-in plugins, infrastructure modules, tests, and documentation. Keep production environment desired state and secrets in separately permissioned GitOps and secret-management systems.

The monorepo is not permissionless. Path ownership, dependency direction, release boundaries, generated-code checks, and policy gates preserve service autonomy.

Core invariants:

1. Runtime state-machine and wire-contract changes are reviewed with all affected consumers in the same change or behind compatibility shims.
2. Services own their persistence schema and migrations. Cross-service database reads are forbidden; read models consume APIs or versioned events.
3. Generated artifacts are never edited. The source contract and generator version are recorded next to the generated output.
4. A package has one declared owner, public surface, dependency allowlist, test target, and release policy.
5. Applications depend inward on domain/contracts and outward through adapters. Domain crates never import databases, queues, HTTP frameworks, cloud SDKs, or UI code.
6. Infrastructure modules contain no production credentials or customer values. Environment repositories pin released charts/images by digest.

## 15.2 Top-level tree

```text
execution-graph-engineering/
├── .config/
│   ├── nextest.toml
│   ├── deny.toml
│   └── cargo-audit.toml
├── .devcontainer/
│   ├── devcontainer.json
│   └── Dockerfile
├── .github/
│   ├── CODEOWNERS
│   ├── dependabot.yml
│   ├── actions/                     # pinned composite actions owned by Developer Productivity
│   └── workflows/
│       ├── pr.yml
│       ├── contracts.yml
│       ├── security.yml
│       ├── release.yml
│       └── nightly-e2e.yml
├── apps/                             # user-facing deployable frontends only
├── services/                         # independently deployable control/data-plane services
├── runtime/                          # execution semantics and worker protocol implementations
├── workers/                          # deployable worker hosts and trusted adapters
├── packages/                         # non-deployable shared frontend/TypeScript packages
├── contracts/                        # cross-process source-of-truth contracts
├── sdks/                             # public language SDKs
├── cli/                              # ege command-line and debug adapter
├── plugins/                          # first-party/reference plugin packages
├── tests/                            # cross-component and system-level tests
├── infrastructure/                   # reusable cloud/Kubernetes modules
├── deployment/                       # versioned deployment packaging, not live secrets
├── examples/                         # compilable, tested, non-production examples
├── docs/                             # architecture, ADRs, operations, API and contributor docs
├── tools/                            # hermetic generators, linters and developer automation
├── third_party/                      # reviewed patches/licenses; no vendored mutable dependency trees
├── MODULE.bazel
├── BUILD.bazel
├── Cargo.toml
├── Cargo.lock
├── package.json
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── versions.lock                     # release-family policy and exact-pin readiness gate
├── buf.yaml
├── buf.gen.yaml
├── rust-toolchain.toml
├── mise.toml                         # developer tool versions; no secrets
├── justfile                          # thin discoverable command facade
├── LICENSE
├── SECURITY.md
├── CONTRIBUTING.md
└── README.md
```

`apps`, `services`, and `workers` are deployable. `runtime`, `packages`, and most of `contracts` are libraries. A reusable library cannot have an undeclared background process, database migration, network listener, or environment-variable dependency.

The root `versions.lock` is distinct from language dependency locks. It records supported runtime families, the exact tool/platform/image/chart digests required for a release, and evidence gates for SBOM, provenance, compatibility, restore, and rollback. Blueprint values may be unresolved only while `deployable: false`; release validation rejects every null/empty pin or floating tag before that flag can become true.

## 15.3 Web applications and shared packages

```text
apps/
├── workbench-web/
│   ├── src/
│   │   ├── app/                     # route shell, providers, authorization gates
│   │   ├── routes/                  # thin route composition only
│   │   ├── features/
│   │   │   ├── graph-editor/
│   │   │   ├── execution-inspector/
│   │   │   ├── projects/
│   │   │   ├── marketplace/
│   │   │   ├── plugins/
│   │   │   ├── knowledge/
│   │   │   ├── memory/
│   │   │   └── administration/
│   │   ├── adapters/                # generated-client to product-domain mapping
│   │   ├── workers/                 # browser Web Workers: validation/layout/search
│   │   ├── styles/
│   │   └── main.tsx
│   ├── public/
│   ├── tests/
│   │   ├── accessibility/
│   │   ├── component/
│   │   └── integration/
│   ├── vite.config.ts
│   └── package.json
├── developer-portal-web/
│   ├── src/
│   ├── tests/
│   └── package.json
├── docs-web/
│   ├── src/
│   ├── content.generated/           # ignored/generated from docs and contracts
│   └── package.json
└── status-web/                       # independently deployable minimal status surface
    └── ...

packages/
├── design-system/                    # accessible primitives, tokens, Storybook; no API calls
├── graph-editor/                     # canvas/outline projections and typed commands
├── graph-layout-worker/              # deterministic layout and spatial index
├── graph-ir-ts/                      # generated/common Graph IR types and validators
├── graph-expression/                 # parser, editor services, source spans
├── collaboration-client/             # Yjs gateway adapter, offline queue, receipts
├── execution-facts-client/           # gap-detecting resumable fact stream
├── api-client/                       # generated REST client; no product UI behavior
├── graph-api-client/                 # generated persisted query documents/types
├── auth-client/                      # OIDC/session and scope-switch lifecycle
├── telemetry-web/                    # redaction-aware browser telemetry
├── test-fixtures/                    # synthetic only; package forbids production-data imports
└── eslint-config/
```

Feature folders may import shared packages but not another feature's private components. Cross-feature behavior becomes either an app-level orchestration service or a deliberately reviewed shared package. `design-system` cannot know about graphs, executions, billing, or organization permissions.

## 15.4 Control-plane and gateway services

```text
services/
├── control-api/                      # Axum REST commands, request authn/z, idempotency
│   ├── src/{routes,commands,queries,adapters,main.rs}
│   ├── migrations/
│   └── tests/
├── graph-api/                        # bounded GraphQL read projections/persisted queries
├── collaboration-gateway/            # Yjs authorization, sequencing, snapshots, presence
├── graph-registry/                   # drafts, immutable graph versions, packages/templates
├── compiler-service/                 # remote compile/admission and diagnostics cache
├── deployment-controller/            # desired deployments, rollout and rollback orchestration
├── execution-coordinator/            # control-node transitions, readiness, checkpoints and outbox
├── worker-gateway/                    # sole worker claim/heartbeat/completion DB and effect authority
├── scheduler/                         # quotas, priorities, leases, capacity and fairness
├── artifact-service/                 # signed handle issuance, metadata, retention, scanning
├── secret-broker/                    # opaque grants and provider-side credential use
├── policy-service/                   # versioned policy evaluation and decision records
├── identity-service/                 # org/project identities and workload principals
├── model-gateway/                    # provider routing, token/cost accounting, safety policy
├── tool-gateway/                     # MCP/OpenAPI/tool invocation and schema enforcement
├── webhook-gateway/                  # public ingress, signatures, dedupe, persisted events
├── plugin-registry/                  # package metadata, install plans, compatibility/revocation
├── marketplace-service/              # catalog/search/reviews/publisher workflow
├── knowledge-service/                # sources, ingestion control and authorized retrieval
├── memory-service/                   # scoped versioned memory API and retention
├── telemetry-ingest/                 # OTLP intake, redaction, tenant routing and quotas
├── audit-service/                    # append-only audit query/export/verification
├── usage-meter/                      # normalized usage ledger and billing export
└── notification-service/             # approval, incident and product notifications
```

Every service follows one internal structure unless a narrower one is justified:

```text
service-name/
├── src/
│   ├── domain/                       # entities, value objects, domain errors; no framework imports
│   ├── application/                  # commands, queries, ports, transaction boundaries
│   ├── adapters/
│   │   ├── inbound/                  # HTTP/gRPC/message translation
│   │   └── outbound/                 # PostgreSQL, queue, object store, provider clients
│   ├── config.rs                     # typed validated config
│   ├── telemetry.rs
│   ├── lib.rs
│   └── main.rs
├── migrations/                       # only this service may write its schema
├── tests/
│   ├── contract/
│   ├── integration/
│   └── fixtures/                     # synthetic, schema-versioned
├── Dockerfile                        # distroless/non-root final image, digest-pinned base
├── BUILD.bazel
└── README.md                         # owner, SLO, APIs/events, stores, runbook links
```

A small service may flatten modules, but it cannot merge domain and transport errors or let route handlers own database transactions. Deployment does not imply a database-per-service; logical schemas or clusters may be shared operationally, while credentials and write ownership remain isolated.

## 15.5 Runtime libraries

```text
runtime/
├── graph-ir/                         # canonical semantic model and normalization
├── graph-compiler/                   # bind, type/effect/policy checks, plan lowering
├── executable-plan/                  # immutable plan format and version readers
├── expression-engine/                # restricted AST, type checker, deterministic evaluator
├── state-machine/                    # pure execution transition function
├── state-reducer/                    # execution facts -> read projections
├── event-store/                      # append/expected-sequence ports and PostgreSQL adapter
├── checkpoint/                       # snapshot/delta codecs and compatibility
├── scheduler-core/                   # ready-set, fairness and admission algorithms
├── lease-protocol/                   # epochs, heartbeat and fencing semantics
├── node-protocol/                    # invocation/result domain types; generated wire adapters
├── artifact-protocol/                # typed handles, digest and streaming helpers
├── capability-model/                 # grants, intersections and invocation tokens
├── error-taxonomy/                   # stable codes/categories and safe details
├── replay-engine/                    # operation/execution/effect-mode planning and validation
├── simulation/                       # virtual clock, deterministic scheduler, fault model
├── test-harness/                     # graph/node assertions and synthetic fixtures
└── telemetry-model/                  # registered events/instruments, no exporter coupling
```

`state-machine`, `graph-ir`, `expression-engine`, and `capability-model` are pure Rust crates: no async runtime, wall clock, randomness, global mutable state, filesystem, network, cloud SDK, or database driver. Callers provide facts, deterministic time/seed, and policies. This boundary makes exhaustive and property testing practical.

Dependency direction is enforced by build visibility and architecture tests:

```text
contracts/generated types
          |
      graph-ir ---- capability-model ---- error-taxonomy
          |                 |
    graph-compiler      state-machine <---- replay-engine
          |                 |
    executable-plan      application ports
                              |
                    service/worker adapters
```

`runtime/*` never imports `services/*`, `workers/*`, `apps/*`, or provider SDKs. A service may depend on runtime libraries; runtime code depends on traits and canonical types, not service implementations.

## 15.6 Workers and executors

```text
workers/
├── worker-agent/                     # JetStream hints, gateway RPCs, sandbox supervision; no DB authority
├── wasm-host/                        # Wasmtime Component Model capability host
├── container-host/                   # OCI/gVisor/Kata launcher and capability sidecar
├── remote-worker-gateway/            # mTLS protocol endpoint for enterprise workers
├── python-runner/                    # pinned Python code-node image/runtime adapter
├── javascript-runner/                # pinned V8/Node code-node image/runtime adapter
├── rust-runner/                      # native trusted workload runner
├── browser-runner/                   # separately isolated web automation, if enabled
└── adapters/
    ├── database/
    ├── http/
    ├── email/
    ├── event-queue/
    ├── vector-search/
    └── knowledge-graph/
```

`worker-agent` holds a short-lived gateway-issued lease/ExecutionGrant but does not own canonical lease state: it consumes non-authoritative hints, presents the proof-of-possession grant on WorkerGateway RPCs, supervises runners, and relays proposals. WorkerGateway alone claims, heartbeats, and commits worker results in PostgreSQL. Runners own language/process lifecycle. Trusted adapters own effect-specific idempotency/reconciliation behind WorkerGateway; sandboxes have no direct adapter route. No worker, runner, or adapter writes execution state tables.

First-party adapters use the same node protocol and contract tests as third-party plugins. Trusted deployment may use a lighter sandbox only when the definition is allowlisted; being stored under `workers/adapters` does not grant ambient authority.

## 15.7 Contracts and generated code

```text
contracts/
├── proto/
│   ├── ege/node/v1/node.proto
│   ├── ege/runtime/v1/execution.proto
│   ├── ege/runtime/v1/worker.proto
│   ├── ege/artifact/v1/artifact.proto
│   └── buf.lock
├── openapi/
│   ├── control-api.v1.yaml
│   └── developer-api.v1.yaml
├── graphql/
│   ├── schema.graphql
│   └── persisted-queries/
├── jsonschema/
│   ├── graph/v1/
│   ├── node-definition/v1/
│   ├── plugin-package/v1/
│   ├── execution-event/v1/
│   └── audit-event/v1/
├── events/
│   ├── catalog.yaml                  # owner, topic, key, retention, privacy, consumers
│   ├── asyncapi.yaml
│   └── compatibility-fixtures/
├── policy/
│   ├── capability-names.yaml
│   └── data-labels.yaml
├── generated/
│   ├── rust/
│   ├── typescript/
│   ├── python/
│   ├── go/
│   └── java/
└── tests/
    ├── wire-compatibility/
    ├── unknown-field-preservation/
    └── golden/
```

Protobuf is authoritative for worker and internal streaming protocols. OpenAPI is authoritative for REST. GraphQL SDL is authoritative for the read projection. JSON Schema is authoritative for authoring documents, configs, and JSON event projections. Duplicating an entity across formats requires a generator or an explicit mapping test; hand-maintained copies drift.

Contract changes run compatibility checks against the last supported releases and fixtures. Generated code is produced in a hermetic tool container, and CI fails on a dirty regeneration diff.

## 15.8 SDK and CLI layout

```text
sdks/
├── typescript/
│   ├── packages/{client,graph-builder,worker-sdk,test-harness}/
│   └── tests/
├── python/
│   ├── src/ege/{client,graph,worker,testing}/
│   └── tests/
├── rust/
│   ├── client/
│   ├── graph-builder/
│   ├── worker-sdk/
│   └── plugin-sdk/
├── go/
│   ├── client/
│   ├── worker/
│   └── testing/
├── java/
│   ├── client/
│   ├── graph-builder/
│   └── worker-sdk/
├── conformance/                      # language-neutral scenarios and expected wire traces
└── examples/                         # minimal per-language API examples

cli/
├── ege/                              # Rust command tree and generated API client adapter
├── debug-adapter/                    # DAP-to-coordinator bridge
├── local-daemon/                     # local control/runtime composition
├── ide/
│   ├── vscode/
│   └── jetbrains/
└── tests/
    ├── golden-output/
    ├── shell-integration/
    └── update-compatibility/
```

SDKs do not hand-implement HTTP models. They wrap generated clients with language-idiomatic builders, retries, cursor streams, tracing, and errors. Conformance scenarios must pass before an SDK is released. CLI human output may change within documented bounds; `--output json` schemas are versioned contracts.

## 15.9 Plugins

```text
plugins/
├── sdk/
│   ├── wit/                          # canonical Component Model ABI
│   ├── rust/
│   ├── typescript/
│   ├── python/
│   └── test-kit/
├── builtin/
│   ├── core-control/
│   ├── llm/
│   ├── retrieval/
│   ├── database/
│   ├── http/
│   ├── mcp/
│   └── observability/
├── reference/
│   ├── hello-wasm/
│   ├── remote-rust-worker/
│   └── schema-form-extension/
├── tooling/
│   ├── packager/
│   ├── signer/
│   ├── manifest-lint/
│   └── conformance-runner/
└── fixtures/
    ├── signed-good/
    ├── malformed/
    ├── malicious/
    └── compatibility/
```

Built-in plugins are packaged, pinned, and exercised through the public ABI. Platform-only primitives that must participate in coordinator transactions—Fork, Merge, Delay, approval suspension—live in runtime crates and expose built-in node definitions; they are not marketplace executors.

Malicious fixtures include zip bombs, path traversal, signature substitution, undeclared host calls, SSRF, output bombs, fork bombs, fuel exhaustion, poisoned SBOM/provenance, and UI XSS. They contain no live exploit credentials or external callback dependency.

## 15.10 Infrastructure and deployment

```text
infrastructure/
├── terraform/
│   ├── modules/
│   │   ├── network/
│   │   ├── kubernetes/
│   │   ├── postgres/
│   │   ├── redis/
│   │   ├── object-store/
│   │   ├── event-bus/
│   │   ├── observability/
│   │   ├── key-management/
│   │   └── workload-identity/
│   ├── tests/
│   └── examples/                     # synthetic values only
├── policies/
│   ├── terraform/
│   ├── kubernetes/
│   └── supply-chain/
├── images/
│   ├── base-rust/
│   ├── python-runner/
│   └── javascript-runner/
└── local/
    ├── kind/
    ├── compose/
    └── fixtures/

deployment/
├── helm/
│   ├── ege-control-plane/
│   ├── ege-runtime/
│   ├── ege-worker-pool/
│   └── ege-observability/
├── operators/
│   ├── deployment-controller-crds/
│   └── worker-pool-controller/
├── profiles/
│   ├── local/
│   ├── single-region/
│   └── multi-region/
├── migrations/
│   ├── orchestrator/
│   └── compatibility-matrix.yaml
└── smoke/
    ├── readiness/
    ├── execution/
    └── rollback/
```

Terraform modules create reusable infrastructure contracts. They do not embed organization accounts, production region names, DNS zones, tenant data, or credentials. Helm packages and image manifests are released from this repository. A restricted environment/GitOps repository selects versioned chart and image digests, supplies non-secret environment values, and references external secret-manager objects.

Database migrations remain under their owning service. `deployment/migrations/orchestrator` orders compatible service rollouts and verifies expand/migrate/contract gates; it does not centralize SQL.

## 15.11 Tests and quality assets

```text
tests/
├── architecture/                     # forbidden dependencies, ownership and public API checks
├── contract/
│   ├── api/
│   ├── events/
│   ├── worker-protocol/
│   └── plugins/
├── integration/
│   ├── postgres/
│   ├── event-bus/
│   ├── object-store/
│   ├── model-gateway/
│   └── tool-gateway/
├── e2e/
│   ├── author-publish-run-debug/
│   ├── replay-recovery/
│   ├── multi-tenant-isolation/
│   ├── plugin-install-revoke/
│   └── accessibility/
├── performance/
│   ├── scheduler/
│   ├── coordinator/
│   ├── graph-editor/
│   ├── artifact-streaming/
│   └── scenarios/
├── resilience/
│   ├── worker-loss/
│   ├── region-failover/
│   ├── queue-duplication/
│   └── dependency-degradation/
├── security/
│   ├── authorization-matrix/
│   ├── sandbox-escape-regressions/
│   ├── fuzz/
│   └── supply-chain/
├── simulation/
│   ├── models/
│   └── expected-invariants/
└── fixtures/
    ├── synthetic/
    ├── schema-versions/
    └── README.md
```

Component tests stay beside code. Root `tests` contains scenarios crossing ownership or deployment boundaries. Large generated/load artifacts are stored by digest in test object storage and referenced by small manifests; they are not committed to Git.

Fixture policy forbids copied production/customer data. Synthetic fixtures declare schema, generator version, seed, sensitivity classification, and owner. Golden updates require review from the owning domain.

## 15.12 Documentation, decisions, and examples

```text
docs/
├── architecture/
│   ├── context.md
│   ├── control-plane.md
│   ├── data-plane.md
│   └── trust-boundaries.md
├── chapters/                         # this implementation blueprint
├── adr/
│   ├── 0000-template.md
│   └── index.md
├── api/                              # explanatory guides; specs remain in contracts/
├── operations/
│   ├── runbooks/
│   ├── slo/
│   ├── capacity/
│   └── disaster-recovery/
├── security/
│   ├── threat-models/
│   ├── data-classification.md
│   └── plugin-review.md
├── development/
│   ├── setup.md
│   ├── testing.md
│   ├── releasing.md
│   └── compatibility.md
└── generated/                        # API/schema reference, rebuilt in CI

examples/
├── hello-graph/
├── retrieval-and-reranking/
├── human-approval/
├── durable-agent-loop/
├── dynamic-fanout/
├── plugin-custom-node/
├── remote-worker/
└── production-reference/
```

Every example pins dependencies, compiles in CI, runs deterministic graph tests, declares expected cost/permissions, and uses fake credentials/endpoints. `production-reference` demonstrates deployment shape but is not copied as an unreviewed production environment.

ADRs contain status, context, decision, alternatives, consequences, failure modes, compatibility/migration plan, security/operational impact, owners, and superseding ADR. A code change that contradicts an accepted ADR updates or supersedes it in the same review.

## 15.13 Developer tooling

```text
tools/
├── bootstrap/                        # checksum-verified toolchain setup
├── codegen/
│   ├── proto/
│   ├── openapi/
│   ├── graphql/
│   ├── jsonschema/
│   └── database/
├── lint/
│   ├── architecture/
│   ├── contracts/
│   ├── migrations/
│   └── docs/
├── build/
│   ├── sbom/
│   ├── provenance/
│   └── images/
├── release/
│   ├── version-plan/
│   ├── changelog/
│   └── publish/
└── dev/
    ├── seed-synthetic/
    ├── local-cert/
    └── doctor/
```

Tools are normal versioned build targets with tests and owners. CI never downloads an unpinned formatter or generator from a mutable URL. Repository scripts emit structured results for CI and concise human output; they do not parse colorful CLI prose.

## 15.14 Ownership boundaries

| Boundary | Primary owner | Required co-review | Writes/authority owned |
|---|---|---|---|
| `runtime/state-machine`, facts and checkpoint semantics | Runtime team | Reliability and contract owners | Transition function and execution semantic version |
| `runtime/graph-*`, expression and plan | Graph/compiler team | Runtime; Security for effects/capabilities | Graph IR normalization and compiler diagnostics |
| `services/execution-coordinator`, scheduler | Runtime services team | SRE for operational changes | Control-node transitions, scheduler-shard/control leases, readiness and coordinator read models |
| `services/worker-gateway` | Runtime services team | Security and SRE | Worker token claim/heartbeat/completion, attempt grants, worker-originated state/budget/effect commits |
| Public/control APIs and Graph API | Control-plane team | SDK/DX and Security | HTTP/Graph contract implementations and idempotency store |
| Web apps and `packages/*` | Product engineering | Design/accessibility; Security for payload/auth changes | Browser UX, editor projections and client cache lifecycle |
| CLI and SDKs | Developer experience | Contract owners and language maintainer | Public language surface, local daemon and DAP |
| Workers/adapters | Integrations/runtime workers | Security for capability/effect changes | Executor lifecycle and target-side idempotency/reconciliation |
| Plugins, registry, marketplace, tool registry | Ecosystem team | Security and contract owners | Package lifecycle, trust metadata and approved tool definitions |
| Identity, secret broker, policy, audit | Security platform | Service owner/SRE | Authorization and security evidence |
| Knowledge/memory/model gateway | AI/data platform | Security/privacy | Authorized projections, model routing, memory lifecycle |
| `contracts/*` | Named domain contract owner | Every registered consumer for breaking/behavior change | Source schemas and compatibility policy |
| Infrastructure modules and deployment packages | Platform/SRE | Security; service owner for runtime settings | Cloud/Kubernetes module and chart releases |
| Cross-system tests | Quality/reliability | Scenario component owners | Test harness and evidence contract |

Ownership is accountable review, not exclusive contribution. Each package `README.md` contains owner alias, Slack/on-call route, maturity, supported users, public API, SLO if deployable, dependencies, data classification, threat-model/runbook links, and deprecation policy.

### 15.14.1 CODEOWNERS excerpt

```text
/runtime/state-machine/              @ege/runtime @ege/reliability
/runtime/graph-ir/                   @ege/compiler @ege/runtime
/contracts/proto/ege/runtime/        @ege/runtime @ege/developer-experience
/contracts/policy/                   @ege/security-platform
/services/secret-broker/             @ege/security-platform @ege/sre
/services/execution-coordinator/     @ege/runtime-services @ege/sre
/apps/workbench-web/                 @ege/product-engineering
/packages/design-system/             @ege/design-systems @ege/accessibility
/plugins/sdk/                        @ege/ecosystem @ege/security-platform
/infrastructure/                     @ege/platform @ege/security-platform
/deployment/                         @ege/sre
/docs/adr/                           @ege/architecture
```

Git branch protection requires owners for sensitive paths, but CODEOWNERS alone is insufficient. CI calculates changed capability names, policy files, public schemas, migrations, egress, sandbox profiles, and release workflows and requires the corresponding review class.

## 15.15 Dependency enforcement

Build visibility and a repository architecture linter enforce:

```yaml
rules:
  - from: runtime/**
    deny: [services/**, workers/**, apps/**, infrastructure/**, deployment/**]
  - from: packages/design-system/**
    deny: [packages/api-client/**, packages/graph-ir-ts/**, apps/**]
  - from: services/*/src/domain/**
    denyCrates: [sqlx, tonic, axum, aws-sdk-*, redis, rdkafka]
  - from: services/A/**
    deny: [services/B/src/**]
    allow: [contracts/**, runtime/**]
  - from: apps/**
    deny: [services/**, infrastructure/**]
  - from: examples/**
    deny: [third_party/private/**]
```

Exceptions include owner, rationale, expiry, and removal issue. The linter fails on expired exceptions. Rust feature flags cannot invert layer direction or hide production behavior that tests do not exercise.

## 15.16 Build and test orchestration

Bazel is the hermetic CI/release graph and remote-cache interface, using Bzlmod, `rules_rust`, `rules_js`, OCI rules, and repository-owned toolchains. Cargo and pnpm remain fast language-native local workflows and canonical dependency declarations. Translation/lock targets are generated and CI checks they match:

```text
Cargo.toml + Cargo.lock --------> crate-universe lock ----+
package.json + pnpm-lock.yaml --> rules_js npm translate --+--> Bazel build graph
buf/openapi/jsonschema ---------> hermetic codegen --------+
```

Release artifacts come only from Bazel in a clean, pinned toolchain environment. This avoids accepting a local Cargo/pnpm artifact that was built with different flags while retaining IDE support and short developer loops.

PR pipeline stages:

1. ownership, generated-file, formatting, lint, secret/license and dependency checks;
2. contract compatibility, architecture rules, migrations and policy tests;
3. affected unit/component/contract tests with remote cache;
4. build signed candidate images/plugins/SDK packages without publishing;
5. risk-selected integration, E2E, accessibility, performance and resilience tests;
6. SBOM/provenance generation and policy evaluation.

Nightly runs full matrices, fuzzing, long simulations, disaster-recovery and multi-version compatibility. A flaky test is quarantined only with owner, issue, expiry and non-blocking visibility; security, isolation, contract, migration and state-machine invariant tests cannot be quarantined.

## 15.17 Versioning and release units

The monorepo does not imply one product version:

- services and workers publish independent OCI image versions/digests;
- runtime wire protocols and Graph IR use explicit major versions with multi-version readers;
- web applications release continuously against negotiated API ranges;
- CLI and each language SDK use independent semantic versions;
- plugins and node definitions follow Chapter 13 versioning;
- Helm charts declare a tested component compatibility matrix.

A release manifest pins the complete deployable set:

```yaml
apiVersion: releases.ege.dev/v1
kind: PlatformRelease
metadata: { version: 2026.08.06-1 }
spec:
  graphIr: ege.dev/v1
  nodeAbi: "1.3"
  images:
    controlApi: registry/ege/control-api@sha256:19ab...d301
    coordinator: registry/ege/coordinator@sha256:37cc...a812
    workerAgent: registry/ege/worker-agent@sha256:a951...12ff
  charts:
    controlPlane: { version: 4.8.0, digest: sha256:1ef3...d91b }
  migrations:
    compatibilityWindow: { from: 2026.07.24-2, to: 2026.08.20-1 }
```

Deployment systems consume the signed manifest by digest. They never assemble production from mutable image tags.

## 15.18 Local development

`just dev` invokes the CLI/local daemon for single-user work. `just stack-up` creates a namespaced kind stack with synthetic identity, PostgreSQL, Redis, object storage, event bus, telemetry, control services and one worker pool. Profiles let developers start only dependencies for the service under test.

Local bootstrap:

- verifies `mise.toml`/tool checksums and container runtime;
- creates certificates and credentials under ignored OS-protected paths;
- never reuses production endpoints or credentials;
- seeds only deterministic synthetic tenants/graphs/executions;
- prints exact ports, scope and cleanup command;
- supports `just stack-reset --project local-dev` with explicit target validation.

Service configuration uses typed files plus environment references for local delivery. Unknown settings fail startup. Configuration documentation is generated from the Rust/TypeScript schema and lists sensitivity, source, default, mutability and restart behavior.

## 15.19 Major decisions and trade-offs

| Decision | Why | Alternative | Trade-off and mitigation |
|---|---|---|---|
| Product monorepo | Atomic contract/consumer changes, common tooling and searchable ownership | Repository per service/SDK | Larger checkout and CI graph; affected-target builds, sparse workflows and remote cache control cost |
| Separate restricted GitOps environment repositories | Limit production mutation and keep tenant values/secrets out of product repo | Store live overlays beside code | Cross-repository release promotion; signed release manifests provide exact handoff |
| Hexagonal service internals and pure runtime core | Test semantics without infrastructure and prevent framework coupling | Shared service framework with active-record models | More adapters and explicit mapping; failures are localized and state machine remains model-checkable |
| Service-owned migrations | Clear write authority and deploy compatibility | Central database repository | Cross-service reporting needs events/read models; avoids invisible schema coupling |
| Contract source directories plus generated clients | Cross-language consistency | Hand-written DTOs in each consumer | Generator maintenance; CI regeneration and compatibility fixtures detect drift |
| Bazel for CI/release; native Cargo/pnpm locally | Hermetic multi-language artifacts with productive IDE loops | Bazel only or independent uncoordinated builds | Dual metadata risk; generated translation locks and release-only-from-Bazel prevent divergence |
| Built-ins exercise public plugin/node contract | Prevent first-party-only semantics and improve ecosystem quality | Special internal adapter API | Some overhead for core integrations; coordinator primitives remain explicitly internal |
| Independent release units | Deploy fixes and scale services separately | One monolithic platform version | Compatibility matrix and multi-version tests are mandatory; signed release manifest restores tested composition |

## 15.20 Patterns and anti-patterns

**Patterns:** package-level owners and public APIs; service-owned migrations; pure state transition crates; adapters at boundaries; generated clients; signed digest-pinned release manifest; affected tests plus nightly full matrices; architecture lint; synthetic seeded fixtures; contract compatibility windows; expiring dependency exceptions; runnable examples.

**Anti-patterns:** `common`, `utils`, or `shared` dumping grounds; service A importing service B internals; cross-service SQL; production values in Terraform examples; checked-in credentials; mutable image tags; editing generated code; downloading tools during CI without checksums; one global integration test suite with no owners; CODEOWNERS as the only sensitive-change gate; runtime libraries reading environment variables; a plugin loaded into a control-plane process; copying production payloads into fixtures.

## 15.21 Repository acceptance criteria

- A clean checkout with pinned tools can regenerate every contract/client and produces no diff; release artifacts are reproducible by digest within documented non-deterministic metadata rules.
- Architecture tests reject runtime-to-service/UI imports, domain-to-framework imports, service-internal cross-imports, and design-system business dependencies.
- Every deployable has owner, SLO, runbook, threat model, typed configuration schema, health probes, migration/rollback statement, SBOM and provenance.
- Every public contract change is checked against supported releases and registered consumers; breaking changes cannot merge as an unreviewed generated diff.
- No production secret/value or customer fixture exists in Git history or release artifacts; GitOps selects signed release manifests and external secret references.
- Killing one worker or plugin sandbox cannot write coordinator state directly, and no first- or third-party adapter bypasses the common node protocol.
- The folder tree covers frontend, backend services, runtime, workers, SDKs, CLI, infrastructure, deployment, tests, documentation, examples, and plugins with explicit ownership and dependency direction.
