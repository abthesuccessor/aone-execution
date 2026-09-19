import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutionPanel } from '../components/ExecutionPanel';
import type { EngineeringGraph, ExecutionEvent, ExecutionRun } from './types';
import { useExecutionStream } from './useExecutionStream';

type MessageHandler = (event: MessageEvent<string>) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly handlers = new Map<string, Set<MessageHandler>>();
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  constructor(readonly url: string | URL) {
    MockEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.(new Event('open')));
  }

  addEventListener(type: string, callback: EventListenerOrEventListenerObject) {
    const listener = typeof callback === 'function' ? callback : callback.handleEvent.bind(callback);
    const handlers = this.handlers.get(type) ?? new Set<MessageHandler>();
    handlers.add(listener as MessageHandler);
    this.handlers.set(type, handlers);
  }

  removeEventListener(type: string, callback: EventListenerOrEventListenerObject) {
    const listener = typeof callback === 'function' ? callback : callback.handleEvent.bind(callback);
    this.handlers.get(type)?.delete(listener as MessageHandler);
  }

  close() {}

  emit(type: string, value: Record<string, unknown>, sequence: number) {
    const event = new MessageEvent<string>(type, {
      data: JSON.stringify({ ...value, type, sequence, createdAt: '2026-08-22T08:00:00.000Z' }),
      lastEventId: String(sequence),
    });
    this.handlers.get(type)?.forEach((handler) => handler(event));
  }
}

const graph: EngineeringGraph = {
  id: 'graph-progress',
  name: 'Progress graph',
  status: 'running',
  nodes: [{
    id: 'specialist:application',
    kind: 'application',
    title: 'Application engineering',
    objective: 'Implement the application contract.',
    context: '',
    status: 'running',
    position: { x: 100, y: 100 },
  }],
  edges: [],
};

const execution: ExecutionRun = {
  id: 'execution-progress',
  graphId: graph.id,
  planId: 'plan-progress',
  status: 'running',
};

function ProgressHarness() {
  const [events, setEvents] = useState<ExecutionEvent[]>([]);
  const [connected, setConnected] = useState(false);
  useExecutionStream({
    executionId: execution.id,
    onEvent: (event) => setEvents((current) => [...current, event]),
    onConnectionChange: setConnected,
  });
  return (
    <ExecutionPanel
      graph={graph}
      execution={execution}
      executions={[execution]}
      events={events}
      artifacts={[]}
      connected={connected}
    />
  );
}

describe('useExecutionStream named progress events', () => {
  afterEach(() => {
    MockEventSource.instances = [];
    vi.unstubAllGlobals();
  });

  it('retains and renders node.progress frames from the named SSE channel', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    render(<ProgressHarness />);

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(String(MockEventSource.instances[0].url)).toBe('/api/executions/execution-progress/events');

    act(() => {
      MockEventSource.instances[0].emit('node.progress', {
        id: 'event-progress-1',
        executionId: execution.id,
        payload: {
          nodeId: 'specialist:application',
          message: 'Generated 2 of 5 application files',
          completed: 2,
          total: 5,
        },
      }, 17);
      MockEventSource.instances[0].emit('node.completed', {
        id: 'event-completed-1',
        executionId: execution.id,
        payload: { nodeId: 'specialist:application', message: 'Application work completed' },
      }, 18);
    });

    expect(await screen.findByText('Generated 2 of 5 application files')).toBeInTheDocument();
    expect(screen.getByText('node.progress')).toBeInTheDocument();
    expect(screen.getAllByText('Application engineering')).toHaveLength(2);
    expect(screen.getByText('Application work completed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Events 2/ })).toBeInTheDocument();
  });
});
