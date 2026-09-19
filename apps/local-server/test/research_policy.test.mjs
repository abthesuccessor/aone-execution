import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESEARCH_POLICY_VERSION,
  ResearchPolicyError,
  codexWebSearchArguments,
  createResearchPolicy,
  validateResearchPolicy,
} from '../src/research_policy.mjs';

test('research is disabled by default and pins Codex web search off', () => {
  const policy = createResearchPolicy();
  assert.deepEqual(policy, {
    version: RESEARCH_POLICY_VERSION,
    enabled: false,
    provider: null,
    tool: null,
    mode: 'disabled',
    primarySourcesPreferred: false,
    citationsRequired: false,
    independentValidationRequired: false,
    digest: policy.digest,
  });
  assert.match(policy.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(codexWebSearchArguments(policy), [
    '--strict-config', '-c', 'web_search="disabled"',
  ]);
});

test('live research is a Codex-only explicit opt-in with immutable evidence requirements', () => {
  const policy = createResearchPolicy({ enabled: true }, 'codex-cli');
  assert.equal(Object.isFrozen(policy), true);
  assert.deepEqual(policy, {
    version: RESEARCH_POLICY_VERSION,
    enabled: true,
    provider: 'codex-cli',
    tool: 'web_search',
    mode: 'live',
    primarySourcesPreferred: true,
    citationsRequired: true,
    independentValidationRequired: true,
    digest: policy.digest,
  });
  assert.deepEqual(codexWebSearchArguments(policy), ['--strict-config', '--search']);
  assert.deepEqual(validateResearchPolicy(policy, 'codex-cli'), policy);
});

test('research rejects unsupported providers, unknown fields, non-booleans, and tampered pins', () => {
  for (const provider of ['simulation', 'openai-api', 'anthropic-api', 'claude-cli', 'ollama']) {
    assert.throws(
      () => createResearchPolicy({ enabled: true }, provider),
      (error) => error instanceof ResearchPolicyError && error.code === 'RESEARCH_PROVIDER_UNSUPPORTED',
    );
  }
  assert.throws(() => createResearchPolicy({ enabled: 'yes' }), /must be a boolean/);
  assert.throws(() => createResearchPolicy({ enabled: false, mode: 'live' }), /only the enabled boolean/);
  const policy = createResearchPolicy({ enabled: true }, 'codex-cli');
  assert.throws(
    () => validateResearchPolicy({ ...policy, citationsRequired: false }, 'codex-cli'),
    (error) => error.code === 'INVALID_RESEARCH_POLICY',
  );
});
