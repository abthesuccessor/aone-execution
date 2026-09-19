import type {
  Artifact,
  EngineeringAgent,
  EngineeringDomain,
  CreatePlanInput,
  EngineeringGraph,
  ExecutionRun,
  ExecutionEvent,
  GraphBundle,
  PlanSourceIntentSnapshot,
  PlanVersion,
  ProposedGraph,
  ProviderStatus,
  ProviderProfile,
  ProviderConnection,
  ProviderConnectionResult,
  ProviderModel,
  DiscoverProviderConnectionInput,
  ConnectProviderConnectionInput,
  RetrievalHit,
  SourceRecord,
  StartExecutionInput,
  TraceDetail,
  TraceEvent,
  TraceListPage,
  TraceRecord,
  TraceSpan,
} from './types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
let apiOrigin = '';

export function configureApiOrigin(origin = ''): void {
  if (!origin) {
    apiOrigin = '';
    return;
  }
  const parsed = new URL(origin);
  if (
    parsed.protocol !== 'http:'
    || parsed.hostname !== '127.0.0.1'
    || !parsed.port
    || parsed.pathname !== '/'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error('The desktop API must use an ephemeral 127.0.0.1 origin.');
  }
  apiOrigin = parsed.origin;
}

export function apiUrl(path: string): string {
  return `${apiOrigin}${path}`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const response = await fetch(apiUrl(path), {
    ...init,
    headers,
    credentials: apiOrigin ? 'omit' : 'same-origin',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined) as {
      error?: string | { code?: string; message?: string; details?: unknown };
      message?: string;
    } | undefined;
    const message = typeof payload?.error === 'string' ? payload.error : payload?.error?.message ?? payload?.message;
    const code = typeof payload?.error === 'object' ? payload.error.code : undefined;
    const details = typeof payload?.error === 'object' ? payload.error.details : undefined;
    throw new ApiError(message ?? `Request failed with ${response.status}`, response.status, code, details);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function unwrapList<T>(value: unknown, keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') {
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (Array.isArray(candidate)) return candidate as T[];
    }
  }
  return [];
}

function unwrapObject<T>(value: unknown, keys: string[]): T {
  if (value && typeof value === 'object') {
    for (const key of keys) {
      const candidate = (value as Record<string, unknown>)[key];
      if (candidate && typeof candidate === 'object') return candidate as T;
    }
  }
  return value as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function normalizeRankSignals(value: unknown): Record<string, number> {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map((item, index) => {
      const signal = asRecord(item);
      return [
        String(signal.ranker ?? signal.name ?? `ranker-${index + 1}`),
        Number(signal.sourceScore ?? signal.score ?? signal.rrfContribution ?? 0),
      ];
    }));
  }
  return Object.fromEntries(Object.entries(asRecord(value)).map(([key, score]) => [key, Number(score)]));
}

function normalizeProposedGraph(raw: unknown): ProposedGraph | undefined {
  const proposal = asRecord(raw);
  const rawNodes = Array.isArray(proposal.nodes) ? proposal.nodes : [];
  if (rawNodes.length === 0) return undefined;
  const traceability = (value: unknown) => {
    const trace = asRecord(value);
    return {
      intentNodeIds: strings(trace.intentNodeIds),
      evidenceIds: strings(trace.evidenceIds),
    };
  };
  const ports = (value: unknown) => (Array.isArray(value) ? value : []).map((item, index) => {
    const port = asRecord(item);
    return {
      id: String(port.id ?? `port-${index}`),
      type: String(port.type ?? 'artifact'),
      required: port.required === undefined ? true : Boolean(port.required),
      provenanceRequired: port.provenanceRequired === undefined ? undefined : Boolean(port.provenanceRequired),
    };
  });
  return {
    proposalId: String(proposal.proposalId ?? proposal.id ?? ''),
    schemaVersion: String(proposal.schemaVersion ?? 'intent-proposed-graph/v1'),
    status: String(proposal.status ?? 'PROPOSED'),
    compilerVersion: String(proposal.compilerVersion ?? ''),
    contentDigest: String(proposal.contentDigest ?? proposal.digest ?? ''),
    selectedDomains: strings(proposal.selectedDomains),
    nodes: rawNodes.map((value, index) => {
      const node = asRecord(value);
      return {
        id: String(node.id ?? `specialist-${index}`),
        type: String(node.type ?? 'SPECIALIST_AGENT'),
        domain: String(node.domain ?? 'engineering'),
        title: String(node.title ?? `Specialist ${index + 1}`),
        objective: String(node.objective ?? node.description ?? ''),
        agentId: String(node.agentId ?? ''),
        promptDigest: String(node.promptDigest ?? ''),
        agentAssignment: node.agentAssignment ? String(node.agentAssignment) : undefined,
        dependsOn: strings(node.dependsOn ?? node.dependencies),
        acceptanceCriteria: strings(node.acceptanceCriteria),
        inputs: ports(node.inputs),
        outputs: ports(node.outputs),
        traceability: traceability(node.traceability),
        budget: Object.fromEntries(Object.entries(asRecord(node.budget)).map(([key, amount]) => [key, Number(amount)])),
        stop: asRecord(node.stop),
      };
    }),
    relationships: (Array.isArray(proposal.relationships) ? proposal.relationships : []).map((value, index) => {
      const relationship = asRecord(value);
      return {
        id: String(relationship.id ?? `proposal-relationship-${index}`),
        type: String(relationship.type ?? relationship.label ?? 'RELATED_TO'),
        source: String(relationship.from ?? relationship.source ?? ''),
        target: String(relationship.to ?? relationship.target ?? ''),
        rationale: String(relationship.rationale ?? relationship.reason ?? relationship.label ?? ''),
        traceability: traceability(relationship.traceability),
      };
    }),
  };
}

function normalizeGraph(raw: unknown, draftValue?: unknown): EngineeringGraph {
  const graph = asRecord(raw);
  const draft = asRecord(draftValue ?? graph.draft);
  const rawNodes = Array.isArray(draft.nodes) ? draft.nodes : Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawEdges = Array.isArray(draft.edges) ? draft.edges : Array.isArray(graph.edges) ? graph.edges : [];
  return {
    ...(graph as unknown as EngineeringGraph),
    id: String(graph.id ?? ''),
    name: String(graph.name ?? 'Untitled workspace'),
    status: String(graph.status ?? 'draft').toLowerCase() as EngineeringGraph['status'],
    draftRevision: draft.revision === undefined ? Number(graph.draftRevision ?? 0) : Number(draft.revision),
    nodes: rawNodes.map((value, index) => {
      const node = asRecord(value);
      const position = asRecord(node.position);
      const x = Number(position.x);
      const y = Number(position.y);
      return {
        id: String(node.id),
        kind: String(node.kind ?? 'custom') as EngineeringGraph['nodes'][number]['kind'],
        title: String(node.title ?? `Topic ${index + 1}`),
        objective: String(node.objective ?? node.description ?? ''),
        context: String(node.context ?? ''),
        ...(node.proposalSource && typeof node.proposalSource === 'object' ? { proposalSource: node.proposalSource as EngineeringGraph['nodes'][number]['proposalSource'] } : {}),
        agentId: node.agentId ? String(node.agentId) : undefined,
        providerId: node.providerId ? String(node.providerId) : undefined,
        model: node.model ? String(node.model) : undefined,
        skills: strings(node.skills), inputs: strings(node.inputs), outputs: strings(node.outputs),
        acceptanceCriteria: strings(node.acceptanceCriteria),
        budgets: node.budgets ? asRecord(node.budgets) : undefined,
        review: node.review ? { required: Boolean(asRecord(node.review).required), reviewerNodeIds: strings(asRecord(node.review).reviewerNodeIds), ...(['openai-api', 'anthropic-api', 'ollama'].includes(String(asRecord(node.review).providerId)) ? { providerId: String(asRecord(node.review).providerId) as NonNullable<EngineeringGraph['nodes'][number]['review']>['providerId'] } : {}) } : undefined,
        breakpoint: Boolean(node.breakpoint), group: node.group ? String(node.group) : undefined,
        status: String(node.status ?? 'draft').toLowerCase() as EngineeringGraph['nodes'][number]['status'],
        position: Number.isFinite(x) && Number.isFinite(y)
          ? { x, y }
          : { x: 100 + (index % 3) * 270, y: 100 + Math.floor(index / 3) * 190 },
      };
    }),
    edges: rawEdges.map((value, index) => {
      const edge = asRecord(value);
      return {
        id: String(edge.id ?? `edge-${index}`),
        source: String(edge.source),
        target: String(edge.target),
        rationale: String(edge.reason ?? edge.rationale ?? edge.label ?? ''),
        type: String(edge.type ?? 'RELATED_TO'), label: String(edge.label ?? edge.rationale ?? ''),
        proposed: Boolean(edge.proposed),
      };
    }),
  };
}

function normalizePlan(raw: unknown): PlanVersion {
  const envelope = asRecord(raw);
  const body = asRecord(envelope.plan);
  const source = Object.keys(body).length > 0 ? body : envelope;
  const steps = Array.isArray(source.steps) ? source.steps : Array.isArray(envelope.workItems) ? envelope.workItems : [];
  const proposedEdges = Array.isArray(source.proposedEdges) ? source.proposedEdges : Array.isArray(envelope.proposedEdges) ? envelope.proposedEdges : [];
  const rawStatus = String(envelope.status ?? 'proposed').toLowerCase();
  const status = rawStatus === 'awaiting_approval' ? 'proposed' : rawStatus;
  const proposedGraph = normalizeProposedGraph(source.proposedGraph ?? envelope.proposedGraph);
  const researchPolicy = asRecord(asRecord(source.contextManifest).researchPolicy);
  const engineering = asRecord(asRecord(source.contextManifest).engineering);
  const hasResearchPolicy = typeof researchPolicy.enabled === 'boolean';
  return {
    id: String(envelope.id),
    graphId: String(envelope.graphId),
    version: Number(envelope.version ?? 1),
    provider: String(envelope.provider ?? 'simulation'),
    ...(['poc', 'mvp', 'production'].includes(String(engineering.profile)) ? { engineeringProfile: engineering.profile as PlanVersion['engineeringProfile'], engineeringConventions: String(engineering.conventions ?? '') } : {}),
    status: status as PlanVersion['status'],
    contentHash: String(envelope.contentHash ?? ''),
    summary: String(source.summary ?? ''),
    previousPlanId: envelope.parentPlanId ? String(envelope.parentPlanId) : undefined,
    baseDraftRevision: envelope.baseDraftRevision === undefined ? undefined : Number(envelope.baseDraftRevision),
    ...(hasResearchPolicy ? {
      researchPolicy: {
        enabled: researchPolicy.enabled as boolean,
        ...(typeof researchPolicy.provider === 'string' ? { provider: researchPolicy.provider } : {}),
        ...(typeof researchPolicy.tool === 'string' ? { tool: researchPolicy.tool } : {}),
        ...(typeof researchPolicy.mode === 'string' ? { mode: researchPolicy.mode } : {}),
        ...(typeof researchPolicy.digest === 'string' ? { digest: researchPolicy.digest } : {}),
      },
    } : {}),
    createdAt: envelope.createdAt ? String(envelope.createdAt) : undefined,
    rawDocument: raw,
    proposedEdges: proposedEdges.map((value, index) => {
      const edge = asRecord(value);
      return {
        id: String(edge.id ?? `plan-edge-${index}`),
        source: String(edge.source),
        target: String(edge.target),
        rationale: String(edge.rationale ?? edge.reason ?? edge.label ?? ''),
        proposed: true,
      };
    }),
    workItems: steps.map((value, index) => {
      const step = asRecord(value);
      const sourceIntents = Array.isArray(step.sourceIntents)
        ? step.sourceIntents.map(normalizePlanSourceIntent).filter((item): item is PlanSourceIntentSnapshot => item !== undefined)
        : undefined;
      return {
        id: String(step.id ?? `step-${index}`),
        nodeId: String(step.nodeId ?? ''),
        title: String(step.title ?? `Work item ${index + 1}`),
        description: String(step.description ?? step.objective ?? ''),
        acceptanceCriteria: Array.isArray(step.acceptanceCriteria) ? step.acceptanceCriteria.map(String) : [],
        dependencies: Array.isArray(step.dependencies) ? step.dependencies.map(String) : Array.isArray(step.dependsOn) ? step.dependsOn.map(String) : [],
        ...(sourceIntents === undefined ? {} : { sourceIntents }),
      };
    }),
    proposedGraph,
    diff: envelope.diff && typeof envelope.diff === 'object' ? envelope.diff as PlanVersion['diff'] : undefined,
  };
}

function normalizePlanSourceIntent(value: unknown): PlanSourceIntentSnapshot | undefined {
  const source = asRecord(value);
  if (typeof source.id !== 'string' || !source.id || typeof source.title !== 'string' || !source.title) return undefined;
  return {
    id: source.id,
    title: source.title,
    objective: typeof source.objective === 'string' ? source.objective : '',
    ...(typeof source.context === 'string' && source.context ? { context: source.context } : {}),
  };
}

function normalizeExecution(raw: unknown): ExecutionRun {
  const execution = asRecord(raw);
  return {
    ...(execution as unknown as ExecutionRun),
    id: String(execution.id),
    graphId: String(execution.graphId),
    planId: String(execution.planId),
    pendingPlanId: execution.pendingPlanId ? String(execution.pendingPlanId) : undefined,
    status: String(execution.status ?? 'queued').toLowerCase() as ExecutionRun['status'],
    parentExecutionId: execution.parentExecutionId ? String(execution.parentExecutionId) : undefined,
    resumedFromCheckpoint: execution.resumedFromCheckpoint ? normalizeCheckpoint(execution.resumedFromCheckpoint) : undefined,
    checkpoint: execution.checkpoint || execution.completedNodeIds ? normalizeCheckpoint(execution.checkpoint ?? execution.completedNodeIds) : undefined,
    selectedNodeIds: Array.isArray(execution.selectedNodeIds) ? execution.selectedNodeIds.map(String) : null,
    completedNodeIds: Array.isArray(execution.completedNodeIds) ? execution.completedNodeIds.map(String) : [],
    currentNodeId: typeof execution.currentNodeId === 'string' ? execution.currentNodeId : null,
  };
}

function normalizeCheckpoint(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? 'start' : `${value.length} completed ${value.length === 1 ? 'node' : 'nodes'}`;
  const checkpoint = asRecord(value);
  const reused = Array.isArray(checkpoint.reusedNodeIds) ? checkpoint.reusedNodeIds : undefined;
  if (reused) {
    const predecessor = String(checkpoint.predecessorExecutionId ?? 'predecessor').slice(0, 8);
    return `${reused.length} reusable ${reused.length === 1 ? 'node' : 'nodes'} from ${predecessor}`;
  }
  const label = checkpoint.id ?? checkpoint.nodeId ?? checkpoint.sequence ?? checkpoint.stepId ?? checkpoint.predecessorExecutionId;
  return label === undefined ? JSON.stringify(value) : String(label);
}

function normalizeArtifact(raw: unknown): Artifact {
  const artifact = asRecord(raw);
  const mediaType = String(artifact.mediaType ?? 'text/plain');
  const language = mediaType.includes('json') ? 'json'
    : mediaType.includes('markdown') ? 'markdown'
      : mediaType.includes('typescript') ? 'typescript'
        : mediaType.includes('javascript') ? 'javascript'
          : 'plaintext';
  return {
    id: String(artifact.id),
    executionId: String(artifact.executionId),
    nodeId: artifact.nodeId ? String(artifact.nodeId) : undefined,
    name: String(artifact.name ?? 'artifact'),
    content: String(artifact.content ?? ''),
    language,
    kind: mediaType.includes('diff') ? 'diff' : mediaType.includes('json') || mediaType.includes('markdown') ? 'report' : 'code',
    path: artifact.path ? String(artifact.path) : undefined,
    createdAt: artifact.createdAt ? String(artifact.createdAt) : undefined,
  };
}

function normalizeProviderProfile(raw: unknown): ProviderProfile {
  const profile = asRecord(raw);
  return {
    id: String(profile.id),
    label: String(profile.label ?? profile.id),
    kind: String(profile.kind ?? 'api'),
    model: profile.model ? String(profile.model) : undefined,
    baseUrl: profile.baseUrl ? String(profile.baseUrl) : undefined,
    enabled: Boolean(profile.enabled),
    secretEnvName: profile.secretEnvName ? String(profile.secretEnvName) : undefined,
    updatedAt: profile.updatedAt ? String(profile.updatedAt) : undefined,
  };
}

function providerKind(providerId: string, value: unknown): ProviderConnection['kind'] {
  if (value === 'hosted' || value === 'local' || value === 'cli') return value;
  if (providerId === 'openai-api' || providerId === 'anthropic-api') return 'hosted';
  if (providerId === 'ollama') return 'local';
  return 'cli';
}

function normalizeProviderConnection(raw: unknown, fallbackProviderId = ''): ProviderConnection {
  const connection = asRecord(raw);
  const providerId = String(connection.providerId ?? fallbackProviderId);
  const rawStatus = String(connection.status ?? 'NOT_CHECKED').toUpperCase();
  const status = ['NOT_CHECKED', 'DISCOVERED', 'CONNECTED', 'DISCONNECTED'].includes(rawStatus)
    ? rawStatus as ProviderConnection['status']
    : 'NOT_CHECKED';
  return {
    kind: providerKind(providerId, connection.kind),
    providerId,
    status,
    verified: Boolean(connection.verified),
    secretStorage: connection.secretStorage === 'SESSION_ONLY' ? 'SESSION_ONLY' : 'NONE',
    selectedModel: connection.selectedModel === null || connection.selectedModel === undefined
      ? null
      : String(connection.selectedModel),
    baseUrl: connection.baseUrl === null || connection.baseUrl === undefined ? null : String(connection.baseUrl),
    capabilities: strings(connection.capabilities),
    detail: String(connection.detail ?? ''),
  };
}

function normalizeProviderModel(raw: unknown): ProviderModel {
  const model = asRecord(raw);
  return {
    id: String(model.id),
    label: String(model.label ?? model.id),
    source: model.source === 'installed' ? 'installed' : 'provider',
    recommended: Boolean(model.recommended),
  };
}

function normalizeProviderStatus(raw: unknown): ProviderStatus {
  const item = asRecord(raw);
  const id = String(item.id);
  return {
    id,
    name: String(item.label ?? item.name ?? id),
    available: Boolean(item.available),
    configured: Boolean(item.configured),
    ready: Boolean(item.ready),
    connectionVerified: Boolean(item.connectionVerified),
    executionEnabled: Boolean(item.executionEnabled),
    workspaceWriteRequested: Boolean(item.workspaceWriteRequested),
    detected: Boolean(item.detected),
    kind: item.kind ? String(item.kind) : undefined,
    capabilities: strings(item.capabilities),
    detail: item.detail ? String(item.detail) : undefined,
    profile: item.profile ? normalizeProviderProfile(item.profile) : undefined,
    connection: item.connection ? normalizeProviderConnection(item.connection, id) : undefined,
  };
}

function normalizeProviderConnectionResult(raw: unknown): ProviderConnectionResult {
  const payload = asRecord(raw);
  return {
    connection: normalizeProviderConnection(payload.connection),
    models: unwrapList<unknown>(payload.models, ['items', 'models']).map(normalizeProviderModel),
    provider: payload.provider ? normalizeProviderStatus(payload.provider) : undefined,
  };
}

function normalizeAgent(raw: unknown): EngineeringAgent {
  const agent = asRecord(raw);
  const prompt = asRecord(agent.currentPrompt);
  return {
    id: String(agent.id),
    slug: String(agent.slug ?? agent.id),
    name: String(agent.name ?? agent.id),
    domain: String(agent.domain),
    description: String(agent.description ?? ''),
    capabilities: Array.isArray(agent.capabilities) ? agent.capabilities.map(String) : [],
    toolPolicy: asRecord(agent.toolPolicy),
    status: String(agent.status ?? 'ACTIVE') as EngineeringAgent['status'],
    currentPrompt: {
      id: prompt.id ? String(prompt.id) : undefined,
      agentId: String(prompt.agentId ?? agent.id),
      version: Number(prompt.version ?? 1),
      prompt: String(prompt.prompt ?? prompt.text ?? ''),
      digest: String(prompt.digest ?? prompt.contentDigest ?? ''),
      parentDigest: prompt.parentDigest ? String(prompt.parentDigest) : undefined,
      createdAt: prompt.createdAt ? String(prompt.createdAt) : undefined,
    },
  };
}

function normalizeSource(raw: unknown): SourceRecord {
  const source = asRecord(raw);
  const metadata = asRecord(source.metadata);
  return {
    id: String(source.id),
    graphId: String(source.graphId),
    nodeId: source.nodeId ? String(source.nodeId) : undefined,
    filename: String(source.filename ?? 'source'),
    mediaType: String(source.mediaType ?? 'application/octet-stream'),
    byteSize: Number(source.byteSize ?? 0),
    sha256: String(source.sha256 ?? ''),
    parseStatus: String(source.parseStatus ?? 'OPAQUE').toUpperCase() as SourceRecord['parseStatus'],
    parserId: String(source.parserId ?? 'opaque'),
    parserVersion: String(source.parserVersion ?? '1'),
    chunkCount: Number(source.chunkCount ?? metadata.chunkCount ?? 0),
    format: source.format || metadata.format ? String(source.format ?? metadata.format) : undefined,
    errors: (Array.isArray(source.errors) ? source.errors : Array.isArray(metadata.errors) ? metadata.errors : []).map((value) => {
      const error = asRecord(value);
      return { code: error.code ? String(error.code) : undefined, message: String(error.message ?? 'Source parsing failed') };
    }),
    metadata,
    createdAt: String(source.createdAt ?? ''),
  };
}

interface EventPage {
  hasMore: boolean;
  nextAfter: string;
  limit: number;
}

function normalizeStoredEvent(raw: unknown): ExecutionEvent {
  const event = asRecord(raw);
  const payload = asRecord(event.payload);
  const type = String(event.type ?? 'message');
  return {
    id: String(event.id ?? event.sequence ?? crypto.randomUUID()),
    cursor: String(event.sequence ?? event.cursor ?? ''),
    executionId: event.executionId ? String(event.executionId) : undefined,
    nodeId: event.nodeId || payload.nodeId ? String(event.nodeId ?? payload.nodeId) : undefined,
    type,
    level: String(event.level ?? payload.level ?? (type.endsWith('failed') ? 'error' : type.endsWith('completed') ? 'success' : 'info')) as ExecutionEvent['level'],
    message: String(event.message ?? payload.message ?? type.replaceAll('.', ' ')),
    timestamp: String(event.timestamp ?? event.createdAt ?? new Date().toISOString()),
    artifactId: event.artifactId || payload.artifactId ? String(event.artifactId ?? payload.artifactId) : undefined,
    data: payload,
  };
}

function normalizeTraceStatus(value: unknown): TraceRecord['status'] {
  const status = String(value ?? 'RUNNING').toUpperCase();
  return ['RUNNING', 'OK', 'ERROR', 'CANCELLED'].includes(status)
    ? status as TraceRecord['status']
    : 'RUNNING';
}

function normalizeTrace(raw: unknown): TraceRecord {
  const trace = asRecord(raw);
  const id = String(trace.id ?? trace.traceId ?? '');
  return {
    id,
    traceId: String(trace.traceId ?? id),
    graphId: String(trace.graphId ?? ''),
    executionId: trace.executionId ? String(trace.executionId) : undefined,
    planId: trace.planId ? String(trace.planId) : undefined,
    kind: String(trace.kind ?? 'EXECUTION').toUpperCase() === 'PLAN' ? 'PLAN' : 'EXECUTION',
    name: String(trace.name ?? `${String(trace.kind ?? 'Execution').toLowerCase()} trace`),
    status: normalizeTraceStatus(trace.status),
    rootSpanId: trace.rootSpanId ? String(trace.rootSpanId) : undefined,
    provider: trace.provider ? String(trace.provider) : undefined,
    model: trace.model ? String(trace.model) : undefined,
    attributes: asRecord(trace.attributes),
    startedAt: String(trace.startedAt ?? trace.createdAt ?? ''),
    endedAt: trace.endedAt ? String(trace.endedAt) : undefined,
    durationMs: trace.durationMs === null || trace.durationMs === undefined ? undefined : Number(trace.durationMs),
  };
}

function normalizeTraceSpan(raw: unknown): TraceSpan {
  const span = asRecord(raw);
  const id = String(span.id ?? span.spanId ?? '');
  const category = String(span.category ?? span.kind ?? 'GRAPH').toUpperCase() as TraceSpan['category'];
  const rawSpanKind = String(span.spanKind ?? 'INTERNAL').toUpperCase();
  return {
    id,
    spanId: String(span.spanId ?? id),
    traceId: String(span.traceId ?? ''),
    parentSpanId: span.parentSpanId ? String(span.parentSpanId) : undefined,
    executionId: span.executionId ? String(span.executionId) : undefined,
    planId: span.planId ? String(span.planId) : undefined,
    nodeId: span.nodeId ? String(span.nodeId) : undefined,
    stepId: span.stepId ? String(span.stepId) : undefined,
    agentId: span.agentId ? String(span.agentId) : undefined,
    name: String(span.name ?? 'Unnamed span'),
    kind: category,
    category,
    spanKind: ['INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'].includes(rawSpanKind)
      ? rawSpanKind as TraceSpan['spanKind']
      : 'INTERNAL',
    status: normalizeTraceStatus(span.status),
    startedAt: String(span.startedAt ?? span.createdAt ?? ''),
    endedAt: span.endedAt ? String(span.endedAt) : undefined,
    durationMs: span.durationMs === null || span.durationMs === undefined ? undefined : Number(span.durationMs),
    attributes: asRecord(span.attributes),
    input: span.input,
    output: span.output,
  };
}

function normalizeTraceEvent(raw: unknown): TraceEvent {
  const event = asRecord(raw);
  const timestamp = String(event.timestamp ?? event.createdAt ?? '');
  return {
    sequence: Number(event.sequence ?? 0),
    id: String(event.id ?? event.sequence ?? ''),
    traceId: String(event.traceId ?? ''),
    spanId: event.spanId ? String(event.spanId) : undefined,
    executionId: event.executionId ? String(event.executionId) : undefined,
    type: String(event.type ?? 'span.event'),
    attributes: asRecord(event.attributes ?? event.payload),
    createdAt: String(event.createdAt ?? timestamp),
    timestamp,
  };
}

function normalizeTraceDetail(raw: unknown): TraceDetail {
  const payload = asRecord(raw);
  const eventPage = asRecord(payload.eventPage);
  const events = (Array.isArray(payload.events) ? payload.events : []).map(normalizeTraceEvent);
  return {
    trace: normalizeTrace(payload.trace ?? payload.data ?? payload),
    spans: (Array.isArray(payload.spans) ? payload.spans : []).map(normalizeTraceSpan),
    events,
    eventPage: {
      after: Number(eventPage.after ?? 0),
      nextAfter: Number(eventPage.nextAfter ?? events.at(-1)?.sequence ?? 0),
      hasMore: Boolean(eventPage.hasMore),
      limit: Number(eventPage.limit ?? 500),
    },
  };
}

export const api = {
  async listProviders(): Promise<ProviderStatus[]> {
    const items = unwrapList<Record<string, unknown>>(await request<unknown>('/api/providers'), ['providers', 'items', 'data']);
    return items.map(normalizeProviderStatus);
  },

  async updateProviderProfile(providerId: string, input: Partial<Pick<ProviderProfile, 'model' | 'baseUrl' | 'enabled' | 'secretEnvName'>>): Promise<ProviderStatus> {
    const payload = asRecord(await request<unknown>(`/api/provider-profiles/${encodeURIComponent(providerId)}`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }));
    return normalizeProviderStatus(payload.provider);
  },

  async discoverProviderConnection(input: DiscoverProviderConnectionInput): Promise<ProviderConnectionResult> {
    return normalizeProviderConnectionResult(await request<unknown>('/api/provider-connections/discover', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }));
  },

  async connectProvider(input: ConnectProviderConnectionInput): Promise<ProviderConnectionResult> {
    return normalizeProviderConnectionResult(await request<unknown>('/api/provider-connections/connect', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(input),
    }));
  },

  async listProviderModels(providerId: string): Promise<ProviderConnectionResult> {
    return normalizeProviderConnectionResult(await request<unknown>(`/api/provider-connections/${encodeURIComponent(providerId)}/models`));
  },

  async disconnectProvider(providerId: string): Promise<ProviderConnectionResult> {
    return normalizeProviderConnectionResult(await request<unknown>(`/api/provider-connections/${encodeURIComponent(providerId)}`, {
      method: 'DELETE',
    }));
  },

  async listAgents(): Promise<{ domains: EngineeringDomain[]; agents: EngineeringAgent[] }> {
    const payload = asRecord(await request<unknown>('/api/agents'));
    return {
      domains: (Array.isArray(payload.domains) ? payload.domains : []).map((value) => {
        const domain = asRecord(value);
        return { id: String(domain.id), name: String(domain.name), purpose: String(domain.purpose ?? '') };
      }),
      agents: (Array.isArray(payload.items) ? payload.items : []).map(normalizeAgent),
    };
  },

  async updateAgentPrompt(agentId: string, prompt: string, expectedDigest: string): Promise<EngineeringAgent> {
    const payload = asRecord(await request<unknown>(`/api/agents/${encodeURIComponent(agentId)}/prompts`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ prompt, expectedDigest }),
    }));
    return normalizeAgent(payload.agent);
  },

  async listSources(graphId: string): Promise<SourceRecord[]> {
    const payload = await request<unknown>(`/api/graphs/${encodeURIComponent(graphId)}/sources`);
    return unwrapList<unknown>(payload, ['items', 'sources', 'data']).map(normalizeSource);
  },

  async uploadSource(graphId: string, nodeId: string | undefined, file: File): Promise<SourceRecord> {
    const query = nodeId ? `?nodeId=${encodeURIComponent(nodeId)}` : '';
    const payload = await request<unknown>(`/api/graphs/${encodeURIComponent(graphId)}/sources${query}`, {
      method: 'POST',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
        'X-EGE-Filename': file.name,
      },
      body: file,
    });
    const envelope = asRecord(payload);
    const source = asRecord(unwrapObject<unknown>(payload, ['source', 'data']));
    return normalizeSource({
      ...source,
      chunkCount: source.chunkCount ?? envelope.chunkCount,
      parseStatus: source.parseStatus ?? envelope.parseStatus,
      errors: source.errors ?? envelope.errors,
    });
  },

  async deleteSource(sourceId: string): Promise<void> {
    await request<void>(`/api/sources/${encodeURIComponent(sourceId)}`, { method: 'DELETE' });
  },

  async retrieveSources(graphId: string, query: string, limit = 8): Promise<RetrievalHit[]> {
    const payload = await request<unknown>(`/api/graphs/${encodeURIComponent(graphId)}/retrieve`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ query, limit }),
    });
    return unwrapList<unknown>(payload, ['items', 'hits', 'results', 'data']).map((value, index) => {
      const hit = asRecord(value);
      const citations = Array.isArray(hit.citations) ? hit.citations : hit.citation ? [hit.citation] : [];
      const firstCitation = asRecord(citations[0]);
      return {
        sourceId: String(hit.sourceId ?? hit.documentId ?? firstCitation.sourceId ?? firstCitation.documentId ?? ''),
        chunkId: String(hit.chunkId ?? hit.id),
        filename: String(hit.filename ?? firstCitation.filename ?? firstCitation.sourceName ?? 'source'),
        nodeId: hit.nodeId ? String(hit.nodeId) : undefined,
        text: String(hit.text ?? ''),
        location: asRecord(hit.location ?? asRecord(citations[0]).locator),
        score: Number(hit.score ?? 0),
        rank: Number(hit.rank ?? index + 1),
        rankSignals: normalizeRankSignals(hit.rankSignals ?? hit.scores),
        citations: citations.map((value) => {
          if (typeof value === 'string') return { locator: { label: value } };
          const citation = asRecord(value);
          return {
            sourceId: citation.sourceId || citation.documentId ? String(citation.sourceId ?? citation.documentId) : undefined,
            filename: citation.filename || citation.sourceName ? String(citation.filename ?? citation.sourceName) : undefined,
            digest: citation.digest ? String(citation.digest) : undefined,
            locator: asRecord(citation.locator ?? citation.location),
          };
        }),
      };
    });
  },

  async listGraphs(): Promise<EngineeringGraph[]> {
    return unwrapList<unknown>(await request<unknown>('/api/graphs'), ['graphs', 'items', 'data']).map((graph) => normalizeGraph(graph));
  },

  async createGraph(name: string, workspacePath?: string): Promise<EngineeringGraph> {
    const payload = await request<unknown>('/api/graphs', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name, workspacePath }),
      });
    return normalizeGraph(unwrapObject<unknown>(payload, ['graph', 'data']));
  },

  async renameWorkspace(graphId: string, name: string): Promise<EngineeringGraph> {
    const payload = await request<unknown>(`/api/graphs/${encodeURIComponent(graphId)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name }),
    });
    return normalizeGraph(unwrapObject<unknown>(payload, ['graph', 'data']));
  },

  async updateWorkspacePath(graphId: string, workspacePath: string): Promise<EngineeringGraph> {
    const payload = asRecord(await request<unknown>(`/api/graphs/${encodeURIComponent(graphId)}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ workspacePath }),
    }));
    return normalizeGraph(payload.graph ?? payload.data ?? payload, payload.draft);
  },

  async deleteWorkspace(graphId: string): Promise<void> {
    await request<void>(`/api/graphs/${encodeURIComponent(graphId)}`, { method: 'DELETE' });
  },

  async getGraphBundle(graphId: string): Promise<GraphBundle> {
    const payload = asRecord(await request<unknown>(`/api/graphs/${graphId}`));
    return {
      graph: normalizeGraph(payload.graph ?? payload.data ?? payload, payload.draft),
      plans: (Array.isArray(payload.plans) ? payload.plans : []).map(normalizePlan),
      executions: (Array.isArray(payload.executions) ? payload.executions : []).map(normalizeExecution),
    };
  },

  async getGraph(graphId: string): Promise<EngineeringGraph> {
    return (await this.getGraphBundle(graphId)).graph;
  },

  async saveGraph(graph: EngineeringGraph): Promise<EngineeringGraph> {
    await request<unknown>(`/api/graphs/${graph.id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: graph.name }),
      });
    const payload = await request<unknown>(`/api/graphs/${graph.id}/draft`, {
      method: 'PUT',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        nodes: graph.nodes.map((node) => ({
          id: node.id,
          title: node.title,
          kind: node.kind,
          description: node.objective,
          context: node.context,
          proposalSource: node.proposalSource,
          position: node.position,
          agentId: node.agentId, providerId: node.providerId, model: node.model,
          skills: node.skills ?? [], inputs: node.inputs ?? [], outputs: node.outputs ?? [],
          acceptanceCriteria: node.acceptanceCriteria ?? [], budgets: node.budgets, review: node.review,
          breakpoint: node.breakpoint ?? false, group: node.group,
        })),
        edges: graph.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          label: edge.label ?? edge.rationale, type: edge.type ?? 'RELATED_TO',
          rationale: edge.rationale,
        })),
      }),
    });
    return normalizeGraph(graph, unwrapObject<unknown>(payload, ['draft', 'data']));
  },

  async listPlans(graphId: string): Promise<PlanVersion[]> {
    return (await this.getGraphBundle(graphId)).plans;
  },

  async createPlan(graphId: string, input: CreatePlanInput): Promise<PlanVersion> {
    const payload = await request<unknown>(`/api/graphs/${graphId}/plans`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          provider: input.provider,
          instructions: input.additionalContext,
          engineeringProfile: input.engineeringProfile,
          conventions: input.conventions,
          parentPlanId: input.previousPlanId,
          research: input.research,
        }),
      });
    return normalizePlan(unwrapObject<unknown>(payload, ['plan', 'data']));
  },

  async replanExecution(executionId: string, input: CreatePlanInput, draft?: EngineeringGraph): Promise<{ execution: ExecutionRun; plan: PlanVersion }> {
    const payload = asRecord(await request<unknown>(`/api/executions/${executionId}/replan`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        provider: input.provider,
        instructions: input.additionalContext,
        engineeringProfile: input.engineeringProfile,
        conventions: input.conventions,
        research: input.research,
        draft: draft ? draftPayload(draft) : undefined,
      }),
    }));
    return {
      execution: normalizeExecution(payload.execution),
      plan: normalizePlan(payload.plan),
    };
  },

  async approvePlan(graphId: string, planId: string, expectedContentHash: string, approvalRationale: string): Promise<PlanVersion> {
    void graphId;
    const payload = await request<unknown>(`/api/plans/${planId}/approve`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ expectedContentHash, rationale: approvalRationale }),
      });
    return normalizePlan(unwrapObject<unknown>(payload, ['plan', 'data']));
  },

  async listExecutions(graphId: string): Promise<ExecutionRun[]> {
    return (await this.getGraphBundle(graphId)).executions;
  },

  async getExecution(executionId: string, after?: string): Promise<{ execution: ExecutionRun; plan?: PlanVersion; events: ExecutionEvent[]; eventPage: EventPage; artifacts: Artifact[] }> {
    const query = `?limit=2000${after ? `&after=${encodeURIComponent(after)}` : ''}`;
    const payload = asRecord(await request<unknown>(`/api/executions/${executionId}${query}`));
    const eventPage = asRecord(payload.eventPage);
    const events = (Array.isArray(payload.events) ? payload.events : []).map(normalizeStoredEvent);
    return {
      execution: normalizeExecution(payload.execution ?? payload.data ?? payload),
      plan: payload.plan ? normalizePlan(payload.plan) : undefined,
      events,
      eventPage: {
        hasMore: Boolean(eventPage.hasMore),
        nextAfter: String(eventPage.nextAfter ?? events.at(-1)?.cursor ?? after ?? ''),
        limit: Number(eventPage.limit ?? 2_000),
      },
      artifacts: (Array.isArray(payload.artifacts) ? payload.artifacts : []).map(normalizeArtifact),
    };
  },

  async getExecutionHistory(executionId: string): Promise<{ execution: ExecutionRun; plan?: PlanVersion; events: ExecutionEvent[]; eventPage: EventPage; artifacts: Artifact[] }> {
    let snapshot = await this.getExecution(executionId);
    const events = [...snapshot.events];
    let pages = 1;
    while (snapshot.eventPage.hasMore && pages < 100) {
      const cursor = snapshot.eventPage.nextAfter;
      if (!cursor) break;
      const next = await this.getExecution(executionId, cursor);
      snapshot = next;
      const known = new Set(events.map((event) => event.id));
      events.push(...next.events.filter((event) => !known.has(event.id)));
      pages += 1;
    }
    return { ...snapshot, events };
  },

  async startExecution(graphId: string, input: StartExecutionInput): Promise<ExecutionRun> {
    const payload = await request<unknown>(`/api/graphs/${graphId}/executions`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ planId: input.planId, expectedPlanHash: input.expectedPlanHash, provider: input.provider }),
      });
    return normalizeExecution(unwrapObject<unknown>(payload, ['execution', 'run', 'data']));
  },

  async cancelExecution(executionId: string): Promise<ExecutionRun> {
    const payload = await request<unknown>(`/api/executions/${encodeURIComponent(executionId)}/cancel`, { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    return normalizeExecution(unwrapObject<unknown>(payload, ['execution', 'run', 'data']));
  },

  async pauseExecution(executionId: string): Promise<ExecutionRun> {
    const payload = await request<unknown>(`/api/executions/${executionId}/pause`, { method: 'POST' });
    return normalizeExecution(unwrapObject<unknown>(payload, ['execution', 'run', 'data']));
  },

  async resumeExecution(executionId: string): Promise<{ execution: ExecutionRun; predecessor?: ExecutionRun }> {
    const payload = asRecord(await request<unknown>(`/api/executions/${executionId}/resume`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: 'APPROVED_REPLAN' }),
    }));
    return {
      execution: normalizeExecution(payload.execution ?? payload.run ?? payload.data ?? payload),
      predecessor: payload.predecessor ? normalizeExecution(payload.predecessor) : undefined,
    };
  },

  async resumeOriginalExecution(executionId: string): Promise<{ execution: ExecutionRun; predecessor?: ExecutionRun }> {
    const payload = asRecord(await request<unknown>(`/api/executions/${executionId}/resume`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ mode: 'PINNED_PLAN' }),
    }));
    return {
      execution: normalizeExecution(payload.execution ?? payload.run ?? payload.data ?? payload),
      predecessor: payload.predecessor ? normalizeExecution(payload.predecessor) : undefined,
    };
  },

  async listArtifacts(executionId: string): Promise<Artifact[]> {
    return unwrapList<unknown>(await request<unknown>(`/api/executions/${executionId}/artifacts`), ['artifacts', 'items', 'data']).map(normalizeArtifact);
  },

  async listGraphTraces(graphId: string, limit = 50, before?: string): Promise<{ items: TraceRecord[]; page: TraceListPage }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (before) query.set('before', before);
    const payload = asRecord(await request<unknown>(`/api/graphs/${encodeURIComponent(graphId)}/traces?${query.toString()}`));
    const page = asRecord(payload.page);
    return {
      items: (Array.isArray(payload.items) ? payload.items : []).map(normalizeTrace),
      page: {
        limit: Number(page.limit ?? limit),
        hasMore: Boolean(page.hasMore),
        nextBefore: page.nextBefore ? String(page.nextBefore) : undefined,
      },
    };
  },

  async getTrace(traceId: string, after = 0, limit = 500): Promise<TraceDetail> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return normalizeTraceDetail(await request<unknown>(`/api/traces/${encodeURIComponent(traceId)}?${query.toString()}`));
  },

  async getExecutionTrace(executionId: string, after = 0, limit = 500): Promise<TraceDetail> {
    const query = new URLSearchParams({ after: String(after), limit: String(limit) });
    return normalizeTraceDetail(await request<unknown>(`/api/executions/${encodeURIComponent(executionId)}/trace?${query.toString()}`));
  },
};

function draftPayload(graph: EngineeringGraph) {
  return {
    nodes: graph.nodes.map((node) => ({
      id: node.id,
      title: node.title,
      kind: node.kind,
      description: node.objective,
      context: node.context,
      proposalSource: node.proposalSource,
      agentId: node.agentId, providerId: node.providerId, model: node.model, skills: node.skills,
      inputs: node.inputs, outputs: node.outputs, acceptanceCriteria: node.acceptanceCriteria,
      budgets: node.budgets, review: node.review, breakpoint: node.breakpoint, group: node.group,
      position: node.position,
    })),
    edges: graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, type: edge.type, label: edge.label, rationale: edge.rationale })),
  };
}

export function eventStreamUrl(executionId: string, cursor?: string): string {
  const query = cursor ? `?after=${encodeURIComponent(cursor)}` : '';
  return apiUrl(`/api/executions/${executionId}/events${query}`);
}

export function graphTraceEventStreamUrl(graphId: string, cursor?: string): string {
  const query = cursor ? `?after=${encodeURIComponent(cursor)}` : '';
  return apiUrl(`/api/graphs/${encodeURIComponent(graphId)}/traces/events${query}`);
}
