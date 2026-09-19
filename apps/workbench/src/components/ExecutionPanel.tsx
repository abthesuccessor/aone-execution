import { useMemo, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Badge, Flex, ScrollArea, Select, Text } from '@radix-ui/themes';
import { IconFileCode, IconHistory, IconLivePhoto, IconPlugConnected, IconPlugOff } from '@tabler/icons-react';
import type { Artifact, EngineeringGraph, ExecutionEvent, ExecutionRun, PlanVersion } from '../lib/types';
import '../lib/monaco';

interface ExecutionPanelProps {
  graph?: EngineeringGraph;
  plan?: PlanVersion;
  execution?: ExecutionRun;
  executions: ExecutionRun[];
  events: ExecutionEvent[];
  artifacts: Artifact[];
  connected: boolean;
}

export function ExecutionPanel({ graph, plan, execution, executions, events, artifacts, connected }: ExecutionPanelProps) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string>();
  const [view, setView] = useState<'events' | 'artifacts'>('events');
  const nodeNames = useMemo(() => new Map([
    ...(graph?.nodes.map((node): [string, string] => [node.id, node.title]) ?? []),
    ...(plan?.workItems.map((item): [string, string] => [item.nodeId, item.title]) ?? []),
    ...(plan?.proposedGraph?.nodes.map((node): [string, string] => [node.id, node.title]) ?? []),
  ]), [graph, plan]);
  const selectedArtifact = artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? artifacts[0];
  const liveEligible = ['queued', 'running', 'pause_requested', 'paused'].includes(execution?.status ?? '');

  if (!execution) {
    return (
      <div className="bottom-empty" role="status">
        <IconLivePhoto size={19} />
        <span>Approve and execute a plan to see live node status, logs, code, and artifacts.</span>
      </div>
    );
  }

  return (
    <div className="execution-panel">
      <div className="execution-toolbar">
        <Flex align="center" gap="2">
          <Text size="2" weight="bold">Execution {shortId(execution.id)}</Text>
          <Badge color={execution.status === 'running' ? 'cyan' : execution.status === 'completed' ? 'green' : execution.status === 'failed' ? 'red' : 'amber'}>
            {execution.status}
          </Badge>
          {execution.parentExecutionId && <Badge variant="outline" color="gray"><IconHistory size={12} /> Successor</Badge>}
          <Badge color="gray" variant="outline" title={execution.selectedNodeIds?.map((id) => nodeNames.get(id) ?? id).join(', ')}>
            {execution.selectedNodeIds ? `Selection · ${execution.selectedNodeIds.length} nodes including prerequisites` : 'Whole plan'}
          </Badge>
          <span className={`stream-status${connected ? ' is-connected' : ''}`} title={connected ? 'Live event stream connected' : liveEligible ? 'Live event stream reconnecting' : 'Durable execution history'}>
            {connected ? <IconPlugConnected size={14} /> : liveEligible ? <IconPlugOff size={14} /> : <IconHistory size={14} />}
            <Text size="1">{connected ? 'Live' : liveEligible ? 'Reconnecting' : 'Historical'}</Text>
          </span>
        </Flex>
        <Flex gap="1">
          <button className={view === 'events' ? 'segmented-active' : ''} type="button" onClick={() => setView('events')}>
            Events <span>{events.length}</span>
          </button>
          <button className={view === 'artifacts' ? 'segmented-active' : ''} type="button" onClick={() => setView('artifacts')}>
            Artifacts <span>{artifacts.length}</span>
          </button>
        </Flex>
      </div>

      {view === 'events' ? (
        <div className="events-layout">
          <ScrollArea type="always" scrollbars="vertical" className="events-scroll">
            <ol className="event-list" aria-label="Live execution events" aria-live="polite">
              {events.length === 0 && <li className="event-empty">Waiting for the first execution event.</li>}
              {events.map((event) => (
                <li key={event.id} className={`event-row event-${event.level}`}>
                  <time dateTime={event.timestamp}>{formatTime(event.timestamp)}</time>
                  <span className="event-type">{event.type}</span>
                  {event.nodeId && <Badge variant="outline" color="gray">{nodeNames.get(event.nodeId) ?? shortId(event.nodeId)}</Badge>}
                  <Text size="1">{event.message}</Text>
                </li>
              ))}
            </ol>
          </ScrollArea>
          <ExecutionLineage executions={executions} activeExecution={execution} />
        </div>
      ) : (
        <div className="artifact-layout">
          <aside className="artifact-list" aria-label="Generated artifacts">
            {artifacts.length === 0 && <Text size="1" color="gray">No artifacts generated yet.</Text>}
            {artifacts.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                className={artifact.id === selectedArtifact?.id ? 'is-selected' : ''}
                onClick={() => setSelectedArtifactId(artifact.id)}
              >
                <IconFileCode size={15} />
                <span>
                  <strong>{artifact.name}</strong>
                  <small>{artifact.path ?? artifact.kind} | {artifact.executionId === execution.id ? 'current run' : `inherited from ${shortId(artifact.executionId)}`}</small>
                </span>
              </button>
            ))}
          </aside>
          <section className="artifact-viewer" aria-label="Artifact content">
            {selectedArtifact ? (
              <>
                <div className="artifact-titlebar">
                  <Flex align="center" gap="2">
                    <Text size="1" weight="medium">{selectedArtifact.path ?? selectedArtifact.name}</Text>
                    {selectedArtifact.executionId !== execution.id && <Badge variant="outline" color="cyan">Inherited artifact</Badge>}
                  </Flex>
                  <Select.Root value={selectedArtifact.language ?? 'plaintext'} disabled>
                    <Select.Trigger variant="ghost" />
                    <Select.Content><Select.Item value={selectedArtifact.language ?? 'plaintext'}>{selectedArtifact.language ?? 'plaintext'}</Select.Item></Select.Content>
                  </Select.Root>
                </div>
                <Editor
                  path={`ege://artifacts/${selectedArtifact.id}.${selectedArtifact.language ?? 'txt'}`}
                  value={selectedArtifact.content}
                  language={selectedArtifact.language ?? 'plaintext'}
                  theme="vs-dark"
                  options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, scrollBeyondLastLine: false, wordWrap: 'on' }}
                />
              </>
            ) : (
              <div className="artifact-empty">Select an artifact to inspect generated code or output.</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function ExecutionLineage({ executions, activeExecution }: { executions: ExecutionRun[]; activeExecution: ExecutionRun }) {
  const lineage = useMemo(() => {
    const byId = new Map(executions.map((run) => [run.id, run]));
    const chain: ExecutionRun[] = [];
    let cursor: ExecutionRun | undefined = activeExecution;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      chain.unshift(cursor);
      seen.add(cursor.id);
      cursor = cursor.parentExecutionId ? byId.get(cursor.parentExecutionId) : undefined;
    }
    return chain;
  }, [executions, activeExecution]);

  return (
    <aside className="lineage-panel" aria-label="Execution lineage">
      <Flex align="center" gap="2" mb="3"><IconHistory size={15} /><Text size="1" weight="bold">LINEAGE</Text></Flex>
      <ol>
        {lineage.map((run, index) => (
          <li key={run.id} className={run.id === activeExecution.id ? 'is-active' : ''}>
            <span>{index + 1}</span>
            <div><Text size="1" weight="medium">{shortId(run.id)}</Text><Text as="div" size="1" color="gray">{run.status}</Text></div>
          </li>
        ))}
      </ol>
      {activeExecution.resumedFromCheckpoint && (
        <Text as="p" size="1" color="gray" mt="3">Resumed from checkpoint {activeExecution.resumedFromCheckpoint}</Text>
      )}
    </aside>
  );
}

function shortId(value: string): string {
  return value.length > 10 ? value.slice(0, 8) : value;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
