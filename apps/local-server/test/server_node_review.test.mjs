import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createLocalServer } from '../src/server.mjs';
import { pinNodeReview } from '../src/node_review.mjs';
import { captureWorkspaceBaseline } from '../src/planners.mjs';
import { workspaceBinding } from '../src/trace_data.mjs';

const criterion = 'The implementation has a passing command receipt.';
const responseText = (status) => JSON.stringify({ summary: 'Compared recorded evidence.', assessments: [{ criterion, status, support: 'recorded_evidence', reasoning: 'The recorded command reports a passing test.', citations: [{ evidenceId: 'command:1', quote: '1 test passed.' }] }] });
async function eventually(read) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('Execution did not reach its expected checkpoint.');
}

// runNodeReviews arms its timeout before the pre-flight staleness check, so the
// budget covers a PostgreSQL round-trip as well as the reviewer call. A 40ms
// budget assumed that round-trip was free and aborted the happy path as
// NODE_REVIEW_TIMEOUT before the reviewer was ever invoked. 1500ms still trips
// promptly for the 'timeout' mode, whose reviewer never resolves at all.
test('required review gates dependent execution with durable success, contradiction, timeout, stale and cancellation outcomes', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-node-review-'));
  const workspacePath = join(root, 'workspace'); const bin = join(root, 'bin');
  await mkdir(workspacePath); await mkdir(bin);
  await writeFile(join(bin, 'codex'), '#!/bin/sh\nexit 0\n'); await chmod(join(bin, 'codex'), 0o755);
  const environment = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, EGE_ENABLE_WORKSPACE_WRITE: '1' };
  let mode = 'pass'; let activeGraph; let calls = []; let reviewCalls = 0;
  const server = createLocalServer({ port: 0, databasePath: join(root, 'postgres'), workspaceRoot: workspacePath, skillsRoot: join(root, 'skills'), environment, nodeReviewTimeoutMs: 1500,
    fetchImpl: async () => new Response(JSON.stringify({ models: [{ name: 'review-model' }] }), { headers: { 'Content-Type': 'application/json' } }),
    codexWorkspaceExecutor: async ({ step }) => {
      calls.push(step.nodeId);
      return { provider: 'codex-cli', model: null, inputDigest: 'd'.repeat(64), receipt: { status: 'COMPLETED', summary: 'Recorded test completed.', changedFiles: [], acceptance: [{ criterion, status: 'PASS', evidence: '1 test passed.' }], verification: [{ command: 'npm test', status: 'PASS', details: '1 test passed.' }], risks: [] }, actualVerification: [{ command: 'npm test', status: 'PASS', exitCode: 0, output: '1 test passed.' }], actualChangedFiles: [], changedFilesMatch: true, workspaceBeforeDigest: 'e'.repeat(64), workspaceAfterDigest: 'e'.repeat(64), workspaceArtifacts: { artifacts: [], skipped: [], totalBytes: 0 }, accepted: true, eventCount: 1 };
    },
    nodeReviewStream: async ({ onEvent }) => {
      reviewCalls++;
      const execution = server.repository.listExecutions(activeGraph.id)[0];
      const trace = server.repository.getTraceByExecution(execution.id);
      const modelSpans = server.repository.listTraceSpans(trace.id).filter((span) => span.category === 'MODEL');
      assert.equal(modelSpans.length, 1);
      assert.ok(modelSpans[0].endedAt, 'Executor model duration must end before the separate review provider starts.');
      assert.equal(modelSpans[0].status, 'OK');
      if (mode === 'timeout') return new Promise(() => {});
      if (mode === 'workspace-drift') await writeFile(join(workspacePath, 'changed-during-review.txt'), 'External drift.');
      if (mode === 'stale') {
        const draft = server.repository.getLatestDraft(activeGraph.id);
        server.repository.saveDraft(activeGraph.id, { ...draft, nodes: draft.nodes.map((node) => node.id === 'reviewer' ? { ...node, context: 'Changed while reviewing.' } : node) });
      }
      if (mode === 'cancel') {
        await api(`/api/executions/${execution.id}/cancel`, { method: 'POST', body: {} });
      }
      onEvent({ type: 'delta', text: responseText(mode === 'contradiction' ? 'contradicted' : 'supported') });
    },
  });
  await server.start();
  context.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${server.address}${path}`, { method, headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  const connected = await api('/api/provider-connections/connect', { method: 'POST', body: { kind: 'local', providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'review-model' } });
  assert.equal(connected.status, 200, JSON.stringify(connected.body));
  const profile = server.repository.getProviderProfile('ollama');
  const providerPin = { id: profile.id, label: profile.label, kind: profile.kind, model: profile.model, baseUrl: profile.baseUrl, enabled: profile.enabled, secretEnvName: profile.secretEnvName, options: profile.options, connectionRevision: connected.body.connection.revision, updatedAt: profile.updatedAt };
  const agent = server.repository.getAgent('requirements-analyst');
  const canonical = await realpath(workspacePath);

  for (mode of ['pass', 'contradiction', 'timeout', 'stale', 'workspace-drift', 'cancel']) {
    calls = []; reviewCalls = 0;
    activeGraph = (await api('/api/graphs', { method: 'POST', body: { name: `Review ${mode}`, workspacePath } })).body.graph;
    const draftResponse = await api(`/api/graphs/${activeGraph.id}/draft`, { method: 'PUT', body: { nodes: [
      { id: 'target', title: 'Implementation', review: { required: true, reviewerNodeIds: ['reviewer'], providerId: 'ollama' } },
      { id: 'reviewer', title: 'Review preset', agentId: agent.id },
      { id: 'consumer', title: 'Dependent work' },
    ], edges: [{ id: 'dependency', source: 'target', target: 'consumer', type: 'REQUIRES' }] } });
    assert.equal(draftResponse.status, 200, JSON.stringify(draftResponse.body));
    const draft = draftResponse.body.draft;
    const base = { title: 'Recorded work', objective: 'Run a test', acceptanceCriteria: [criterion], skills: [], agentId: agent.id, promptDigest: `sha256:${agent.currentPrompt.digest}`, sourceEvidenceIds: [] };
    const target = { ...base, id: 'step:target', nodeId: 'target-step', dependsOn: [], inputDigest: 'b'.repeat(64), sourceIntentNodeIds: ['target'], review: draft.nodes[0].review };
    target.reviewPin = pinNodeReview({ step: target, draft, steps: [target], agents: [agent], defaultProviderId: 'codex-cli', getProviderPin: () => providerPin });
    const consumer = { ...base, id: 'step:consumer', nodeId: 'consumer-step', dependsOn: ['target-step'], inputDigest: 'c'.repeat(64), sourceIntentNodeIds: ['consumer'] };
    const contentHash = 'a'.repeat(64);
    const plan = server.repository.createPlan({ graphId: activeGraph.id, baseDraftRevision: draft.revision, provider: 'codex-cli', contentHash,
      plan: { summary: 'Review before dependency admission.', proposedEdges: [], contextManifest: { workspaceBinding: workspaceBinding(canonical, await stat(canonical)), workspaceBaseline: await captureWorkspaceBaseline(workspacePath, environment) }, steps: [target, consumer] }, diff: { summary: 'Initial plan' } });
    const approved = await api(`/api/plans/${plan.id}/approve`, { method: 'POST', body: { expectedContentHash: contentHash } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const started = await api(`/api/graphs/${activeGraph.id}/executions`, { method: 'POST', body: { planId: plan.id, expectedPlanHash: contentHash } });
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const executionId = started.body.execution.id;
    const final = await eventually(() => { const value = server.repository.getExecution(executionId); return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(value.status) ? value : null; });
    assert.equal(reviewCalls, 1, mode);
    assert.equal(final.status, mode === 'pass' ? 'COMPLETED' : mode === 'cancel' ? 'CANCELLED' : 'FAILED', mode);
    assert.deepEqual(calls, mode === 'pass' ? ['target-step', 'consumer-step'] : ['target-step'], mode);
    const events = server.repository.listEvents(executionId);
    assert.ok(events.some((event) => event.type === 'node.review.started'), mode);
    if (mode !== 'cancel') {
      const receipt = server.repository.listArtifacts(executionId).map((artifact) => { try { return JSON.parse(artifact.content); } catch { return null; } }).find((value) => value?.nodeId === 'target-step' && value.review);
      assert.ok(receipt, mode);
      assert.equal(receipt.executionResult, 'PASS');
      assert.equal(receipt.review.passed, mode === 'pass');
      if (mode === 'timeout') assert.equal(receipt.review.error.code, 'NODE_REVIEW_TIMEOUT');
      if (mode === 'stale') assert.equal(receipt.review.error.code, 'NODE_REVIEW_STALE');
      if (mode === 'workspace-drift') assert.equal(receipt.review.error.code, 'NODE_REVIEW_WORKSPACE_CHANGED');
    } else assert.equal(events.some((event) => event.type === 'node.completed'), false);
  }

  const graph = (await api('/api/graphs', { method: 'POST', body: { name: 'Plan pin validation', workspacePath } })).body.graph;
  const draftInput = { nodes: [
    { id: 'target', title: 'Implement a small function', description: 'Implement and test a pure function.', acceptanceCriteria: [criterion], review: { required: true, reviewerNodeIds: ['reviewer'], providerId: 'ollama' } },
    { id: 'reviewer', title: 'Review quality', agentId: agent.id },
  ], edges: [] };
  assert.equal((await api(`/api/graphs/${graph.id}/draft`, { method: 'PUT', body: draftInput })).status, 200);
  const planned = await api(`/api/graphs/${graph.id}/plans`, { method: 'POST', body: { provider: 'local-agents' } });
  assert.equal(planned.status, 201, JSON.stringify(planned.body));
  const plan = planned.body.plan;
  const reviewedSteps = plan.plan.steps.filter((step) => step.reviewPin);
  assert.ok(reviewedSteps.length > 0, 'Saved review configuration must survive compilation into immutable steps.');
  assert.ok(reviewedSteps.every((step) => step.reviewPin.reviewers[0].nodeId === 'reviewer'));
  assert.equal(plan.plan.contextManifest.engineeringSettings.revision, 0);
  const settings = (await api('/api/engineering/settings')).body;
  const savedSettings = await api('/api/engineering/settings', { method: 'PUT', body: { ...settings, expectedRevision: settings.revision, skills: { disabledIds: ['disabled-for-test'] } } });
  assert.equal(savedSettings.status, 200);
  const staleApproval = await api(`/api/plans/${plan.id}/approve`, { method: 'POST', body: { expectedContentHash: plan.contentHash } });
  assert.equal(staleApproval.status, 409);
  assert.equal(staleApproval.body.error.code, 'PLAN_CONTEXT_STALE');
  draftInput.nodes[0].skills = ['disabled-for-test'];
  assert.equal((await api(`/api/graphs/${graph.id}/draft`, { method: 'PUT', body: draftInput })).status, 200);
  const disabledPlan = await api(`/api/graphs/${graph.id}/plans`, { method: 'POST', body: { provider: 'local-agents' } });
  assert.equal(disabledPlan.status, 409);
  assert.equal(disabledPlan.body.error.code, 'SKILL_GLOBALLY_DISABLED');
});
