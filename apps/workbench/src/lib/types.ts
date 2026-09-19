export type TopicKind = string;

export type NodeRunStatus = 'draft' | 'queued' | 'running' | 'completed' | 'failed' | 'paused' | 'partial' | 'blocked' | 'cancelled' | 'not_run';

export interface TopicNode {
  proposalSource?: { planId: string; planHash: string; proposalNodeId: string; sourceIntentNodeIds: string[]; sourceEvidenceIds: string[] };
  [key: string]: unknown;
  id: string;
  kind: TopicKind;
  title: string;
  objective: string;
  context: string;
  status: NodeRunStatus;
  position: { x: number; y: number };
  agentId?: string;
  providerId?: string;
  model?: string;
  skills?: string[];
  inputs?: string[];
  outputs?: string[];
  acceptanceCriteria?: string[];
  budgets?: { timeoutMs?: number; maxAttempts?: number };
  review?: { reviewerNodeIds: string[]; required: boolean; providerId?: 'openai-api' | 'anthropic-api' | 'ollama' };
  breakpoint?: boolean;
  group?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  rationale?: string;
  type?: string;
  label?: string;
  proposed?: boolean;
}

export type GraphLifecycle =
  | 'draft'
  | 'planning'
  | 'awaiting_approval'
  | 'approved'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed';

export interface EngineeringGraph {
  id: string;
  name: string;
  workspacePath?: string;
  nodes: TopicNode[];
  edges: GraphEdge[];
  status: GraphLifecycle;
  activePlanId?: string;
  activeExecutionId?: string;
  draftRevision?: number;
  updatedAt?: string;
}

export interface PlanSourceIntentSnapshot {
  id: string;
  title: string;
  objective: string;
  context?: string;
}

export interface PlanWorkItem {
  id: string;
  nodeId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  sourceIntents?: PlanSourceIntentSnapshot[];
}

export interface PlanDiff {
  summary: string;
  added: string[];
  changed: string[];
  removed: string[];
}

export interface ProposalTraceability {
  intentNodeIds: string[];
  evidenceIds: string[];
}

export interface ProposedGraphPort {
  id: string;
  type: string;
  required: boolean;
  provenanceRequired?: boolean;
}

export interface ProposedSpecialistNode {
  id: string;
  type: string;
  domain: string;
  title: string;
  objective: string;
  agentId: string;
  promptDigest: string;
  agentAssignment?: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  inputs: ProposedGraphPort[];
  outputs: ProposedGraphPort[];
  traceability: ProposalTraceability;
  budget?: Record<string, number>;
  stop?: Record<string, unknown>;
}

export interface ProposedRelationship {
  id: string;
  type: string;
  source: string;
  target: string;
  rationale: string;
  traceability: ProposalTraceability;
}

export interface ProposedGraph {
  proposalId: string;
  schemaVersion: string;
  status: string;
  compilerVersion: string;
  contentDigest: string;
  selectedDomains: string[];
  nodes: ProposedSpecialistNode[];
  relationships: ProposedRelationship[];
}

export interface PlanResearchPolicy {
  enabled: boolean;
  provider?: string;
  tool?: string;
  mode?: string;
  digest?: string;
}

export interface PlanVersion {
  engineeringProfile?: 'poc' | 'mvp' | 'production';
  engineeringConventions?: string;
  id: string;
  graphId: string;
  version: number;
  provider: string;
  status: 'proposed' | 'approved' | 'superseded';
  contentHash: string;
  summary: string;
  proposedEdges: GraphEdge[];
  workItems: PlanWorkItem[];
  proposedGraph?: ProposedGraph;
  previousPlanId?: string;
  baseDraftRevision?: number;
  researchPolicy?: PlanResearchPolicy;
  diff?: PlanDiff;
  createdAt?: string;
  rawDocument?: unknown;
}

export interface ExecutionRun {
  id: string;
  graphId: string;
  planId: string;
  pendingPlanId?: string;
  status: 'queued' | 'running' | 'pause_requested' | 'paused' | 'completed' | 'failed' | 'stopped' | 'superseded' | 'cancel_requested' | 'cancelled';
  parentExecutionId?: string;
  resumedFromCheckpoint?: string;
  checkpoint?: string;
  selectedNodeIds?: string[] | null;
  completedNodeIds?: string[];
  currentNodeId?: string | null;
  startedAt?: string;
  finishedAt?: string;
}

export interface ExecutionEvent {
  id: string;
  cursor: string;
  executionId?: string;
  nodeId?: string;
  type: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp: string;
  artifactId?: string;
  data?: Record<string, unknown>;
}

export type TraceKind = 'PLAN' | 'EXECUTION';
export type TraceStatus = 'RUNNING' | 'OK' | 'ERROR' | 'CANCELLED';
export type TraceOperationKind =
  | 'GRAPH'
  | 'PLANNER'
  | 'MODEL'
  | 'AGENT'
  | 'NODE'
  | 'TOOL'
  | 'COMMAND'
  | 'VERIFIER'
  | 'ARTIFACT'
  | 'CHECKPOINT';
export type OpenTelemetrySpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';

export interface TraceRecord {
  id: string;
  traceId: string;
  graphId: string;
  executionId?: string;
  planId?: string;
  kind: TraceKind;
  name: string;
  status: TraceStatus;
  rootSpanId?: string;
  provider?: string;
  model?: string;
  attributes: Record<string, unknown>;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
}

export interface TraceSpan {
  id: string;
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  executionId?: string;
  planId?: string;
  nodeId?: string;
  stepId?: string;
  agentId?: string;
  name: string;
  /** Application operation category. This is not the OpenTelemetry SpanKind enum. */
  kind: TraceOperationKind;
  category: TraceOperationKind;
  spanKind: OpenTelemetrySpanKind;
  status: TraceStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attributes: Record<string, unknown>;
  input?: unknown;
  output?: unknown;
}

export interface TraceEvent {
  sequence: number;
  id: string;
  traceId: string;
  spanId?: string;
  executionId?: string;
  type: string;
  attributes: Record<string, unknown>;
  createdAt: string;
  timestamp: string;
}

export interface TraceStreamEvent {
  id: string;
  cursor: string;
  traceId?: string;
  spanId?: string;
  executionId?: string;
  planId?: string;
  nodeId?: string;
  type: 'trace.started' | 'span.started' | 'span.event' | 'span.ended' | 'trace.ended' | string;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface TraceListPage {
  limit: number;
  hasMore: boolean;
  nextBefore?: string;
}

export interface TraceEventPage {
  after: number;
  nextAfter: number;
  hasMore: boolean;
  limit: number;
}

export interface TraceDetail {
  trace: TraceRecord;
  spans: TraceSpan[];
  events: TraceEvent[];
  eventPage: TraceEventPage;
}

export interface Artifact {
  id: string;
  executionId: string;
  nodeId?: string;
  name: string;
  language?: string;
  content: string;
  path?: string;
  kind: 'code' | 'diff' | 'log' | 'report';
  createdAt?: string;
}

export interface ProviderStatus {
  id: string;
  name: string;
  available: boolean;
  configured?: boolean;
  ready?: boolean;
  connectionVerified?: boolean;
  executionEnabled?: boolean;
  workspaceWriteRequested?: boolean;
  kind?: string;
  capabilities?: string[];
  detail?: string;
  detected?: boolean;
  profile?: ProviderProfile;
  connection?: ProviderConnection;
}

export interface ProviderProfile {
  id: string;
  label: string;
  kind: string;
  model?: string;
  baseUrl?: string;
  enabled: boolean;
  secretEnvName?: string;
  updatedAt?: string;
}

export type ProviderConnectionKind = 'hosted' | 'local' | 'cli';
export type ProviderConnectionStatus = 'NOT_CHECKED' | 'DISCOVERED' | 'CONNECTED' | 'DISCONNECTED';

export interface ProviderConnection {
  kind: ProviderConnectionKind;
  providerId: string;
  status: ProviderConnectionStatus;
  verified: boolean;
  secretStorage: 'SESSION_ONLY' | 'NONE';
  selectedModel: string | null;
  baseUrl: string | null;
  capabilities: string[];
  detail: string;
}

export interface ProviderModel {
  id: string;
  label: string;
  source: 'provider' | 'installed';
  recommended: boolean;
}

export interface ProviderConnectionResult {
  connection: ProviderConnection;
  models: ProviderModel[];
  provider?: ProviderStatus;
}

export type DiscoverProviderConnectionInput =
  | { kind: 'hosted'; providerId: 'openai-api' | 'anthropic-api'; apiKey: string }
  | { kind: 'local'; providerId: 'ollama'; baseUrl: string }
  | { kind: 'cli'; providerId: 'codex-cli' | 'claude-cli' };

export type ConnectProviderConnectionInput =
  | { kind: 'hosted'; providerId: 'openai-api' | 'anthropic-api'; model: string }
  | { kind: 'local'; providerId: 'ollama'; baseUrl: string; model: string }
  | { kind: 'cli'; providerId: 'codex-cli' | 'claude-cli' };

export interface SourceRecord {
  id: string;
  graphId: string;
  nodeId?: string;
  filename: string;
  mediaType: string;
  byteSize: number;
  sha256: string;
  parseStatus: 'PARSED' | 'OPAQUE' | 'FAILED';
  parserId: string;
  parserVersion: string;
  chunkCount: number;
  format?: string;
  errors?: Array<{ code?: string; message: string }>;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface EvidenceCitation {
  sourceId?: string;
  filename?: string;
  digest?: string;
  locator: Record<string, unknown>;
}

export interface RetrievalHit {
  sourceId: string;
  chunkId: string;
  filename: string;
  nodeId?: string;
  text: string;
  location: Record<string, unknown>;
  score: number;
  rank: number;
  rankSignals: Record<string, number>;
  citations: EvidenceCitation[];
}

export interface EngineeringDomain {
  id: string;
  name: string;
  purpose: string;
}

export interface AgentPromptRevision {
  id?: string;
  agentId: string;
  version: number;
  prompt: string;
  digest: string;
  parentDigest?: string;
  createdAt?: string;
}

export interface EngineeringAgent {
  id: string;
  slug: string;
  name: string;
  domain: string;
  description: string;
  capabilities: string[];
  toolPolicy: Record<string, unknown>;
  status: 'ACTIVE' | 'DISABLED';
  currentPrompt: AgentPromptRevision;
}

export interface ResearchPolicyRequest {
  enabled: boolean;
}

export interface CreatePlanInput {
  engineeringProfile?: 'poc' | 'mvp' | 'production';
  conventions?: string;
  provider: string;
  additionalContext?: string;
  previousPlanId?: string;
  pausedExecutionId?: string;
  checkpoint?: string;
  research?: ResearchPolicyRequest;
}

export interface StartExecutionInput {
  nodeIds?: string[];
  planId: string;
  expectedPlanHash: string;
  provider: string;
  parentExecutionId?: string;
  resumedFromCheckpoint?: string;
}

export interface GraphBundle {
  graph: EngineeringGraph;
  plans: PlanVersion[];
  executions: ExecutionRun[];
}
