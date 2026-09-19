import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/index.mjs';

const origin = 'http://127.0.0.1:5173';
const jsonResponse = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

async function until(callback) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error('Execution did not reach expected state.');
}

test('real provider planning preserves editable node configuration, semantic links, selection closure, breakpoints and cancellation', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-refinement-'));
  const workspaceRoot = join(root, 'workspace');
  const skillsRoot = join(root, 'skills');
  await mkdir(workspaceRoot);
  await mkdir(join(skillsRoot, 'verification'), { recursive: true });
  await writeFile(join(skillsRoot, 'verification', 'SKILL.md'), '---\nname: verification\ndescription: Check concrete implementation evidence.\n---\nVerify with command receipts.\n');
  const proposal = {
    summary: 'A provider-generated proposal with an independent node.',
    nodes: [['pre', 'a'], ['selected', 'b'], ['unrelated', 'c']].map(([id, source]) => ({
      id, title: id, domain: 'application', objective: `Implement ${id}.`,
      agentId: 'backend-systems-engineer',
      inputs: [{ id: `${id}-input`, type: 'requirements' }],
      outputs: [{ id: `${id}-output`, type: 'artifact' }],
      acceptanceCriteria: [`Verify ${id}.`],
      dependsOn: id === 'selected' ? ['pre'] : [],
      traceability: { intentNodeIds: [source], evidenceIds: [] },
    })),
    relationships: [
      { id: 'dependency', type: 'REQUIRES', from: 'pre', to: 'selected', rationale: 'Input must exist first.', traceability: { intentNodeIds: ['a', 'b'], evidenceIds: [] } },
      { id: 'semantic', type: 'SUPPORTS', from: 'selected', to: 'pre', rationale: 'Independent semantic relation.', traceability: { intentNodeIds: ['a', 'b'], evidenceIds: [] } },
    ],
  };
  const calls = [];
  const server = createLocalServer({
    port: 0, databasePath: join(root, 'local.db'), workspaceRoot, skillsRoot,
    environment: { ...process.env, PATH: '' }, stepDelayMs: 80,
    fetchImpl: async (url, options) => {
      calls.push({ url, method: options.method, body: options.body });
      if (options.method === 'GET') return jsonResponse({ data: [{ id: 'test-model' }] });
      return jsonResponse({ status: 'completed', output_text: JSON.stringify(proposal) });
    },
  });
  await server.start();
  context.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${server.address}${path}`, {
      method, headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  assert.equal((await api('/api/provider-connections/discover', 'POST', { kind: 'hosted', providerId: 'openai-api', apiKey: 'test-session-key' })).status, 200);
  assert.equal((await api('/api/provider-connections/connect', 'POST', { kind: 'hosted', providerId: 'openai-api', model: 'test-model' })).status, 200);
  const skillId = (await api('/api/skills')).body.items.find((item) => item.name === 'verification').id;
  const configuredSkill = await api(`/api/catalog/skills/${skillId}`, 'PATCH', { expectedDigest: null, enabled: true });
  assert.equal(configuredSkill.status, 200);
  const graph = (await api('/api/graphs', 'POST', { name: 'Refinement', workspacePath: workspaceRoot })).body.graph;
  const draft = {
    nodes: [
      { id: 'a', title: 'First', providerId: 'simulation' },
      { id: 'b', title: 'Selected', providerId: 'simulation', model: 'simulation-model', agentId: 'requirements-analyst', skills: [skillId], inputs: ['Approved contract'], outputs: ['Verified implementation'], acceptanceCriteria: ['Pass the requested check.'], budgets: { timeoutMs: 5000, maxAttempts: 2 }, breakpoint: true, group: 'API' },
      { id: 'c', title: 'Unrelated', providerId: 'simulation' },
    ],
    edges: [{ id: 'ab', source: 'a', target: 'b', type: 'REQUIRES' }, { id: 'ba', source: 'b', target: 'a', type: 'SUPPORTS' }],
  };
  const saved = await api(`/api/graphs/${graph.id}/draft`, 'PUT', draft);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.draft.nodes[1].skills, [skillId]);
  assert.equal(saved.body.draft.nodes[1].group, 'API');
  assert.equal(saved.body.draft.edges[1].type, 'SUPPORTS');
  const planned = await api(`/api/graphs/${graph.id}/plans`, 'POST', { provider: 'openai-api' });
  assert.equal(planned.status, 201, JSON.stringify(planned.body));
  const plan = planned.body.plan;
  assert.equal(plan.plan.contextManifest.proposalGenerator.kind, 'configured-ai-provider');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  assert.match(calls.find((call) => call.method === 'POST').body, /SUPPORTS/);
  const selected = plan.plan.steps.find((step) => step.nodeId === 'selected');
  assert.equal(selected.agentId, 'requirements-analyst');
  assert.equal(selected.providerId, 'simulation');
  assert.equal(selected.model, 'simulation-model');
  assert.deepEqual(selected.skills.map((skill) => skill.id), [skillId]);
  assert.deepEqual(selected.acceptanceCriteria, ['Pass the requested check.']);
  assert.deepEqual(selected.budgets, { timeoutMs: 5000, maxAttempts: 2 });
  assert.equal(selected.breakpoint, true);
  assert.equal(selected.inputs[0].description, 'Approved contract');
  assert.equal((await api(`/api/plans/${plan.id}/approve`, 'POST', { expectedContentHash: plan.contentHash })).status, 200);
  const started = await api(`/api/graphs/${graph.id}/executions`, 'POST', { planId: plan.id, expectedPlanHash: plan.contentHash, nodeIds: ['b'] });
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const id = started.body.execution.id;
  assert.deepEqual(started.body.execution.selectedNodeIds, ['pre', 'selected']);
  const paused = await until(async () => { const item = server.repository.getExecution(id); return item.status === 'PAUSED' && item; });
  assert.deepEqual(paused.completedNodeIds, ['pre']);
  assert.deepEqual(paused.passedBreakpointNodeIds, ['selected']);
  assert.equal((await api(`/api/executions/${id}/resume`, 'POST', { mode: 'PINNED_PLAN' })).status, 202);
  const completed = await until(async () => { const item = server.repository.getExecution(id); return item.status === 'COMPLETED' && item; });
  assert.deepEqual(completed.completedNodeIds, ['pre', 'selected']);
  assert.equal(server.repository.listEvents(id).some((event) => event.type === 'node.started' && event.payload.nodeId === 'unrelated'), false);

  const cancellable = await api(`/api/graphs/${graph.id}/executions`, 'POST', { planId: plan.id, expectedPlanHash: plan.contentHash, nodeIds: ['pre'] });
  assert.equal(cancellable.status, 202);
  const cancelId = cancellable.body.execution.id;
  const cancelled = await api(`/api/executions/${cancelId}/cancel`, 'POST', {});
  assert.equal(cancelled.status, 202);
  assert.equal(cancelled.body.execution.status, 'CANCELLED');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(server.repository.getExecution(cancelId).status, 'CANCELLED');
  assert.deepEqual(server.repository.getExecution(cancelId).completedNodeIds, []);
  assert.equal((await api(`/api/executions/${cancelId}/resume`, 'POST', {})).status, 409);
  assert.equal((await api(`/api/executions/${cancelId}/cancel`, 'POST', {})).status, 202);
  assert.equal((await api(`/api/graphs/${graph.id}/executions`, 'POST', { planId: plan.id, expectedPlanHash: plan.contentHash, nodeIds: ['missing'] })).status, 422);
  const invalid = structuredClone(draft);
  invalid.nodes[1].budgets.maxAttempts = 0;
  assert.equal((await api(`/api/graphs/${graph.id}/draft`, 'PUT', invalid)).status, 422);
  const disabledSkill = await api(`/api/catalog/skills/${skillId}`, 'PATCH', { expectedDigest: configuredSkill.body.item.configDigest, enabled: false });
  assert.equal(disabledSkill.status, 200);
  assert.equal(disabledSkill.body.item.contentDigest, configuredSkill.body.item.contentDigest);
  assert.equal(disabledSkill.body.item.packageDigest, configuredSkill.body.item.packageDigest);
  const stale = await api(`/api/plans/${plan.id}/approve`, 'POST', { expectedContentHash: plan.contentHash });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.reason, 'AGENT_CAPABILITY_CATALOG_CHANGED');
});
