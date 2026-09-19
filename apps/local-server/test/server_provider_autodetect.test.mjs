import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/index.mjs';

const origin = 'http://127.0.0.1:5173';
const ollamaBaseUrl = 'http://127.0.0.1:11434';

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function fixture(context, { environment, fetchImpl }) {
  const root = await mkdtemp(join(tmpdir(), 'ege-autodetect-'));
  const workspaceRoot = join(root, 'workspace');
  const binaryRoot = join(root, 'bin');
  await mkdir(workspaceRoot);
  await mkdir(binaryRoot);
  const server = createLocalServer({
    port: 0,
    databasePath: join(root, 'postgres'),
    workspaceRoot,
    skillsRoot: join(root, 'skills'),
    environment: { HOME: root, ...environment, PATH: `${binaryRoot}${environment?.PATH ? `:${environment.PATH}` : ''}` },
    fetchImpl,
  });
  await server.start();
  context.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (path, { method = 'GET', body } = {}) => {
    const response = await fetch(`${server.address}${path}`, {
      method,
      headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  const installCodex = async () => {
    await writeFile(join(binaryRoot, 'codex'), '#!/bin/sh\nexit 0\n');
    await chmod(join(binaryRoot, 'codex'), 0o700);
  };
  return { server, request, installCodex, root };
}

test('autodetect connects every provider this machine already offers and explains each one it does not', async (context) => {
  const { request, installCodex, server } = await fixture(context, {
    environment: { OPENAI_API_KEY: 'sk-autodetect-session-only' },
    fetchImpl: async (url, options) => {
      const target = String(url);
      if (target === 'https://api.openai.com/v1/models') return jsonResponse({ data: [{ id: 'gpt-5.6-terra' }, { id: 'gpt-5.6-sol' }] });
      if (target === `${ollamaBaseUrl}/api/tags`) return jsonResponse({ models: [{ name: 'gemma4:E4B' }] });
      throw new Error(`Unexpected request: ${options?.method} ${target}`);
    },
  });
  await installCodex();

  const { status, body } = await request('/api/provider-connections/autodetect', { method: 'POST', body: {} });
  assert.equal(status, 200);
  const byId = Object.fromEntries(body.results.map((item) => [item.providerId, item]));

  // Every provider is reported, in a stable order, exactly once.
  assert.deepEqual(body.results.map((item) => item.providerId), ['openai-api', 'anthropic-api', 'ollama', 'codex-cli']);

  // A hosted key exported into the engine environment connects, and keeps the
  // model already configured on the profile ('gpt-5.6-terra') even though the
  // provider also offers 'gpt-5.6-sol'. Autodetect must not quietly move a user
  // off a model they chose.
  assert.equal(byId['openai-api'].status, 'connected');
  assert.equal(byId['openai-api'].model, 'gpt-5.6-terra');

  // Ollama's configured default is 'qwen3-coder', which this daemon does not
  // have installed, so it falls back to what is actually available rather than
  // connecting to a model that would fail on first use.
  assert.equal(byId.ollama.status, 'connected');
  assert.equal(byId.ollama.model, 'gemma4:E4B');

  // A logged-in CLI connects without any model selection.
  assert.equal(byId['codex-cli'].status, 'connected');
  assert.equal(byId['codex-cli'].model, null);

  // A provider with no evidence is skipped, and says what would make it work.
  assert.equal(byId['anthropic-api'].status, 'skipped');
  assert.match(byId['anthropic-api'].detail, /ANTHROPIC_API_KEY/);

  assert.equal(body.connected, 3);

  // The verified key stays in process memory: it must not reach the profile row.
  const profile = server.repository.getProviderProfile('openai-api');
  assert.equal(profile.enabled, true);
  assert.equal(profile.model, 'gpt-5.6-terra');
  assert.equal(profile.secretEnvName, 'OPENAI_API_KEY');
  assert.equal(JSON.stringify(profile).includes('sk-autodetect-session-only'), false);

  // Connections are durable, so the normal provider inventory now reports them.
  const { body: inventory } = await request('/api/providers');
  const connectedIds = inventory.items.filter((item) => item.connection?.status === 'CONNECTED').map((item) => item.id);
  assert.deepEqual([...connectedIds].sort(), ['codex-cli', 'ollama', 'openai-api']);
});

test('autodetect isolates one provider failure from the rest', async (context) => {
  const { request } = await fixture(context, {
    environment: { OPENAI_API_KEY: 'sk-autodetect-rejected' },
    fetchImpl: async (url) => {
      const target = String(url);
      // The hosted credential is rejected; the loopback daemon is healthy.
      if (target === 'https://api.openai.com/v1/models') return jsonResponse({ error: 'invalid_api_key' }, 401);
      if (target === `${ollamaBaseUrl}/api/tags`) return jsonResponse({ models: [{ name: 'gemma4:E4B' }] });
      throw new Error(`Unexpected request: ${target}`);
    },
  });

  const { body } = await request('/api/provider-connections/autodetect', { method: 'POST', body: {} });
  const byId = Object.fromEntries(body.results.map((item) => [item.providerId, item]));

  // The rejected key is reported against its own provider only...
  assert.equal(byId['openai-api'].status, 'failed');
  // ...and does not prevent the healthy one from connecting.
  assert.equal(byId.ollama.status, 'connected');
  assert.equal(byId.ollama.model, 'gemma4:E4B');
  // An absent CLI is a skip, not a failure: nothing is wrong, it is just not here.
  assert.equal(byId['codex-cli'].status, 'skipped');
  assert.equal(byId['codex-cli'].code, 'CLI_NOT_INSTALLED');
  assert.equal(body.connected, 1);
});
