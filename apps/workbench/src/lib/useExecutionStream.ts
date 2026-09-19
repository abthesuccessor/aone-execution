import { useEffect, useRef } from 'react';
import { eventStreamUrl } from './api';
import type { ExecutionEvent } from './types';

const EVENT_TYPES = [
  'execution.started',
  'execution.pause_requested',
  'execution.paused',
  'execution.resumed',
  'execution.resumed_from_checkpoint',
  'execution.recovered',
  'execution.completed',
  'execution.failed',
  'execution.superseded',
  'node.started',
  'node.progress',
  'node.completed',
  'node.failed',
  'node.skipped',
  'artifact.created',
  'verification.receipt',
  'plan.replanned',
  'plan.approved',
  'plan.discarded',
] as const;

function parseEvent(message: MessageEvent<string>, fallbackType: string): ExecutionEvent | undefined {
  try {
    const value = JSON.parse(message.data) as Record<string, unknown>;
    const payload = value.payload && typeof value.payload === 'object' ? value.payload as Record<string, unknown> : {};
    const sequence = value.sequence ?? value.cursor ?? message.lastEventId;
    return {
      ...(value as unknown as ExecutionEvent),
      id: String(value.id ?? sequence ?? crypto.randomUUID()),
      cursor: String(sequence ?? ''),
      type: String(value.type ?? fallbackType),
      level: (value.level ?? payload.level ?? (fallbackType.endsWith('failed') ? 'error' : fallbackType.endsWith('completed') ? 'success' : 'info')) as ExecutionEvent['level'],
      message: String(value.message ?? payload.message ?? fallbackType.replaceAll('.', ' ')),
      timestamp: String(value.timestamp ?? value.createdAt ?? new Date().toISOString()),
      nodeId: value.nodeId || payload.nodeId ? String(value.nodeId ?? payload.nodeId) : undefined,
      executionId: value.executionId ? String(value.executionId) : undefined,
      artifactId: value.artifactId || payload.artifactId ? String(value.artifactId ?? payload.artifactId) : undefined,
      data: payload,
    };
  } catch {
    return undefined;
  }
}

export interface ExecutionStreamOptions {
  executionId?: string;
  initialCursor?: string;
  onEvent: (event: ExecutionEvent) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export function useExecutionStream({
  executionId,
  initialCursor,
  onEvent,
  onConnectionChange,
}: ExecutionStreamOptions): void {
  const onEventRef = useRef(onEvent);
  const connectionRef = useRef(onConnectionChange);
  const cursorByExecutionRef = useRef(new Map<string, string>());

  onEventRef.current = onEvent;
  connectionRef.current = onConnectionChange;

  useEffect(() => {
    if (!executionId) return;

    const cursor = cursorByExecutionRef.current.get(executionId) ?? initialCursor;
    const stream = new EventSource(eventStreamUrl(executionId, cursor));
    const handlers = new Map<string, EventListener>();

    const consume = (fallbackType: string) => (raw: Event) => {
      const event = parseEvent(raw as MessageEvent<string>, fallbackType);
      if (!event) return;
      cursorByExecutionRef.current.set(executionId, event.cursor);
      onEventRef.current(event);
    };

    stream.onopen = () => connectionRef.current?.(true);
    stream.onerror = () => connectionRef.current?.(false);
    stream.onmessage = consume('message');

    for (const eventType of EVENT_TYPES) {
      const handler = consume(eventType) as EventListener;
      handlers.set(eventType, handler);
      stream.addEventListener(eventType, handler);
    }

    return () => {
      for (const [eventType, handler] of handlers) stream.removeEventListener(eventType, handler);
      stream.close();
      connectionRef.current?.(false);
    };
  }, [executionId]);
}
