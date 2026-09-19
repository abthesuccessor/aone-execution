import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

vi.mock('./components/GraphCanvas', () => ({
  GraphCanvas: ({
    nodes,
    proposedGraph,
    selectedProposalNodeId,
    onSelectProposalNode,
    onConnectNodes,
    onPositionsChange,
    readOnly,
  }: {
    nodes: Array<{ id: string; position?: { x: number; y: number } }>;
    proposedGraph?: { nodes: Array<{ id: string; title: string }> };
    selectedProposalNodeId?: string;
    onSelectProposalNode: (nodeId?: string) => void;
    onConnectNodes?: (sourceNodeId: string, targetNodeId: string) => void;
    onPositionsChange?: (positions: Array<{ nodeId: string; position: { x: number; y: number } }>) => void;
    readOnly?: boolean;
  }) => (
    <div aria-label="Engineering topic graph">
      {nodes.map((node) => <span key={node.id} data-testid={`canvas-position-${node.id}`} data-x={node.position?.x} data-y={node.position?.y} />)}
      {nodes.length > 1 && onPositionsChange && <button type="button" disabled={readOnly} onClick={() => onPositionsChange(nodes.map((node) => ({ nodeId: node.id, position: { x: (node.position?.x ?? 0) + 100, y: (node.position?.y ?? 0) + 50 } })))}>Move canvas selection</button>}

      {nodes.length > 1 ? (
        <button type="button" aria-label="Connect first two canvas nodes" onClick={() => onConnectNodes?.(nodes[0].id, nodes[1].id)}>
          Connect canvas nodes
        </button>
      ) : null}
      {proposedGraph?.nodes.map((node) => (
        <button
          type="button"
          key={node.id}
          aria-pressed={selectedProposalNodeId === node.id}
          aria-label={`${node.title}, proposed specialist, drag to move or select for details`}
          onClick={() => onSelectProposalNode(node.id)}
        >
          {node.title}
        </button>
      ))}
    </div>
  ),
}));

interface HandlerMap { [event: string]: Set<(event: MessageEvent<string>) => void> }

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly handlers: HandlerMap = {};
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  closed = false;

  constructor(readonly url: string | URL) {
    MockEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  addEventListener(type: string, callback: EventListenerOrEventListenerObject) {
    const listener = typeof callback === 'function' ? callback : callback.handleEvent.bind(callback);
    (this.handlers[type] ??= new Set()).add(listener as (event: MessageEvent<string>) => void);
  }

  removeEventListener(type: string, callback: EventListenerOrEventListenerObject) {
    const listener = typeof callback === 'function' ? callback : callback.handleEvent.bind(callback);
    this.handlers[type]?.delete(listener as (event: MessageEvent<string>) => void);
  }

  close() { this.closed = true; }

  emit(type: string, payload: Record<string, unknown>, sequence: number) {
    const event = new MessageEvent<string>(type, {
      data: JSON.stringify({ ...payload, type, sequence, timestamp: '2026-08-22T07:00:00.000Z' }),
      lastEventId: String(sequence),
    });
    this.handlers[type]?.forEach((handler) => handler(event));
  }
}

const graphMetadata = { id: 'graph-1', name: 'Product build', status: 'DRAFT', updatedAt: '2026-08-22T06:00:00.000Z' };
let draftNodes: Record<string, unknown>[];
let draftRevision: number;
let currentPlanVersion: number;
let planApproved: boolean;
let sourceRecords: Record<string, unknown>[];

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function auxiliaryResponse(url: string, method: string): Response | undefined {
  if (method !== 'GET') return undefined;
  if (url === '/api/agents') return json({ domains: [], items: [] });
  if (url === '/api/catalog/skills') return json({ items: [] });
  if (/^\/api\/graphs\/[^/]+\/chat(?:\/templates)?$/.test(url)) return json({ items: [] });
  if (/^\/api\/graphs\/[^/]+\/chat\/context$/.test(url)) return json({ draftRevision, nodes: draftNodes, sources: sourceRecords });
  if (/^\/api\/graphs\/[^/]+\/terminal$/.test(url)) return json({ session: null });
  return undefined;
}

function plan(version: number) {
  const intentNodeId = String(draftNodes[0]?.id ?? 'intent-node');
  return {
    id: `plan-${version}`,
    graphId: 'graph-1',
    version,
    parentPlanId: version > 1 ? `plan-${version - 1}` : undefined,
    provider: 'codex-cli',
    contentHash: `hash-plan-${version}`,
    baseDraftRevision: draftRevision,
    status: planApproved ? 'APPROVED' : 'PROPOSED',
    createdAt: '2026-08-22T07:00:00.000Z',
    plan: {
      summary: version > 1 ? 'Updated plan keeps the frontend work and adds checkpoint context.' : 'Build the frontend topic with the assigned specialist.',
      steps: [{
        id: `step-${version}`,
        nodeId: 'specialist:experience',
        title: version > 1 ? 'Continue frontend from checkpoint' : 'Implement frontend',
        objective: 'Create the requested browser experience.',
        acceptanceCriteria: ['The frontend is keyboard accessible.'],
        dependsOn: [],
        skills: ['design-taste-frontend'],
      }],
      proposedEdges: [],
      proposedGraph: {
        proposalId: `proposal:${version}`,
        schemaVersion: 'intent-proposed-graph/v2',
        status: 'PROPOSED',
        compilerVersion: 'configured-ai-proposal/2.0.0',
        contentDigest: `sha256:proposal-${version}`,
        selectedDomains: ['experience'],
        nodes: [{
          id: 'specialist:experience',
          type: 'SPECIALIST_AGENT',
          domain: 'experience',
          title: 'Experience engineering',
          objective: 'Build the accessible customer portal experience.',
          agentId: 'experience-agent',
          promptDigest: 'sha256:prompt',
          dependsOn: [],
          acceptanceCriteria: ['The frontend is keyboard accessible.'],
          inputs: [{ id: 'input:context', type: 'intent_evidence_bundle', required: true }],
          outputs: [{ id: 'artifact:experience', type: 'experience_contract', required: true, provenanceRequired: true }],
          traceability: { intentNodeIds: [intentNodeId], evidenceIds: sourceRecords.map((source) => String(source.id)) },
        }],
        relationships: [{
          id: 'relationship:supported',
          type: 'SUPPORTED_BY',
          from: 'sources:specialist:experience',
          to: 'specialist:experience',
          rationale: 'The proposal is grounded in bound intent and evidence.',
          traceability: { intentNodeIds: [intentNodeId], evidenceIds: sourceRecords.map((source) => String(source.id)) },
        }],
      },
    },
    diff: version > 1 ? { summary: 'One work item changed.', added: [], changed: ['step-2'], removed: [] } : undefined,
  };
}

describe('Graph Engineering workbench', () => {
  beforeEach(() => {
    localStorage.clear();
    MockEventSource.instances = [];
    draftNodes = [];
    draftRevision = 1;
    currentPlanVersion = 0;
    planApproved = false;
    sourceRecords = [];
    vi.stubGlobal('EventSource', MockEventSource);

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();

      const auxiliary = auxiliaryResponse(url, method);
      if (auxiliary) return auxiliary;

      if (url === '/api/providers') return json({ items: [
        { id: 'simulation', label: 'Simulation', kind: 'local', available: true, configured: true, capabilities: ['planning'], detail: 'Deterministic planning and simulated execution only' },
        {
          id: 'codex-cli', label: 'Codex CLI', kind: 'cli', available: true, configured: true,
          capabilities: ['plan', 'execute', 'research-live-web'], detail: 'Connected Codex runtime with approval-gated workspace execution.',
          connection: { providerId: 'codex-cli', status: 'CONNECTED', verified: true },
        },
      ] });
      if (url === '/api/graphs' && method === 'GET') return json({ items: [graphMetadata] });
      if (url === '/api/graphs/graph-1' && method === 'GET') return json({ graph: graphMetadata, draft: { nodes: draftNodes, edges: [], revision: draftRevision }, plans: currentPlanVersion ? [plan(currentPlanVersion)] : [], executions: [] });
      if (url === '/api/graphs/graph-1' && method === 'PATCH') return json({ graph: graphMetadata });
      if (url === '/api/graphs/graph-1/draft' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { nodes: Record<string, unknown>[] };
        draftNodes = body.nodes;
        draftRevision += 1;
        return json({ draft: { nodes: draftNodes, edges: [], revision: draftRevision } });
      }
      if (url === '/api/graphs/graph-1/sources' && method === 'GET') return json({ items: sourceRecords });
      if (url.startsWith('/api/graphs/graph-1/sources?nodeId=') && method === 'POST') {
        const headers = new Headers(init?.headers);
        const filename = headers.get('X-EGE-Filename') ?? 'source';
        const source = {
          id: `source-${sourceRecords.length + 1}`,
          graphId: 'graph-1',
          nodeId: decodeURIComponent(url.split('nodeId=')[1]),
          filename,
          mediaType: headers.get('Content-Type') ?? 'application/octet-stream',
          byteSize: init?.body instanceof File ? init.body.size : 0,
          sha256: String(sourceRecords.length + 1).repeat(64),
          parseStatus: 'PARSED',
          parserId: 'bounded-evidence-parser',
          parserVersion: 'evidence-parser-v1',
          chunkCount: 2,
          format: filename.split('.').at(-1),
          metadata: filename.endsWith('.xlsx') ? { sheetCount: 2, rowCount: 8 } : { lineCount: 3 },
          createdAt: '2026-08-22T06:30:00.000Z',
        };
        sourceRecords.unshift(source);
        return json({ source });
      }
      if (url === '/api/graphs/graph-1/retrieve' && method === 'POST') return json({ query: 'keyboard', items: [{
        sourceId: String(sourceRecords[0]?.id ?? 'source-1'),
        chunkId: 'chunk-keyboard',
        filename: String(sourceRecords[0]?.filename ?? 'requirements.md'),
        nodeId: String(draftNodes[0]?.id),
        text: 'Keyboard navigation is required for every action.',
        score: 0.03125,
        rank: 1,
        citations: [{ sourceId: 'source-1', locator: { lineStart: 2, lineEnd: 2 } }],
      }] });
      if (url === '/api/graphs/graph-1/plans' && method === 'POST') {
        currentPlanVersion += 1;
        planApproved = false;
        return json({ plan: plan(currentPlanVersion) });
      }
      if (url === '/api/plans/plan-1/approve' && method === 'POST') {
        planApproved = true;
        return json({ plan: plan(1), approval: { context: 'Use the accessible design constraints' } });
      }
      if (url === '/api/graphs/graph-1/executions' && method === 'POST') return json({ execution: { id: 'run-1', graphId: 'graph-1', planId: 'plan-1', status: 'RUNNING', startedAt: '2026-08-22T07:00:00.000Z' } }, 202);
      if (url === '/api/executions/run-1/artifacts' && method === 'GET') return json({ items: [{ id: 'artifact-1', executionId: 'run-1', nodeId: String(draftNodes[0]?.id), name: 'App.tsx', path: 'src/App.tsx', kind: 'code', language: 'typescript', content: 'export function App() {}' }] });
      if (url === '/api/executions/run-1/pause' && method === 'POST') return json({ execution: { id: 'run-1', graphId: 'graph-1', planId: 'plan-1', status: 'PAUSE_REQUESTED', checkpoint: 'after-step-1' } });
      if (url === '/api/executions/run-1/replan' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { draft?: { nodes?: Record<string, unknown>[] } };
        if (body.draft) {
          draftNodes = body.draft.nodes ?? draftNodes;
          draftRevision += 1;
        }
        currentPlanVersion = 2;
        planApproved = false;
        return json({ execution: { id: 'run-1', graphId: 'graph-1', planId: 'plan-1', status: 'PAUSED', checkpoint: 'after-step-1' }, plan: plan(2) });
      }
      if (url === '/api/plans/plan-2/approve' && method === 'POST') {
        planApproved = true;
        return json({ plan: plan(2), approval: { context: 'Continue with the new constraint' } });
      }
      if (url === '/api/executions/run-1/resume' && method === 'POST') {
        const body = init?.body ? JSON.parse(String(init.body)) as { mode?: string } : {};
        if (body.mode === 'PINNED_PLAN') return json({ predecessor: null, execution: { id: 'run-1', graphId: 'graph-1', planId: 'plan-1', status: 'RUNNING' } });
        return json({ predecessor: { id: 'run-1', status: 'SUPERSEDED' }, execution: { id: 'run-2', graphId: 'graph-1', planId: 'plan-2', status: 'RUNNING', parentExecutionId: 'run-1', resumedFromCheckpoint: 'after-step-1' } });
      }
      if (url === '/api/executions/run-2/artifacts' && method === 'GET') return json({ items: [] });

      return json({ error: { code: 'UNMOCKED', message: `${method} ${url}` } }, 500);
    }));
  });

  afterEach(() => {
    cleanup();
    delete window.egeDesktop;
    vi.unstubAllGlobals();
  });

  it('keeps the graph locked while planning when an independent chat context save finishes', async () => {
    draftNodes = [{ id: 'intent-1', title: 'Requirements', description: 'Build the service.', context: '', skills: [], position: { x: 0, y: 0 } }];
    const original = vi.mocked(fetch).getMockImplementation()!;
    let releasePlan: (() => void) | undefined;
    let planRequested = false;
    const context = { draftRevision: 1, boundary: 'Supplied context only.', capturedAt: '2026-09-12T00:00:00Z', nodes: [{ id: 'intent-1', title: 'Requirements' }], evidence: [], agents: [], skills: [] };
    const conversation = { id: 'chat-1', graphId: 'graph-1', title: 'Requirements', nodeIds: ['intent-1'], updatedAt: '2026-09-12T00:00:00Z' };
    const message = { id: 'chat-message', conversationId: 'chat-1', role: 'assistant', content: 'Read-only discussion completed.', status: 'completed', action: 'discuss', context, createdAt: '2026-09-12T00:00:00Z' };
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input); const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/graphs/graph-1/plans' && method === 'POST') { planRequested = true; await new Promise<void>((resolve) => { releasePlan = resolve; }); }
      if (url === '/api/graphs/graph-1/chat' && method === 'POST') return json({ conversation });
      if (url === '/api/graphs/graph-1/chat/chat-1/messages' && method === 'POST') return new Response(`event: message\ndata: ${JSON.stringify({ message })}\n\nevent: done\ndata: ${JSON.stringify({ message })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      if (url === '/api/graphs/graph-1/chat/chat-1' && method === 'GET') return json({ conversation, messages: [message] });
      return original(input, init);
    });
    const user = userEvent.setup(); render(<App />);
    await screen.findByText('Product build');
    await user.click(screen.getByRole('tab', { name: 'Requirements' }));
    await user.click(screen.getByRole('button', { name: 'Request plan' }));
    await waitFor(() => expect(planRequested).toBe(true));
    expect(screen.getByRole('textbox', { name: 'Node title' })).toBeDisabled();
    await user.type(screen.getByLabelText('Message AI'), 'Discuss these requirements.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Read-only discussion completed.');
    expect(screen.getByRole('textbox', { name: 'Node title' })).toBeDisabled();
    expect(screen.getByLabelText('Node agent')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Save draft/i })).toBeDisabled();
    await act(async () => { releasePlan?.(); });
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Node title' })).toBeEnabled());
  });

  it('commits a multi-node drag as one reversible graph change', async () => {
    draftNodes = [{ id: 'first', title: 'First', description: 'Build first', position: { x: 10, y: 20 } }, { id: 'second', title: 'Second', description: 'Build second', position: { x: 40, y: 60 } }];
    const user = userEvent.setup(); render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Move canvas selection' }));
    expect(screen.getByTestId('canvas-position-first')).toHaveAttribute('data-x', '110');
    expect(screen.getByTestId('canvas-position-second')).toHaveAttribute('data-x', '140');
    await user.click(screen.getByRole('button', { name: 'Undo graph change' }));
    expect(screen.getByTestId('canvas-position-first')).toHaveAttribute('data-x', '10');
    expect(screen.getByTestId('canvas-position-second')).toHaveAttribute('data-x', '40');
    expect(screen.getByRole('button', { name: 'Undo graph change' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Redo graph change' }));
    expect(screen.getByTestId('canvas-position-first')).toHaveAttribute('data-y', '70');
    expect(screen.getByTestId('canvas-position-second')).toHaveAttribute('data-y', '110');
  });

  it('clears pending selected-node execution scope with the Whole plan control', async () => {
    draftNodes = [{ id: 'first', title: 'First', description: 'Build first', position: { x: 10, y: 20 } }];
    const user = userEvent.setup(); render(<App />);
    await screen.findByText('Product build');
    await user.click(screen.getByRole('button', { name: 'Run' }));
    const wholePlan = await screen.findByRole('button', { name: 'Use whole plan' });
    await waitFor(() => expect(wholePlan).toBeEnabled());
    await user.click(wholePlan);
    expect(screen.queryByRole('button', { name: 'Use whole plan' })).not.toBeInTheDocument();
    const executionRequests = vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).endsWith('/executions') && init?.method === 'POST');
    expect(executionRequests).toHaveLength(0);
  });

  it('creates context nodes, plans, approves, executes, pauses, replans, and continues through a successor run', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText('Product build')).toBeInTheDocument();
    expect(await screen.findByText('Connected Codex runtime with approval-gated workspace execution.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create node' }));
    await user.type(screen.getByRole('textbox', { name: 'Node name' }), 'Customer portal frontend');
    await user.type(screen.getByRole('textbox', { name: 'Node objective' }), 'Create the requested browser experience.');
    await user.type(screen.getByRole('textbox', { name: 'Node context' }), 'Use an accessible, high density developer interface.');
    const requirementsFile = new File(['# Accessibility\nKeyboard navigation is required.'], 'requirements.md', { type: 'text/markdown' });
    await user.upload(screen.getByLabelText('Source files for new node'), requirementsFile);
    await user.click(screen.getByRole('button', { name: 'Create and upload' }));
    await user.click(screen.getByRole('tab', { name: 'Customer portal frontend' }));
    expect(screen.getByRole('textbox', { name: 'Node title' })).toHaveValue('Customer portal frontend');
    const nodeInspector = within(screen.getByRole('complementary', { name: 'Inspector for Customer portal frontend' }));
    expect(await nodeInspector.findByText('requirements.md')).toBeInTheDocument();
    expect(nodeInspector.getByText('parsed')).toBeInTheDocument();
    const creationCalls = vi.mocked(fetch).mock.calls.map(([url, init]) => `${(init?.method ?? 'GET').toUpperCase()} ${String(url)}`);
    expect(creationCalls.indexOf('PUT /api/graphs/graph-1/draft')).toBeLessThan(creationCalls.findIndex((call) => call.startsWith('POST /api/graphs/graph-1/sources?nodeId=')));

    await user.click(screen.getByRole('button', { name: /Save draft/i }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    expect(draftNodes).toHaveLength(1);

    const apiFile = new File(['{"endpoint":"/graphql"}'], 'api.json', { type: 'application/json' });
    await user.upload(screen.getByLabelText('Attach source files to Customer portal frontend'), apiFile);
    expect(await nodeInspector.findByText('api.json')).toBeInTheDocument();
    expect(sourceRecords).toHaveLength(2);

    await user.click(screen.getByText('Search graph evidence'));
    await user.type(screen.getByRole('textbox', { name: 'Search graph evidence' }), 'keyboard');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Keyboard navigation is required for every action.')).toBeInTheDocument();
    expect(screen.getByText(/lineStart: 2/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Request plan' }));
    expect((await screen.findAllByText('Plan v1')).length).toBeGreaterThan(0);
    expect(screen.getByRole('textbox', { name: 'Node title' })).toHaveValue('Customer portal frontend');
    expect(screen.getByText('Implement frontend')).toBeInTheDocument();
    expect(screen.getByText('The frontend is keyboard accessible.')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: /^Graph/ }));
    expect((await screen.findAllByText('Experience engineering')).length).toBeGreaterThan(0);
    expect(screen.getByText('Your intent nodes remain unchanged. Approval admits this generated specialist graph.')).toBeInTheDocument();
    expect(screen.getByText('SUPPORTED BY')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Approval rationale' }), 'Use the accessible design constraints');
    await user.click(screen.getByRole('button', { name: 'Approve plan v1' }));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.getByText('Runtime codex-cli')).toBeInTheDocument();
    expect(screen.getByText('Web research off')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Agent runtime' }));
    expect(screen.queryByRole('option', { name: /Local agents/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Simulation/i })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('button', { name: 'Run plan' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Run plan' }));
    await waitFor(() => expect(MockEventSource.instances.some((stream) => String(stream.url) === '/api/executions/run-1/events')).toBe(true));
    const executionStream = MockEventSource.instances.find((stream) => String(stream.url) === '/api/executions/run-1/events')!;

    act(() => {
      executionStream.emit('execution.recovered', { id: 'event-recovered', executionId: 'run-1', payload: { status: 'RUNNING', message: 'Recovered persisted execution' } }, 1);
      executionStream.emit('node.started', { id: 'event-1', executionId: 'run-1', payload: { nodeId: String(draftNodes[0].id), message: 'Frontend work started' } }, 2);
      executionStream.emit('artifact.created', { id: 'event-2', executionId: 'run-1', payload: { nodeId: String(draftNodes[0].id), artifactId: 'artifact-1', message: 'Created App.tsx' } }, 3);
      executionStream.emit('verification.receipt', { id: 'event-receipt', executionId: 'run-1', payload: { nodeId: String(draftNodes[0].id), message: 'Simulated verification receipt created' } }, 4);
    });
    expect(await screen.findByText('Recovered persisted execution')).toBeInTheDocument();
    expect(await screen.findByText('Frontend work started')).toBeInTheDocument();
    expect(await screen.findByText('Simulated verification receipt created')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pause after current node' }));
    expect(await screen.findByRole('button', { name: 'Waiting for checkpoint' })).toBeDisabled();
    await user.click(screen.getByRole('tab', { name: 'Customer portal frontend' }));
    expect(screen.getByRole('textbox', { name: 'Node title' })).toBeDisabled();

    act(() => {
      executionStream.emit('execution.paused', { id: 'event-3', executionId: 'run-1', message: 'Paused after the current node' }, 5);
    });
    expect(screen.getByRole('textbox', { name: 'Node title' })).toBeEnabled();
    await user.click(screen.getByRole('tab', { name: /^Graph/ }));
    expect(await screen.findByText('Paused, editing enabled')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Customer portal frontend' }));
    expect(screen.getByRole('button', { name: 'Resume original plan' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Resume original plan' }));
    expect(await screen.findByRole('button', { name: 'Pause after current node' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Pause after current node' }));
    act(() => {
      executionStream.emit('execution.paused', { id: 'event-4', executionId: 'run-1', message: 'Paused again for successor planning' }, 6);
    });
    expect(await screen.findByText('Paused again for successor planning')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Resume original plan' })).toBeEnabled();

    await user.type(screen.getByRole('textbox', { name: 'Node known context' }), ' Add a checkpoint-safe restart.');
    await user.type(screen.getByRole('textbox', { name: 'Planner instructions' }), 'Preserve completed frontend work.');
    await user.click(screen.getByRole('button', { name: 'Create next plan' }));

    expect((await screen.findAllByText('Plan v2')).length).toBeGreaterThan(0);
    expect(screen.getByText('Replanned from v1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Compare versions' }));
    expect(await screen.findByTestId('diff-editor')).toBeInTheDocument();

    await user.type(screen.getByRole('textbox', { name: 'Approval rationale' }), 'Continue with the new constraint');
    await user.click(screen.getByRole('button', { name: 'Approve plan v2' }));
    expect(await screen.findByRole('button', { name: 'Continue successor' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Continue successor' }));

    await waitFor(() => expect(MockEventSource.instances.some((stream) => String(stream.url) === '/api/executions/run-2/events')).toBe(true));
    await user.click(screen.getByRole('tab', { name: /Execution/i }));
    expect(await screen.findByText('Successor')).toBeInTheDocument();
    expect(screen.getByText('Resumed from checkpoint after-step-1')).toBeInTheDocument();

    const calls = vi.mocked(fetch).mock.calls.map(([url, init]) => `${(init?.method ?? 'GET').toUpperCase()} ${String(url)}`);
    expect(calls).not.toContain('GET /api/session');
    expect(calls).toContain('PUT /api/graphs/graph-1/draft');
    expect(calls).toContain('POST /api/executions/run-1/replan');
    expect(calls).toContain('POST /api/executions/run-1/resume');
    const draftCall = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith('/draft') && init?.method === 'PUT');
    expect(new Headers(draftCall?.[1]?.headers).get('X-EGE-Session')).toBeNull();
    const approvalCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === '/api/plans/plan-1/approve');
    expect(JSON.parse(String(approvalCall?.[1]?.body))).toMatchObject({ expectedContentHash: 'hash-plan-1', rationale: 'Use the accessible design constraints' });
    const executeCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === '/api/graphs/graph-1/executions');
    expect(JSON.parse(String(executeCall?.[1]?.body))).toEqual({
      planId: 'plan-1', expectedPlanHash: 'hash-plan-1', provider: 'codex-cli',
    });
    const replanCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === '/api/executions/run-1/replan');
    expect(JSON.parse(String(replanCall?.[1]?.body)).draft.nodes).toHaveLength(1);
    const resumeModes = vi.mocked(fetch).mock.calls
      .filter(([url]) => String(url) === '/api/executions/run-1/resume')
      .map(([, init]) => JSON.parse(String(init?.body)).mode);
    expect(resumeModes).toEqual(['PINNED_PLAN', 'APPROVED_REPLAN']);
  }, 15_000);

  it('keeps local agents implicit while selecting the connected AI or CLI runtime', async () => {
    const originalFetch = vi.mocked(fetch).getMockImplementation()!;
    let requestedProvider = '';
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const auxiliary = auxiliaryResponse(url, method);
      if (auxiliary) return auxiliary;
      if (url === '/api/providers') {
        return json({ items: [
          {
            id: 'local-agents', label: 'Local agents', kind: 'local-planner', available: true,
            configured: true, ready: true, capabilities: ['plan'],
            detail: 'Context parser and configured agent catalog; no model, network request, project scan, or CLI probe.',
          },
          {
            id: 'codex-cli', label: 'Codex CLI', kind: 'cli', available: true, configured: true,
            capabilities: ['plan'], connection: { providerId: 'codex-cli', status: 'CONNECTED', verified: true },
          },
        ] });
      }
      if (url === '/api/graphs/graph-1/plans' && method === 'POST') {
        requestedProvider = (JSON.parse(String(init?.body)) as { provider: string }).provider;
        currentPlanVersion += 1;
        return json({ plan: { ...plan(currentPlanVersion), provider: 'codex-cli' } });
      }
      return originalFetch(input, init);
    });

    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByText('Product build')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Agent runtime' }));
    expect(screen.queryByRole('option', { name: /Local agents/i })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Create node' }));
    await user.type(screen.getByRole('textbox', { name: 'Node name' }), 'Memory architecture');
    await user.type(screen.getByRole('textbox', { name: 'Node objective' }), 'Design durable contextual memory.');
    await user.click(screen.getByRole('button', { name: 'Create node' }));
    await user.click(screen.getByRole('button', { name: 'Request plan' }));

    expect((await screen.findAllByText('Plan v1')).length).toBeGreaterThan(0);
    expect(requestedProvider).toBe('codex-cli');
    await user.click(screen.getByRole('tab', { name: 'Memory architecture' }));
    expect(screen.getByRole('textbox', { name: 'Node title' })).toHaveValue('Memory architecture');
    expect(screen.queryByText(/local skills/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^skills:/i)).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url) === '/api/skills')).toBe(false);
  });

  it('reopens overlapping nodes from the library and keeps their refinement visible', async () => {
    draftNodes = [
      {
        id: 'intent-one', title: 'Planner memory', kind: 'custom', description: 'Plan durable memory.',
        context: 'First node context.', position: { x: -207, y: 84 },
      },
      {
        id: 'intent-two', title: 'Long-term memory', kind: 'custom', description: 'Store durable memory.',
        context: 'Second node context.', position: { x: -244, y: 90 },
      },
    ];
    const user = userEvent.setup();
    render(<App />);

    const firstNode = await screen.findByRole('button', { name: 'Refine node Planner memory' });
    const secondNode = screen.getByRole('button', { name: 'Refine node Long-term memory' });
    expect(firstNode).toHaveAttribute('aria-pressed', 'true');

    await user.dblClick(secondNode);
    expect(secondNode).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('textbox', { name: 'Node title' })).toHaveValue('Long-term memory');

    await user.clear(screen.getByRole('textbox', { name: 'Node desired outcome' }));
    await user.type(screen.getByRole('textbox', { name: 'Node desired outcome' }), 'Store refined durable memory safely.');
    await user.click(firstNode);
    await user.click(secondNode);

    expect(screen.getByRole('textbox', { name: 'Node desired outcome' })).toHaveValue('Store refined durable memory safely.');
    expect(screen.queryByText('Select a node')).not.toBeInTheDocument();
  });

  it('adopts editable suggestions without retaining the superseded proposal or deleted chat selection', async () => {
    draftNodes = [{ id: 'intent-portal', title: 'Customer portal', description: 'Build an accessible portal.', context: '', skills: [], position: { x: 40, y: 60 } }];
    const original = vi.mocked(fetch).getMockImplementation()!;
    let adopted = false;
    let historicalPlan: ReturnType<typeof plan> | undefined;
    let adoptionBody: Record<string, unknown> | undefined;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input); const method = (init?.method ?? 'GET').toUpperCase();
      if (url === '/api/graphs/graph-1/plans/plan-1/adopt' && method === 'POST') {
        adoptionBody = JSON.parse(String(init?.body));
        historicalPlan = { ...plan(1), status: 'SUPERSEDED' };
        adopted = true;
        draftNodes = [...draftNodes, { id: 'adopted-experience', title: 'Experience engineering', description: 'Build the accessible customer portal experience.', context: 'Adopted from Plan v1.', skills: [], position: { x: 200, y: 60 } }];
        draftRevision += 1;
        return json({ draft: { nodes: draftNodes, edges: [], revision: draftRevision }, sourcePlanId: 'plan-1', adoptedNodeIds: ['adopted-experience'], idempotent: false });
      }
      if (adopted && url === '/api/graphs/graph-1' && method === 'GET') {
        // The old proposal remains in server history; the editor must explicitly clear it.
        return json({ graph: graphMetadata, draft: { nodes: draftNodes, edges: [], revision: draftRevision }, plans: [historicalPlan], executions: [] });
      }
      return original(input, init);
    });
    const user = userEvent.setup(); render(<App />);
    await screen.findByRole('button', { name: 'Refine node Customer portal' });
    await user.click(screen.getByRole('button', { name: 'Request plan' }));
    const proposalName = 'Experience engineering, proposed specialist, drag to move or select for details';
    await user.click(await screen.findByRole('button', { name: proposalName }));
    expect(screen.getByRole('button', { name: 'Approve plan v1' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit suggested nodes' }));
    const review = within(screen.getByRole('region', { name: 'Review suggested nodes' }));
    expect(review.getByRole('checkbox', { name: 'Include Experience engineering' })).toBeChecked();
    await user.click(review.getByRole('button', { name: 'Use 1 suggested nodes' }));

    await screen.findByTestId('canvas-position-adopted-experience');
    expect(screen.getByTestId('canvas-position-intent-portal')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /^Graph/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('button', { name: proposalName })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve plan v1' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit suggested nodes' })).not.toBeInTheDocument();
    expect(adoptionBody).toMatchObject({ nodeIds: ['specialist:experience'], expectedDraftRevision: 1, requestId: expect.any(String) });
    expect(historicalPlan?.status).toBe('SUPERSEDED');

    await user.dblClick(screen.getByRole('button', { name: 'Refine node Experience engineering' }));
    expect(screen.getByRole('textbox', { name: 'Node title' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: 'Node title' })).toHaveValue('Experience engineering');
    await user.clear(screen.getByRole('textbox', { name: 'Node desired outcome' }));
    await user.type(screen.getByRole('textbox', { name: 'Node desired outcome' }), 'Build keyboard navigation first.');
    await user.click(screen.getByRole('button', { name: /Save draft/i }));
    await waitFor(() => expect(draftNodes.find((node) => node.id === 'adopted-experience')?.description).toBe('Build keyboard navigation first.'));
    expect(await screen.findByText(/^Context · Experience engineering ·/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete Experience engineering' }));
    expect(await screen.findByText(/^Context · Workspace ·/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refine node Experience engineering' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Save draft/i }));
    await waitFor(() => expect(draftNodes.map((node) => node.id)).toEqual(['intent-portal']));
  });

  it('selects an immutable proposal node, persists its linked intent refinement, and creates Plan vNext', async () => {
    draftNodes = [{
      id: 'intent-customer-portal',
      title: 'Customer portal',
      kind: 'custom',
      description: 'Build an accessible customer portal.',
      context: 'Keyboard navigation is required.',
      position: { x: 40, y: 60 },
    }];
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole('tab', { name: 'Customer portal' }));
    expect(await screen.findByRole('textbox', { name: 'Node title' })).toHaveValue('Customer portal');
    await user.click(screen.getByRole('button', { name: 'Request plan' }));
    await user.click(screen.getByRole('tab', { name: /^Graph/ }));

    const proposalNode = await screen.findByRole('button', {
      name: 'Experience engineering, proposed specialist, drag to move or select for details',
    });
    await user.click(proposalNode);
    await user.click(screen.getByRole('tab', { name: 'Experience engineering' }));

    const inspector = await screen.findByRole('complementary', { name: 'Proposal inspector for Experience engineering' });
    expect(within(inspector).getByText('Plan v1 immutable')).toBeInTheDocument();
    expect(within(inspector).getByText('Build the accessible customer portal experience.')).toBeInTheDocument();
    expect(within(inspector).getByText('experience-agent')).toBeInTheDocument();
    expect(within(inspector).getByText('Customer portal')).toBeInTheDocument();
    expect(within(inspector).getByText('The frontend is keyboard accessible.')).toBeInTheDocument();

    const refinement = 'Add focus recovery, narrow viewport checks, and screen reader acceptance criteria.';
    await user.type(within(inspector).getByRole('textbox', { name: 'Refinement request for Experience engineering' }), refinement);
    await user.click(within(inspector).getByRole('button', { name: 'Save refinement and create Plan v2' }));

    expect(await screen.findByText('Plan v2 immutable')).toBeInTheDocument();
    expect(screen.getByText('Replanned from v1')).toBeInTheDocument();
    expect(String(draftNodes[0].context)).toContain('[Proposal refinement from Plan v1: Experience engineering]');
    expect(String(draftNodes[0].context)).toContain(refinement);

    const planCalls = vi.mocked(fetch).mock.calls.filter(([url, init]) => (
      String(url) === '/api/graphs/graph-1/plans' && init?.method === 'POST'
    ));
    expect(planCalls).toHaveLength(2);
    expect(JSON.parse(String(planCalls[1][1]?.body)).instructions).toContain('Recompile proposal node specialist:experience');
    expect(JSON.parse(String(planCalls[1][1]?.body)).instructions).toContain(refinement);
    expect(JSON.parse(String(planCalls[1][1]?.body)).parentPlanId).toBe('plan-1');

    const draftCalls = vi.mocked(fetch).mock.calls.filter(([url, init]) => (
      String(url) === '/api/graphs/graph-1/draft' && init?.method === 'PUT'
    ));
    expect(draftCalls).toHaveLength(1);
    expect(JSON.parse(String(draftCalls[0][1]?.body)).nodes[0].context).toContain(refinement);
  });

  it('uses the preferred connected Codex provider for opt-in live research', async () => {
    draftNodes = [{
      id: 'intent-research',
      title: 'Standards-aware API',
      kind: 'custom',
      description: 'Design an API against current primary standards.',
      context: 'Use cited authoritative sources.',
      position: { x: 40, y: 60 },
    }];
    const user = userEvent.setup();
    render(<App />);

    const research = await screen.findByRole('checkbox', { name: 'Live web research' });
    expect(research).toBeEnabled();
    await user.click(research);
    expect(research).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Request plan' }));
    expect((await screen.findAllByText('Plan v1')).length).toBeGreaterThan(0);

    const planCall = vi.mocked(fetch).mock.calls.find(([url, init]) => (
      String(url) === '/api/graphs/graph-1/plans' && init?.method === 'POST'
    ));
    expect(JSON.parse(String(planCall?.[1]?.body))).toMatchObject({
      provider: 'codex-cli',
      research: { enabled: true },
    });
  });

  it('reloads the active pinned plan instead of a superseded successor and hydrates its research policy', async () => {
    draftNodes = [{
      id: 'intent-reload',
      title: 'Reload-safe system',
      kind: 'custom',
      description: 'Keep execution and plan lineage aligned after reload.',
      context: 'Use live primary-source research.',
      position: { x: 40, y: 60 },
    }];
    draftRevision = 4;
    const basePlan = plan(1);
    const approvedCodexPlan = {
      ...basePlan,
      provider: 'codex-cli',
      status: 'APPROVED',
      plan: {
        ...basePlan.plan,
        contextManifest: {
          researchPolicy: {
            enabled: true,
            provider: 'codex-cli',
            tool: 'web_search',
            mode: 'live',
            digest: 'sha256:approved-live-research',
          },
        },
      },
    };
    const successorBase = plan(2);
    const supersededSuccessor = { ...successorBase, status: 'SUPERSEDED' };
    const runningExecution = {
      id: 'run-reload',
      graphId: 'graph-1',
      planId: approvedCodexPlan.id,
      pendingPlanId: null,
      status: 'RUNNING',
      startedAt: '2026-08-22T08:00:00.000Z',
    };

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const auxiliary = auxiliaryResponse(url, method);
      if (auxiliary) return auxiliary;
      if (url === '/api/agents') return json({ domains: [], items: [] });
      if (url === '/api/providers') return json({ items: [
        { id: 'simulation', label: 'Simulation', kind: 'local', available: true, configured: true, capabilities: ['planning'] },
        {
          id: 'codex-cli', label: 'Codex CLI', kind: 'cli', available: true, configured: true,
          capabilities: ['plan', 'research-live-web'],
          connection: { providerId: 'codex-cli', status: 'CONNECTED', verified: true },
        },
      ] });
      if (url === '/api/graphs' && method === 'GET') return json({ items: [graphMetadata] });
      if (url === '/api/graphs/graph-1' && method === 'GET') {
        return json({
          graph: graphMetadata,
          draft: { nodes: draftNodes, edges: [], revision: draftRevision },
          plans: [approvedCodexPlan, supersededSuccessor],
          executions: [runningExecution],
        });
      }
      if (url === '/api/graphs/graph-1/sources' && method === 'GET') return json({ items: [] });
      if (url === '/api/executions/run-reload?limit=2000' && method === 'GET') {
        return json({
          execution: runningExecution,
          plan: approvedCodexPlan,
          events: [],
          eventPage: { hasMore: false, nextAfter: '', limit: 2000 },
          artifacts: [],
        });
      }
      return json({ error: { code: 'UNMOCKED', message: `${method} ${url}` } }, 500);
    }));

    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Toggle bottom panel' }));

    expect((await screen.findAllByText('Plan v1')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Plan v2')).not.toBeInTheDocument();
    expect(screen.getByText('Runtime codex-cli')).toBeInTheDocument();
    expect(screen.getByText('Web research live')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Live web research' })).toBeChecked();
    expect(screen.queryByRole('button', { name: /Approve plan v2/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause after current node' })).toBeEnabled();
  });

  it('creates an empty workspace, renames it, switches workspaces, and deletes it after confirmation', async () => {
    const user = userEvent.setup();
    const workspaceDrafts = new Map<string, { nodes: Record<string, unknown>[]; revision: number }>([
      ['workspace-1', { nodes: [], revision: 1 }],
      ['workspace-2', { nodes: [], revision: 1 }],
    ]);
    let workspaces = [
      { id: 'workspace-1', name: 'Payments', status: 'DRAFT', updatedAt: '2026-08-22T06:00:00.000Z' },
      { id: 'workspace-2', name: 'Customer portal', status: 'DRAFT', updatedAt: '2026-08-22T05:00:00.000Z' },
    ];

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const auxiliary = auxiliaryResponse(url, method);
      if (auxiliary) return auxiliary;
      if (url === '/api/providers') return json({ items: [] });
      if (url === '/api/agents') return json({ domains: [], items: [] });
      if (url === '/api/graphs' && method === 'GET') return json({ items: workspaces });
      if (url === '/api/graphs' && method === 'POST') {
        const body = JSON.parse(String(init?.body)) as { name: string };
        const created = { id: 'workspace-3', name: body.name, status: 'DRAFT', updatedAt: '2026-08-22T08:00:00.000Z' };
        workspaces = [created, ...workspaces];
        workspaceDrafts.set(created.id, { nodes: [], revision: 1 });
        return json({ graph: created }, 201);
      }
      const match = url.match(/^\/api\/graphs\/([^/]+)$/);
      if (match) {
        const workspaceId = decodeURIComponent(match[1]);
        const workspace = workspaces.find((item) => item.id === workspaceId);
        if (method === 'GET' && workspace) {
          return json({ graph: workspace, draft: { ...workspaceDrafts.get(workspaceId), edges: [] }, plans: [], executions: [] });
        }
        if (method === 'PATCH' && workspace) {
          const body = JSON.parse(String(init?.body)) as { name: string };
          const renamed = { ...workspace, name: body.name, updatedAt: '2026-08-22T08:01:00.000Z' };
          workspaces = workspaces.map((item) => item.id === workspaceId ? renamed : item);
          return json({ graph: renamed });
        }
        if (method === 'DELETE' && workspace) {
          workspaces = workspaces.filter((item) => item.id !== workspaceId);
          workspaceDrafts.delete(workspaceId);
          return new Response(null, { status: 204 });
        }
      }
      const draftMatch = url.match(/^\/api\/graphs\/([^/]+)\/draft$/);
      if (draftMatch && method === 'PUT') {
        const workspaceId = decodeURIComponent(draftMatch[1]);
        const body = JSON.parse(String(init?.body)) as { nodes: Record<string, unknown>[] };
        const nextDraft = {
          nodes: body.nodes,
          revision: (workspaceDrafts.get(workspaceId)?.revision ?? 0) + 1,
        };
        workspaceDrafts.set(workspaceId, nextDraft);
        return json({ draft: { ...nextDraft, edges: [] } });
      }
      if (url.match(/^\/api\/graphs\/[^/]+\/sources$/) && method === 'GET') return json({ items: [] });
      return json({ error: { code: 'UNMOCKED', message: `${method} ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('combobox', { name: 'Select workspace' })).toHaveTextContent('Payments');

    await user.click(screen.getByRole('button', { name: 'Create node' }));
    await user.type(screen.getByRole('textbox', { name: 'Node name' }), 'Payment requirements');
    await user.type(screen.getByRole('textbox', { name: 'Node objective' }), 'Capture the payment behavior.');
    await user.click(screen.getByRole('button', { name: 'Create node' }));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    await user.click(within(screen.getByLabelText('Workspace controls')).getByRole('button', { name: 'New' }));
    await user.type(screen.getByRole('textbox', { name: 'Workspace name' }), 'Checkout');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Select workspace' })).toHaveTextContent('Checkout'));
    expect(screen.getByText('0 nodes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Rename workspace' }));
    const renameField = screen.getByRole('textbox', { name: 'New workspace name' });
    await user.clear(renameField);
    await user.type(renameField, 'Checkout delivery');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Select workspace' })).toHaveTextContent('Checkout delivery'));

    await user.click(screen.getByRole('button', { name: 'Create node' }));
    await user.type(screen.getByRole('textbox', { name: 'Node name' }), 'Checkout requirements');
    await user.type(screen.getByRole('textbox', { name: 'Node objective' }), 'Capture checkout delivery behavior.');
    await user.click(screen.getByRole('button', { name: 'Create node' }));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: 'Select workspace' }));
    await user.click(await screen.findByRole('option', { name: 'Customer portal' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Select workspace' })).toHaveTextContent('Customer portal'));
    await user.click(screen.getByRole('combobox', { name: 'Select workspace' }));
    await user.click(await screen.findByRole('option', { name: 'Checkout delivery' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Select workspace' })).toHaveTextContent('Checkout delivery'));

    await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete workspace?' })).toHaveTextContent('Checkout delivery');
    await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Select workspace' })).toHaveTextContent('Payments'));

    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init?.method ?? 'GET').toUpperCase()} ${String(url)}`);
    expect(calls).toContain('POST /api/graphs');
    expect(calls).toContain('PATCH /api/graphs/workspace-3');
    expect(calls).toContain('DELETE /api/graphs/workspace-3');
    expect(calls.indexOf('PUT /api/graphs/workspace-1/draft')).toBeLessThan(calls.indexOf('POST /api/graphs'));
    expect(calls.indexOf('PUT /api/graphs/workspace-3/draft')).toBeLessThan(calls.indexOf('GET /api/graphs/workspace-2'));
    expect(workspaceDrafts.get('workspace-1')?.nodes).toHaveLength(1);
  });

  it('keeps the current workspace active and does not create another workspace when its dirty draft cannot be saved', async () => {
    const user = userEvent.setup();
    const workspaces = [
      { id: 'workspace-1', name: 'Payments', status: 'DRAFT', updatedAt: '2026-08-22T06:00:00.000Z' },
      { id: 'workspace-2', name: 'Customer portal', status: 'DRAFT', updatedAt: '2026-08-22T05:00:00.000Z' },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const auxiliary = auxiliaryResponse(url, method);
      if (auxiliary) return auxiliary;
      if (url === '/api/providers') return json({ items: [] });
      if (url === '/api/agents') return json({ domains: [], items: [] });
      if (url === '/api/graphs' && method === 'GET') return json({ items: workspaces });
      if (url === '/api/graphs/workspace-1' && method === 'GET') {
        return json({ graph: workspaces[0], draft: { nodes: [], edges: [], revision: 1 }, plans: [], executions: [] });
      }
      if (url === '/api/graphs/workspace-1' && method === 'PATCH') return json({ graph: workspaces[0] });
      if (url === '/api/graphs/workspace-1/draft' && method === 'PUT') {
        return json({ error: { code: 'SAVE_FAILED', message: 'Draft save failed' } }, 500);
      }
      if (url === '/api/graphs/workspace-1/sources' && method === 'GET') return json({ items: [] });
      if (url === '/api/graphs' && method === 'POST') {
        return json({ graph: { id: 'workspace-3', name: 'Must not be created', status: 'DRAFT' } }, 201);
      }
      if (url === '/api/graphs/workspace-2' && method === 'GET') {
        return json({ graph: workspaces[1], draft: { nodes: [], edges: [], revision: 1 }, plans: [], executions: [] });
      }
      return json({ error: { code: 'UNMOCKED', message: `${method} ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('combobox', { name: 'Select workspace' })).toHaveTextContent('Payments');

    await user.click(screen.getByRole('button', { name: 'Create node' }));
    await user.type(screen.getByRole('textbox', { name: 'Node name' }), 'Unsaved payment behavior');
    await user.type(screen.getByRole('textbox', { name: 'Node objective' }), 'Keep this node in the current workspace.');
    await user.click(screen.getByRole('button', { name: 'Create node' }));

    await user.click(screen.getByRole('tab', { name: 'Unsaved payment behavior' }));

    await user.click(screen.getByRole('combobox', { name: 'Select workspace' }));
    await user.click(await screen.findByRole('option', { name: 'Customer portal' }));
    expect(await screen.findByText('Draft save failed')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Select workspace' })).toHaveTextContent('Payments');
    expect(screen.getByRole('textbox', { name: 'Node title' })).toHaveValue('Unsaved payment behavior');

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await user.click(within(screen.getByLabelText('Workspace controls')).getByRole('button', { name: 'New' }));
    await user.type(screen.getByRole('textbox', { name: 'Workspace name' }), 'Must not be created');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    const createDialog = await screen.findByRole('dialog', { name: 'Create workspace' });
    expect(within(createDialog).getByRole('alert')).toHaveTextContent('Draft save failed');
    await user.click(within(createDialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('combobox', { name: 'Select workspace' })).toHaveTextContent('Payments');
    const calls = fetchMock.mock.calls.map(([url, init]) => `${(init?.method ?? 'GET').toUpperCase()} ${String(url)}`);
    expect(calls).not.toContain('GET /api/graphs/workspace-2');
    expect(calls).not.toContain('POST /api/graphs');
  });

  it('saves a dirty draft before changing the desktop local project binding', async () => {
    const user = userEvent.setup();
    let workspacePath = '/Users/example/Projects/orders';
    let nodes: Record<string, unknown>[] = [];
    let revision = 1;
    window.egeDesktop = {
      platform: 'darwin',
      appVersion: '0.1.0',
      selectWorkspaceDirectory: vi.fn(async () => '/Users/example/Projects/orders-v2'),
    };
    const metadata = () => ({
      id: 'workspace-local',
      name: 'Orders',
      workspacePath,
      status: 'DRAFT',
      updatedAt: '2026-08-22T08:00:00.000Z',
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const auxiliary = auxiliaryResponse(url, method);
      if (auxiliary) return auxiliary;
      if (url === '/api/providers') return json({ items: [] });
      if (url === '/api/agents') return json({ domains: [], items: [] });
      if (url === '/api/graphs' && method === 'GET') return json({ items: [metadata()] });
      if (url === '/api/graphs/workspace-local' && method === 'GET') {
        return json({ graph: metadata(), draft: { nodes, edges: [], revision }, plans: [], executions: [] });
      }
      if (url === '/api/graphs/workspace-local' && method === 'PATCH') {
        const body = JSON.parse(String(init?.body)) as { name?: string; workspacePath?: string };
        if (body.workspacePath) {
          workspacePath = body.workspacePath;
          revision += 1;
          return json({
            graph: metadata(),
            draft: { nodes, edges: [], revision },
            stalePlanIds: [],
            workspaceChanged: true,
          });
        }
        return json({ graph: metadata(), draft: { nodes, edges: [], revision } });
      }
      if (url === '/api/graphs/workspace-local/draft' && method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { nodes: Record<string, unknown>[] };
        nodes = body.nodes;
        revision += 1;
        return json({ draft: { nodes, edges: [], revision } });
      }
      if (url === '/api/graphs/workspace-local/sources' && method === 'GET') return json({ items: [] });
      return json({ error: { code: 'UNMOCKED', message: `${method} ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    expect(await screen.findByRole('button', { name: /Current folder \/Users\/example\/Projects\/orders/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create node' }));
    await user.type(screen.getByRole('textbox', { name: 'Node name' }), 'Order requirements');
    await user.type(screen.getByRole('textbox', { name: 'Node objective' }), 'Implement order behavior.');
    await user.click(screen.getByRole('button', { name: 'Create node' }));
    expect(screen.getByText('Unsaved')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Change local project folder/ }));
    await user.click(screen.getByRole('button', { name: 'Choose' }));
    await user.click(screen.getByRole('button', { name: 'Use folder' }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Current folder \/Users\/example\/Projects\/orders-v2/ })).toBeInTheDocument());
    const mutatingCalls = fetchMock.mock.calls
      .map(([url, init]) => ({ url: String(url), method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} }));
    const draftIndex = mutatingCalls.findIndex((call) => call.url.endsWith('/draft') && call.method === 'PUT');
    const rebindIndex = mutatingCalls.findIndex((call) => call.url === '/api/graphs/workspace-local' && call.method === 'PATCH' && call.body.workspacePath);
    expect(draftIndex).toBeGreaterThanOrEqual(0);
    expect(rebindIndex).toBeGreaterThan(draftIndex);
    expect(nodes).toHaveLength(1);
  });

  it('persists a user-created relation between draft nodes', async () => {
    const user = userEvent.setup();
    draftNodes = [
      {
        id: 'intent:first',
        title: 'First intent',
        kind: 'custom',
        description: 'First objective',
        context: '',
        position: { x: 80, y: 80 },
      },
      {
        id: 'intent:second',
        title: 'Second intent',
        kind: 'custom',
        description: 'Second objective',
        context: '',
        position: { x: 420, y: 80 },
      },
    ];
    const fetchMock = vi.mocked(fetch);

    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Connect first two canvas nodes' }));
    expect(screen.getByText('1 relation')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
    const saveCall = [...fetchMock.mock.calls].reverse().find(([url, init]) => (
      String(url) === '/api/graphs/graph-1/draft' && (init?.method ?? 'GET').toUpperCase() === 'PUT'
    ));
    expect(saveCall).toBeDefined();
    const savedDraft = JSON.parse(String(saveCall?.[1]?.body)) as {
      edges: Array<{ source: string; target: string; label: string; type: string }>;
    };
    expect(savedDraft.edges).toEqual([{
      id: expect.any(String),
      source: 'intent:first',
      target: 'intent:second',
      label: '',
      rationale: '',
      type: 'RELATED_TO',
    }]);
  });

  it('opens selected nodes through the command palette and collapses panes with keyboard shortcuts', async () => {
    draftNodes = [{ id: 'intent-keyboard', title: 'Keyboard workflow', kind: 'custom', description: 'Configure without losing graph context.', context: 'Retained context', position: { x: 40, y: 60 } }];
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('button', { name: 'Refine node Keyboard workflow' });
    const explorerToggle = screen.getByRole('button', { name: 'Toggle explorer' });
    expect(explorerToggle).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Control>}b{/Control}');
    expect(explorerToggle).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.workbench-main')).toHaveClass('hide-left');

    await user.keyboard('{Control>}k{/Control}');
    const palette = await screen.findByRole('dialog', { name: 'Workspace commands' });
    await user.type(within(palette).getByRole('textbox', { name: 'Search commands' }), 'Keyboard workflow');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('dialog', { name: 'Workspace commands' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Node title' })).toHaveValue('Keyboard workflow');
    expect(screen.getByRole('textbox', { name: 'Node known context' })).toHaveValue('Retained context');

    await user.keyboard('{Control>}k{/Control}');
    await user.type(screen.getByRole('textbox', { name: 'Search commands' }), 'Focus graph');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('tab', { name: /^Graph/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: 'Toggle chat sidebar' })).toHaveAttribute('aria-pressed', 'false');
    expect(document.querySelector('.workbench-main')).toHaveClass('hide-left', 'hide-right', 'hide-bottom');
  });

  it('shows recoverable empty, loading, and backend error states', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/graphs') return json({ error: { code: 'OFFLINE', message: 'Local graph service is unavailable' } }, 503);
      if (url === '/api/providers') return json({ items: [] });
      return json({}, 404);
    }));

    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading local workspaces');
    expect(await screen.findByText('Local graph service is unavailable')).toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('error-callout');
    expect(alert.closest('.workbench-shell')).toHaveClass('has-error');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });
});
