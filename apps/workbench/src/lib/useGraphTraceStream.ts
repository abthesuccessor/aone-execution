import { useEffect, useRef } from 'react';
import { graphTraceEventStreamUrl } from './api';
import type { TraceStreamEvent } from './types';

const TRACE_EVENT_TYPES = [
  'trace.started',
  'span.started',
  'span.event',
  'span.ended',
  'trace.ended',
] as const;

function parseTraceStreamEvent(message: MessageEvent<string>, fallbackType: string): TraceStreamEvent | undefined {
  try {
    const value = JSON.parse(message.data) as Record<string, unknown>;
    const payload = value.payload && typeof value.payload === 'object'
      ? value.payload as Record<string, unknown>
      : value.data && typeof value.data === 'object'
        ? value.data as Record<string, unknown>
        : value.attributes && typeof value.attributes === 'object'
          ? value.attributes as Record<string, unknown>
          : {};
    const sequence = value.sequence ?? value.cursor ?? message.lastEventId;
    return {
      id: String(value.id ?? sequence ?? crypto.randomUUID()),
      cursor: String(sequence ?? ''),
      traceId: value.traceId || payload.traceId ? String(value.traceId ?? payload.traceId) : undefined,
      spanId: value.spanId || payload.spanId ? String(value.spanId ?? payload.spanId) : undefined,
      executionId: value.executionId || payload.executionId ? String(value.executionId ?? payload.executionId) : undefined,
      planId: value.planId || payload.planId ? String(value.planId ?? payload.planId) : undefined,
      nodeId: value.nodeId || payload.nodeId ? String(value.nodeId ?? payload.nodeId) : undefined,
      type: String(value.type ?? fallbackType),
      timestamp: String(value.timestamp ?? value.createdAt ?? payload.timestamp ?? new Date().toISOString()),
      data: payload,
    };
  } catch {
    return undefined;
  }
}

export interface GraphTraceStreamOptions {
  graphId?: string;
  initialCursor?: string;
  onEvent: (event: TraceStreamEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export function useGraphTraceStream({
  graphId,
  initialCursor,
  onEvent,
  onConnectionChange,
}: GraphTraceStreamOptions): void {
  const onEventRef = useRef(onEvent);
  const connectionRef = useRef(onConnectionChange);
  const cursorByGraphRef = useRef(new Map<string, string>());

  onEventRef.current = onEvent;
  connectionRef.current = onConnectionChange;

  useEffect(() => {
    if (!graphId) return;

    const cursor = cursorByGraphRef.current.get(graphId) ?? initialCursor;
    const stream = new EventSource(graphTraceEventStreamUrl(graphId, cursor));
    const handlers = new Map<string, EventListener>();

    const consume = (fallbackType: string) => (raw: Event) => {
      const event = parseTraceStreamEvent(raw as MessageEvent<string>, fallbackType);
      if (!event) return;
      cursorByGraphRef.current.set(graphId, event.cursor);
      onEventRef.current(event);
    };

    stream.onopen = () => connectionRef.current?.(true);
    stream.onerror = () => connectionRef.current?.(false);
    stream.onmessage = consume('span.event');

    for (const eventType of TRACE_EVENT_TYPES) {
      const handler = consume(eventType) as EventListener;
      handlers.set(eventType, handler);
      stream.addEventListener(eventType, handler);
    }

    return () => {
      for (const [eventType, handler] of handlers) stream.removeEventListener(eventType, handler);
      stream.close();
      connectionRef.current?.(false);
    };
  }, [graphId]);
}
