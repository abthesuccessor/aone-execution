import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/index.mjs';

const allowedOrigin = 'http://127.0.0.1:5173';

async function eventually(callback, { timeoutMs = 5_000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await callback();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition was not met before timeout; last value: ${JSON.stringify(lastValue)}`);
}

function rawRequest({ port, path, hostHeader, origin }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { Host: hostHeader, ...(origin ? { Origin: origin } : {}) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('localhost harness persists plan/approval/execution/replan lineage and guards its browser boundary', async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ege-local-server-test-'));
  const workspaceRoot = join(temporaryRoot, 'workspace');
  const skillsRoot = join(temporaryRoot, 'skills');
  const skillDirectory = join(skillsRoot, 'frontend-quality');
  const invalidSkillDirectory = join(skillsRoot, 'invalid-skill');
  const outsideRoot = await mkdtemp(join(tmpdir(), 'ege-outside-'));
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(invalidSkillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, 'SKILL.md'), [
    '---',
    'name: frontend-quality',
    'description: Apply accessible frontend quality checks.',
    '---',
    '',
    '# Frontend quality',
    '',
    'Check keyboard access and visible loading, error, empty, and success states.',
    '',
  ].join('\n'));
  await writeFile(join(skillDirectory, 'reference.md'), 'Initial package reference.\n');
  await writeFile(join(invalidSkillDirectory, 'SKILL.md'), '# Missing frontmatter\n');
  await symlink(outsideRoot, join(workspaceRoot, 'outside-link'));

  const localServer = createLocalServer({
    port: 0,
    databasePath: join(temporaryRoot, 'local.db'),
    skillsRoot,
    workspaceRoot,
    stepDelayMs: 90,
  });
  const address = await localServer.start();
  const baseUrl = localServer.address;
  context.after(async () => {
    await localServer.close();
    await rm(temporaryRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  });

  const sessionResponse = await fetch(`${baseUrl}/api/session`, { headers: { Origin: allowedOrigin } });
  assert.equal(sessionResponse.status, 200);
  const { sessionToken } = await sessionResponse.json();
  assert.equal(sessionToken, null);

  async function api(path, { method = 'GET', body, origin = allowedOrigin } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(origin ? { Origin: origin } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null };
  }

  const hostileHost = await rawRequest({ port: address.port, path: '/api/health', hostHeader: 'attacker.example' });
  assert.equal(hostileHost.status, 403);
  assert.equal(JSON.parse(hostileHost.body).error.code, 'HOST_REJECTED');

  const hostileOrigin = await api('/api/health', { origin: 'https://attacker.example' });
  assert.equal(hostileOrigin.response.status, 403);
  assert.equal(hostileOrigin.response.headers.get('access-control-allow-origin'), null);
  assert.equal(hostileOrigin.body.error.code, 'ORIGIN_REJECTED');

  const noAuth = await api('/api/graphs', { method: 'POST', body: { name: 'No authentication required' } });
  assert.equal(noAuth.response.status, 201);
  const noAuthDelete = await api(`/api/graphs/${noAuth.body.graph.id}`, { method: 'DELETE' });
  assert.equal(noAuthDelete.response.status, 204);
  const noOrigin = await api('/api/graphs', { method: 'POST', body: { name: 'Blocked' }, origin: null });
  assert.equal(noOrigin.response.status, 403);
  assert.equal(noOrigin.body.error.code, 'ORIGIN_REQUIRED');

  const escapedWorkspace = await api('/api/graphs', {
    method: 'POST',
    body: { name: 'Escaped', workspacePath: join(workspaceRoot, 'outside-link') },
  });
  assert.equal(escapedWorkspace.response.status, 403);
  assert.equal(escapedWorkspace.body.error.code, 'WORKSPACE_OUTSIDE_ROOT');

  const skillResult = await api('/api/skills');
  assert.equal(skillResult.response.status, 200);
  assert.equal(skillResult.body.items.length, 2);
  const selectedSkill = skillResult.body.items.find((skill) => skill.name === 'frontend-quality');
  const invalidSkill = skillResult.body.items.find((skill) => skill.name === 'invalid-skill');
  assert.equal(selectedSkill.valid, true);
  assert.equal(invalidSkill.valid, false);
  assert.match(invalidSkill.validationErrors[0], /frontmatter/i);
  assert.match(selectedSkill.contentDigest, /^[a-f0-9]{64}$/);
  assert.match(selectedSkill.packageDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(selectedSkill.packageFiles.map((file) => file.path), ['reference.md', 'SKILL.md']);
  assert.equal(selectedSkill.relativePath, 'frontend-quality/SKILL.md');
  assert.equal(JSON.stringify(skillResult.body).includes(temporaryRoot), false);
  assert.equal('content' in selectedSkill, false);

  const providers = await api('/api/providers');
  assert.equal(providers.response.status, 200);
  assert.equal(providers.body.items.find((provider) => provider.id === 'local-agents').available, true);
  assert.equal(providers.body.items.find((provider) => provider.id === 'simulation').available, true);
  assert.equal(providers.body.items.find((provider) => provider.id === 'claude-cli').available, false);
  assert.equal(JSON.stringify(providers.body).includes(process.env.OPENAI_API_KEY || '__never__'), false);

  const localGraph = await api('/api/graphs', {
    method: 'POST', body: { name: 'Fast local planning' },
  });
  const localGraphId = localGraph.body.graph.id;
  await api(`/api/graphs/${localGraphId}/draft`, {
    method: 'PUT',
    body: {
      nodes: [{ id: 'memory-intent', title: 'Long-term memory architecture', objective: 'Design durable service memory.', context: 'Use persisted evidence and clear quality gates.' }],
      edges: [],
    },
  });
  const localPlanned = await api(`/api/graphs/${localGraphId}/plans`, {
    method: 'POST', body: { provider: 'local-agents' },
  });
  assert.equal(localPlanned.response.status, 201);
  assert.equal(localPlanned.body.plan.provider, 'local-agents');
  assert.equal(localPlanned.body.plan.plan.contextManifest.workspaceBaseline.kind, 'local-context');
  assert.equal(localPlanned.body.plan.plan.contextManifest.proposalGenerator.kind, 'local-agent-parser');
  assert.ok(localPlanned.body.plan.plan.proposedGraph.nodes.length > 1);
  const localApproval = await api(`/api/plans/${localPlanned.body.plan.id}/approve`, {
    method: 'POST',
    body: { expectedContentHash: localPlanned.body.plan.contentHash, rationale: 'Local context decomposition is correct.' },
  });
  assert.equal(localApproval.response.status, 200);

  const created = await api('/api/graphs', {
    method: 'POST',
    body: { name: 'Engineering lifecycle', description: 'Local graph harness', workspacePath: workspaceRoot },
  });
  assert.equal(created.response.status, 201);
  const graphId = created.body.graph.id;

  const nodes = [
    { id: 'wish', title: 'Desired outcome', kind: 'wish', context: 'Build the requested developer experience.' },
    { id: 'frontend', title: 'Frontend workbench', kind: 'frontend', context: 'Implement an accessible responsive React node editor.' },
    { id: 'backend', title: 'Backend API', kind: 'backend', context: 'Implement the orchestration API.' },
  ];
  const draftTwo = await api(`/api/graphs/${graphId}/draft`, {
    method: 'PUT', body: { nodes, edges: [], context: 'Initial graph context.' },
  });
  assert.equal(draftTwo.response.status, 200);
  assert.equal(draftTwo.body.draft.revision, 2);
  assert.ok(draftTwo.body.draft.nodes.every((node) => Array.isArray(node.skills) && node.skills.length === 0));

  const missingProvider = await api(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: {},
  });
  assert.equal(missingProvider.response.status, 422);
  assert.equal(missingProvider.body.error.code, 'PLANNING_PROVIDER_REQUIRED');

  const unsupportedResearch = await api(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'simulation', research: { enabled: true } },
  });
  assert.equal(unsupportedResearch.response.status, 422);
  assert.equal(unsupportedResearch.body.error.code, 'RESEARCH_PROVIDER_UNSUPPORTED');

  const malformedResearch = await api(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'simulation', research: { enabled: 'yes' } },
  });
  assert.equal(malformedResearch.response.status, 422);
  assert.equal(malformedResearch.body.error.code, 'INVALID_RESEARCH_POLICY');

  const plannedOne = await api(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'simulation', instructions: 'Keep the plan testable.' },
  });
  assert.equal(plannedOne.response.status, 201);
  const planOne = plannedOne.body.plan;
  assert.equal(planOne.plan.steps.length, planOne.plan.proposedGraph.nodes.length);
  assert.equal(
    planOne.plan.proposedEdges.length,
    planOne.plan.proposedGraph.relationships.filter((relationship) => relationship.type === 'REQUIRES').length,
  );
  assert.ok(planOne.plan.steps.length > 1 && planOne.plan.steps.length <= 7);
  assert.ok(planOne.plan.proposedGraph.selectedDomains.includes('quality'));
  assert.ok(planOne.plan.proposedGraph.selectedDomains.includes('security'));
  assert.ok(planOne.plan.steps.every((step) => step.acceptanceCriteria.length && /^[a-f0-9]{64}$/.test(step.inputDigest)));
  const skillBoundStep = planOne.plan.steps.find((step) => step.skills.some((skill) => skill.id === selectedSkill.id));
  assert.ok(skillBoundStep);
  assert.deepEqual(skillBoundStep.skills.find((skill) => skill.id === selectedSkill.id), {
    id: selectedSkill.id,
    name: selectedSkill.name,
    digest: selectedSkill.contentDigest,
    packageDigest: selectedSkill.packageDigest,
  });
  assert.equal(planOne.plan.contextManifest.selectedSkills[0].digest, selectedSkill.contentDigest);
  assert.equal(planOne.plan.contextManifest.selectedSkills[0].packageDigest, selectedSkill.packageDigest);
  assert.equal(planOne.plan.contextManifest.skillRouting.mode, 'agent-managed');
  assert.equal(planOne.plan.contextManifest.researchPolicy.enabled, false);
  assert.equal(planOne.plan.contextManifest.researchPolicy.mode, 'disabled');

  const wrongHashApproval = await api(`/api/plans/${planOne.id}/approve`, {
    method: 'POST', body: { expectedContentHash: '0'.repeat(64), rationale: 'Wrong document.' },
  });
  assert.equal(wrongHashApproval.response.status, 409);
  assert.equal(wrongHashApproval.body.error.code, 'PLAN_HASH_MISMATCH');

  const approvalOne = await api(`/api/plans/${planOne.id}/approve`, {
    method: 'POST', body: { expectedContentHash: planOne.contentHash, rationale: 'The scope is correct.' },
  });
  assert.equal(approvalOne.response.status, 200);
  assert.equal(approvalOne.body.approval.rationale, 'The scope is correct.');

  const draftThree = await api(`/api/graphs/${graphId}/draft`, {
    method: 'PUT', body: { nodes, edges: [], context: 'Changed graph context.' },
  });
  assert.equal(draftThree.body.draft.revision, 3);
  const staleStart = await api(`/api/graphs/${graphId}/executions`, {
    method: 'POST', body: { planId: planOne.id, expectedPlanHash: planOne.contentHash },
  });
  assert.equal(staleStart.response.status, 409);
  assert.equal(staleStart.body.error.code, 'PLAN_DRAFT_STALE');

  const plannedTwo = await api(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'simulation', instructions: 'Keep the plan testable.' },
  });
  const planTwo = plannedTwo.body.plan;
  assert.equal(planTwo.version, 2);
  assert.ok(planTwo.diff.changedNodeIds.length >= 1);
  assert.equal((await api(`/api/plans/${planTwo.id}/approve`, {
    method: 'POST', body: { expectedContentHash: planTwo.contentHash, rationale: 'Approved for simulation.' },
  })).response.status, 200);

  const wrongHashStart = await api(`/api/graphs/${graphId}/executions`, {
    method: 'POST', body: { planId: planTwo.id, expectedPlanHash: 'f'.repeat(64) },
  });
  assert.equal(wrongHashStart.response.status, 409);
  assert.equal(wrongHashStart.body.error.code, 'PLAN_HASH_MISMATCH');

  const started = await api(`/api/graphs/${graphId}/executions`, {
    method: 'POST', body: { planId: planTwo.id, expectedPlanHash: planTwo.contentHash },
  });
  assert.equal(started.response.status, 202);
  const predecessorId = started.body.execution.id;
  await eventually(async () => {
    const detail = await api(`/api/executions/${predecessorId}`);
    return detail.body.events.some((event) => event.type === 'node.started') && detail.body;
  });
  const pause = await api(`/api/executions/${predecessorId}/pause`, { method: 'POST', body: {} });
  assert.equal(pause.response.status, 202);
  const paused = await eventually(async () => {
    const detail = (await api(`/api/executions/${predecessorId}`)).body;
    return detail.execution.status === 'PAUSED' ? detail : null;
  });
  assert.ok(paused.execution.completedNodeIds.length >= 1);

  const changedNodes = nodes.map((node) => node.id === 'wish'
    ? { ...node, context: 'Build a materially changed developer experience.' }
    : node);
  const replanned = await api(`/api/executions/${predecessorId}/replan`, {
    method: 'POST',
    body: {
      provider: 'simulation',
      instructions: 'Continue from reusable checkpoints.',
      draft: { nodes: changedNodes, edges: [], context: 'Changed graph context.' },
    },
  });
  assert.equal(replanned.response.status, 201);
  assert.equal(replanned.body.plan.version, 3);
  assert.equal(replanned.body.plan.status, 'AWAITING_APPROVAL');
  assert.ok(replanned.body.plan.diff.changedNodeIds.length >= 1);
  assert.ok(replanned.body.plan.diff.changedNodeIds.every((nodeId) => (
    replanned.body.plan.plan.proposedGraph.nodes.some((node) => node.id === nodeId)
  )));
  assert.equal((await api(`/api/plans/${replanned.body.plan.id}/approve`, {
    method: 'POST', body: {
      expectedContentHash: replanned.body.plan.contentHash,
      rationale: 'New context is represented.',
    },
  })).response.status, 200);

  const continued = await api(`/api/executions/${predecessorId}/resume`, { method: 'POST', body: {} });
  assert.equal(continued.response.status, 202);
  assert.notEqual(continued.body.execution.id, predecessorId);
  assert.equal(continued.body.predecessor.status, 'SUPERSEDED');
  assert.equal(continued.body.execution.parentExecutionId, predecessorId);
  assert.deepEqual(continued.body.execution.resumedFromCheckpoint.reusedNodeIds, []);
  const successorId = continued.body.execution.id;

  const completed = await eventually(async () => {
    const detail = (await api(`/api/executions/${successorId}`)).body;
    return detail.execution.status === 'COMPLETED' ? detail : null;
  }, { timeoutMs: 8_000 });
  assert.equal(completed.execution.completedNodeIds.length, replanned.body.plan.plan.steps.length);
  assert.ok(completed.artifacts.some((artifact) => artifact.mediaType === 'text/markdown'));
  assert.ok(completed.artifacts.some((artifact) => artifact.mediaType === 'application/json'));
  assert.ok(completed.events.some((event) => event.type === 'verification.receipt' && event.verificationMode === 'SIMULATED'));
  const nodeEvent = completed.events.find((event) => event.type === 'node.completed');
  assert.equal(nodeEvent.nodeId, nodeEvent.payload.nodeId);
  assert.equal(nodeEvent.timestamp, nodeEvent.createdAt);

  const predecessorReplay = (await api(`/api/executions/${predecessorId}`)).body;
  const supersededEvent = predecessorReplay.events.find((event) => event.type === 'execution.superseded');
  assert.equal(supersededEvent.successorExecutionId, successorId);
  const filteredArtifacts = (await api(`/api/executions/${successorId}/artifacts`)).body.items;
  const historyArtifacts = (await api(`/api/executions/${successorId}/artifacts?history=true`)).body.items;
  assert.equal(filteredArtifacts.every((artifact) => artifact.lineageStatus === 'CURRENT'), true);
  assert.ok(historyArtifacts.length > filteredArtifacts.length);
  assert.ok(historyArtifacts.some((artifact) => artifact.lineageStatus === 'OBSOLETE_HISTORY'));

  const pinnedRun = await api(`/api/graphs/${graphId}/executions`, {
    method: 'POST',
    body: { planId: replanned.body.plan.id, expectedPlanHash: replanned.body.plan.contentHash },
  });
  const pinnedExecutionId = pinnedRun.body.execution.id;
  await eventually(async () => {
    const detail = (await api(`/api/executions/${pinnedExecutionId}`)).body;
    return detail.events.some((event) => event.type === 'node.started');
  });
  await api(`/api/executions/${pinnedExecutionId}/pause`, { method: 'POST', body: {} });
  await eventually(async () => {
    const detail = (await api(`/api/executions/${pinnedExecutionId}`)).body;
    return detail.execution.status === 'PAUSED';
  });
  const pendingOriginalReplacement = await api(`/api/executions/${pinnedExecutionId}/replan`, {
    method: 'POST', body: { provider: 'simulation', instructions: 'Proposal that will be discarded.' },
  });
  assert.equal(pendingOriginalReplacement.response.status, 201);
  await api(`/api/graphs/${graphId}/draft`, {
    method: 'PUT',
    body: { nodes: changedNodes, edges: [], context: 'Mutable draft changed after original execution admission.' },
  });
  const resumedOriginal = await api(`/api/executions/${pinnedExecutionId}/resume`, {
    method: 'POST', body: { mode: 'PINNED_PLAN' },
  });
  assert.equal(resumedOriginal.response.status, 202);
  assert.equal(resumedOriginal.body.execution.id, pinnedExecutionId);
  assert.equal(resumedOriginal.body.execution.pendingPlanId, null);
  const discardedPlan = (await api(`/api/plans/${pendingOriginalReplacement.body.plan.id}`)).body.plan;
  assert.equal(discardedPlan.status, 'SUPERSEDED');
  const pinnedCompleted = await eventually(async () => {
    const detail = (await api(`/api/executions/${pinnedExecutionId}`)).body;
    return detail.execution.status === 'COMPLETED' ? detail : null;
  }, { timeoutMs: 8_000 });
  assert.ok(pinnedCompleted.events.some((event) => event.type === 'plan.discarded'));
  assert.ok(pinnedCompleted.events.some((event) => event.type === 'execution.resumed' && event.mode === 'PINNED_PLAN'));

  const explicitBranch = await api(`/api/graphs/${graphId}/plans`, {
    method: 'POST',
    body: {
      provider: 'simulation',
      parentPlanId: replanned.body.plan.id,
      instructions: 'Branch from the active pinned plan, not the discarded successor.',
    },
  });
  assert.equal(explicitBranch.response.status, 201);
  assert.equal(explicitBranch.body.plan.parentPlanId, replanned.body.plan.id);
  assert.ok(explicitBranch.body.plan.version > pendingOriginalReplacement.body.plan.version);

  const otherWorkspace = await api('/api/graphs', {
    method: 'POST', body: { name: 'Other workspace', workspacePath: workspaceRoot },
  });
  await api(`/api/graphs/${otherWorkspace.body.graph.id}/draft`, {
    method: 'PUT',
    body: { nodes: [{ id: 'other-intent', title: 'Other intent', context: 'Keep lineage isolated.' }], edges: [] },
  });
  const crossWorkspaceParent = await api(`/api/graphs/${otherWorkspace.body.graph.id}/plans`, {
    method: 'POST',
    body: { provider: 'simulation', parentPlanId: replanned.body.plan.id },
  });
  assert.equal(crossWorkspaceParent.response.status, 409);
  assert.equal(crossWorkspaceParent.body.error.code, 'PLAN_GRAPH_MISMATCH');

  const sseAbort = new AbortController();
  const sseResponse = await fetch(`${baseUrl}/api/executions/${successorId}/events?after=0`, {
    headers: { Origin: allowedOrigin }, signal: sseAbort.signal,
  });
  assert.equal(sseResponse.status, 200);
  const reader = sseResponse.body.getReader();
  let sseText = '';
  while (!sseText.includes('event: execution.started')) {
    const { value, done } = await reader.read();
    if (done) break;
    sseText += Buffer.from(value).toString('utf8');
  }
  sseAbort.abort();
  assert.match(sseText, /event: execution\.started/);
  assert.match(sseText, /"plannerProvider":"simulation"/);

  const baselineSequence = Math.max(...completed.events.map((event) => event.sequence));
  for (let index = 0; index < 2_005; index += 1) {
    localServer.repository.appendEvent(successorId, 'bulk.event', { message: `bulk ${index}` });
  }
  const firstHistoryPage = (await api(`/api/executions/${successorId}?after=${baselineSequence}&limit=2000`)).body;
  assert.equal(firstHistoryPage.events.length, 2_000);
  assert.equal(firstHistoryPage.eventPage.hasMore, true);
  const secondHistoryPage = (await api(`/api/executions/${successorId}?after=${firstHistoryPage.eventPage.nextAfter}&limit=2000`)).body;
  assert.equal(secondHistoryPage.events.length, 5);
  assert.equal(secondHistoryPage.eventPage.hasMore, false);
  const replayAbort = new AbortController();
  const replayResponse = await fetch(`${baseUrl}/api/executions/${successorId}/events?after=${baselineSequence}`, {
    headers: { Origin: allowedOrigin }, signal: replayAbort.signal,
  });
  const replayReader = replayResponse.body.getReader();
  let replayText = '';
  while (!replayText.includes('"message":"bulk 2004"')) {
    const { value, done } = await replayReader.read();
    if (done) break;
    replayText += Buffer.from(value).toString('utf8');
  }
  replayAbort.abort();
  assert.equal((replayText.match(/event: bulk\.event/g) || []).length, 2_005);

  const skillPinnedPlan = (await api(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'simulation' },
  })).body.plan;
  assert.equal((await api(`/api/plans/${skillPinnedPlan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: skillPinnedPlan.contentHash, rationale: 'Pin current skill.' },
  })).response.status, 200);
  await writeFile(join(skillDirectory, 'reference.md'), 'Package resource changed after approval.\n');
  const staleSkillStart = await api(`/api/graphs/${graphId}/executions`, {
    method: 'POST', body: { planId: skillPinnedPlan.id, expectedPlanHash: skillPinnedPlan.contentHash },
  });
  assert.equal(staleSkillStart.response.status, 409);
  assert.equal(staleSkillStart.body.error.code, 'PLAN_CONTEXT_STALE');
  assert.equal(staleSkillStart.body.error.details.reason, 'AGENT_CAPABILITY_CATALOG_CHANGED');
});

test('planner rejects cyclic dependency graphs instead of executing out of order', async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ege-cycle-test-'));
  const workspaceRoot = join(temporaryRoot, 'workspace');
  await mkdir(workspaceRoot, { recursive: true });
  const localServer = createLocalServer({
    port: 0,
    databasePath: join(temporaryRoot, 'cycle.db'),
    skillsRoot: join(temporaryRoot, 'skills'),
    workspaceRoot,
    stepDelayMs: 5,
  });
  await localServer.start();
  context.after(async () => {
    await localServer.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const baseUrl = localServer.address;
  const mutate = async (path, body, method = 'POST') => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Origin: allowedOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const graph = await mutate('/api/graphs', { name: 'Cycle' });
  const graphId = graph.body.graph.id;
  await mutate(`/api/graphs/${graphId}/draft`, {
    nodes: [
      { id: 'a', title: 'A', context: 'A' },
      { id: 'b', title: 'B', context: 'B' },
    ],
    edges: [
      { id: 'a-b', source: 'a', target: 'b' },
      { id: 'b-a', source: 'b', target: 'a' },
    ],
  }, 'PUT');
  const result = await mutate(`/api/graphs/${graphId}/plans`, { provider: 'simulation' });
  assert.equal(result.status, 422);
  assert.equal(result.body.error.code, 'INTENT_CYCLE');
  assert.match(result.body.error.message, /dependency cycle/i);
});

test('startup recovery resumes a persisted running simulation from its last completed checkpoint', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ege-recovery-test-'));
  const workspaceRoot = join(temporaryRoot, 'workspace');
  const databasePath = join(temporaryRoot, 'recovery.db');
  await mkdir(workspaceRoot, { recursive: true });
  let firstServer;
  let secondServer;
  try {
    firstServer = createLocalServer({
      port: 0,
      databasePath,
      skillsRoot: join(temporaryRoot, 'skills'),
      workspaceRoot,
      stepDelayMs: 400,
    });
    await firstServer.start();
    const firstBase = firstServer.address;
    const firstMutation = async (path, body, method = 'POST') => {
      const response = await fetch(`${firstBase}${path}`, {
        method,
        headers: { Origin: allowedOrigin, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const graph = await firstMutation('/api/graphs', { name: 'Recoverable' });
    const graphId = graph.body.graph.id;
    await firstMutation(`/api/graphs/${graphId}/draft`, {
      nodes: [
        { id: 'one', title: 'One', context: 'First' },
        { id: 'two', title: 'Two', context: 'Second' },
      ],
      edges: [],
    }, 'PUT');
    const plan = (await firstMutation(`/api/graphs/${graphId}/plans`, { provider: 'simulation' })).body.plan;
    await firstMutation(`/api/plans/${plan.id}/approve`, {
      expectedContentHash: plan.contentHash,
      rationale: 'Recovery test.',
    });
    const execution = (await firstMutation(`/api/graphs/${graphId}/executions`, {
      planId: plan.id,
      expectedPlanHash: plan.contentHash,
    })).body.execution;
    await eventually(async () => {
      const detail = await (await fetch(`${firstBase}/api/executions/${execution.id}`, { headers: { Origin: allowedOrigin } })).json();
      return detail.events.some((event) => event.type === 'node.started');
    });
    await firstServer.close();
    firstServer = null;

    secondServer = createLocalServer({
      port: 0,
      databasePath,
      skillsRoot: join(temporaryRoot, 'skills'),
      workspaceRoot,
      stepDelayMs: 5,
    });
    await secondServer.start();
    const secondBase = secondServer.address;
    const recovered = await eventually(async () => {
      const response = await fetch(`${secondBase}/api/executions/${execution.id}`, { headers: { Origin: allowedOrigin } });
      const detail = await response.json();
      return detail.execution.status === 'COMPLETED' ? detail : null;
    }, { timeoutMs: 5_000 });
    assert.ok(recovered.events.some((event) => event.type === 'execution.recovered'));
    assert.equal(recovered.execution.completedNodeIds.length, plan.plan.steps.length);
    assert.equal(
      new Set(recovered.events.filter((event) => event.type === 'node.started').map((event) => event.nodeId)).size,
      plan.plan.steps.length,
    );
  } finally {
    if (firstServer) await firstServer.close();
    if (secondServer) await secondServer.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
