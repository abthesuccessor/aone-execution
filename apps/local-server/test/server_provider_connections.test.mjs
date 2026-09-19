import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/index.mjs';

const origin = 'http://127.0.0.1:5173';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

function providerProposal(intentId) {
  return { summary: 'A configured provider proposal.', nodes: [{
    id: 'planned-node', domain: 'application', title: 'Implement the requested intent', objective: 'Build and verify the requested module.',
    agentId: 'backend-systems-engineer', inputs: [{ id: 'requirements', type: 'text' }], outputs: [{ id: 'implementation', type: 'artifact' }],
    acceptanceCriteria: ['Verify the implementation.'], dependsOn: [], traceability: { intentNodeIds: [intentId], evidenceIds: [] },
  }], relationships: [] };
}

async function workspaceFilesContain(root, needle) {
  for (const name of await readdir(root)) {
    const path = join(root, name);
    if (!(await stat(path)).isFile()) continue;
    if ((await readFile(path)).includes(Buffer.from(needle))) return true;
  }
  return false;
}

test('provider routes keep hosted keys process-only, invoke the selected planner, reject secret-name exfiltration, and disconnect immediately', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-server-provider-connections-'));
  const workspaceRoot = join(root, 'workspace');
  const binaryRoot = join(root, 'bin');
  const databasePath = join(root, 'local.db');
  await mkdir(workspaceRoot);
  await mkdir(binaryRoot);
  await writeFile(join(binaryRoot, 'claude'), '#!/bin/sh\n[ "$1" = "auth" ] && [ "$2" = "status" ] && exit 1\nexit 1\n');
  await chmod(join(binaryRoot, 'claude'), 0o700);
  const secret = 'sk-write-only-provider-route-secret';
  const replacementSecret = 'sk-write-only-replacement-secret';
  const calls = [];
  const server = createLocalServer({
    port: 0,
    databasePath,
    workspaceRoot,
    environment: { PATH: binaryRoot, HOME: root, AWS_SECRET_ACCESS_KEY: 'must-never-be-resolved' },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), method: options.method, authorization: options.headers?.Authorization, body: options.body });
      if (options.method === 'GET' && String(url) === 'https://api.openai.com/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-5.6-terra' }] });
      }
      if (options.method === 'POST' && String(url) === 'https://api.openai.com/v1/responses') return jsonResponse({ status: 'completed', output_text: JSON.stringify(providerProposal('intent')) });
      throw new Error('Unexpected provider request');
    },
  });
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  async function request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${server.address}${path}`, {
      method,
      headers: {
        Origin: origin,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  }

  const discovered = await request('/api/provider-connections/discover', {
    method: 'POST', body: { kind: 'hosted', providerId: 'openai-api', apiKey: secret },
  });
  assert.equal(discovered.status, 200);
  assert.equal(discovered.body.connection.status, 'DISCOVERED');
  assert.equal(discovered.body.connection.secretStorage, 'SESSION_ONLY');
  assert.equal(discovered.text.includes(secret), false);

  const connected = await request('/api/provider-connections/connect', {
    method: 'POST', body: { kind: 'hosted', providerId: 'openai-api', model: 'gpt-5.6-terra' },
  });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.connection.status, 'CONNECTED');
  assert.equal(connected.body.provider.available, true);
  assert.equal(connected.text.includes(secret), false);
  assert.equal(server.repository.getProviderProfile('openai-api').enabled, true);
  assert.equal(JSON.stringify(server.repository.getProviderProfile('openai-api')).includes(secret), false);
  assert.equal(await workspaceFilesContain(root, secret), false);

  const providers = await request('/api/providers');
  const openai = providers.body.items.find((provider) => provider.id === 'openai-api');
  assert.equal(openai.connection.status, 'CONNECTED');
  assert.equal(openai.connection.verified, true);
  assert.equal(providers.text.includes(secret), false);

  const exfiltration = await request('/api/provider-profiles/openai-api', {
    method: 'PUT', body: { secretEnvName: 'AWS_SECRET_ACCESS_KEY', enabled: true },
  });
  assert.equal(exfiltration.status, 422);
  assert.equal(exfiltration.body.error.code, 'VALIDATION_ERROR');
  assert.equal(server.repository.getProviderProfile('openai-api').secretEnvName, 'OPENAI_API_KEY');

  const graph = await request('/api/graphs', {
    method: 'POST', body: { name: 'Hosted provider plan', workspacePath: workspaceRoot },
  });
  const graphId = graph.body.graph.id;
  await request(`/api/graphs/${graphId}/draft`, {
    method: 'PUT',
    body: {
      nodes: [{ id: 'intent', title: 'Build API', kind: 'intent', context: 'Implement a tested API.' }],
      edges: [],
      context: 'Use the hosted provider.',
    },
  });
  const successfulPlan = await request(`/api/graphs/${graphId}/plans`, {
    method: 'POST', body: { provider: 'openai-api' },
  });
  assert.equal(successfulPlan.status, 201);
  assert.equal(successfulPlan.body.plan.plan.contextManifest.proposalGenerator.kind, 'configured-ai-provider');
  assert.equal(successfulPlan.body.plan.plan.contextManifest.proposalGenerator.provider, 'openai-api');
  assert.equal(calls.filter((call) => call.method === 'POST').length, 1);
  const pinnedRevision = successfulPlan.body.plan.plan.contextManifest.plannerProvider.connectionRevision;
  assert.match(pinnedRevision, /^[a-f0-9]{32}$/);
  assert.equal(successfulPlan.text.includes(secret), false);

  const replacement = await request('/api/provider-connections/discover', {
    method: 'POST', body: { kind: 'hosted', providerId: 'openai-api', apiKey: replacementSecret },
  });
  assert.equal(replacement.status, 200);
  assert.notEqual(replacement.body.connection.revision, pinnedRevision);
  assert.equal(replacement.text.includes(replacementSecret), false);
  const staleApproval = await request(`/api/plans/${successfulPlan.body.plan.id}/approve`, {
    method: 'POST',
    body: {
      expectedContentHash: successfulPlan.body.plan.contentHash,
      rationale: 'This approval must be rejected after the credential generation changed.',
    },
  });
  assert.equal(staleApproval.status, 409);
  assert.equal(staleApproval.body.error.code, 'PLAN_CONTEXT_STALE');
  assert.equal(staleApproval.body.error.details.reason, 'PROVIDER_CHANGED');

  const claude = await request('/api/provider-connections/connect', {
    method: 'POST', body: { kind: 'cli', providerId: 'claude-cli' },
  });
  assert.equal(claude.status, 422);
  assert.equal(claude.body.error.code, 'CLI_AUTH_REQUIRED');
  assert.equal(server.repository.getProviderProfile('claude-cli').enabled, false);

  const disconnected = await request('/api/provider-connections/openai-api', { method: 'DELETE' });
  assert.equal(disconnected.status, 200);
  assert.equal(disconnected.body.connection.status, 'DISCONNECTED');
  assert.equal(disconnected.body.connection.hasSecret, false);
  assert.equal(disconnected.body.provider.available, false);
  assert.equal(disconnected.text.includes(secret), false);
  assert.equal(disconnected.text.includes(replacementSecret), false);
  assert.equal(server.repository.getProviderProfile('openai-api').enabled, false);

  const afterDelete = await request('/api/providers');
  const unavailable = afterDelete.body.items.find((provider) => provider.id === 'openai-api');
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.connection.status, 'DISCONNECTED');
  assert.equal(await workspaceFilesContain(root, secret), false);
  assert.equal(await workspaceFilesContain(root, replacementSecret), false);
});

test('authenticated Codex CLI is ready automatically and an unchanged plan remains approvable after server restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ege-server-codex-restart-'));
  const workspaceRoot = join(root, 'workspace');
  const binaryRoot = join(root, 'bin');
  const skillsRoot = join(root, 'skills');
  const skillRoot = join(skillsRoot, 'memory-design');
  const databasePath = join(root, 'local.db');
  await mkdir(workspaceRoot);
  await mkdir(binaryRoot);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(join(skillRoot, 'SKILL.md'), [
    '---',
    'name: memory-design',
    'description: Design reliable application memory and retrieval.',
    '---',
    '# Memory design',
    '',
  ].join('\n'));
  await writeFile(join(binaryRoot, 'codex'), [
    '#!/bin/sh',
    'if [ "$1" = "login" ] && [ "$2" = "status" ]; then exit 0; fi',
    'if [ "$1" = "--help" ]; then printf "  --search\\n"; exit 0; fi',
    'output=""; previous=""; for argument in "$@"; do if [ "$previous" = "--output-last-message" ]; then output="$argument"; fi; previous="$argument"; done',
    `if [ -n "$output" ]; then printf '%s' '${JSON.stringify(providerProposal('memory-intent'))}' > "$output"; exit 0; fi`,
    'if [ "$1" = "--strict-config" ]; then exit 0; fi',
    'exit 0',
    '',
  ].join('\n'));
  await chmod(join(binaryRoot, 'codex'), 0o700);
  const environment = { PATH: binaryRoot, HOME: root };
  const createServer = () => createLocalServer({
    port: 0,
    databasePath,
    workspaceRoot,
    skillsRoot,
    environment,
  });
  let server;
  const request = async (path, { method = 'GET', body } = {}) => {
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
  };

  try {
    server = createServer();
    await server.start();
    const firstProviders = await request('/api/providers');
    const firstCodex = firstProviders.body.items.find((provider) => provider.id === 'codex-cli');
    assert.equal(firstCodex.connection.status, 'CONNECTED');
    assert.equal(firstCodex.connection.verified, true);
    assert.equal(firstCodex.connection.revision, null);

    const graph = await request('/api/graphs', {
      method: 'POST', body: { name: 'Codex restart approval', workspacePath: workspaceRoot },
    });
    const graphId = graph.body.graph.id;
    await request(`/api/graphs/${graphId}/draft`, {
      method: 'PUT',
      body: {
        nodes: [{
          id: 'memory-intent',
          title: 'Long-term memory',
          objective: 'Design reliable entity-scoped memory retrieval.',
          context: 'Keep context bounded and attributable.',
          position: { x: 100, y: 100 },
        }],
        edges: [],
      },
    });
    const planned = await request(`/api/graphs/${graphId}/plans`, {
      method: 'POST', body: { provider: 'codex-cli' },
    });
    assert.equal(planned.status, 201);
    assert.equal(planned.body.plan.plan.contextManifest.proposalGenerator.kind, 'configured-ai-provider');
    assert.equal(planned.body.plan.plan.contextManifest.plannerProvider.connectionRevision, null);
    const plan = planned.body.plan;

    await server.close();
    server = createServer();
    await server.start();
    const restartedProviders = await request('/api/providers');
    const restartedCodex = restartedProviders.body.items.find((provider) => provider.id === 'codex-cli');
    assert.equal(restartedCodex.connection.status, 'CONNECTED');
    assert.equal(restartedCodex.connection.verified, true);
    assert.equal(restartedCodex.connection.revision, null);

    const approved = await request(`/api/plans/${plan.id}/approve`, {
      method: 'POST',
      body: {
        expectedContentHash: plan.contentHash,
        rationale: 'The unchanged locally compiled plan is correct.',
      },
    });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.approval.rationale, 'The unchanged locally compiled plan is correct.');
  } finally {
    if (server) await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('provider connection endpoints reject remote Ollama targets before network access', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-server-provider-ssrf-'));
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  let called = false;
  const server = createLocalServer({
    port: 0,
    databasePath: join(root, 'local.db'),
    workspaceRoot,
    environment: { PATH: '', HOME: root },
    fetchImpl: async () => { called = true; throw new Error('must not be called'); },
  });
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  const response = await fetch(`${server.address}/api/provider-connections/discover`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'local', providerId: 'ollama', baseUrl: 'http://169.254.169.254/latest/meta-data' }),
  });
  const body = await response.json();
  assert.equal(response.status, 422);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(called, false);
  assert.equal(server.repository.getProviderProfile('ollama').enabled, false);
});
