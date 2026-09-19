import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/server.mjs';
import { createEngineeringProposalRoutes } from '../src/engineering_proposals.mjs';

test('planning profiles, confirmed memory, environment evidence and editable proposal adoption retain their boundaries', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-adopt-'));
  const snapshot = { workspacePath: root, checkedAt: new Date().toISOString(), tools: [{ id: 'node', available: false, version: null, setupOptions: [{ label: 'Review Node setup' }] }], summary: 'Node unavailable', installsPerformed: false };
  let inspections = 0;
  const server = createLocalServer({ port: 0, databasePath: join(root, 'data.db'), workspaceRoot: root, skillsRoot: join(root, 'skills'), environment: { PATH: '', HOME: root },
    engineeringEnvironmentInspector: { inspect: async () => { inspections += 1; return snapshot; } },
  });
  await server.start();
  context.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${server.address}${path}`, { method, headers: { Origin: 'http://127.0.0.1:5173', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const graph = (await api('/api/graphs', 'POST', { name: 'Small product', workspacePath: root })).body.graph;
  const saved = (await api(`/api/graphs/${graph.id}/draft`, 'PUT', { nodes: [{ id: 'idea', title: 'Create an inventory tool', description: 'One editable idea.', context: 'Preserve the existing data model.' }], edges: [], context: 'Original design intention.' })).body.draft;
  const acceptedMemory = await api(`/api/graphs/${graph.id}/memory`, 'POST', { content: 'Keep the application as one deployable service.', kind: 'decision', validation: { state: 'user_confirmed' } });
  assert.equal(acceptedMemory.status, 201);
  await api(`/api/graphs/${graph.id}/memory`, 'POST', { content: 'UNCONFIRMED_SPLIT_EVERYTHING', kind: 'decision' });
  const planned = await api(`/api/graphs/${graph.id}/plans`, 'POST', { provider: 'local-agents', engineeringProfile: 'poc', conventions: 'Keep modules small.' });
  assert.equal(planned.status, 201, JSON.stringify(planned.body));
  const engineering = planned.body.plan.plan.contextManifest.engineering;
  assert.deepEqual(planned.body.plan.plan.contextManifest.planningOrchestration.stages, ['capture_context', 'propose_plan', 'validate_plan']);
  assert.equal(planned.body.plan.plan.contextManifest.planningOrchestration.engine, 'langgraph');
  assert.equal(planned.body.plan.plan.contextManifest.planningOrchestration.modelCallPolicy, 'deterministic-no-model');
  const stageSpans = server.repository.listTraceSpans(planned.body.plan.traceId).filter((span) => span.attributes.orchestrationEngine === 'langgraph');
  assert.deepEqual(stageSpans.map((span) => span.attributes.stage), ['capture_context', 'propose_plan', 'validate_plan']);
  assert.equal(stageSpans.every((span) => span.status === 'OK'), true);
  assert.equal(engineering.profile, 'poc');
  assert.equal(engineering.conventions, 'Keep modules small.');
  assert.equal(engineering.environment.tools[0].available, false);
  assert.match(engineering.memory.context, /one deployable service/);
  assert.equal(engineering.memory.context.includes('UNCONFIRMED'), false);
  assert.equal(inspections, 1);
  const environment = await api(`/api/graphs/${graph.id}/environment`);
  assert.equal(environment.status, 200);
  assert.equal(environment.body.environment.execution.ready, false);
  assert.equal(environment.body.environment.installsPerformed, false);
  assert.equal((await api(`/api/graphs/${graph.id}/plans`, 'POST', { provider: 'local-agents', engineeringProfile: 'invalid' })).status, 422);
  await api(`/api/graphs/${graph.id}/memory/${acceptedMemory.body.item.id}`, 'PATCH', { content: 'Use a different confirmed deployment convention.', validation: { state: 'user_confirmed' } });
  const staleApproval = await api(`/api/plans/${planned.body.plan.id}/approve`, 'POST', { expectedContentHash: planned.body.plan.contentHash });
  assert.equal(staleApproval.status, 409);
  assert.equal(staleApproval.body.error.code, 'PLAN_CONTEXT_STALE');

  const nodes = ['build', 'verify', 'omitted'].map((id) => ({ id, title: id, objective: `Perform ${id}.`, agentId: 'requirements-analyst',
    inputs: [{ id: 'input', description: 'Current project' }], outputs: [{ id: 'output', description: `${id} artifact` }], traceability: { intentNodeIds: ['idea'], evidenceIds: [] } }));
  const steps = nodes.map((node) => ({ nodeId: node.id, title: node.title, objective: node.objective, agentId: node.agentId, acceptanceCriteria: ['Output is reviewable.'], skills: [], dependsOn: node.id === 'verify' ? ['build'] : [] }));
  const proposal = server.repository.createPlan({ graphId: graph.id, baseDraftRevision: saved.revision, provider: 'local-agents', contentHash: 'a'.repeat(64),
    plan: { steps, proposedGraph: { nodes, relationships: [
      { id: 'order', from: 'build', to: 'verify', type: 'REQUIRES', rationale: 'Verifier consumes the implementation.' },
      { id: 'support', from: 'verify', to: 'build', type: 'SUPPORTS' },
      { id: 'outside', from: 'omitted', to: 'build', type: 'RELATED_TO' },
    ] } }, diff: {} });
  const body = { nodeIds: ['build', 'verify'], expectedDraftRevision: saved.revision, requestId: 'adoption-12345678' };
  const adopted = await api(`/api/graphs/${graph.id}/plans/${proposal.id}/adopt`, 'POST', body);
  assert.equal(adopted.status, 201, JSON.stringify(adopted.body));
  assert.equal(adopted.body.draft.nodes.length, 3);
  assert.deepEqual(adopted.body.draft.nodes.find((node) => node.id === 'idea'), saved.nodes[0]);
  assert.equal(adopted.body.draft.context, saved.context);
  assert.deepEqual(adopted.body.draft.edges.map((edge) => edge.type).sort(), ['DERIVED_FROM', 'DERIVED_FROM', 'REQUIRES', 'SUPPORTS']);
  const adoptedBuild = adopted.body.draft.nodes.find((node) => node.proposalSource?.proposalNodeId === 'build');
  assert.equal(adoptedBuild.proposalSource.planHash, proposal.contentHash);
  assert.deepEqual(adoptedBuild.proposalSource.sourceIntentNodeIds, ['idea']);
  assert.equal(server.repository.getPlan(proposal.id).status, 'SUPERSEDED');
  const repeated = await api(`/api/graphs/${graph.id}/plans/${proposal.id}/adopt`, 'POST', body);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.idempotent, true);
  assert.deepEqual(repeated.body.draft, adopted.body.draft);
  assert.equal(server.repository.getLatestDraft(graph.id).revision, adopted.body.draft.revision);
  assert.equal((await api(`/api/graphs/${graph.id}/plans/${proposal.id}/adopt`, 'POST', { ...body, nodeIds: ['build'] })).status, 409);
  const other = (await api('/api/graphs', 'POST', { name: 'Other graph' })).body.graph;
  assert.equal((await api(`/api/graphs/${other.id}/plans/${proposal.id}/adopt`, 'POST', body)).status, 409);
  assert.equal((await api(`/api/graphs/${graph.id}/plans/${proposal.id}/adopt`, 'POST', { ...body, requestId: 'new-stale-request' })).status, 409);
  const fresh = server.repository.createPlan({ graphId: graph.id, baseDraftRevision: adopted.body.draft.revision, provider: 'local-agents', contentHash: 'b'.repeat(64), plan: { steps, proposedGraph: { nodes, relationships: [] } }, diff: {} });
  assert.equal((await api(`/api/graphs/${graph.id}/plans/${fresh.id}/adopt`, 'POST', { nodeIds: ['unknown'] })).status, 422);
  const active = server.repository.createExecution({ graphId: graph.id, planId: fresh.id });
  assert.equal((await api(`/api/graphs/${graph.id}/plans/${fresh.id}/adopt`, 'POST', { nodeIds: ['build'] })).status, 409);
  server.repository.cancelExecution(active.id);
  const racingPlan = server.repository.createPlan({ graphId: graph.id, baseDraftRevision: adopted.body.draft.revision, provider: 'local-agents', contentHash: 'c'.repeat(64), plan: { steps, proposedGraph: { nodes, relationships: [] } }, diff: {} });
  const racingRoute = createEngineeringProposalRoutes({
    repository: server.repository,
    readJson: async () => { server.repository.supersedeAwaitingPlan(racingPlan.id); return { nodeIds: ['build'] }; },
    HttpError: class extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } },
    json: () => assert.fail('Superseded proposal must not be adopted.'), validateDraft: () => assert.fail('Admission must reject before draft mutation.'),
  });
  await assert.rejects(racingRoute.handle({ request: {}, response: {}, path: `/api/graphs/${graph.id}/plans/${racingPlan.id}/adopt`, method: 'POST', cors: {} }), { code: 'PLAN_DRAFT_STALE' });
  assert.equal(server.repository.getLatestDraft(graph.id).revision, adopted.body.draft.revision);
  const edited = await api(`/api/graphs/${graph.id}/draft`, 'PUT', { ...adopted.body.draft, nodes: adopted.body.draft.nodes.filter((node) => node.id !== adoptedBuild.id), edges: adopted.body.draft.edges.filter((edge) => edge.source !== adoptedBuild.id && edge.target !== adoptedBuild.id) });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.draft.nodes.length, 2);
});
