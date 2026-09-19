import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/index.mjs';
import { captureWorkspaceBaseline } from '../src/planners.mjs';
import { boundedWorkspaceManifest, captureWorkspaceFileManifest, digestExecutionInput } from '../src/execution_adapters.mjs';
import { executionDependencyContext } from '../src/server.mjs';
import { workspaceBinding } from '../src/trace_data.mjs';

const origin = 'http://127.0.0.1:5173';

async function eventually(callback, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await callback();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Condition was not met before timeout.');
}

async function createApprovedCodexHarness(context, { executor, prefix, attachWorkspace = true, stepConfig = {} }) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const workspacePath = join(root, 'workspace');
  const binaryDirectory = join(root, 'bin');
  const databasePath = join(root, 'local.db');
  await mkdir(workspacePath);
  await mkdir(binaryDirectory);
  const fakeCodex = join(binaryDirectory, 'codex');
  await writeFile(fakeCodex, '#!/bin/sh\nexit 0\n');
  await chmod(fakeCodex, 0o755);
  const environment = {
    ...process.env,
    PATH: `${binaryDirectory}${delimiter}${process.env.PATH}`,
    EGE_ENABLE_WORKSPACE_WRITE: '1',
  };
  const server = createLocalServer({
    port: 0,
    databasePath,
    objectRoot: join(root, 'objects'),
    workspaceRoot: workspacePath,
    environment,
    codexWorkspaceExecutor: executor,
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

  const graph = (await api('/api/graphs', {
    method: 'POST', body: {
      name: 'Codex failure harness',
      ...(attachWorkspace ? { workspacePath } : {}),
    },
  })).body.graph;
  const draft = (await api(`/api/graphs/${graph.id}/draft`, {
    method: 'PUT',
    body: {
      nodes: [{ id: 'intent', title: 'Implementation intent', context: 'Create a command-verified module.' }],
      edges: [],
    },
  })).body.draft;
  const agent = server.repository.getAgent('requirements-analyst');
  const contentHash = 'a'.repeat(64);
  const step = {
    id: 'step:specialist:product',
    nodeId: 'specialist:product',
    title: 'Implement verified output',
    objective: 'Create the output module and verify it.',
    acceptanceCriteria: ['The implementation has a passing command receipt.'],
    dependsOn: [],
    skills: [],
    agentId: agent.id,
    promptDigest: `sha256:${agent.currentPrompt.digest}`,
    sourceIntentNodeIds: ['intent'],
    sourceEvidenceIds: [],
    inputDigest: 'b'.repeat(64),
    ...stepConfig,
  };
  const canonicalWorkspacePath = attachWorkspace ? await realpath(workspacePath) : null;
  const binding = attachWorkspace ? workspaceBinding(canonicalWorkspacePath, await stat(canonicalWorkspacePath)) : null;
  const baseline = attachWorkspace ? await captureWorkspaceBaseline(workspacePath, environment) : null;
  const plan = server.repository.createPlan({
    graphId: graph.id,
    baseDraftRevision: draft.revision,
    provider: 'codex-cli',
    contentHash,
    plan: {
      summary: 'Execute one approved specialist.',
      proposedEdges: [],
      contextManifest: {
        ...(binding ? { workspaceBinding: binding, workspaceBaseline: baseline } : {}),
      },
      steps: [step],
    },
    diff: { summary: 'Initial plan.' },
  });
  const approval = await api(`/api/plans/${plan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: contentHash, rationale: 'Exercise the durable failure path.' },
  });
  assert.equal(approval.status, attachWorkspace ? 200 : 409, JSON.stringify(approval.body));
  if (!attachWorkspace) assert.equal(approval.body.error.details.reason, 'WORKSPACE_BINDING_MISSING');
  return { api, contentHash, databasePath, environment, graph, plan, root, server, step, workspacePath };
}

test('Codex plans cannot be approved without an explicitly selected graph workspace', async (context) => {
  let executorCalls = 0;
  const harness = await createApprovedCodexHarness(context, {
    prefix: 'ege-missing-workspace-test-',
    attachWorkspace: false,
    executor: async () => {
      executorCalls += 1;
      throw new Error('Executor must not be reached.');
    },
  });

  assert.equal(harness.graph.workspacePath, null);
  const planDetail = await harness.api(`/api/plans/${harness.plan.id}`);
  assert.equal(planDetail.body.plan.status, 'AWAITING_APPROVAL');
  assert.equal(executorCalls, 0);
  assert.deepEqual(harness.server.repository.listExecutions(harness.graph.id), []);
});

async function assertDurableCodexFailure({ api, executionId, expectedResult, expectedCode }) {
  const failed = await eventually(async () => {
    const detail = (await api(`/api/executions/${executionId}`)).body;
    return detail.execution.status === 'FAILED' ? detail : null;
  });
  assert.equal(failed.execution.currentNodeId, null);
  assert.deepEqual(failed.execution.completedNodeIds, []);
  assert.equal(failed.events.some((event) => event.type === 'node.completed'), false);
  assert.equal(failed.events.some((event) => event.type === 'execution.completed'), false);

  const receiptEvent = failed.events.find((event) => event.type === 'verification.receipt');
  const nodeFailed = failed.events.find((event) => event.type === 'node.failed');
  const executionFailed = failed.events.find((event) => event.type === 'execution.failed');
  assert.ok(receiptEvent);
  assert.equal(receiptEvent.verificationMode, 'CODEX_CLI');
  assert.equal(receiptEvent.result, expectedResult);
  assert.ok(nodeFailed);
  assert.ok(executionFailed);
  assert.equal(nodeFailed.nodeId, 'specialist:product');
  assert.equal(executionFailed.nodeId, 'specialist:product');
  assert.ok(receiptEvent.sequence < nodeFailed.sequence && nodeFailed.sequence < executionFailed.sequence);

  const receiptArtifact = failed.artifacts.find((artifact) => artifact.id === receiptEvent.artifactId);
  assert.ok(receiptArtifact);
  assert.equal(receiptArtifact.mediaType, 'application/json');
  const receipt = JSON.parse(receiptArtifact.content);
  assert.equal(receipt.result, expectedResult);
  assert.equal(receipt.nodeId, 'specialist:product');
  if (expectedCode) assert.equal(receipt.code, expectedCode);
  return { failed, receipt };
}

test('configured retry and timeout budgets bound adapter attempts without repeating partial workspace changes', async (context) => {
  for (const changesWorkspace of [false, true]) {
    let calls = 0;
    const harness = await createApprovedCodexHarness(context, {
      prefix: 'ege-retry-budget-',
      stepConfig: { budgets: { timeoutMs: 250, maxAttempts: 2 } },
      executor: async (input) => {
        calls += 1;
        assert.equal(input.timeoutMs, 250);
        if (changesWorkspace) await writeFile(join(input.workspacePath, 'partial.txt'), 'An unfinished effect.');
        throw Object.assign(new Error('Provider disconnected.'), { code: 'PROVIDER_DISCONNECTED' });
      },
    });
    const started = await harness.api(`/api/graphs/${harness.graph.id}/executions`, {
      method: 'POST', body: { planId: harness.plan.id, expectedPlanHash: harness.contentHash },
    });
    assert.equal(started.status, 202);
    const id = started.body.execution.id;
    await eventually(() => harness.server.repository.getExecution(id).status === 'FAILED');
    assert.equal(calls, changesWorkspace ? 1 : 2);
    const retries = harness.server.repository.listEvents(id).filter((event) => event.type === 'node.retry');
    assert.equal(retries.length, changesWorkspace ? 0 : 1);
  }
});

test('approved Codex plan executes through the opt-in workspace adapter with durable progress and receipts', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-real-execution-test-'));
  const workspacePath = join(root, 'workspace');
  const binaryDirectory = join(root, 'bin');
  await mkdir(workspacePath);
  await mkdir(binaryDirectory);
  const fakeCodex = join(binaryDirectory, 'codex');
  await writeFile(fakeCodex, '#!/bin/sh\nexit 0\n');
  await chmod(fakeCodex, 0o755);
  const calls = [];
  const executor = async (input) => {
    calls.push(input);
    input.onProgress({ type: 'command.started', message: 'npm test' });
    input.onProgress({ type: 'command.completed', message: 'PASS: npm test', exitCode: 0 });
    return {
      provider: 'codex-cli',
      model: null,
      inputDigest: 'd'.repeat(64),
      receipt: {
        status: 'COMPLETED',
        summary: 'Implemented the approved specialist node.',
        changedFiles: ['src/output.ts'],
        acceptance: [{ criterion: 'The implementation has a passing command receipt.', status: 'PASS', evidence: 'npm test passed.' }],
        verification: [{ command: 'npm test', status: 'PASS', details: '1 test passed.' }],
        risks: [],
      },
      actualVerification: [{ command: 'npm test', status: 'PASS', exitCode: 0, output: '1 test passed.' }],
      actualChangedFiles: ['src/output.ts'],
      changedFilesMatch: true,
      workspaceBeforeDigest: 'e'.repeat(64),
      workspaceAfterDigest: 'f'.repeat(64),
      workspaceArtifacts: {
        artifacts: [{ name: 'src/output.ts', mediaType: 'text/typescript', content: 'export const output = true;\n' }],
        skipped: [],
        totalBytes: 28,
      },
      accepted: true,
      eventCount: 4,
    };
  };
  const environment = {
    ...process.env,
    PATH: `${binaryDirectory}${delimiter}${process.env.PATH}`,
    EGE_ENABLE_WORKSPACE_WRITE: '1',
  };
  const server = createLocalServer({
    port: 0,
    databasePath: join(root, 'local.db'),
    objectRoot: join(root, 'objects'),
    workspaceRoot: workspacePath,
    environment,
    codexWorkspaceExecutor: executor,
  });
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = server.address;
  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
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

  const graph = (await api('/api/graphs', {
    method: 'POST', body: { name: 'Codex execution', workspacePath },
  })).body.graph;
  const draft = (await api(`/api/graphs/${graph.id}/draft`, {
    method: 'PUT',
    body: {
      nodes: [{ id: 'intent', title: 'Implementation intent', context: 'Create a verified output module.' }],
      edges: [],
    },
  })).body.draft;
  const agent = server.repository.getAgent('requirements-analyst');
  const contentHash = 'a'.repeat(64);
  const plan = server.repository.createPlan({
    graphId: graph.id,
    baseDraftRevision: draft.revision,
    provider: 'codex-cli',
    contentHash,
    plan: {
      summary: 'Execute one approved specialist.',
      proposedEdges: [],
      contextManifest: {
        workspaceBinding: workspaceBinding(await realpath(workspacePath), await stat(await realpath(workspacePath))),
        workspaceBaseline: await captureWorkspaceBaseline(workspacePath, environment),
      },
      steps: [{
        id: 'step:specialist:product',
        nodeId: 'specialist:product',
        title: 'Implement verified output',
        objective: 'Create the output module and verify it.',
        acceptanceCriteria: ['The implementation has a passing command receipt.'],
        dependsOn: [],
        skills: [],
        agentId: agent.id,
        promptDigest: `sha256:${agent.currentPrompt.digest}`,
        sourceIntentNodeIds: ['intent'],
        sourceEvidenceIds: [],
        inputDigest: 'b'.repeat(64),
      }],
    },
    diff: { summary: 'Initial plan.' },
  });
  const approvalResponse = await api(`/api/plans/${plan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: contentHash, rationale: 'Approved for bounded workspace execution.' },
  });
  assert.equal(approvalResponse.status, 200, JSON.stringify(approvalResponse.body));

  const mismatch = await api(`/api/graphs/${graph.id}/executions`, {
    method: 'POST', body: { planId: plan.id, expectedPlanHash: contentHash, provider: 'simulation' },
  });
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error.code, 'EXECUTION_PROVIDER_MISMATCH');

  const started = await api(`/api/graphs/${graph.id}/executions`, {
    method: 'POST', body: { planId: plan.id, expectedPlanHash: contentHash, provider: 'codex-cli' },
  });
  assert.equal(started.status, 202);
  const completed = await eventually(async () => {
    const detail = (await api(`/api/executions/${started.body.execution.id}`)).body;
    return detail.execution.status === 'COMPLETED' ? detail : null;
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].agent.currentPrompt.prompt, /critical/i);
  assert.ok(calls[0].evidence.some((item) => item.sourceId === 'intent:intent'));
  assert.ok(completed.events.some((event) => event.type === 'node.progress' && event.exitCode === 0));
  assert.ok(completed.events.some((event) => event.type === 'verification.receipt'
    && event.verificationMode === 'CODEX_CLI' && event.result === 'PASS'));
  assert.ok(completed.artifacts.some((artifact) => artifact.name === 'src/output.ts'
    && artifact.content.includes('output = true')));
  assert.ok(completed.artifacts.some((artifact) => artifact.mediaType === 'application/json'
    && artifact.content.includes('actualVerification')));
  assert.equal(completed.events.find((event) => event.type === 'execution.started').executionProvider, 'codex-cli');
});

test('a rejected Codex result durably stores its receipt and fails the node and execution together', async (context) => {
  let calls = 0;
  const harness = await createApprovedCodexHarness(context, {
    prefix: 'ege-rejected-execution-test-',
    executor: async () => {
      calls += 1;
      return {
        provider: 'codex-cli',
        model: null,
        inputDigest: 'c'.repeat(64),
        receipt: {
          status: 'BLOCKED',
          summary: 'The approved criterion could not be verified.',
          changedFiles: [],
          acceptance: [{
            criterion: 'The implementation has a passing command receipt.',
            status: 'FAIL',
            evidence: 'npm test exited with status 1.',
          }],
          verification: [{ command: 'npm test', status: 'FAIL', details: '1 test failed.' }],
          risks: ['The requested implementation remains incomplete.'],
        },
        actualVerification: [{ command: 'npm test', status: 'FAIL', exitCode: 1, output: '1 test failed.' }],
        actualChangedFiles: [],
        changedFilesMatch: true,
        workspaceBeforeDigest: 'd'.repeat(64),
        workspaceAfterDigest: 'd'.repeat(64),
        workspaceArtifacts: { artifacts: [], skipped: [], totalBytes: 0 },
        accepted: false,
        eventCount: 2,
      };
    },
  });
  const started = await harness.api(`/api/graphs/${harness.graph.id}/executions`, {
    method: 'POST',
    body: { planId: harness.plan.id, expectedPlanHash: harness.contentHash, provider: 'codex-cli' },
  });
  assert.equal(started.status, 202);
  const { receipt } = await assertDurableCodexFailure({
    api: harness.api,
    executionId: started.body.execution.id,
    expectedResult: 'FAILED',
  });
  assert.equal(calls, 1);
  assert.equal(receipt.acceptance[0].status, 'FAIL');
  assert.equal(receipt.actualVerification[0].exitCode, 1);
});

test('a failed Codex adapter durably stores an adapter-failure receipt and fails the node and execution together', async (context) => {
  let calls = 0;
  const harness = await createApprovedCodexHarness(context, {
    prefix: 'ege-adapter-failure-test-',
    executor: async () => {
      calls += 1;
      const error = new Error('Synthetic Codex process failure.');
      error.code = 'EXECUTOR_TEST_FAILURE';
      throw error;
    },
  });
  const started = await harness.api(`/api/graphs/${harness.graph.id}/executions`, {
    method: 'POST',
    body: { planId: harness.plan.id, expectedPlanHash: harness.contentHash, provider: 'codex-cli' },
  });
  assert.equal(started.status, 202);
  const { receipt } = await assertDurableCodexFailure({
    api: harness.api,
    executionId: started.body.execution.id,
    expectedResult: 'ADAPTER_FAILED',
    expectedCode: 'EXECUTOR_TEST_FAILURE',
  });
  assert.equal(calls, 1);
  assert.equal(receipt.message, 'Synthetic Codex process failure.');
});

test('multi-node execution supplies accepted dependency receipts, artifact provenance, and engine workspace evidence', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-multi-node-baseline-'));
  const workspacePath = join(root, 'workspace');
  const binaryDirectory = join(root, 'bin');
  await mkdir(workspacePath);
  await mkdir(binaryDirectory);
  await writeFile(join(workspacePath, 'README.md'), 'Preserve this original baseline.\n');
  await writeFile(join(binaryDirectory, 'codex'), '#!/bin/sh\nexit 0\n');
  await chmod(join(binaryDirectory, 'codex'), 0o755);
  const environment = {
    ...process.env,
    PATH: `${binaryDirectory}${delimiter}${process.env.PATH}`,
    EGE_ENABLE_WORKSPACE_WRITE: '1',
  };
  let calls = 0;
  const inputs = [];
  const executor = async ({ workspacePath: pinnedPath, step, onProgress, executionContext, executionContextDigest, prompt }) => {
    calls += 1;
    inputs.push(executionContext);
    assert.equal(digestExecutionInput(executionContext), executionContextDigest);
    assert.equal(executionContext.currentWorkspace.manifest.files.some((file) => file.path === 'README.md'), true);
    assert.ok(prompt.includes(executionContextDigest) || prompt.includes(executionContext.executionId));
    if (calls === 1) assert.deepEqual(executionContext.dependencies, []);
    else {
      assert.equal(executionContext.dependencies.length, 1);
      const dependency = executionContext.dependencies[0];
      assert.equal(dependency.nodeId, 'specialist-1');
      assert.equal(dependency.sourceExecutionId, executionContext.executionId);
      assert.equal(dependency.sourcePlanId, executionContext.planId);
      assert.equal(dependency.lineageStatus, 'CURRENT');
      assert.match(dependency.receipt.sha256, /^[a-f0-9]{64}$/);
      const receipt = JSON.parse(dependency.receipt.content);
      assert.equal(receipt.result, 'PASS');
      assert.equal(receipt.changedFilesMatch, true);
      assert.deepEqual(receipt.changedFiles, ['node-1.txt']);
      assert.equal(receipt.actualVerification[0].exitCode, 0);
      assert.equal(receipt.workspaceEvidence.before.files.find((file) => file.path === 'README.md').sha256,
        receipt.workspaceEvidence.after.files.find((file) => file.path === 'README.md').sha256);
      assert.equal(dependency.artifacts.some((artifact) => artifact.name === 'node-1.txt' && artifact.content === 'specialist-1\n'), true);
      assert.equal(prompt.includes(dependency.receipt.artifactId), true);
      assert.equal(prompt.includes('UNRELATED_OUTPUT'), false);
    }
    const before = await captureWorkspaceFileManifest(pinnedPath, environment);
    const changedFile = `node-${calls}.txt`;
    await writeFile(join(pinnedPath, changedFile), `${step.nodeId}\n`);
    const after = await captureWorkspaceFileManifest(pinnedPath, environment);
    onProgress({ type: 'command.started', message: 'node verification', command: { command: 'node verification' } });
    onProgress({
      type: 'command.completed', message: 'PASS: node verification', exitCode: 0,
      command: { command: 'node verification', exitCode: 0, status: 'PASS', output: 'passed' },
    });
    return {
      provider: 'codex-cli', model: null, inputDigest: `${calls}`.repeat(64),
      receipt: {
        status: 'COMPLETED', summary: `Completed ${step.nodeId}.`, changedFiles: [changedFile],
        acceptance: step.acceptanceCriteria.map((criterion) => ({ criterion, status: 'PASS', evidence: 'node verification passed' })),
        verification: [{ command: 'node verification', status: 'PASS', details: 'passed' }], risks: [],
      },
      actualVerification: [{ command: 'node verification', status: 'PASS', exitCode: 0, output: 'passed' }],
      actualChangedFiles: [changedFile], changedFilesMatch: true,
      workspaceBeforeDigest: before.digest, workspaceAfterDigest: after.digest,
      workspaceEvidence: { before: boundedWorkspaceManifest(before), after: boundedWorkspaceManifest(after) },
      workspaceArtifacts: { artifacts: [{ name: changedFile, mediaType: 'text/plain', content: `${step.nodeId}\n` }], skipped: [], totalBytes: step.nodeId.length + 1 },
      accepted: true, eventCount: 2,
    };
  };
  const server = createLocalServer({
    port: 0, databasePath: join(root, 'local.db'), objectRoot: join(root, 'objects'),
    workspaceRoot: workspacePath, environment, codexWorkspaceExecutor: executor,
  });
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  async function api(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${server.address}${path}`, {
      method,
      headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }
  const graph = (await api('/api/graphs', { method: 'POST', body: { name: 'Two nodes', workspacePath } })).body.graph;
  const draft = (await api(`/api/graphs/${graph.id}/draft`, {
    method: 'PUT', body: {
      nodes: [
        { id: 'intent-1', title: 'First change', context: 'Create the first file.' },
        { id: 'intent-2', title: 'Second change', context: 'Create the second file.' },
      ], edges: [],
    },
  })).body.draft;
  const agent = server.repository.getAgent('requirements-analyst');
  const criterion = 'The node has a passing command receipt.';
  const steps = [1, 2].map((number) => ({
    id: `step-${number}`, nodeId: `specialist-${number}`, title: `Node ${number}`,
    objective: `Create file ${number}.`, acceptanceCriteria: [criterion],
    dependsOn: number === 1 ? [] : ['specialist-1'], skills: [], agentId: agent.id,
    promptDigest: `sha256:${agent.currentPrompt.digest}`, sourceIntentNodeIds: [`intent-${number}`],
    sourceEvidenceIds: [], inputDigest: `${number}`.repeat(64),
  }));
  const canonicalPath = await realpath(workspacePath);
  const initialBaseline = await captureWorkspaceBaseline(canonicalPath, environment);
  const plan = server.repository.createPlan({
    graphId: graph.id, baseDraftRevision: draft.revision, provider: 'codex-cli', contentHash: 'c'.repeat(64),
    plan: {
      summary: 'Execute two nodes.', steps,
      proposedEdges: [{ id: 'edge', source: 'specialist-1', target: 'specialist-2', label: 'requires', reason: 'ordered' }],
      contextManifest: {
        workspaceBinding: workspaceBinding(canonicalPath, await stat(canonicalPath)),
        workspaceBaseline: initialBaseline,
      },
    },
    diff: { summary: 'Initial plan.' },
  });
  assert.equal((await api(`/api/plans/${plan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: plan.contentHash },
  })).status, 200);
  const started = await api(`/api/graphs/${graph.id}/executions`, {
    method: 'POST', body: { planId: plan.id, expectedPlanHash: plan.contentHash },
  });
  server.repository.createArtifact({ executionId: started.body.execution.id, nodeId: 'unrelated-node', name: 'unrelated.txt', mediaType: 'text/plain', content: 'UNRELATED_OUTPUT' });
  const completed = await eventually(async () => {
    const detail = await api(`/api/executions/${started.body.execution.id}`);
    return detail.body.execution.status === 'COMPLETED' ? detail.body : null;
  });
  assert.equal(calls, 2);
  assert.notDeepEqual(completed.execution.workspaceBaseline, initialBaseline);
  const trace = await api(`/api/executions/${completed.execution.id}/trace`);
  assert.equal(trace.body.spans.filter((span) => span.category === 'NODE' && span.status === 'OK').length, 2);
  const downstreamModel = trace.body.spans.find((span) => span.category === 'MODEL' && span.nodeId === 'specialist-2');
  assert.equal(downstreamModel.attributes.executionContextDigest, digestExecutionInput(inputs[1]));
  assert.equal(downstreamModel.input.executionContext.dependencies[0].receipt.artifactId, inputs[1].dependencies[0].receipt.artifactId);
});

test('dependency evidence follows verified reused checkpoints and excludes unrelated or invalidated execution records', () => {
  const predecessorStep = { id: 'step-a', nodeId: 'a', title: 'Build', dependsOn: [], inputDigest: 'a'.repeat(64), promptDigest: 'pinned-prompt' };
  const downstreamStep = { id: 'step-b', nodeId: 'b', title: 'Verify', dependsOn: ['a'], inputDigest: 'b'.repeat(64), promptDigest: 'pinned-prompt' };
  const oldPlan = { id: 'old-plan', contentHash: 'c'.repeat(64), plan: { steps: [predecessorStep, downstreamStep] } };
  const newPlan = { ...oldPlan, id: 'new-plan', contentHash: 'd'.repeat(64) };
  const parent = { id: 'parent', planId: oldPlan.id, graphId: 'graph', completedNodeIds: ['a'], rootExecutionId: 'parent', workspaceBindingDigest: 'binding' };
  const execution = { id: 'child', planId: newPlan.id, graphId: 'graph', completedNodeIds: ['a'], parentExecutionId: parent.id, rootExecutionId: 'parent', workspaceBindingDigest: 'binding',
    resumedFromCheckpoint: { predecessorExecutionId: parent.id, predecessorPlanId: oldPlan.id, newPlanId: newPlan.id, reusedNodeIds: ['a'] } };
  const artifact = { id: 'output', executionId: 'parent', nodeId: 'a', name: 'result.txt', mediaType: 'text/plain', content: 'Accepted result.' };
  const receipt = { id: 'receipt', executionId: 'parent', nodeId: 'a', name: 'verification.json', mediaType: 'application/json', content: JSON.stringify({ nodeId: 'a', planId: oldPlan.id, result: 'PASS', verificationMode: 'CODEX_CLI', changedFilesMatch: true }) };
  const events = [
    { id: 'verified', sequence: 1, type: 'verification.receipt', payload: { nodeId: 'a', artifactId: receipt.id, result: 'PASS' } },
    { id: 'completed', sequence: 2, type: 'node.completed', payload: { nodeId: 'a', stepId: 'step-a', artifactIds: [artifact.id] } },
  ];
  const repository = {
    listEvents: (id) => id === 'parent' ? events : [],
    getArtifact: (id) => id === 'output' ? artifact : id === 'receipt' ? receipt : null,
    getExecution: (id) => id === 'parent' ? parent : null,
    getPlan: (id) => id === oldPlan.id ? oldPlan : newPlan,
  };
  const accepted = executionDependencyContext(repository, execution, newPlan, downstreamStep);
  assert.equal(accepted.dependencies[0].lineageStatus, 'REUSED_CHECKPOINT');
  assert.equal(accepted.dependencies[0].sourceExecutionId, parent.id);
  assert.equal(accepted.dependencies[0].receipt.artifactId, receipt.id);
  assert.equal(accepted.dependencies[0].workspaceVerification.manifestEvidenceAvailable, false, 'Legacy receipts explicitly disclose absent manifest evidence.');
  assert.throws(() => executionDependencyContext(repository, { ...execution, parentExecutionId: null }, newPlan, downstreamStep), { code: 'DEPENDENCY_EVIDENCE_MISSING' });
  const invalidatedPlan = { ...newPlan, plan: { steps: [{ ...predecessorStep, inputDigest: 'changed' }, downstreamStep] } };
  assert.throws(() => executionDependencyContext(repository, execution, invalidatedPlan, downstreamStep), { code: 'DEPENDENCY_EVIDENCE_MISSING' });
  assert.throws(() => executionDependencyContext({ ...repository, getArtifact: (id) => id === receipt.id ? { ...receipt, executionId: 'unrelated' } : artifact }, execution, newPlan, downstreamStep), { code: 'DEPENDENCY_EVIDENCE_MISSING' });
  assert.throws(() => executionDependencyContext({ ...repository, listEvents: () => events.slice(0, 1) }, execution, newPlan, downstreamStep), { code: 'DEPENDENCY_EVIDENCE_MISSING' });
});

test('restart recovery fails an interrupted Codex node closed without re-running workspace effects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ege-codex-restart-recovery-test-'));
  const workspacePath = join(root, 'workspace');
  const binaryDirectory = join(root, 'bin');
  const databasePath = join(root, 'recovery.db');
  const markerPath = join(workspacePath, 'marker.txt');
  const unexpectedEffectPath = join(workspacePath, 'unexpected-effect.txt');
  await mkdir(workspacePath);
  await mkdir(binaryDirectory);
  await writeFile(markerPath, 'workspace state before restart\n');
  const fakeCodex = join(binaryDirectory, 'codex');
  await writeFile(fakeCodex, '#!/bin/sh\nexit 0\n');
  await chmod(fakeCodex, 0o755);
  const environment = {
    ...process.env,
    PATH: `${binaryDirectory}${delimiter}${process.env.PATH}`,
    EGE_ENABLE_WORKSPACE_WRITE: '1',
  };
  let firstServer;
  let secondServer;
  let executorCalls = 0;
  try {
    firstServer = createLocalServer({
      port: 0,
      databasePath,
      workspaceRoot: workspacePath,
      environment,
      codexWorkspaceExecutor: async () => {
        throw new Error('The pre-restart executor must not run in this persisted-state fixture.');
      },
    });
    const graph = firstServer.repository.createGraph({ name: 'Interrupted Codex execution', workspacePath });
    const draft = firstServer.repository.saveDraft(graph.id, {
      nodes: [{ id: 'intent', title: 'Intent', context: 'Apply one bounded workspace change.' }],
      edges: [],
    });
    const agent = firstServer.repository.getAgent('requirements-analyst');
    const contentHash = 'e'.repeat(64);
    const step = {
      id: 'step:specialist:product',
      nodeId: 'specialist:product',
      title: 'Interrupted workspace node',
      objective: 'Apply and verify the bounded change.',
      acceptanceCriteria: ['The change has a passing command receipt.'],
      dependsOn: [],
      skills: [],
      agentId: agent.id,
      promptDigest: `sha256:${agent.currentPrompt.digest}`,
      sourceIntentNodeIds: ['intent'],
      sourceEvidenceIds: [],
      inputDigest: 'f'.repeat(64),
    };
    const plan = firstServer.repository.createPlan({
      graphId: graph.id,
      baseDraftRevision: draft.revision,
      provider: 'codex-cli',
      contentHash,
      plan: { summary: 'Persist an interrupted node.', proposedEdges: [], contextManifest: {}, steps: [step] },
      diff: { summary: 'Initial plan.' },
    });
    firstServer.repository.approvePlan(plan.id, contentHash, 'Approved before the simulated process interruption.');
    const admitted = firstServer.repository.createApprovedExecution({
      graphId: graph.id,
      planId: plan.id,
      expectedContentHash: contentHash,
      startEventPayload: {
        graphId: graph.id,
        planId: plan.id,
        planVersion: plan.version,
        plannerProvider: 'codex-cli',
        executionProvider: 'codex-cli',
      },
    });
    firstServer.repository.startNode({
      executionId: admitted.execution.id,
      nodeId: step.nodeId,
      stepId: step.id,
      title: step.title,
    });
    assert.equal(firstServer.repository.getExecution(admitted.execution.id).currentNodeId, step.nodeId);
    await firstServer.close();
    firstServer = null;

    secondServer = createLocalServer({
      port: 0,
      databasePath,
      workspaceRoot: workspacePath,
      environment,
      codexWorkspaceExecutor: async () => {
        executorCalls += 1;
        await writeFile(unexpectedEffectPath, 'this must never be written\n');
        throw new Error('Recovered execution incorrectly re-ran workspace effects.');
      },
    });
    await secondServer.start();
    const recovered = secondServer.repository.getExecution(admitted.execution.id);
    const events = secondServer.repository.listEvents(admitted.execution.id);
    assert.equal(recovered.status, 'FAILED');
    assert.equal(recovered.currentNodeId, null);
    assert.deepEqual(recovered.completedNodeIds, []);
    assert.equal(executorCalls, 0);
    assert.equal(await readFile(markerPath, 'utf8'), 'workspace state before restart\n');
    await assert.rejects(readFile(unexpectedEffectPath, 'utf8'), { code: 'ENOENT' });
    assert.equal(events.filter((event) => event.type === 'node.started').length, 1);
    assert.equal(events.some((event) => event.type === 'execution.recovered'), false);
    const failed = events.find((event) => event.type === 'execution.failed');
    assert.match(failed.message, /interrupted before a durable receipt/i);
    assert.match(failed.message, /create and approve a new plan/i);
  } finally {
    if (firstServer) await firstServer.close();
    if (secondServer) await secondServer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('provider profile enabled updates accept only literal JSON booleans', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-provider-boolean-test-'));
  const workspacePath = join(root, 'workspace');
  await mkdir(workspacePath);
  const server = createLocalServer({
    port: 0,
    databasePath: join(root, 'local.db'),
    workspaceRoot: workspacePath,
  });
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  async function update(enabled) {
    const response = await fetch(`${server.address}/api/provider-profiles/openai-api`, {
      method: 'PUT',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    return { status: response.status, body: await response.json() };
  }

  for (const invalid of ['false', 'true', 0, 1, null, {}, []]) {
    const result = await update(invalid);
    assert.equal(result.status, 422);
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
    assert.equal(result.body.error.details.field, 'enabled');
    assert.equal(server.repository.getProviderProfile('openai-api').enabled, false);
  }
  const enabled = await update(true);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.profile.enabled, true);
  const noOp = await update(true);
  assert.equal(noOp.status, 200);
  assert.equal(noOp.body.profile.updatedAt, enabled.body.profile.updatedAt);
  const disabled = await update(false);
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.profile.enabled, false);
});
