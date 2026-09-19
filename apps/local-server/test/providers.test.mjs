import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_PROVIDER_PROFILES, detectProviders } from '../src/providers.mjs';

async function executable(path, content) {
  await writeFile(path, `#!/bin/sh\n${content}\n`);
  await chmod(path, 0o700);
}

test('provider detection distinguishes configuration, request-time verification, local readiness, and Codex execution opt-in', async (context) => {
  const binaryDirectory = await mkdtemp(join(tmpdir(), 'ege-provider-test-'));
  context.after(() => rm(binaryDirectory, { recursive: true, force: true }));
  await executable(join(binaryDirectory, 'codex'), [
    '[ "$1" = "login" ] && [ "$2" = "status" ] && exit 0',
    '[ "$1" = "--help" ] && printf "  --search\\n" && exit 0',
    '[ "$1" = "--strict-config" ] && exit 0',
    'exit 1',
  ].join('\n'));
  await executable(join(binaryDirectory, 'ollama'), '[ "$1" = "ps" ] && exit 0\nexit 1');

  const profiles = DEFAULT_PROVIDER_PROFILES.map((profile) => ({
    ...profile,
    enabled: ['local-agents', 'simulation', 'codex-cli', 'openai-api', 'anthropic-api', 'ollama'].includes(profile.id),
  }));
  const environment = {
    PATH: binaryDirectory,
    HOME: binaryDirectory,
    EGE_ENABLE_WORKSPACE_WRITE: '1',
    OPENAI_API_KEY: 'openai-secret-not-returned',
    ANTHROPIC_API_KEY: 'anthropic-secret-not-returned',
  };
  const providers = detectProviders(environment, profiles);

  const localAgents = providers.find((provider) => provider.id === 'local-agents');
  assert.equal(localAgents.available, true);
  assert.equal(localAgents.ready, true);
  assert.deepEqual(localAgents.capabilities, ['plan']);
  assert.match(localAgents.detail, /no model, network request, project scan, or CLI probe/i);

  const codex = providers.find((provider) => provider.id === 'codex-cli');
  assert.equal(codex.available, true);
  assert.equal(codex.executionEnabled, true);
  assert.deepEqual(codex.capabilities, ['chat', 'plan', 'execute', 'research-live-web']);

  for (const providerId of ['openai-api', 'anthropic-api']) {
    const provider = providers.find((candidate) => candidate.id === providerId);
    assert.equal(provider.configured, true);
    assert.equal(provider.available, true);
    assert.equal(provider.ready, false);
    assert.equal(provider.connectionVerified, false);
    assert.deepEqual(provider.capabilities, ['chat', 'plan']);
  }

  const ollama = providers.find((provider) => provider.id === 'ollama');
  assert.equal(ollama.detected, true);
  assert.equal(ollama.configured, true);
  assert.equal(ollama.available, false);
  assert.equal(ollama.ready, false);
  assert.equal(JSON.stringify(providers).includes('openai-secret-not-returned'), false);
  assert.equal(JSON.stringify(providers).includes('anthropic-secret-not-returned'), false);

  const planningOnly = detectProviders({ ...environment, EGE_ENABLE_WORKSPACE_WRITE: '0' }, profiles)
    .find((provider) => provider.id === 'codex-cli');
  assert.equal(planningOnly.executionEnabled, false);
  assert.deepEqual(planningOnly.capabilities, ['chat', 'plan', 'research-live-web']);

  await executable(join(binaryDirectory, 'ollama'), 'exit 1');
  const stoppedOllama = detectProviders(environment, profiles).find((provider) => provider.id === 'ollama');
  assert.equal(stoppedOllama.configured, true);
  assert.equal(stoppedOllama.available, false);
  assert.equal(stoppedOllama.ready, false);
  assert.deepEqual(stoppedOllama.capabilities, []);
});
