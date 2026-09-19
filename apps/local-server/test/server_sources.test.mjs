import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { createLocalServer } from '../src/index.mjs';

const origin = 'http://127.0.0.1:5173';
const execFileAsync = promisify(execFile);

function revisedPrompt(label) {
  return [
    `Act as the revised ${label} specialist. Inspect the supplied intent, evidence, contracts, implementation risks, and unresolved decisions in depth. Challenge contradictions and preserve exact provenance before proposing bounded work. Explain uncertainty and refuse authority that was not granted.`,
    'Work critically and challenge unsupported assumptions before recommending any implementation or release action.',
    'Keep every conclusion evidence-based and distinguish observed evidence, inference, and proposal.',
    'Cite the acceptance-criteria IDs addressed by every recommendation and report missing criteria as a planning gap.',
    'Never claim that a test, evaluation, validation, benchmark, or security check passed without a verifiable receipt.',
  ].join('\n\n');
}

test('source routes persist evidence, retrieve with RRF, compile specialists, and enforce all mutable context pins', async (t) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ege-source-server-'));
  const workspaceRoot = join(temporaryRoot, 'workspace');
  const objectRoot = join(temporaryRoot, 'objects');
  await mkdir(workspaceRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'README.md'), 'Initial workspace content.\n');
  await execFileAsync('git', ['init'], { cwd: workspaceRoot });
  await execFileAsync('git', ['config', 'user.name', 'EGE Test'], { cwd: workspaceRoot });
  await execFileAsync('git', ['config', 'user.email', 'ege-test@example.invalid'], { cwd: workspaceRoot });
  await execFileAsync('git', ['add', 'README.md'], { cwd: workspaceRoot });
  await execFileAsync('git', ['commit', '-m', 'Initial workspace'], { cwd: workspaceRoot });
  const localServer = createLocalServer({
    port: 0,
    databasePath: join(temporaryRoot, 'local.db'),
    objectRoot,
    skillsRoot: join(temporaryRoot, 'skills'),
    workspaceRoot,
    stepDelayMs: 5,
  });
  await assert.rejects(access(objectRoot));
  await localServer.start();
  await assert.rejects(access(objectRoot));
  t.after(async () => {
    await localServer.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  async function request(path, { method = 'GET', body, raw, headers = {} } = {}) {
    const response = await fetch(`${localServer.address}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined && raw === undefined ? {} : { body: raw ?? JSON.stringify(body) }),
    });
    const contentType = response.headers.get('content-type') || '';
    const result = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { response, body: result };
  }

  const created = await request('/api/graphs', {
    method: 'POST', body: { name: 'BRD delivery', workspacePath: workspaceRoot },
  });
  const graphId = created.body.graph.id;
  await request(`/api/graphs/${graphId}/draft`, {
    method: 'PUT',
    body: {
      nodes: [{
        id: 'intent-brd',
        title: 'Customer portal BRD',
        kind: 'intent',
        context: 'Build an accessible browser frontend, GraphQL backend, PostgreSQL storage, Kubernetes deployment, monitoring, testing, and coding security.',
      }],
      edges: [],
      context: 'Use uploaded requirements as cited evidence.',
    },
  });

  const sourceBytes = Buffer.from([
    '# Customer portal',
    'BR-101: Keyboard navigation is required for checkout.',
    'BR-102: GraphQL mutations persist canonical order totals in PostgreSQL.',
    'BR-103: Kubernetes delivery requires rollback, monitoring, security scanning, and test receipts.',
  ].join('\n'));
  const uploaded = await request(`/api/graphs/${graphId}/sources?filename=portal-brd.md&nodeId=intent-brd`, {
    method: 'POST',
    raw: sourceBytes,
    headers: { 'Content-Type': 'text/markdown' },
  });
  assert.equal(uploaded.response.status, 201);
  assert.equal(uploaded.body.parseStatus, 'parsed');
  assert.ok(uploaded.body.chunkCount > 0);
  assert.match(uploaded.body.object.digest, /^[a-f0-9]{64}$/);
  await access(objectRoot);
  const sourceId = uploaded.body.source.id;

  const listed = await request(`/api/graphs/${graphId}/sources`);
  assert.equal(listed.body.items.length, 1);
  assert.equal(listed.body.items[0].sha256, uploaded.body.object.digest);
  assert.equal(listed.body.items[0].chunkCount, uploaded.body.chunkCount);
  const detail = await request(`/api/sources/${sourceId}`);
  assert.equal(detail.body.source.chunkCount, uploaded.body.chunkCount);
  assert.ok(detail.body.chunks[0].location.citations[0].locator.lineStart >= 1);
  const content = await request(`/api/sources/${sourceId}/content`);
  assert.deepEqual(content.body, sourceBytes);
  assert.match(content.response.headers.get('content-disposition'), /^attachment;/);

  const retrieved = await request(`/api/graphs/${graphId}/retrieve`, {
    method: 'POST', body: { query: 'GraphQL PostgreSQL order totals', limit: 5 },
  });
  assert.equal(retrieved.response.status, 200);
  assert.equal(retrieved.body.fusion.method, 'reciprocal_rank_fusion');
  assert.deepEqual(retrieved.body.fusion.rankers, ['bm25-v1', 'trigram-v1']);
  assert.ok(retrieved.body.results.length > 0);
  assert.equal(retrieved.body.results[0].citations[0].objectId, uploaded.body.object.id);
  assert.match(retrieved.body.manifest.digest, /^[a-f0-9]{64}$/);

  const firstPlanResult = await request(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'simulation', instructions: 'Keep traceability explicit.' },
  });
  assert.equal(firstPlanResult.response.status, 201);
  const firstPlan = firstPlanResult.body.plan;
  assert.equal(firstPlan.plan.proposedGraph.nodes.length, 7);
  assert.equal(firstPlan.plan.steps.length, 7);
  assert.equal(firstPlan.plan.contextManifest.evidenceManifest.sources[0].id, sourceId);
  assert.equal(firstPlan.plan.contextManifest.selectedAgents.length, 7);
  assert.equal(firstPlan.plan.contextManifest.providerProfile.id, 'simulation');
  assert.deepEqual(Object.keys(firstPlan.plan.contextManifest.plannerProvider).sort(), [
    'baseUrl', 'connectionRevision', 'id', 'model', 'secretEnvName', 'updatedAt',
  ]);
  assert.equal(firstPlan.plan.contextManifest.workspaceBaseline.kind, 'git');
  assert.ok(firstPlan.plan.steps.every((step) => /^[a-f0-9]{64}$/.test(step.inputDigest)));

  const pinnedAgent = firstPlan.plan.contextManifest.selectedAgents.find((agent) => agent.assignment === 'catalog');
  const agentDetail = await request(`/api/agents/${pinnedAgent.id}`);
  const promptChanged = await request(`/api/agents/${pinnedAgent.id}/prompts`, {
    method: 'POST',
    body: {
      expectedDigest: agentDetail.body.agent.currentPrompt.digest,
      prompt: revisedPrompt(pinnedAgent.id),
    },
  });
  assert.equal(promptChanged.response.status, 201);
  const stalePromptApproval = await request(`/api/plans/${firstPlan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: firstPlan.contentHash, rationale: 'Attempt stale approval.' },
  });
  assert.equal(stalePromptApproval.response.status, 409);
  assert.equal(stalePromptApproval.body.error.details.reason, 'AGENT_PROMPT_CHANGED');

  const secondPlan = (await request(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'simulation' },
  })).body.plan;
  const secondUpload = await request(`/api/graphs/${graphId}/sources?filename=security.md&nodeId=intent-brd`, {
    method: 'POST',
    raw: Buffer.from('# Security\nDependency scanning and threat-model approval are required.'),
    headers: { 'Content-Type': 'text/markdown' },
  });
  assert.equal(secondUpload.response.status, 201);
  const staleSourceApproval = await request(`/api/plans/${secondPlan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: secondPlan.contentHash, rationale: 'Attempt stale source approval.' },
  });
  assert.equal(staleSourceApproval.response.status, 409);
  assert.equal(staleSourceApproval.body.error.details.reason, 'SOURCE_CHANGED');

  const providerPinnedPlan = (await request(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'simulation' },
  })).body.plan;
  const providerChanged = await request('/api/provider-profiles/simulation', {
    method: 'PUT', body: { model: 'deterministic-v2' },
  });
  assert.equal(providerChanged.response.status, 200);
  const staleProviderApproval = await request(`/api/plans/${providerPinnedPlan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: providerPinnedPlan.contentHash, rationale: 'Attempt stale provider approval.' },
  });
  assert.equal(staleProviderApproval.response.status, 409);
  assert.equal(staleProviderApproval.body.error.details.reason, 'PROVIDER_CHANGED');

  const workspacePinnedPlan = (await request(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'simulation' },
  })).body.plan;
  await writeFile(join(workspaceRoot, 'README.md'), 'Workspace changed after planning.\n');
  const staleWorkspaceApproval = await request(`/api/plans/${workspacePinnedPlan.id}/approve`, {
    method: 'POST', body: { expectedContentHash: workspacePinnedPlan.contentHash, rationale: 'Attempt stale workspace approval.' },
  });
  assert.equal(staleWorkspaceApproval.response.status, 409);
  assert.equal(staleWorkspaceApproval.body.error.details.reason, 'WORKSPACE_CHANGED');

  const deleted = await request(`/api/sources/${sourceId}`, { method: 'DELETE' });
  assert.equal(deleted.response.status, 204);
  assert.equal(deleted.response.headers.get('x-ege-object-retained'), 'content-addressed');
  const afterDelete = await request(`/api/graphs/${graphId}/sources`);
  assert.equal(afterDelete.body.items.length, 1);
});
