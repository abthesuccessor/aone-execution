import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TraceStreamEvent } from './types';
import { useGraphTraceStream } from './useGraphTraceStream';

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

function TraceStreamHarness() {
  const [events, setEvents] = useState<TraceStreamEvent[]>([]);
  const [connected, setConnected] = useState(false);
  useGraphTraceStream({
    graphId: 'graph-live',
    onEvent: (event) => setEvents((current) => [...current, event]),
    onConnectionChange: setConnected,
  });
  return <div>{connected ? 'connected' : 'reconnecting'} | {events.map((event) => `${event.type}:${event.traceId}:${event.spanId}`).join(',')}</div>;
}

describe('useGraphTraceStream', () => {
  afterEach(() => {
    cleanup();
    MockEventSource.instances = [];
    vi.unstubAllGlobals();
  });

  it('subscribes before planning and consumes named trace events with nested identifiers', async () => {
    vi.stubGlobal('EventSource', MockEventSource);
    render(<TraceStreamHarness />);

    await waitFor(() => expect(MockEventSource.instances).toHaveLength(1));
    expect(String(MockEventSource.instances[0].url)).toBe('/api/graphs/graph-live/traces/events');
    expect(await screen.findByText(/connected/)).toBeInTheDocument();

    act(() => {
      MockEventSource.instances[0].emit('span.started', {
        id: 'trace-event-1',
        payload: { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef' },
      }, 12);
    });

    expect(await screen.findByText(/span.started:0123456789abcdef0123456789abcdef:0123456789abcdef/)).toBeInTheDocument();
  });
});
