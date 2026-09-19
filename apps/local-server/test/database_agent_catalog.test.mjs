import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { LocalRepository } from '../src/database.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function builtinCatalog(prompt, suffix = 'v1') {
  return [{
    id: 'graph-architect-compiler',
    slug: 'graph-architect-compiler',
    name: `Graph architect ${suffix}`,
    domain: 'architecture-computation',
    description: `Builtin metadata ${suffix}`,
    capabilities: [`graph.plan.${suffix}`],
    toolPolicy: { id: 'graph-policy', version: suffix, contentDigest: sha256(`policy:${suffix}`) },
    prompt,
    promptDigest: sha256(prompt),
    outputSchema: { type: 'object', title: suffix },
  }];
}

test('builtin catalog upgrades an untouched deterministic v1 prompt and refreshes builtin metadata', () => {
  const repository = new LocalRepository(':memory:');
  try {
    const oldPrompt = 'Original deterministic builtin prompt.';
    const upgradedPrompt = 'Revised builtin prompt requiring explicit high-level and low-level design.';
    repository.syncAgentCatalog(builtinCatalog(oldPrompt, 'old'));

    const initial = repository.getAgent('graph-architect-compiler');
    assert.equal(initial.currentPrompt.id, 'prompt:graph-architect-compiler:1');
    assert.equal(initial.currentPrompt.version, 1);

    repository.syncAgentCatalog(builtinCatalog(upgradedPrompt, 'current'));
    const upgraded = repository.getAgent('graph-architect-compiler');
    const history = repository.listAgentPrompts('graph-architect-compiler');
    assert.equal(upgraded.name, 'Graph architect current');
    assert.deepEqual(upgraded.capabilities, ['graph.plan.current']);
    assert.equal(upgraded.toolPolicy.version, 'current');
    assert.equal(upgraded.currentPrompt.version, 2);
    assert.equal(upgraded.currentPrompt.prompt, upgradedPrompt);
    assert.equal(upgraded.currentPrompt.parentDigest, sha256(oldPrompt));
    assert.equal(history.length, 2);
    assert.match(upgraded.currentPrompt.id, /^prompt:graph-architect-compiler:builtin:[a-f0-9]{64}$/);

    repository.syncAgentCatalog(builtinCatalog(upgradedPrompt, 'current'));
    assert.equal(repository.listAgentPrompts('graph-architect-compiler').length, 2);
  } finally {
    repository.close();
  }
});

test('builtin catalog preserves a user-created v2 prompt while refreshing builtin metadata and policy', () => {
  const repository = new LocalRepository(':memory:');
  try {
    const oldPrompt = 'Original deterministic builtin prompt.';
    const userPrompt = 'User governed prompt revision that must remain current.';
    repository.syncAgentCatalog(builtinCatalog(oldPrompt, 'old'));
    repository.createAgentPromptRevision('graph-architect-compiler', {
      prompt: userPrompt,
      outputSchema: { type: 'object', title: 'user' },
      digest: sha256(userPrompt),
      expectedCurrentDigest: sha256(oldPrompt),
    });

    repository.syncAgentCatalog(builtinCatalog('New builtin prompt that must not replace the user revision.', 'current'));
    const current = repository.getAgent('graph-architect-compiler');
    assert.equal(current.name, 'Graph architect current');
    assert.deepEqual(current.capabilities, ['graph.plan.current']);
    assert.equal(current.toolPolicy.version, 'current');
    assert.equal(current.currentPrompt.version, 2);
    assert.equal(current.currentPrompt.prompt, userPrompt);
    assert.equal(repository.listAgentPrompts('graph-architect-compiler').length, 2);
  } finally {
    repository.close();
  }
});

test('builtin-only prompt history follows successive seed upgrades without rolling back to an earlier seed', () => {
  const repository = new LocalRepository(':memory:');
  try {
    repository.syncAgentCatalog(builtinCatalog('Original seed.', 'v1'));
    repository.syncAgentCatalog(builtinCatalog('Second seed.', 'v2'));
    repository.syncAgentCatalog(builtinCatalog('Third seed honors editable skill defaults.', 'v3'));
    const third = repository.getAgent('graph-architect-compiler').currentPrompt;
    assert.equal(third.version, 3);
    assert.equal(third.parentDigest, sha256('Second seed.'));
    assert.equal(third.prompt, 'Third seed honors editable skill defaults.');

    repository.syncAgentCatalog(builtinCatalog('Second seed.', 'restored'));
    const restored = repository.getAgent('graph-architect-compiler').currentPrompt;
    assert.equal(restored.version, 3);
    assert.equal(restored.digest, third.digest);

    repository.syncAgentCatalog(builtinCatalog('Second seed.', 'restored'));
    assert.equal(repository.listAgentPrompts('graph-architect-compiler').length, 3);
  } finally {
    repository.close();
  }
});

test('seed upgrades preserve custom prompts after a builtin upgrade and catalog configuration overrides', () => {
  const repository = new LocalRepository(':memory:');
  try {
    repository.syncAgentCatalog(builtinCatalog('Original seed.', 'v1'));
    repository.syncAgentCatalog(builtinCatalog('Second seed.', 'v2'));
    repository.createAgentPromptRevision('graph-architect-compiler', {
      prompt: 'User instructions after a built-in upgrade.',
      outputSchema: {},
      digest: sha256('User instructions after a built-in upgrade.'),
      expectedCurrentDigest: sha256('Second seed.'),
    });
    repository.syncAgentCatalog(builtinCatalog('Third seed.', 'v3'));
    assert.equal(repository.getAgent('graph-architect-compiler').currentPrompt.prompt, 'User instructions after a built-in upgrade.');
    assert.equal(repository.listAgentPrompts('graph-architect-compiler').length, 3);

    const configuredAgent = { ...builtinCatalog('Configured seed.', 'v1')[0], id: 'configured-agent', slug: 'configured-agent' };
    repository.syncAgentCatalog([configuredAgent]);
    repository.saveCatalogRevision('agents', configuredAgent.id, { name: 'My configured agent', skillIds: ['custom-skill'] });
    repository.syncAgentCatalog([{ ...configuredAgent, name: 'Updated seed name', prompt: 'New configured seed.', promptDigest: sha256('New configured seed.') }]);
    const configured = repository.getAgent(configuredAgent.id);
    assert.equal(configured.name, 'My configured agent');
    assert.equal(configured.currentPrompt.prompt, 'Configured seed.');
    assert.equal(repository.listAgentPrompts(configuredAgent.id).length, 1);
  } finally {
    repository.close();
  }
});
