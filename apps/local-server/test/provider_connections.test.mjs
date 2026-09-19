import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ProviderConnectionManager,
  normalizeOllamaBaseUrl,
} from '../src/provider_connections.mjs';

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status || 200,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

test('hosted connection keeps credentials write-only, verifies models, and fails closed after disconnect', async () => {
  const secret = 'sk-session-only-super-secret';
  const calls = [];
  const manager = new ProviderConnectionManager({
    environment: {},
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ data: [{ id: 'gpt-5.6-terra' }, { id: 'other-text-model' }] });
    },
  });
  const profile = {
    id: 'openai-api', kind: 'api', enabled: false, model: 'gpt-5.6-terra', secretEnvName: 'OPENAI_API_KEY',
  };

  const discovered = await manager.discover({ kind: 'hosted', providerId: 'openai-api', apiKey: secret }, profile);
  assert.equal(discovered.connection.status, 'DISCOVERED');
  assert.equal(discovered.connection.verified, true);
  assert.equal(discovered.connection.secretStorage, 'SESSION_ONLY');
  assert.equal(discovered.connection.hasSecret, true);
  assert.match(discovered.connection.revision, /^[a-f0-9]{32}$/);
  assert.equal(JSON.stringify(discovered).includes(secret), false);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/models');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${secret}`);
  assert.equal(calls[0].options.redirect, 'error');

  const connected = await manager.connect({ kind: 'hosted', providerId: 'openai-api', model: 'gpt-5.6-terra' }, profile);
  assert.equal(connected.connection.status, 'CONNECTED');
  assert.equal(connected.connection.selectedModel, 'gpt-5.6-terra');
  assert.equal(JSON.stringify(connected).includes(secret), false);
  assert.equal(manager.runtimeSecret('openai-api'), secret);
  const connectedRevision = connected.connection.revision;

  const noOp = await manager.connect({ kind: 'hosted', providerId: 'openai-api', model: 'gpt-5.6-terra' }, profile);
  assert.equal(noOp.connection.revision, connectedRevision);
  const refreshed = await manager.listModels('openai-api', profile);
  assert.equal(refreshed.connection.revision, connectedRevision);

  const decorated = manager.decorate({
    id: 'openai-api', available: false, ready: false, capabilities: [], profile: { ...profile, enabled: true },
  });
  assert.equal(decorated.available, true);
  assert.deepEqual(decorated.capabilities, ['chat', 'plan']);

  const disconnected = manager.disconnect('openai-api', { ...profile, enabled: true });
  assert.equal(disconnected.connection.status, 'DISCONNECTED');
  assert.equal(disconnected.connection.hasSecret, false);
  assert.notEqual(disconnected.connection.revision, connectedRevision);
  assert.equal(manager.runtimeSecret('openai-api'), null);
  assert.equal(JSON.stringify(disconnected).includes(secret), false);
  const unavailable = manager.decorate({
    id: 'openai-api', available: true, ready: false, capabilities: ['plan'], profile: { ...profile, enabled: false },
  });
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.capabilities, []);
  manager.close();

  let anthropicCall;
  const anthropic = new ProviderConnectionManager({
    fetchImpl: async (url, options) => {
      anthropicCall = { url: String(url), options };
      return jsonResponse({ data: [{ id: 'claude-sonnet-4-5', display_name: 'Claude Sonnet 4.5' }] });
    },
  });
  const anthropicResult = await anthropic.discover({
    kind: 'hosted', providerId: 'anthropic-api', apiKey: 'anthropic-session-secret',
  }, { id: 'anthropic-api', model: 'claude-sonnet-4-5' });
  assert.equal(anthropicCall.url, 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(anthropicCall.options.headers['x-api-key'], 'anthropic-session-secret');
  assert.equal(anthropicCall.options.headers['anthropic-version'], '2023-06-01');
  assert.equal(anthropicResult.models[0].label, 'Claude Sonnet 4.5');
  assert.equal(JSON.stringify(anthropicResult).includes('anthropic-session-secret'), false);
  anthropic.close();
});

test('Ollama discovery is bounded to a literal loopback origin and /api/tags without requiring a CLI', async () => {
  for (const value of [
    'https://127.0.0.1:11434',
    'http://localhost:11434',
    'http://127.0.0.1:11434/private',
    'http://user:password@127.0.0.1:11434',
    'http://10.0.0.2:11434',
    'http://127.0.0.1:11434?next=http://internal',
  ]) {
    assert.throws(() => normalizeOllamaBaseUrl(value), (error) => error.code === 'VALIDATION_ERROR');
  }
  assert.equal(normalizeOllamaBaseUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaBaseUrl('http://[::1]:11434'), 'http://[::1]:11434');

  const calls = [];
  const manager = new ProviderConnectionManager({
    environment: { PATH: '' },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return jsonResponse({ models: [{ name: 'qwen3-coder:latest' }, { model: 'deepseek-r1:8b' }] });
    },
  });
  const profile = { id: 'ollama', kind: 'local-api', enabled: false, model: 'qwen3-coder:latest' };
  const discovered = await manager.discover({
    kind: 'local', providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434',
  }, profile);
  assert.equal(discovered.connection.status, 'DISCOVERED');
  assert.equal(discovered.connection.baseUrl, 'http://127.0.0.1:11434');
  assert.deepEqual(discovered.models.map((model) => model.id).sort(), ['deepseek-r1:8b', 'qwen3-coder:latest']);
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/tags');
  assert.equal(calls[0].options.redirect, 'error');

  const connected = await manager.connect({
    kind: 'local', providerId: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen3-coder:latest',
  }, profile);
  const provider = manager.decorate({
    id: 'ollama', detected: false, available: false, capabilities: [], profile: { ...profile, enabled: true },
  });
  assert.equal(connected.connection.status, 'CONNECTED');
  assert.equal(provider.available, true);
  assert.equal(provider.connectionVerified, true);
  manager.close();
});

test('CLI connection requires both an executable and successful non-interactive auth status', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ege-provider-connections-cli-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'codex'), [
    '#!/bin/sh',
    '[ "$1" = "login" ] && [ "$2" = "status" ] && exit 0',
    '[ "$1" = "--help" ] && printf "  --search\\n" && exit 0',
    '[ "$1" = "--strict-config" ] && exit 0',
    'exit 1',
    '',
  ].join('\n'));
  await writeFile(join(directory, 'claude'), '#!/bin/sh\n[ "$1" = "auth" ] && [ "$2" = "status" ] && exit 1\nexit 1\n');
  await chmod(join(directory, 'codex'), 0o700);
  await chmod(join(directory, 'claude'), 0o700);
  const manager = new ProviderConnectionManager({ environment: { PATH: directory, HOME: directory } });

  const codex = await manager.connect({ kind: 'cli', providerId: 'codex-cli' }, { id: 'codex-cli', enabled: false });
  assert.equal(codex.connection.status, 'CONNECTED');
  assert.deepEqual(codex.connection.capabilities, ['chat', 'plan', 'research-live-web']);
  const connectedRevision = codex.connection.revision;
  const lostLogin = manager.decorate({
    id: 'codex-cli', detected: true, configured: false, available: false, capabilities: [],
    profile: { id: 'codex-cli', enabled: true },
  });
  assert.equal(lostLogin.available, false);
  assert.equal(lostLogin.connection.status, 'DISCONNECTED');
  assert.equal(lostLogin.connection.verified, false);
  assert.notEqual(lostLogin.connection.revision, connectedRevision);
  await assert.rejects(
    manager.connect({ kind: 'cli', providerId: 'claude-cli' }, { id: 'claude-cli', enabled: false }),
    (error) => error.code === 'CLI_AUTH_REQUIRED',
  );
  await assert.rejects(
    manager.connect({ kind: 'cli', providerId: 'copilot-cli' }, { id: 'copilot-cli', enabled: false }),
    (error) => error.code === 'PROVIDER_NOT_SUPPORTED',
  );
  manager.close();
});

test('model discovery rejects redirects, invalid JSON, and excessive model lists without exposing upstream bodies', async () => {
  const profile = { id: 'openai-api', enabled: false, model: 'gpt-5.6-terra' };
  for (const response of [
    new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private' } }),
    new Response('not json', { status: 200 }),
    jsonResponse({ data: Array.from({ length: 2_001 }, (_, index) => ({ id: `model-${index}` })) }),
  ]) {
    const manager = new ProviderConnectionManager({ fetchImpl: async () => response });
    await assert.rejects(
      manager.discover({ kind: 'hosted', providerId: 'openai-api', apiKey: 'secret-not-in-error' }, profile),
      (error) => ['PROVIDER_UNREACHABLE', 'PROVIDER_RESPONSE_INVALID'].includes(error.code)
        && !error.message.includes('secret-not-in-error'),
    );
    manager.close();
  }
});
