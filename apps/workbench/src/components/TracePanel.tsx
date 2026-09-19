import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import {
  Badge,
  Button,
  Flex,
  ScrollArea,
  Select,
  Text,
  Tooltip,
} from '@radix-ui/themes';
import {
  IconActivity,
  IconAlertTriangle,
  IconBan,
  IconChevronDown,
  IconChevronRight,
  IconCircleCheck,
  IconEye,
  IconFilter,
  IconHistory,
  IconLoader2,
  IconRefresh,
} from '@tabler/icons-react';
import { api } from '../lib/api';
import type {
  EngineeringGraph,
  ExecutionRun,
  PlanVersion,
  TraceDetail,
  TraceListPage,
  TraceStreamEvent,
  TraceRecord,
  TraceSpan,
  TraceOperationKind,
  TraceStatus,
} from '../lib/types';

const TRACE_KINDS: TraceOperationKind[] = [
  'GRAPH',
  'PLANNER',
  'MODEL',
  'AGENT',
  'NODE',
  'TOOL',
  'COMMAND',
  'VERIFIER',
  'ARTIFACT',
  'CHECKPOINT',
];

interface TracePanelProps {
  graph: EngineeringGraph;
  plan?: PlanVersion;
  execution?: ExecutionRun;
  selectedNodeId?: string;
  selectedProposalNodeId?: string;
  liveEvents: TraceStreamEvent[];
  connected: boolean;
}

export function TracePanel({
  graph,
  plan,
  execution,
  selectedNodeId,
  selectedProposalNodeId,
  liveEvents,
  connected,
}: TracePanelProps) {
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [tracePage, setTracePage] = useState<TraceListPage>({ limit: 50, hasMore: false });
  const [selectedTraceId, setSelectedTraceId] = useState<string>();
  const [detail, setDetail] = useState<TraceDetail>();
  const [selectedSpanId, setSelectedSpanId] = useState<string>();
  const [kindFilter, setKindFilter] = useState<'ALL' | TraceOperationKind>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | TraceStatus>('ALL');
  const [useCanvasSelection, setUseCanvasSelection] = useState(true);
  const [collapsedSpanIds, setCollapsedSpanIds] = useState<Set<string>>(new Set());
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [spanLimit, setSpanLimit] = useState(500);
  const [error, setError] = useState<string>();
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const selectedFilterId = selectedProposalNodeId ?? selectedNodeId;
  const selectedFilterName = selectedProposalNodeId
    ? plan?.proposedGraph?.nodes.find((node) => node.id === selectedProposalNodeId)?.title ?? selectedProposalNodeId
    : graph.nodes.find((node) => node.id === selectedNodeId)?.title ?? selectedNodeId;
  const liveEvent = liveEvents.at(-1);
  const selectedFilterIds = useMemo(() => {
    if (!selectedFilterId) return undefined;
    const ids = new Set([selectedFilterId]);
    if (selectedNodeId) {
      for (const proposedNode of plan?.proposedGraph?.nodes ?? []) {
        if (proposedNode.traceability.intentNodeIds.includes(selectedNodeId)) ids.add(proposedNode.id);
      }
    }
    return ids;
  }, [plan?.id, selectedFilterId, selectedNodeId]);
  const selectedTrace = detail?.trace ?? traces.find((trace) => trace.id === selectedTraceId);
  const traceIsLive = selectedTrace?.status === 'RUNNING';

  useEffect(() => {
    setTraces([]);
    setDetail(undefined);
    setSelectedTraceId(undefined);
    setSelectedSpanId(undefined);
    setError(undefined);
    setRefreshKey((value) => value + 1);
  }, [graph.id]);

  useEffect(() => {
    setUseCanvasSelection(true);
  }, [selectedFilterId]);

  useEffect(() => {
    setSpanLimit(500);
  }, [kindFilter, selectedFilterId, selectedTraceId, statusFilter]);

  useEffect(() => {
    setCollapsedSpanIds(new Set());
  }, [selectedTraceId]);

  useEffect(() => {
    let cancelled = false;
    setLoadingList(true);
    void api.listGraphTraces(graph.id, 50).then((result) => {
      if (cancelled) return;
      setTraces(result.items);
      setTracePage(result.page);
      setSelectedTraceId((current) => {
        if (current && result.items.some((trace) => trace.id === current)) return current;
        return result.items.find((trace) => trace.executionId === execution?.id)?.id
          ?? result.items.find((trace) => trace.planId === plan?.id)?.id
          ?? result.items[0]?.id;
      });
      setError(undefined);
    }).catch((cause) => {
      if (!cancelled) setError(messageFrom(cause));
    }).finally(() => {
      if (!cancelled) setLoadingList(false);
    });
    return () => { cancelled = true; };
  }, [graph.id, execution?.id, plan?.id, refreshKey]);

  useEffect(() => {
    if (!selectedTraceId) {
      setDetail(undefined);
      setSelectedSpanId(undefined);
      return;
    }
    let cancelled = false;
    setLoadingDetail((current) => current || !detail || detail.trace.id !== selectedTraceId);
    void api.getTrace(selectedTraceId).then((result) => {
      if (cancelled) return;
      setDetail(result);
      setSelectedSpanId((current) => current && result.spans.some((span) => span.id === current)
        ? current
        : result.trace.rootSpanId ?? result.spans[0]?.id);
      setError(undefined);
    }).catch((cause) => {
      if (!cancelled) setError(messageFrom(cause));
    }).finally(() => {
      if (!cancelled) setLoadingDetail(false);
    });
    return () => { cancelled = true; };
    // The detail object is deliberately excluded so a live refresh does not loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTraceId, refreshKey]);

  useEffect(() => {
    if (!liveEvent || !liveEvent.type.startsWith('trace.') && !liveEvent.type.startsWith('span.')) return;
    if (liveEvent.executionId && execution?.id && liveEvent.executionId !== execution.id) return;
    const timeout = window.setTimeout(() => setRefreshKey((value) => value + 1), 100);
    return () => window.clearTimeout(timeout);
  }, [execution?.id, liveEvent?.cursor, liveEvent?.executionId, liveEvent?.type]);

  useEffect(() => {
    if (!traceIsLive) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [traceIsLive, selectedTraceId]);

  const visibleSpans = useMemo(() => filterAndFlattenSpans(
    detail?.spans ?? [],
    collapsedSpanIds,
    kindFilter,
    statusFilter,
    useCanvasSelection ? selectedFilterIds : undefined,
  ), [collapsedSpanIds, detail?.spans, kindFilter, selectedFilterIds, statusFilter, useCanvasSelection]);

  const selectedSpan = detail?.spans.find((span) => span.id === selectedSpanId)
    ?? visibleSpans[0]?.span;
  const selectedSpanEvents = detail?.events.filter((event) => event.spanId === selectedSpan?.id) ?? [];
  const traceWindow = useMemo(() => getTraceWindow(detail?.spans ?? [], now), [detail?.spans, now]);

  const loadOlderTraces = async () => {
    if (!tracePage.hasMore || !tracePage.nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const result = await api.listGraphTraces(graph.id, 50, tracePage.nextBefore);
      setTraces((current) => {
        const known = new Set(current.map((trace) => trace.id));
        return [...current, ...result.items.filter((trace) => !known.has(trace.id))];
      });
      setTracePage(result.page);
      setError(undefined);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoadingOlder(false);
    }
  };

  const loadMoreEvents = async () => {
    if (!detail?.eventPage.hasMore || loadingEvents) return;
    setLoadingEvents(true);
    try {
      const next = await api.getTrace(detail.trace.id, detail.eventPage.nextAfter, 500);
      setDetail((current) => {
        if (!current || current.trace.id !== next.trace.id) return next;
        const known = new Set(current.events.map((event) => event.id));
        return {
          ...next,
          spans: next.spans.length > 0 ? next.spans : current.spans,
          events: [...current.events, ...next.events.filter((event) => !known.has(event.id))],
        };
      });
      setError(undefined);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setLoadingEvents(false);
    }
  };

  return (
    <div className="trace-panel">
      <header className="trace-toolbar">
        <Flex align="center" gap="2" minWidth="0">
          <IconActivity size={15} />
          <Text size="2" weight="bold">Trace Explorer</Text>
          <Tooltip content="Recorded provider, agent, tool, command, verification, and artifact activity. Hidden model reasoning is not exposed.">
            <Badge variant="outline" color="gray"><IconEye size={12} /> Observed and redacted</Badge>
          </Tooltip>
          {selectedTrace?.provider === 'simulation' && <Badge color="amber">Simulation</Badge>}
          {selectedTrace && (
            <span className={`stream-status${connected && traceIsLive ? ' is-connected' : ''}`}>
              {connected && traceIsLive ? <IconActivity size={13} /> : <IconHistory size={13} />}
              <Text size="1">{connected && traceIsLive ? 'Live' : traceIsLive ? 'Reconnecting' : 'Historical'}</Text>
            </span>
          )}
        </Flex>
        <Flex align="center" gap="1" className="trace-filters">
          {selectedFilterId && (
            <Tooltip content={useCanvasSelection ? 'Showing spans associated with the selected graph node and its child operations' : 'Canvas selection filter is off'}>
              <Button
                size="1"
                variant={useCanvasSelection ? 'soft' : 'ghost'}
                color={useCanvasSelection ? 'cyan' : 'gray'}
                onClick={() => setUseCanvasSelection((value) => !value)}
                aria-pressed={useCanvasSelection}
                aria-label={`Filter traces by selected node ${selectedFilterName}`}
              >
                <IconFilter size={13} /> {shortLabel(selectedFilterName ?? selectedFilterId, 24)}
              </Button>
            </Tooltip>
          )}
          <Select.Root value={kindFilter} onValueChange={(value) => setKindFilter(value as 'ALL' | TraceOperationKind)}>
            <Select.Trigger aria-label="Filter spans by operation" variant="soft" />
            <Select.Content>
              <Select.Item value="ALL">All operations</Select.Item>
              {TRACE_KINDS.map((kind) => <Select.Item key={kind} value={kind}>{titleCase(kind)}</Select.Item>)}
            </Select.Content>
          </Select.Root>
          <Select.Root value={statusFilter} onValueChange={(value) => setStatusFilter(value as 'ALL' | TraceStatus)}>
            <Select.Trigger aria-label="Filter spans by status" variant="soft" />
            <Select.Content>
              <Select.Item value="ALL">All statuses</Select.Item>
              {(['RUNNING', 'OK', 'ERROR', 'CANCELLED'] as const).map((status) => (
                <Select.Item key={status} value={status}>{titleCase(status)}</Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
          <Tooltip content="Refresh recorded traces">
            <Button size="1" variant="ghost" color="gray" aria-label="Refresh traces" onClick={() => setRefreshKey((value) => value + 1)}>
              <IconRefresh size={14} />
            </Button>
          </Tooltip>
        </Flex>
      </header>

      {error && traces.length === 0 ? (
        <TraceMessage icon={<IconAlertTriangle size={19} />} tone="error" title="Trace data is unavailable">
          <span>{error}</span>
          <Button size="1" variant="soft" color="red" onClick={() => setRefreshKey((value) => value + 1)}>Retry</Button>
        </TraceMessage>
      ) : loadingList && traces.length === 0 ? (
        <TraceLoading />
      ) : traces.length === 0 ? (
        <TraceMessage icon={<IconActivity size={19} />} title="No observed traces yet">
          <span>Request a plan or execute an approved plan. Recorded activity will appear here.</span>
        </TraceMessage>
      ) : (
        <div className="trace-layout">
          <aside className="trace-run-list" aria-label="Plan and execution traces">
            <ScrollArea type="always" scrollbars="vertical">
              <div className="trace-run-list-inner">
                {traces.map((trace) => (
                  <button
                    key={trace.id}
                    type="button"
                    className={trace.id === selectedTraceId ? 'is-selected' : ''}
                    onClick={() => setSelectedTraceId(trace.id)}
                    aria-label={`${trace.kind === 'PLAN' ? 'Plan' : 'Execution'} trace ${trace.name}, ${titleCase(trace.status)}`}
                  >
                    <span className="trace-run-heading">
                      <TraceStatusIcon status={trace.status} />
                      <strong>{trace.name}</strong>
                      <small>{formatDuration(traceDuration(trace, now))}</small>
                    </span>
                    <span className="trace-run-meta">
                      <span>{titleCase(trace.kind)}</span>
                      <span>{trace.provider ?? 'local'}</span>
                      {trace.model && <span>{trace.model}</span>}
                    </span>
                    <time dateTime={trace.startedAt}>{formatDateTime(trace.startedAt)}</time>
                  </button>
                ))}
                {tracePage.hasMore && (
                  <Button size="1" variant="ghost" color="gray" disabled={loadingOlder} onClick={() => void loadOlderTraces()}>
                    <IconHistory size={13} /> {loadingOlder ? 'Loading' : 'Load earlier traces'}
                  </Button>
                )}
              </div>
            </ScrollArea>
          </aside>

          <section className="trace-span-pane" aria-label="Causal span timeline">
            {loadingDetail && !detail ? (
              <TraceLoading compact />
            ) : !detail ? (
              <TraceMessage icon={<IconActivity size={17} />} title="Select a trace">
                <span>Choose a plan or execution trace to inspect its recorded operations.</span>
              </TraceMessage>
            ) : (
              <>
                <div className="trace-span-header">
                  <span>Operation</span>
                  <span>Offset</span>
                  <span>Duration</span>
                </div>
                <ScrollArea type="always" scrollbars="vertical" className="trace-span-scroll">
                  <ol className="trace-span-tree" aria-label="Causal trace spans">
                    {visibleSpans.length === 0 && (
                      <li className="trace-filter-empty">No spans match the current filters.</li>
                    )}
                    {visibleSpans.slice(0, spanLimit).map(({ span, depth, hasChildren }) => {
                      const collapsed = collapsedSpanIds.has(span.id);
                      const displayName = spanDisplayName(span);
                      const offsetMs = Math.max(0, parseTime(span.startedAt) - traceWindow.start);
                      const durationMs = spanDuration(span, now);
                      const timelineStyle = timelinePosition(offsetMs, durationMs, traceWindow.duration);
                      return (
                        <li key={span.id} className={span.id === selectedSpan?.id ? 'is-selected' : ''}>
                          <span className="trace-span-indent" style={{ '--trace-depth': depth } as CSSProperties}>
                            {hasChildren ? (
                              <button
                                type="button"
                                className="trace-disclosure"
                                onClick={() => setCollapsedSpanIds((current) => toggleSet(current, span.id))}
                                aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${displayName}`}
                                aria-expanded={!collapsed}
                              >
                                {collapsed ? <IconChevronRight size={12} /> : <IconChevronDown size={12} />}
                              </button>
                            ) : <span className="trace-disclosure-spacer" />}
                          </span>
                          <button type="button" className="trace-span-select" onClick={() => setSelectedSpanId(span.id)}>
                            <span className="trace-span-name">
                              <TraceStatusIcon status={span.status} />
                              <span>
                                <strong>{displayName}</strong>
                                <small>{titleCase(span.kind)}{span.agentId ? ` | ${span.agentId}` : ''}</small>
                              </span>
                            </span>
                            <span className="trace-span-offset">+{formatDuration(offsetMs)}</span>
                            <span className="trace-span-duration">
                              <span className={`trace-timeline-mark is-${span.status.toLowerCase()}`} style={timelineStyle} />
                              <span>{formatDuration(durationMs)}</span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {visibleSpans.length > spanLimit && (
                      <li className="trace-span-more">
                        <Button size="1" variant="ghost" color="gray" onClick={() => setSpanLimit((value) => value + 500)}>
                          Show 500 more spans ({visibleSpans.length - spanLimit} remaining)
                        </Button>
                      </li>
                    )}
                  </ol>
                </ScrollArea>
              </>
            )}
          </section>

          <aside className="trace-detail-pane" aria-label="Selected span details">
            {selectedSpan && detail ? (
              <ScrollArea type="always" scrollbars="vertical">
                <div className="trace-detail-content">
                  <div className="trace-detail-heading">
                    <Flex align="center" gap="2">
                      <TraceStatusIcon status={selectedSpan.status} />
                      <Text size="2" weight="bold">{spanDisplayName(selectedSpan)}</Text>
                    </Flex>
                    <Flex gap="1" wrap="wrap">
                      <Badge variant="outline" color="gray">{titleCase(selectedSpan.kind)}</Badge>
                      <Badge color={statusColor(selectedSpan.status)}>{titleCase(selectedSpan.status)}</Badge>
                      {captureBadges(selectedSpan, detail.trace).map((badge) => (
                        <Badge key={badge.label} variant="soft" color={badge.color}>{badge.label}</Badge>
                      ))}
                    </Flex>
                  </div>

                  {detail.trace.provider === 'simulation' && (
                    <div className="trace-boundary-note is-simulation">
                      <strong>Simulation trace</strong>
                      <span>No external model call was made. These operations record the deterministic simulator.</span>
                    </div>
                  )}
                  <div className="trace-boundary-note">
                    <strong>Observed activity only</strong>
                    <span>Observable inputs and outputs are recorded when available, bounded, and secret-redacted. Hidden model reasoning is never captured.</span>
                  </div>

                  <TraceMetadata trace={detail.trace} span={selectedSpan} now={now} />
                  <PayloadSection title="Sent input (observed, redacted)" value={selectedSpan.input} empty="No input was captured for this operation." />
                  <PayloadSection title="Observed output (redacted)" value={selectedSpan.output} empty="No output has been recorded for this operation." />

                  <section className="trace-detail-section">
                    <Flex align="center" justify="between">
                      <Text size="1" weight="bold">SPAN EVENTS</Text>
                      <Badge variant="outline" color="gray">{selectedSpanEvents.length}</Badge>
                    </Flex>
                    {selectedSpanEvents.length === 0 ? (
                      <Text as="p" size="1" color="gray">No events were recorded inside this span.</Text>
                    ) : (
                      <ol className="trace-detail-events">
                        {selectedSpanEvents.map((event) => (
                          <li key={event.id}>
                            <time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
                            <strong>{event.type}</strong>
                            {Object.keys(event.attributes).length > 0 && <code>{formatInline(event.attributes)}</code>}
                          </li>
                        ))}
                      </ol>
                    )}
                    {detail.eventPage.hasMore && (
                      <Button size="1" variant="ghost" color="gray" disabled={loadingEvents} onClick={() => void loadMoreEvents()}>
                        {loadingEvents ? 'Loading events' : 'Load more events'}
                      </Button>
                    )}
                  </section>
                </div>
              </ScrollArea>
            ) : (
              <TraceMessage icon={<IconEye size={17} />} title="Select an operation">
                <span>Choose a span to inspect sent input, tool activity, verification, artifacts, output, and errors.</span>
              </TraceMessage>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function TraceMetadata({ trace, span, now }: { trace: TraceRecord; span: TraceSpan; now: number }) {
  const values: Array<[string, unknown]> = [
    ['Operation name', span.name],
    ['Provider', trace.provider],
    ['Model', trace.model],
    ['Agent', span.agentId],
    ['Graph node', span.nodeId],
    ['Plan step', span.stepId],
    ['Span ID', span.id],
    ['Parent span', span.parentSpanId],
    ['OTel span kind', span.spanKind],
    ['Started', formatDateTime(span.startedAt)],
    ['Duration', formatDuration(spanDuration(span, now))],
    ...Object.entries(trace.attributes).map(([key, value]): [string, unknown] => [`Trace ${humanKey(key)}`, value]),
    ...Object.entries(span.attributes).filter(([key]) => key !== 'displayName'),
  ];
  return (
    <section className="trace-detail-section">
      <Text size="1" weight="bold">OBSERVED METADATA</Text>
      <dl className="trace-metadata">
        {values.filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => (
          <div key={key}>
            <dt>{humanKey(key)}</dt>
            <dd title={formatInline(value)}>{formatInline(value)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function spanDisplayName(span: TraceSpan): string {
  const displayName = span.attributes.displayName;
  return typeof displayName === 'string' && displayName.trim() ? displayName : span.name;
}

function PayloadSection({ title, value, empty }: { title: string; value: unknown; empty: string }) {
  return (
    <section className="trace-detail-section trace-payload-section">
      <Text size="1" weight="bold">{title.toUpperCase()}</Text>
      {value === undefined || value === null || value === '' ? (
        <Text as="p" size="1" color="gray">{empty}</Text>
      ) : (
        <pre>{formatPayload(value)}</pre>
      )}
    </section>
  );
}

function TraceLoading({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`trace-loading${compact ? ' is-compact' : ''}`} role="status" aria-label="Loading recorded traces">
      <span /><span /><span /><span />
      <Text size="1" color="gray">Loading observed traces</Text>
    </div>
  );
}

function TraceMessage({ icon, title, tone, children }: { icon: ReactNode; title: string; tone?: 'error'; children: ReactNode }) {
  return (
    <div className={`trace-message${tone ? ` is-${tone}` : ''}`} role={tone === 'error' ? 'alert' : 'status'}>
      {icon}
      <strong>{title}</strong>
      {children}
    </div>
  );
}

function TraceStatusIcon({ status }: { status: TraceStatus }) {
  if (status === 'OK') return <IconCircleCheck className="trace-status-icon is-ok" size={13} aria-label="Complete" />;
  if (status === 'ERROR') return <IconAlertTriangle className="trace-status-icon is-error" size={13} aria-label="Error" />;
  if (status === 'CANCELLED') return <IconBan className="trace-status-icon is-cancelled" size={13} aria-label="Cancelled" />;
  return <IconLoader2 className="trace-status-icon is-running spin-icon" size={13} aria-label="Running" />;
}

interface FlatSpan {
  span: TraceSpan;
  depth: number;
  hasChildren: boolean;
}

function filterAndFlattenSpans(
  spans: TraceSpan[],
  collapsed: Set<string>,
  kindFilter: 'ALL' | TraceOperationKind,
  statusFilter: 'ALL' | TraceStatus,
  nodeFilterIds?: Set<string>,
): FlatSpan[] {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const children = new Map<string | undefined, TraceSpan[]>();
  for (const span of spans) {
    const parentId = span.parentSpanId && byId.has(span.parentSpanId) ? span.parentSpanId : undefined;
    const siblings = children.get(parentId) ?? [];
    siblings.push(span);
    children.set(parentId, siblings);
  }
  for (const siblings of children.values()) siblings.sort(compareSpans);

  const belongsToNode = (span: TraceSpan): boolean => {
    if (!nodeFilterIds || nodeFilterIds.size === 0) return true;
    let cursor: TraceSpan | undefined = span;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const sourceIntentNodeIds = Array.isArray(cursor.attributes.sourceIntentNodeIds)
        ? cursor.attributes.sourceIntentNodeIds.map(String)
        : [];
      if ((cursor.nodeId && nodeFilterIds.has(cursor.nodeId)) || (cursor.stepId && nodeFilterIds.has(cursor.stepId))
        || (typeof cursor.attributes.nodeId === 'string' && nodeFilterIds.has(cursor.attributes.nodeId))
        || (typeof cursor.attributes.proposalNodeId === 'string' && nodeFilterIds.has(cursor.attributes.proposalNodeId))
        || sourceIntentNodeIds.some((id) => nodeFilterIds.has(id))) return true;
      cursor = cursor.parentSpanId ? byId.get(cursor.parentSpanId) : undefined;
    }
    return false;
  };

  const matches = new Set(spans.filter((span) => (
    (kindFilter === 'ALL' || span.kind === kindFilter)
    && (statusFilter === 'ALL' || span.status === statusFilter)
    && belongsToNode(span)
  )).map((span) => span.id));
  const filtering = kindFilter !== 'ALL' || statusFilter !== 'ALL' || Boolean(nodeFilterIds?.size);
  const visible = new Set(matches);
  if (filtering) {
    for (const spanId of matches) {
      let cursor = byId.get(spanId);
      const seen = new Set<string>();
      while (cursor?.parentSpanId && !seen.has(cursor.parentSpanId)) {
        seen.add(cursor.parentSpanId);
        visible.add(cursor.parentSpanId);
        cursor = byId.get(cursor.parentSpanId);
      }
    }
  }

  const result: FlatSpan[] = [];
  const visit = (span: TraceSpan, depth: number) => {
    if (!filtering || visible.has(span.id)) {
      const childSpans = children.get(span.id) ?? [];
      result.push({ span, depth, hasChildren: childSpans.some((child) => !filtering || visible.has(child.id)) });
      if (!collapsed.has(span.id)) childSpans.forEach((child) => visit(child, depth + 1));
    }
  };
  (children.get(undefined) ?? []).forEach((span) => visit(span, 0));
  return result;
}

function captureBadges(span: TraceSpan, trace: TraceRecord): Array<{ label: string; color: 'gray' | 'amber' | 'cyan' }> {
  const serialized = formatPayload({ input: span.input, output: span.output });
  const inputCapture = recordValue(span.attributes.inputCapture);
  const outputCapture = recordValue(span.attributes.outputCapture);
  const mode = span.attributes.captureMode ?? span.attributes.capture_mode ?? inputCapture.captureMode ?? outputCapture.captureMode
    ?? trace.attributes.captureMode;
  const redacted = span.attributes.redacted === true || inputCapture.redacted === true || outputCapture.redacted === true
    || Number(inputCapture.redactionCount ?? 0) > 0 || Number(outputCapture.redactionCount ?? 0) > 0
    || /\[redacted(?:_[^\]]+)?\]/i.test(serialized);
  const truncated = span.attributes.truncated === true || inputCapture.truncated === true || outputCapture.truncated === true
    || /\[truncated(?:_[^\]]+)?\]/i.test(serialized);
  const badges: Array<{ label: string; color: 'gray' | 'amber' | 'cyan' }> = [
    { label: mode ? String(mode) : 'Local capture', color: 'gray' },
  ];
  if (redacted) badges.push({ label: 'Redacted', color: 'amber' });
  if (truncated) badges.push({ label: 'Truncated', color: 'amber' });
  if (!redacted && !truncated) badges.push({ label: 'Bounded', color: 'cyan' });
  return badges;
}

function getTraceWindow(spans: TraceSpan[], now: number): { start: number; duration: number } {
  if (spans.length === 0) return { start: now, duration: 1 };
  const start = Math.min(...spans.map((span) => parseTime(span.startedAt)).filter(Number.isFinite));
  const end = Math.max(...spans.map((span) => span.endedAt ? parseTime(span.endedAt) : now).filter(Number.isFinite));
  return { start, duration: Math.max(1, end - start) };
}

function timelinePosition(offsetMs: number, durationMs: number, totalMs: number): CSSProperties {
  const left = Math.min(98, Math.max(0, offsetMs / totalMs * 100));
  const width = Math.max(2, Math.min(100 - left, durationMs / totalMs * 100));
  return { left: `${left}%`, width: `${width}%` };
}

function traceDuration(trace: TraceRecord, now: number): number {
  if (trace.durationMs !== undefined) return trace.durationMs;
  const started = parseTime(trace.startedAt);
  const ended = trace.endedAt ? parseTime(trace.endedAt) : now;
  return Math.max(0, ended - started);
}

function spanDuration(span: TraceSpan, now: number): number {
  if (span.durationMs !== undefined) return span.durationMs;
  const started = parseTime(span.startedAt);
  const ended = span.endedAt ? parseTime(span.endedAt) : now;
  return Math.max(0, ended - started);
}

function compareSpans(left: TraceSpan, right: TraceSpan): number {
  return parseTime(left.startedAt) - parseTime(right.startedAt) || left.id.localeCompare(right.id);
}

function toggleSet(current: Set<string>, value: string): Set<string> {
  const next = new Set(current);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function statusColor(status: TraceStatus): 'cyan' | 'green' | 'red' | 'amber' {
  if (status === 'OK') return 'green';
  if (status === 'ERROR') return 'red';
  if (status === 'CANCELLED') return 'amber';
  return 'cyan';
}

function humanKey(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, (letter) => letter.toUpperCase());
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/(^|\s|_)(\w)/g, (_, separator: string, letter: string) => `${separator === '_' ? ' ' : separator}${letter.toUpperCase()}`);
}

function formatPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function formatInline(value: unknown): string {
  const formatted = formatPayload(value).replace(/\s+/g, ' ').trim();
  return formatted.length > 180 ? `${formatted.slice(0, 177)}...` : formatted;
}

function shortLabel(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 3)}...` : value;
}

function formatDuration(value: number): string {
  if (!Number.isFinite(value)) return '0 ms';
  if (value < 1_000) return `${Math.round(value)} ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.floor(value % 60_000 / 1_000);
  return `${minutes}m ${seconds}s`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'Recorded trace data could not be loaded.';
}
