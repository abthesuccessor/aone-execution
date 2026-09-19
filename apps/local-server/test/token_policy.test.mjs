import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertPromptContextLimit, CAVEMAN_SOURCE, compressionGuidance, selectConversationHistory, tokenPolicyManifest } from '../src/token_policy.mjs';
import { defaultEngineeringSettings, validateEngineeringSettings } from '../src/engineering_settings.mjs';

test('Caveman source is pinned to MIT skill with a verified upstream checksum', () => {
  const source = readFileSync(new URL('../../../third_party/caveman/SKILL.md', import.meta.url));
  assert.equal(createHash('sha256').update(source).digest('hex'), CAVEMAN_SOURCE.sha256);
  assert.match(readFileSync(new URL('../../../third_party/caveman/LICENSE', import.meta.url), 'utf8'), /MIT License/);
});

test('every enabled compression level preserves evidence, uncertainty and exact structured data', () => {
  assert.equal(compressionGuidance('off'), '');
  for (const mode of ['lite', 'full', 'ultra']) {
    const guidance = compressionGuidance(mode);
    for (const protectedValue of ['uncertainty', 'negations', 'citations', 'code', 'commands', 'paths', 'JSON keys', 'receipts', 'acceptance criteria', 'approvals']) assert.ok(guidance.includes(protectedValue));
    assert.ok(guidance.length < 1100, 'adapted prefix stays small rather than injecting full upstream skill');
  }
  assert.throws(() => compressionGuidance('wenyan'), /Unknown/);
  const controls = defaultEngineeringSettings();
  controls.harness.compression = 'off';
  assert.equal(tokenPolicyManifest(controls).estimatedInstructionTokens, 0);
});

test('context selection preserves whole exact messages, reports omissions and pins all originals', () => {
  const source = [
    { id: 'first', role: 'user', status: 'completed', content: 'Do not deploy.' },
    { id: 'middle', role: 'assistant', status: 'completed', content: 'Long background '.repeat(30) },
    { id: 'last', role: 'user', status: 'completed', content: 'Run `psql -c "SELECT 1"` only locally.' },
  ];
  const original = structuredClone(source);
  const selected = selectConversationHistory(source, { maxCharacters: 70, compactionEnabled: true });
  assert.deepEqual(selected.messages, [source[0], source[2]].map(({ role, content }) => ({ role, content })));
  assert.equal(selected.omittedMessageCount, 1);
  assert.deepEqual(source, original);
  source[1].content += 'Changed omitted original';
  assert.notEqual(selectConversationHistory(source, { maxCharacters: 70, compactionEnabled: true }).originalDigest, selected.originalDigest);
  assert.throws(() => selectConversationHistory(source, { maxCharacters: 70, compactionEnabled: false }), { code: 'CHAT_CONTEXT_LIMIT' });
});

test('engineering settings reject unsafe budgets and unsupported values and normalize disabled skills', () => {
  const settings = defaultEngineeringSettings();
  settings.skills.disabledIds = ['alpha', 'alpha', 'beta'];
  assert.deepEqual(validateEngineeringSettings(settings).skills.disabledIds, ['alpha', 'beta']);
  for (const maxCharacters of [0, 3999, 200001, Infinity, '5000']) assert.throws(() => validateEngineeringSettings({ ...settings, context: { compactionEnabled: true, maxCharacters } }), { code: 'ENGINEERING_SETTINGS_INVALID' });
  assert.throws(() => validateEngineeringSettings({ ...settings, harness: { compression: 'proxy' } }), { code: 'ENGINEERING_SETTINGS_INVALID' });
  assert.throws(() => validateEngineeringSettings({ ...settings, memory: { enabled: 'yes' } }), { code: 'ENGINEERING_SETTINGS_INVALID' });
});

test('outbound context counts exact serialized message overhead and escaped content', () => {
  const messages = [{ role: 'user', content: '\n"'.repeat(40) }];
  assert.throws(() => assertPromptContextLimit(messages, 100), { code: 'CHAT_CONTEXT_LIMIT' });
  assert.doesNotThrow(() => assertPromptContextLimit(messages, JSON.stringify(messages).length));
  assert.equal(selectConversationHistory(messages, { maxCharacters: 100, compactionEnabled: true, serialized: true }).messages.length, 0);
  assert.throws(() => selectConversationHistory(messages, { maxCharacters: 100, compactionEnabled: false, serialized: true }), { code: 'CHAT_CONTEXT_LIMIT' });
});
