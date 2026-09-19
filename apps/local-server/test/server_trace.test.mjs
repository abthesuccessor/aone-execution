import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/index.mjs';

const origin = 'http://127.0.0.1:5173';

async function eventually(callback, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Condition was not met before timeout.');
}

async function harness(context, { stepDelayMs = 10 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ege-trace-server-'));
  const workspace = join(root, 'workspace');
  const replacement = join(root, 'replacement');
  await mkdir(workspace);
  await mkdir(replacement);
  const server = createLocalServer({
    port: 0,
    databasePath: join(root, 'local.db'),
    objectRoot: join(root, 'objects'),
    workspaceRoot: root,
    skillsRoot: join(root, 'skills'),
    stepDelayMs,
  });
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${server.address}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  return { api, replacement, server, workspace };
}

async function createDraft(api, workspacePath, nodes) {
  const graph = (await api('/api/graphs', {
    method: 'POST', body: { name: 'Observable local project', workspacePath },
  })).body.graph;
  await api(`/api/graphs/${graph.id}/draft`, {
    method: 'PUT', body: { nodes, edges: [], context: 'Trace every observable operation.' },
  });
  return graph;
}

test('planning and execution expose durable redacted graph and execution traces with SSE replay', async (context) => {
  const { api, replacement, server, workspace } = await harness(context);
  const graph = await createDraft(api, workspace, [{
    id: 'intent', title: 'Traceable feature', context: 'Implement and verify a small feature.',
  }]);

  const stream = await fetch(`${server.address}/api/graphs/${graph.id}/traces/events?after=0`, {
    headers: { Origin: origin },
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const planned = await api(`/api/graphs/${graph.id}/plans`, {
    method: 'POST',
    body: { provider: 'simulation', instructions: 'Authorization: Bearer top.secret.value' },
  });
  assert.equal(planned.status, 201);

  const decoder = new TextDecoder();
  let streamed = '';
  for (let index = 0; index < 20 && !streamed.includes('event: trace.ended'); index += 1) {
    const result = await reader.read();
    streamed += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
    if (result.done) break;
  }
  await reader.cancel();
  assert.match(streamed, /event: trace\.started/);
  assert.match(streamed, /event: span\.started/);
  assert.match(streamed, /event: span\.ended/);

  const listed = await api(`/api/graphs/${graph.id}/traces?limit=1`);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.items[0].kind, 'PLAN');
  assert.match(listed.body.items[0].traceId, /^[a-f0-9]{32}$/);
  const planTrace = await api(`/api/traces/${listed.body.items[0].id}`);
  assert.equal(planTrace.body.trace.status, 'OK');
  assert.equal(JSON.stringify(planTrace.body).includes('top.secret.value'), false);
  assert.ok(planTrace.body.spans.some((span) => span.category === 'PLANNER' && span.spanKind === 'INTERNAL'));

  const approved = await api(`/api/plans/${planned.body.plan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: planned.body.plan.contentHash, rationale: 'Approved.' },
  });
  assert.equal(approved.status, 200);
  const started = await api(`/api/graphs/${graph.id}/executions`, {
    method: 'POST', body: { planId: planned.body.plan.id, expectedPlanHash: planned.body.plan.contentHash },
  });
  assert.equal(started.status, 202);
  const detail = await eventually(async () => {
    const current = await api(`/api/executions/${started.body.execution.id}`);
    return current.body.execution.status === 'COMPLETED' ? current.body : null;
  });
  assert.ok(detail.trace);
  const executionTrace = await api(`/api/executions/${started.body.execution.id}/trace`);
  assert.equal(executionTrace.status, 200);
  assert.equal(executionTrace.body.trace.status, 'OK');
  assert.ok(executionTrace.body.spans.some((span) => span.category === 'NODE' && span.status === 'OK'));
  assert.ok(executionTrace.body.spans.some((span) => span.category === 'VERIFIER'));
  assert.ok(executionTrace.body.spans.some((span) => span.category === 'ARTIFACT'));
  const rebound = await api(`/api/graphs/${graph.id}`, {
    method: 'PATCH', body: { workspacePath: replacement },
  });
  assert.equal(rebound.status, 200);
  assert.equal(rebound.body.workspaceChanged, true);
  assert.equal(rebound.body.draft.revision, 3);
  assert.ok(rebound.body.stalePlanIds.includes(planned.body.plan.id));
  assert.equal(rebound.body.graph.workspacePath.endsWith('/replacement'), true);
});

test('local project rebinding is blocked for paused admitted executions', async (context) => {
  const { api, replacement, workspace } = await harness(context, { stepDelayMs: 120 });
  const graph = await createDraft(api, workspace, [
    { id: 'first', title: 'First bounded change', context: 'Produce the first checkpoint.' },
    { id: 'second', title: 'Second bounded change', context: 'Produce the second checkpoint.' },
  ]);
  const planned = await api(`/api/graphs/${graph.id}/plans`, { method: 'POST', body: { provider: 'simulation' } });
  await api(`/api/plans/${planned.body.plan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: planned.body.plan.contentHash },
  });
  const started = await api(`/api/graphs/${graph.id}/executions`, {
    method: 'POST', body: { planId: planned.body.plan.id, expectedPlanHash: planned.body.plan.contentHash },
  });
  await eventually(async () => {
    const detail = await api(`/api/executions/${started.body.execution.id}`);
    return detail.body.events.some((event) => event.type === 'node.started');
  });
  assert.equal((await api(`/api/executions/${started.body.execution.id}/pause`, { method: 'POST', body: {} })).status, 202);
  await eventually(async () => {
    const detail = await api(`/api/executions/${started.body.execution.id}`);
    return detail.body.execution.status === 'PAUSED';
  });
  const rebound = await api(`/api/graphs/${graph.id}`, {
    method: 'PATCH', body: { workspacePath: replacement },
  });
  assert.equal(rebound.status, 409);
  assert.equal(rebound.body.error.code, 'WORKSPACE_REBIND_BLOCKED');
  assert.equal((await api(`/api/graphs/${graph.id}`)).body.graph.workspacePath, graph.workspacePath);
});
