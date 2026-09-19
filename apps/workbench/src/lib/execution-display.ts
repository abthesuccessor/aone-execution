import type { ExecutionEvent, ExecutionRun, NodeRunStatus, PlanVersion, TopicNode } from './types';

export interface ExecutionDisplay {
  intentStatuses: Record<string, NodeRunStatus>;
  proposalStatuses: Record<string, NodeRunStatus>;
}

/** Derive run badges without adding execution state to the editable draft or immutable plan. */
export function projectExecutionDisplay(
  nodes: Pick<TopicNode, 'id'>[],
  plan: PlanVersion | undefined,
  execution: ExecutionRun | undefined,
  events: ExecutionEvent[],
): ExecutionDisplay {
  const intentStatuses: Record<string, NodeRunStatus> = Object.fromEntries(nodes.map((node) => [node.id, 'draft']));
  const proposalStatuses: Record<string, NodeRunStatus> = {};
  if (!plan || !execution || execution.planId !== plan.id || execution.graphId !== plan.graphId) return { intentStatuses, proposalStatuses };

  const specialists = plan.proposedGraph?.nodes ?? [];
  const stepIds = new Set([...plan.workItems.map((item) => item.nodeId), ...specialists.map((node) => node.id)]);
  const selected = execution.selectedNodeIds == null ? stepIds : new Set(execution.selectedNodeIds);
  const runEvents = events.filter((event) => !event.executionId || event.executionId === execution.id);
  const completed = new Set(execution.completedNodeIds ?? []);
  const failed = new Set<string>();
  const started = new Set<string>();
  const skipped = new Set<string>();
  const interrupted = new Set<string>();
  let status = execution.status;
  for (const event of runEvents) {
    const nodeId = event.nodeId ?? (typeof event.data?.nodeId === 'string' ? event.data.nodeId : undefined);
    if (nodeId && event.type === 'node.started') started.add(nodeId);
    if (nodeId && event.type === 'node.completed') completed.add(nodeId);
    if (nodeId && ['node.failed', 'execution.failed'].includes(event.type)) failed.add(nodeId);
    if (nodeId && event.type === 'node.skipped') skipped.add(nodeId);
    if (event.type === 'execution.cancelled' && typeof event.data?.interruptedNodeId === 'string') interrupted.add(event.data.interruptedNodeId);
  }
  // A replay or late completion must never hide a terminal failure/cancellation.
  if (status === 'cancelled' || runEvents.some((event) => event.type === 'execution.cancelled')) status = 'cancelled';
  else if (status === 'failed' || failed.size || runEvents.some((event) => event.type === 'execution.failed')) status = 'failed';
  else if (status === 'completed' || runEvents.some((event) => event.type === 'execution.completed')) status = 'completed';

  for (const id of stepIds) {
    if (!selected.has(id)) { proposalStatuses[id] = 'draft'; continue; }
    if (failed.has(id)) proposalStatuses[id] = 'failed';
    else if (completed.has(id)) proposalStatuses[id] = 'completed';
    else if (status === 'cancelled' || interrupted.has(id)) proposalStatuses[id] = 'cancelled';
    else if (status === 'failed') proposalStatuses[id] = started.has(id) || execution.currentNodeId === id ? 'failed' : 'blocked';
    else if (['completed', 'stopped', 'superseded'].includes(status) || skipped.has(id)) proposalStatuses[id] = 'not_run';
    else if (status === 'paused') proposalStatuses[id] = 'paused';
    else if (started.has(id) || execution.currentNodeId === id) proposalStatuses[id] = 'running';
    else proposalStatuses[id] = 'queued';
  }

  for (const intent of nodes) {
    const linked = new Set(specialists.filter((node) => node.traceability.intentNodeIds.includes(intent.id)).map((node) => node.id));
    for (const item of plan.workItems) {
      if (item.nodeId === intent.id || item.sourceIntents?.some((source) => source.id === intent.id)) linked.add(item.nodeId);
    }
    const states = [...linked].map((id) => proposalStatuses[id] ?? 'draft');
    intentStatuses[intent.id] = aggregateStatuses(states);
  }
  return { intentStatuses, proposalStatuses };
}

function aggregateStatuses(states: NodeRunStatus[]): NodeRunStatus {
  if (!states.length || states.every((status) => status === 'draft')) return 'draft';
  if (states.includes('failed')) return 'failed';
  if (states.includes('running')) return 'running';
  if (states.every((status) => status === 'completed')) return 'completed';
  if (states.includes('cancelled')) return 'cancelled';
  if (states.includes('blocked')) return 'blocked';
  if (states.includes('paused')) return 'paused';
  if (states.includes('completed')) return 'partial';
  if (states.includes('queued')) return 'queued';
  return 'not_run';
}
