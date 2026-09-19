import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, configureApiOrigin, eventStreamUrl } from './api';
import type { EngineeringGraph } from './types';

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function executionPayload(events: Array<Record<string, unknown>>, eventPage: Record<string, unknown>) {
  return {
    execution: { id: 'run-history', graphId: 'graph-1', planId: 'plan-1', status: 'COMPLETED' },
    plan: {
      id: 'plan-1',
      graphId: 'graph-1',
      version: 1,
      baseDraftRevision: 4,
      contentHash: 'hash-1',
      status: 'AWAITING_APPROVAL',
      plan: {
        summary: 'Historical plan',
        auditFieldRetainedOnlyInRawPlan: 'exact-value',
        contextManifest: {
          researchPolicy: {
            enabled: true,
            provider: 'codex-cli',
            tool: 'web_search',
            mode: 'live',
            digest: 'sha256:research-policy',
          },
        },
        steps: [{
          id: 'step:application',
          nodeId: 'specialist:application',
          title: 'Application engineering',
          objective: 'Implement the application contract.',
          acceptanceCriteria: ['The contract is versioned.'],
          dependsOn: [],
          skills: [],
          sourceIntents: [{
            id: 'node-a',
            title: 'Order status requirements',
            objective: 'Define approved order state behavior.',
            context: 'Orders have a finite state machine.',
          }],
        }],
        proposedEdges: [{ id: 'edge-1', source: 'node-a', target: 'node-b', label: 'feeds', reason: 'The API contract informs the backend implementation.' }],
        proposedGraph: {
          proposalId: 'proposal:1',
          schemaVersion: 'intent-proposed-graph/v1',
          status: 'PROPOSED',
          compilerVersion: 'intent-map-compiler/1.0.0',
          contentDigest: 'sha256:proposal',
          selectedDomains: ['application'],
          nodes: [{
            id: 'specialist:application',
            type: 'SPECIALIST_AGENT',
            domain: 'application',
            title: 'Application engineering',
            objective: 'Implement the application contract.',
            agentId: 'application-agent',
            promptDigest: 'sha256:prompt',
            dependsOn: [],
            acceptanceCriteria: ['The contract is versioned.'],
            inputs: [{ id: 'input:context', type: 'intent_evidence_bundle', required: true }],
            outputs: [{ id: 'artifact:application', type: 'application_contract', required: true, provenanceRequired: true }],
            traceability: { intentNodeIds: ['node-a'], evidenceIds: ['source-1'] },
          }],
          relationships: [{
            id: 'relationship:1',
            type: 'SUPPORTED_BY',
            from: 'sources:specialist:application',
            to: 'specialist:application',
            rationale: 'The specialist is grounded in source evidence.',
            traceability: { intentNodeIds: ['node-a'], evidenceIds: ['source-1'] },
          }],
        },
      },
    },
    events,
    eventPage,
    artifacts: [],
  };
}

describe('local API adapter', () => {
  afterEach(() => {
    configureApiOrigin();
    vi.unstubAllGlobals();
  });

  it('preserves adopted provenance and execution overrides when saving and replanning the draft', async () => {
    const proposalSource = { planId: 'p', planHash: 'hash', proposalNodeId: 'ui', sourceIntentNodeIds: ['idea'], sourceEvidenceIds: [] };
    const graph: EngineeringGraph = { id: 'g', name: 'MVP', status: 'draft', nodes: [{ id: 'ui', title: 'UI', kind: 'client', objective: 'Implement', context: 'Reviewable', status: 'draft', position: { x: 0, y: 0 }, proposalSource, agentId: 'frontend', providerId: 'codex-cli', model: 'configured-model', skills: ['skill'], inputs: ['contract'], outputs: ['app'], acceptanceCriteria: ['Build succeeds'], budgets: { maxAttempts: 2, timeoutMs: 4000 }, review: { required: true, reviewerNodeIds: ['reviewer'], providerId: 'openai-api' }, breakpoint: true, group: 'Client' }], edges: [{ id: 'e', source: 'idea', target: 'ui', type: 'DERIVED_FROM', label: 'informs', rationale: 'Preserve the idea reference' }] };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      if (String(input).endsWith('/draft')) return json({ draft: { ...body, revision: 2 } });
      if (String(input).endsWith('/replan')) return json({ execution: { id: 'run' }, plan: { id: 'new-plan', plan: { contextManifest: { engineering: { profile: 'poc', conventions: 'Use fixtures' } } } } });
      return json({ graph });
    });
    vi.stubGlobal('fetch', fetchMock);
    const saved = await api.saveGraph(graph);
    expect(saved.nodes[0].proposalSource).toEqual(proposalSource);
    expect(saved.nodes[0].review).toEqual({ required: true, reviewerNodeIds: ['reviewer'], providerId: 'openai-api' });
    const result = await api.replanExecution('run', { provider: 'codex-cli', engineeringProfile: 'poc', conventions: 'Use fixtures' }, graph);
    const body = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(body).toMatchObject({ engineeringProfile: 'poc', conventions: 'Use fixtures', draft: { nodes: [{ proposalSource, agentId: 'frontend', providerId: 'codex-cli', model: 'configured-model', skills: ['skill'], inputs: ['contract'], outputs: ['app'], acceptanceCriteria: ['Build succeeds'], budgets: { maxAttempts: 2, timeoutMs: 4000 }, review: { required: true, reviewerNodeIds: ['reviewer'], providerId: 'openai-api' }, breakpoint: true, group: 'Client' }], edges: [graph.edges[0]] } });
    expect(result.plan.engineeringProfile).toBe('poc');
    expect(result.plan.engineeringConventions).toBe('Use fixtures');
  });

  it('routes desktop API and event requests through a validated loopback origin', async () => {
    configureApiOrigin('http://127.0.0.1:45821');
    const fetchMock = vi.fn(async () => json({ items: [] }));
    vi.stubGlobal('fetch', fetchMock);

    await api.listGraphs();

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:45821/api/graphs',
      expect.objectContaining({ credentials: 'omit' }),
    );
    expect(eventStreamUrl('run-1')).toBe('http://127.0.0.1:45821/api/executions/run-1/events');
    expect(() => configureApiOrigin('https://api.example.com')).toThrow(/127\.0\.0\.1/);
  });

  it('follows eventPage cursors until durable execution history is complete', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/executions/run-history?limit=2000') {
        return json(executionPayload([
          { id: 'event-1', sequence: 1, type: 'node.started', payload: { nodeId: 'node-a' }, createdAt: '2026-08-22T07:00:00.000Z' },
          { id: 'event-2', sequence: 2, type: 'node.completed', payload: { nodeId: 'node-a' }, createdAt: '2026-08-22T07:00:01.000Z' },
        ], { hasMore: true, nextAfter: 2, limit: 2 }));
      }
      if (url === '/api/executions/run-history?limit=2000&after=2') {
        return json(executionPayload([
          { id: 'event-3', sequence: 3, type: 'execution.completed', payload: {}, createdAt: '2026-08-22T07:00:02.000Z' },
        ], { hasMore: false, nextAfter: 3, limit: 2 }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const snapshot = await api.getExecutionHistory('run-history');

    expect(snapshot.events.map((event) => event.id)).toEqual(['event-1', 'event-2', 'event-3']);
    expect(snapshot.eventPage).toMatchObject({ hasMore: false, nextAfter: '3' });
    expect(snapshot.plan?.status).toBe('proposed');
    expect(snapshot.plan?.researchPolicy).toEqual({
      enabled: true,
      provider: 'codex-cli',
      tool: 'web_search',
      mode: 'live',
      digest: 'sha256:research-policy',
    });
    expect(snapshot.plan?.proposedEdges[0].rationale).toBe('The API contract informs the backend implementation.');
    expect(snapshot.plan?.proposedGraph?.nodes[0]).toMatchObject({ id: 'specialist:application', agentId: 'application-agent' });
    expect(snapshot.plan?.proposedGraph?.relationships[0]).toMatchObject({
      source: 'sources:specialist:application',
      target: 'specialist:application',
      rationale: 'The specialist is grounded in source evidence.',
    });
    expect(snapshot.plan?.workItems[0].sourceIntents).toEqual([{
      id: 'node-a',
      title: 'Order status requirements',
      objective: 'Define approved order state behavior.',
      context: 'Orders have a finite state machine.',
    }]);
    expect(snapshot.plan?.rawDocument).toMatchObject({
      plan: {
        auditFieldRetainedOnlyInRawPlan: 'exact-value',
        steps: [{ sourceIntents: [{ title: 'Order status requirements' }] }],
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uploads source bytes and normalizes provenance-aware retrieval results', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/graphs/graph-1/sources?nodeId=node-a' && init?.method === 'POST') {
        return json({ source: {
          id: 'source-1',
          graphId: 'graph-1',
          nodeId: 'node-a',
          filename: 'requirements.md',
          mediaType: 'text/markdown',
          byteSize: 42,
          sha256: 'a'.repeat(64),
          parseStatus: 'PARSED',
          parserId: 'bounded-evidence-parser',
          parserVersion: 'evidence-parser-v1',
          chunkCount: 2,
          format: 'markdown',
          metadata: { lineCount: 4 },
        } });
      }
      if (url === '/api/graphs/graph-1/retrieve' && init?.method === 'POST') {
        return json({ query: 'keyboard', results: [{
          documentId: 'source-1',
          chunkId: 'chunk-1',
          nodeId: 'node-a',
          text: 'Keyboard navigation is required.',
          score: 0.03125,
          rank: 1,
          scores: [{ ranker: 'bm25-v1', sourceScore: 1.75 }],
          citations: [{ documentId: 'source-1', sourceName: 'requirements.md', digest: 'a'.repeat(64), locator: { lineStart: 3, lineEnd: 3 } }],
        }] });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const file = new File(['# Requirements\nKeyboard navigation is required.'], 'requirements.md', { type: 'text/markdown' });
    const source = await api.uploadSource('graph-1', 'node-a', file);
    const hits = await api.retrieveSources('graph-1', 'keyboard');

    expect(source).toMatchObject({ filename: 'requirements.md', format: 'markdown', chunkCount: 2, parseStatus: 'PARSED' });
    expect(hits[0]).toMatchObject({ text: 'Keyboard navigation is required.', score: 0.03125 });
    expect(hits[0].rankSignals).toEqual({ 'bm25-v1': 1.75 });
    expect(hits[0].citations[0].locator).toEqual({ lineStart: 3, lineEnd: 3 });
    const uploadCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/sources?nodeId='));
    expect(new Headers(uploadCall?.[1]?.headers).get('X-EGE-Filename')).toBe('requirements.md');
    expect(new Headers(uploadCall?.[1]?.headers).get('X-EGE-Session')).toBeNull();
    expect(uploadCall?.[1]?.body).toBe(file);
  });

  it('renames and deletes a workspace through the canonical graph routes', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/graphs' && init?.method === 'POST') {
        return json({ graph: {
          id: 'workspace-new',
          name: 'Desktop workspace',
          workspacePath: '/Users/example/Projects/desktop-app',
          status: 'DRAFT',
          draftRevision: 1,
          updatedAt: '2026-08-22T07:59:00.000Z',
        } });
      }
      if (url === '/api/graphs/workspace%2Fone' && init?.method === 'PATCH') {
        return json({ graph: {
          id: 'workspace/one',
          name: 'Renamed workspace',
          status: 'DRAFT',
          draftRevision: 1,
          updatedAt: '2026-08-22T08:00:00.000Z',
        } });
      }
      if (url === '/api/graphs/workspace%2Fone' && init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const created = await api.createGraph('Desktop workspace', '/Users/example/Projects/desktop-app');
    const renamed = await api.renameWorkspace('workspace/one', 'Renamed workspace');
    await api.deleteWorkspace('workspace/one');

    expect(created).toMatchObject({ name: 'Desktop workspace', workspacePath: '/Users/example/Projects/desktop-app' });
    expect(renamed).toMatchObject({ id: 'workspace/one', name: 'Renamed workspace', status: 'draft' });
    const createCall = fetchMock.mock.calls.find(([url, init]) => String(url) === '/api/graphs' && init?.method === 'POST');
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      name: 'Desktop workspace',
      workspacePath: '/Users/example/Projects/desktop-app',
    });
    const renameCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(renameCall?.[1]?.body))).toEqual({ name: 'Renamed workspace' });
    expect(new Headers(renameCall?.[1]?.headers).get('X-EGE-Session')).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/api/graphs/workspace%2Fone', expect.objectContaining({ method: 'DELETE' }));
  });

  it('sends the explicit research opt-in on both planning and replanning requests', async () => {
    const plan = {
      id: 'plan-research', graphId: 'graph-1', version: 1, provider: 'codex-cli',
      status: 'AWAITING_APPROVAL', contentHash: 'hash', plan: { summary: 'Plan', steps: [], proposedEdges: [] },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/graphs/graph-1/plans') return json({ plan });
      if (url === '/api/executions/run-1/replan') {
        return json({ execution: { id: 'run-1', graphId: 'graph-1', planId: 'plan-research', status: 'PAUSED' }, plan });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const input = {
      provider: 'codex-cli',
      additionalContext: 'Use current standards.',
      previousPlanId: 'plan-parent',
      research: { enabled: true },
    };
    await api.createPlan('graph-1', input);
    await api.replanExecution('run-1', input);

    const planCall = fetchMock.mock.calls.find(([request]) => String(request) === '/api/graphs/graph-1/plans');
    const replanCall = fetchMock.mock.calls.find(([request]) => String(request) === '/api/executions/run-1/replan');
    const planBody = JSON.parse(String(planCall?.[1]?.body));
    const replanBody = JSON.parse(String(replanCall?.[1]?.body));
    expect(planBody).toEqual({
      provider: 'codex-cli',
      instructions: 'Use current standards.',
      parentPlanId: 'plan-parent',
      research: { enabled: true },
    });
    expect(replanBody).toMatchObject({
      provider: 'codex-cli',
      instructions: 'Use current standards.',
      research: { enabled: true },
    });
  });

  it('normalizes graph trace history without confusing operation category and OTel span kind', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/graphs/graph-1/traces?limit=50') return json({
        items: [{
          id: '0123456789abcdef0123456789abcdef',
          graphId: 'graph-1',
          kind: 'EXECUTION',
          name: 'Run plan',
          status: 'RUNNING',
          startedAt: '2026-08-22T08:00:00.000Z',
        }],
        page: { limit: 50, hasMore: false },
      });
      if (url === '/api/traces/0123456789abcdef0123456789abcdef?after=0&limit=500') return json({
        trace: {
          id: '0123456789abcdef0123456789abcdef',
          graphId: 'graph-1',
          kind: 'EXECUTION',
          name: 'Run plan',
          status: 'OK',
          startedAt: '2026-08-22T08:00:00.000Z',
          endedAt: '2026-08-22T08:00:01.000Z',
        },
        spans: [{
          id: '0123456789abcdef',
          traceId: '0123456789abcdef0123456789abcdef',
          category: 'MODEL',
          spanKind: 'CLIENT',
          name: 'Provider request',
          status: 'OK',
          startedAt: '2026-08-22T08:00:00.000Z',
          endedAt: '2026-08-22T08:00:01.000Z',
          attributes: { inputCapture: { captureMode: 'REDACTED_LOCAL', redacted: true } },
          input: '[REDACTED_SECRET]',
        }],
        events: [{ sequence: 1, id: 'event-1', traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef', type: 'span.started', attributes: {}, createdAt: '2026-08-22T08:00:00.000Z' }],
        eventPage: { after: 0, nextAfter: 1, hasMore: false, limit: 500 },
      });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const list = await api.listGraphTraces('graph-1');
    const detail = await api.getTrace(list.items[0].id);

    expect(detail.spans[0]).toMatchObject({
      category: 'MODEL',
      kind: 'MODEL',
      spanKind: 'CLIENT',
      input: '[REDACTED_SECRET]',
    });
    expect(detail.events[0]).toMatchObject({ sequence: 1, type: 'span.started' });
  });

  it('changes a workspace project path through the canonical patch route', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/graphs/workspace%2Fone' && init?.method === 'PATCH') return json({
        graph: {
          id: 'workspace/one',
          name: 'Orders',
          workspacePath: '/Users/example/Projects/orders-v2',
          status: 'DRAFT',
        },
        draft: { nodes: [], edges: [], revision: 5 },
        stalePlanIds: ['plan-1'],
        workspaceChanged: true,
      });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const rebound = await api.updateWorkspacePath('workspace/one', '/Users/example/Projects/orders-v2');

    expect(rebound).toMatchObject({ workspacePath: '/Users/example/Projects/orders-v2', draftRevision: 5 });
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ workspacePath: '/Users/example/Projects/orders-v2' });
    expect(new Headers(patchCall?.[1]?.headers).get('X-EGE-Session')).toBeNull();
  });
});
