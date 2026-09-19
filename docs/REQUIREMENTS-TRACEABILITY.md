# Requirements Traceability

This matrix maps every topic in the architecture brief to its normative implementation chapter. It is a coverage index, not a substitute for the linked design. Exact brief terminology is retained so automated validation can detect accidental omissions. Evidence links intentionally target stable chapter documents rather than fragile displayed subsection numbers; the required-topic column supplies the precise scope.

## 1. Platform Vision

| Required topic | Normative evidence |
|---|---|
| Graph Engineering; why execution graphs are replacing prompt engineering | [Chapter 1](chapters/01-platform-vision.md) |
| AI Builder Club concept baseline; Prompt Engineering; Context Engineering; Harness Engineering; Loop Engineering; Graph Engineering | [Chapter 1](chapters/01-platform-vision.md) |
| Loop-first graph right-sizing; intent map to approved executable plan | [Chapter 1](chapters/01-platform-vision.md) |
| Workflow; Execution Graph; State Machine; DAG; Knowledge Graph | [Chapter 1](chapters/01-platform-vision.md) |

## 2. Runtime Architecture

| Required topic | Normative evidence |
|---|---|
| Execution; Scheduler; State Machine; Execution Engine | [Chapter 2](chapters/02-runtime-architecture.md) |
| Checkpointing; Recovery; Persistence; Replay | [Chapter 2](chapters/02-runtime-architecture.md) |
| Retries; Timeouts; Cancellation; Dead Letter Queue | [Chapter 2](chapters/02-runtime-architecture.md) |
| Parallel Execution; Fan-Out; Fan-In; Conditional Branching; Loop Execution | [Chapter 2](chapters/02-runtime-architecture.md) |
| Subgraphs; Nested Graphs; Dynamic Graph Generation; Graph Expansion | [Chapter 2](chapters/02-runtime-architecture.md) and [Chapter 3](chapters/03-graph-model-and-state.md) |
| Distributed Execution; Multi-worker Scheduling | [Chapter 2](chapters/02-runtime-architecture.md) |
| Execution Tokens; Execution Context; Execution Metadata; Execution History | [Chapter 2](chapters/02-runtime-architecture.md) |

## 3. Graph Model

| Required topic | Normative evidence |
|---|---|
| Node; Edge; Port; Connector | [Chapter 3](chapters/03-graph-model-and-state.md) |
| Variable; Scope; Memory; Input; Output | [Chapter 3](chapters/03-graph-model-and-state.md) |
| Shared State; Execution State | [Chapter 3](chapters/03-graph-model-and-state.md) and [Chapter 5](chapters/05-shared-state.md) |
| Metadata; Tags; Labels; Version; Namespace | [Chapter 3](chapters/03-graph-model-and-state.md) |
| Reusable Components; Subgraph; Templates; Packages; Plugins | [Chapter 3](chapters/03-graph-model-and-state.md) and [Chapter 13](chapters/13-plugin-system.md) |

## 4. Node System

The shared inputs, outputs, configuration, execution lifecycle, validation, serialization, and error handling contract is defined in [Chapter 4](chapters/04-node-system.md).

| Required node family | Normative evidence |
|---|---|
| LLM Node; Prompt Node; Function Node | [Chapter 4](chapters/04-node-system.md) |
| Python Node; JavaScript Node; Rust Worker | [Chapter 4](chapters/04-node-system.md) |
| Database Node; REST API Node; Webhook Node; Email Node | [Chapter 4](chapters/04-node-system.md) |
| MCP Tool Node; Agent Node; Memory Node; Cache Node | [Chapter 4](chapters/04-node-system.md) |
| Human Approval Node; Delay Node; Timer Node | [Chapter 4](chapters/04-node-system.md) |
| Condition Node; Switch Node; Loop Node; Merge Node | [Chapter 4](chapters/04-node-system.md) |
| Fork Node; Parallel Node; Event Node; Queue Node | [Chapter 4](chapters/04-node-system.md) |
| Embedding Node; Retriever Node; Reranker Node; Vector Search Node | [Chapter 4](chapters/04-node-system.md) |
| Knowledge Graph Node; Validation Node; Security Node; Policy Node | [Chapter 4](chapters/04-node-system.md) |
| Logging Node; Metrics Node; Custom Plugin Node | [Chapter 4](chapters/04-node-system.md) |

## 5. Shared State

| Required topic | Normative evidence |
|---|---|
| Global State; Local State; Scoped Variables | [Chapter 5](chapters/05-shared-state.md) |
| Immutable Variables; Mutable Variables; Context | [Chapter 5](chapters/05-shared-state.md) |
| Execution Snapshot; Incremental Updates; State Versioning | [Chapter 5](chapters/05-shared-state.md) |
| Conflict Resolution; Synchronization; Streaming Updates | [Chapter 5](chapters/05-shared-state.md) |
| Memory Management; Serialization Strategy | [Chapter 5](chapters/05-shared-state.md) |

## 6. Execution Loops

| Required topic | Normative evidence |
|---|---|
| Retry Loops; Reflection Loops; Critic Loops; Self-improvement Loops | [Chapter 6](chapters/06-loop-engineering.md) |
| Planning Loops; Tool Loops; Repair Loops; Evaluation Loops | [Chapter 6](chapters/06-loop-engineering.md) |
| Stopping Conditions; Maximum Iterations; Cost Limits; Time Limits | [Chapter 6](chapters/06-loop-engineering.md) |
| Quality Thresholds; Confidence Thresholds | [Chapter 6](chapters/06-loop-engineering.md) |
| Loop Detection; Infinite Loop Prevention; Loop Metrics | [Chapter 6](chapters/06-loop-engineering.md) |

## 7. UI/UX

| Required surface | Normative evidence |
|---|---|
| Dashboard; Projects; Graphs; Executions; Templates; Marketplace; Plugins | [Chapter 7](chapters/07-product-ux.md) |
| Settings; Users; Organizations; Audit Logs; Secrets; Billing | [Chapter 7](chapters/07-product-ux.md) |
| Models; Knowledge; Memory; API Keys; Observability; Documentation; Developer Portal | [Chapter 7](chapters/07-product-ux.md) |
| Graph Editor: Drag-and-drop; Zoom; Mini Map; Multi-select; Alignment; Groups; Subgraphs; Comments | [Chapter 7](chapters/07-product-ux.md) |
| Live Collaboration; Keyboard Shortcuts; Auto Layout; Search; Graph Diff; History | [Chapter 7](chapters/07-product-ux.md) |
| Undo; Redo; Copy; Paste; Version Compare | [Chapter 7](chapters/07-product-ux.md) |
| Node Editor; Edge Editor | [Chapter 7](chapters/07-product-ux.md) |
| Execution Inspector; State Viewer; Log Viewer; Trace Viewer; Timeline | [Chapter 7](chapters/07-product-ux.md) |
| Profiler; Cost Viewer; Token Viewer; Latency Viewer | [Chapter 7](chapters/07-product-ux.md) |

## 8. Developer Experience

| Required topic | Normative evidence |
|---|---|
| CLI; SDK; REST API; Graph API | [Chapter 8](chapters/08-developer-experience.md) |
| Graph DSL; YAML Format; JSON Format; Code-first Graphs; Visual-first Graphs | [Chapter 8](chapters/08-developer-experience.md) |
| Live Debugging; Breakpoints; Step Execution; Replay | [Chapter 8](chapters/08-developer-experience.md) |
| Mock Execution; Local Runtime; Remote Runtime; Hot Reload | [Chapter 8](chapters/08-developer-experience.md) |
| Testing; Simulation; Unit Testing; Integration Testing; Graph Testing | [Chapter 8](chapters/08-developer-experience.md) |
| Golden Tests; Snapshot Tests | [Chapter 8](chapters/08-developer-experience.md) |

## 9. Observability

| Required topic | Normative evidence |
|---|---|
| Metrics; Tracing; Logging; OpenTelemetry; Prometheus; Grafana | [Chapter 9](chapters/09-observability.md) |
| Cost Tracking; Execution Timeline; Node Timeline; Heatmaps | [Chapter 9](chapters/09-observability.md) |
| Critical Path; Performance Bottlenecks; Failure Analysis | [Chapter 9](chapters/09-observability.md) |
| Replay; Audit Trail | [Chapter 9](chapters/09-observability.md) |

## 10. Security

| Required topic | Normative evidence |
|---|---|
| Authentication; Authorization; RBAC; ABAC | [Chapter 10](chapters/10-security-governance.md) |
| Secret Management; Encryption | [Chapter 10](chapters/10-security-governance.md) |
| Execution Isolation; Sandboxing; Rate Limits | [Chapter 10](chapters/10-security-governance.md) |
| Input Validation; Output Validation; Policy Enforcement | [Chapter 10](chapters/10-security-governance.md) |
| Prompt Injection Protection; Tool Permission System | [Chapter 10](chapters/10-security-governance.md) |
| Tenant Isolation; Compliance | [Chapter 10](chapters/10-security-governance.md) |

## 11. Scalability

| Required topic | Normative evidence |
|---|---|
| 1 million graphs; 100 million executions | [Chapter 11](chapters/11-scalability-reliability.md) |
| Horizontal Scaling; Distributed Workers; Queue System; Scheduling | [Chapter 11](chapters/11-scalability-reliability.md) |
| Backpressure; Caching; Load Balancing; Autoscaling | [Chapter 11](chapters/11-scalability-reliability.md) |
| Geo Distribution; High Availability; Disaster Recovery | [Chapter 11](chapters/11-scalability-reliability.md) |

## 12. AI Features

| Required topic | Normative evidence |
|---|---|
| Multi-model Routing; Model Selection; Model Fallback | [Chapter 12](chapters/12-ai-intelligence.md) |
| Prompt Versioning; Prompt Registry | [Chapter 12](chapters/12-ai-intelligence.md) |
| Context Compression; Memory Management | [Chapter 12](chapters/12-ai-intelligence.md) |
| Embedding Pipelines; Retrieval Pipelines | [Chapter 12](chapters/12-ai-intelligence.md) |
| Agent Collaboration; Agent Swarms | [Chapter 12](chapters/12-ai-intelligence.md) |
| Tool Calling; Structured Output | [Chapter 12](chapters/12-ai-intelligence.md) |
| Reflection; Self Critique; Planning; Reasoning; Evaluation | [Chapter 12](chapters/12-ai-intelligence.md) |
| Graph Optimization; Automatic Node Suggestions; Automatic Graph Generation | [Chapter 12](chapters/12-ai-intelligence.md) |
| Automatic Graph Refactoring; Automatic Performance Optimization | [Chapter 12](chapters/12-ai-intelligence.md) |

## 13. Plugin System

| Required topic | Normative evidence |
|---|---|
| Plugin SDK; Plugin Marketplace; Custom Nodes; Tool Registry | [Chapter 13](chapters/13-plugin-system.md) |
| Local Agent Skills discovery; progressive disclosure; digest pinning; capability separation | [Chapter 13](chapters/13-plugin-system.md) |
| Version Compatibility; Dependency Management | [Chapter 13](chapters/13-plugin-system.md) |
| Sandboxing; Signing; Permissions; Distribution | [Chapter 13](chapters/13-plugin-system.md) |

## 14. Data Model

| Required artifact | Normative evidence |
|---|---|
| ER Diagram | [Chapter 14](chapters/14-data-model.md) |
| Runtime Schema; Execution Schema | [Chapter 14](chapters/14-data-model.md) |
| Graph Schema; Node Schema; Edge Schema | [Chapter 14](chapters/14-data-model.md) |
| State Schema; Checkpoint Schema | [Chapter 14](chapters/14-data-model.md) |
| Log Schema; Metrics Schema; Audit Schema | [Chapter 14](chapters/14-data-model.md) |
| Version Schema | [Chapter 14](chapters/14-data-model.md) |

## 15. Folder Structure

| Required area | Normative evidence |
|---|---|
| Frontend; Backend; Workers; SDK; CLI | [Chapter 15](chapters/15-repository-structure.md) |
| Infrastructure; Deployment; Testing; Documentation | [Chapter 15](chapters/15-repository-structure.md) |
| Examples; Plugins; Runtime | [Chapter 15](chapters/15-repository-structure.md) |

## 16. Technology Stack

| Required layer | Normative evidence |
|---|---|
| Frontend; Backend; Execution Runtime | [Chapter 16](chapters/16-technology-stack.md) |
| Queue; Messaging; Streaming | [Chapter 16](chapters/16-technology-stack.md) |
| Database; Cache; Object Storage | [Chapter 16](chapters/16-technology-stack.md) |
| Graph Storage; Vector Storage; Search | [Chapter 16](chapters/16-technology-stack.md) |
| Monitoring; Tracing | [Chapter 16](chapters/16-technology-stack.md) |
| Authentication; Secrets | [Chapter 16](chapters/16-technology-stack.md) |
| Deployment; Container Runtime; Kubernetes; CI/CD | [Chapter 16](chapters/16-technology-stack.md) |

## 17. Engineering Decisions

Every major decision records **why this approach was chosen**, **alternatives**, **trade-offs**, **performance implications**, **scalability implications**, **failure modes**, and **operational complexity** in [Chapter 17](chapters/17-engineering-decisions.md). Detailed local decisions also appear in each chapter.

Chapter 17 explicitly identifies reusable design patterns, anti-patterns, best practices, and production recommendations.

## Required Artifact Forms

| Required form | Normative evidence |
|---|---|
| Architecture Diagrams; Component Diagrams; Data Flow Diagrams | [Architecture entry](ARCHITECTURE.md) and Chapters 2, 9, 10, 11, and 16 |
| Sequence Diagrams; State Diagrams; Runtime Flow Diagrams | [Architecture entry](ARCHITECTURE.md), [Chapter 2](chapters/02-runtime-architecture.md), and [Chapter 5](chapters/05-shared-state.md) |
| Folder Structures | [Chapter 15](chapters/15-repository-structure.md) |
| API Examples | [Chapter 8](chapters/08-developer-experience.md) and [OpenAPI contract](contracts/control-plane.openapi.yaml) |
| JSON Schemas; YAML Examples | Chapters 3–8, 12–14 and [GraphSpec contract](contracts/graph-spec.schema.json) |
| Database Schemas | [Chapter 14](chapters/14-data-model.md) |
| Event Schemas | Chapters 2, 9, 14 and [AsyncAPI contract](contracts/execution-events.asyncapi.yaml) |
| Pseudocode | Chapters 2, 3, 5, 6, 11, 12, and 14 |
| Design Patterns; Anti-patterns; Best Practices; Production Recommendations | All implementation chapters and [Chapter 17](chapters/17-engineering-decisions.md) |

## Traceability acceptance rule

A topic is complete only when the linked chapter provides operational semantics, validation, failure behavior, and trade-offs where applicable. Presence in this matrix alone does not satisfy the requirement. The repository validator checks exact-term presence, file/link integrity, JSON syntax, and fence balance; human architecture review remains mandatory.
