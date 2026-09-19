import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineeringGraph, PlanVersion, TraceStreamEvent } from '../lib/types';
import { TracePanel } from './TracePanel';

const graph: EngineeringGraph = {
  id: 'graph-trace',
  name: 'Orders project',
  workspacePath: '/Users/example/Projects/orders',
  status: 'running',
  nodes: [{
    id: 'intent-ui',
    kind: 'custom',
    title: 'Frontend requirements',
    objective: 'Build the interface.',
    context: 'Use keyboard navigation.',
    status: 'running',
    position: { x: 20, y: 30 },
  }],
  edges: [],
};

const plan: PlanVersion = {
  id: 'plan-trace',
  graphId: graph.id,
  version: 1,
  provider: 'codex-cli',
  status: 'approved',
  contentHash: 'hash',
  summary: 'Implement the UI.',
  proposedEdges: [],
  workItems: [],
  proposedGraph: {
    proposalId: 'proposal-trace',
    schemaVersion: 'intent-proposed-graph/v1',
    status: 'PROPOSED',
    compilerVersion: '1',
    contentDigest: 'digest',
    selectedDomains: ['experience'],
    nodes: [{
      id: 'specialist-ui',
      type: 'SPECIALIST_AGENT',
      domain: 'experience',
      title: 'Experience engineering',
      objective: 'Implement the UI.',
      agentId: 'experience-agent',
      promptDigest: 'sha256:prompt',
      dependsOn: [],
      acceptanceCriteria: [],
      inputs: [],
      outputs: [],
      traceability: { intentNodeIds: ['intent-ui'], evidenceIds: [] },
    }],
    relationships: [],
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function renderTrace(liveEvents: TraceStreamEvent[] = []) {
  return render(
    <Theme appearance="dark">
      <TracePanel
        graph={graph}
        plan={plan}
        execution={{ id: 'execution-trace', graphId: graph.id, planId: plan.id, status: 'running' }}
        selectedNodeId="intent-ui"
        liveEvents={liveEvents}
        connected
      />
    </Theme>,
  );
}

describe('TracePanel', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders a causal live trace, maps a selected intent to its specialist, and marks captured data honestly', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/graphs/graph-trace/traces?limit=50') return json({
        items: [{
          id: '0123456789abcdef0123456789abcdef',
          traceId: '0123456789abcdef0123456789abcdef',
          graphId: graph.id,
          executionId: 'execution-trace',
          planId: plan.id,
          kind: 'EXECUTION',
          name: 'Execute approved plan',
          status: 'RUNNING',
          rootSpanId: '0123456789abcdef',
          provider: 'codex-cli',
          model: 'gpt-5.6-sol',
          startedAt: '2026-08-22T08:00:00.000Z',
        }],
        page: { limit: 50, hasMore: false },
      });
      if (url === '/api/traces/0123456789abcdef0123456789abcdef?after=0&limit=500') return json({
        trace: {
          id: '0123456789abcdef0123456789abcdef',
          graphId: graph.id,
          executionId: 'execution-trace',
          planId: plan.id,
          kind: 'EXECUTION',
          name: 'Execute approved plan',
          status: 'RUNNING',
          rootSpanId: '0123456789abcdef',
          provider: 'codex-cli',
          model: 'gpt-5.6-sol',
          startedAt: '2026-08-22T08:00:00.000Z',
        },
        spans: [
          {
            id: '0123456789abcdef',
            traceId: '0123456789abcdef0123456789abcdef',
            name: 'Execute approved plan',
            category: 'GRAPH',
            spanKind: 'INTERNAL',
            status: 'RUNNING',
            startedAt: '2026-08-22T08:00:00.000Z',
            attributes: { captureMode: 'REDACTED_LOCAL', exportMode: 'DISABLED' },
          },
          {
            id: '1111111111111111',
            traceId: '0123456789abcdef0123456789abcdef',
            parentSpanId: '0123456789abcdef',
            nodeId: 'specialist-ui',
            name: 'Experience engineering',
            category: 'NODE',
            spanKind: 'INTERNAL',
            status: 'RUNNING',
            startedAt: '2026-08-22T08:00:00.010Z',
            attributes: { sourceIntentNodeIds: ['intent-ui'], agentId: 'experience-agent' },
          },
          {
            id: '2222222222222222',
            traceId: '0123456789abcdef0123456789abcdef',
            parentSpanId: '1111111111111111',
            name: 'ege.model.invoke',
            category: 'MODEL',
            spanKind: 'CLIENT',
            status: 'OK',
            startedAt: '2026-08-22T08:00:00.020Z',
            endedAt: '2026-08-22T08:00:00.120Z',
            durationMs: 100,
            agentId: 'experience-agent',
            attributes: {
              displayName: 'Model request',
              provider: 'codex-cli',
              model: 'gpt-5.6-sol',
              promptDigest: 'sha256:prompt',
              inputCapture: { captureMode: 'REDACTED_LOCAL', redacted: true, truncated: true },
              outputCapture: { captureMode: 'REDACTED_LOCAL', redacted: false, truncated: false },
            },
            input: 'apiKey=[REDACTED_OPENAI_KEY]\ncontext=[TRUNCATED_DEPTH]',
            output: { result: 'Generated App.tsx' },
          },
        ],
        events: [{
          sequence: 3,
          id: 'event-model',
          traceId: '0123456789abcdef0123456789abcdef',
          spanId: '2222222222222222',
          type: 'model.response',
          attributes: { outputTokens: 41 },
          timestamp: '2026-08-22T08:00:00.120Z',
        }],
        eventPage: { after: 0, nextAfter: 3, hasMore: false, limit: 500 },
      });
      return json({ error: { message: `Unmocked ${url}` } }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderTrace();

    expect(await screen.findByText('Execute approved plan')).toBeInTheDocument();
    expect(screen.getByText('Observed and redacted')).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Filter traces by selected node Frontend requirements' })).toHaveAttribute('aria-pressed', 'true');
    expect(await screen.findByText('Model request')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Model request/ }));
    expect(screen.getByText('Redacted')).toBeInTheDocument();
    expect(screen.getByText('Truncated')).toBeInTheDocument();
    expect(screen.getByText('REDACTED_LOCAL')).toBeInTheDocument();
    expect(screen.getByText(/apiKey=\[REDACTED_OPENAI_KEY\]/)).toBeInTheDocument();
    expect(screen.getByText(/context=\[TRUNCATED_DEPTH\]/)).toBeInTheDocument();
    expect(screen.getByText(/Hidden model reasoning is never captured/)).toBeInTheDocument();
    expect(screen.getByText('model.response')).toBeInTheDocument();
    expect(screen.getByText('CLIENT')).toBeInTheDocument();
    expect(screen.getByText('ege.model.invoke')).toBeInTheDocument();
  });

  it('shows a recoverable error state when trace storage is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'TRACE_OFFLINE', message: 'Local trace store is unavailable' } }, 503)));
    renderTrace();

    expect(await screen.findByRole('alert')).toHaveTextContent('Local trace store is unavailable');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
