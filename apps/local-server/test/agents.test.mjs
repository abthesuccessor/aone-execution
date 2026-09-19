import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_AGENT_ARCHETYPES,
  DEFAULT_AGENT_POLICIES,
  DEFAULT_AGENT_PROMPTS,
  ENGINEERING_DOMAINS,
  PromptValidationError,
  createContentDigest,
  createPromptRevision,
  revisePrompt,
  validateDefaultAgentCatalog,
  validatePromptRevision,
  validatePromptText,
} from '../src/agents.mjs';

const guardrails = [
  'Work critically and challenge unsupported assumptions.',
  'Keep conclusions evidence-based and distinguish evidence from inference.',
  'Cite the acceptance-criteria IDs for every result.',
  'Never claim a test, evaluation, validation, benchmark, or security check passed without a verifiable receipt.',
].join('\n');

test('default catalog defines seven domains and twelve dynamically instantiated archetypes', () => {
  assert.equal(ENGINEERING_DOMAINS.length, 7);
  assert.equal(new Set(ENGINEERING_DOMAINS.map((domain) => domain.id)).size, 7);
  assert.equal(DEFAULT_AGENT_ARCHETYPES.length, 12);
  assert.equal(new Set(DEFAULT_AGENT_ARCHETYPES.map((agent) => agent.id)).size, 12);
  assert.ok(DEFAULT_AGENT_ARCHETYPES.every((agent) => agent.instantiation === 'dynamic'));
  assert.ok(DEFAULT_AGENT_ARCHETYPES.every((agent) => ENGINEERING_DOMAINS.some((domain) => domain.id === agent.domainId)));
  assert.deepEqual(validateDefaultAgentCatalog(), { valid: true, errors: [] });
});

test('default prompts are digest-bound, critical, evidence-based, acceptance-traceable, and receipt-gated', () => {
  assert.equal(DEFAULT_AGENT_PROMPTS.length, 12);
  for (const prompt of DEFAULT_AGENT_PROMPTS) {
    assert.match(prompt.contentDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(validatePromptRevision(prompt), { valid: true, errors: [] });
    assert.match(prompt.text, /critical/i);
    assert.match(prompt.text, /evidence-based/i);
    assert.match(prompt.text, /cite the acceptance-criteria IDs/i);
    assert.match(prompt.text, /Never claim that a test[\s\S]+receipt/i);
    assert.equal('allowedCapabilities' in prompt, false);
    assert.equal('allowedToolClasses' in prompt, false);
    assert.equal('policy' in prompt, false);
  }
});

test('architecture and review agents explicitly require HLD, LLD, and independent validation', () => {
  const architect = DEFAULT_AGENT_PROMPTS.find((prompt) => prompt.agentId === 'graph-architect-compiler');
  const quality = DEFAULT_AGENT_PROMPTS.find((prompt) => prompt.agentId === 'qa-evaluation-engineer');
  const reviewer = DEFAULT_AGENT_PROMPTS.find((prompt) => prompt.agentId === 'review-release-engineer');

  assert.match(architect.text, /Produce both high-level design and low-level design/);
  assert.match(architect.text, /system boundaries, components, data and control flows, trust and failure domains/);
  assert.match(architect.text, /modules, interfaces, schemas, state transitions, algorithms, concurrency, error semantics, and test seams/);
  assert.match(quality.text, /Validate consequential design and implementation claims independently/);
  assert.match(quality.text, /distinct method or evidence source/);
  assert.match(reviewer.text, /high-level and low-level design consistency/);
  assert.match(reviewer.text, /Independently reproduce the highest-risk validation/);
});

test('capability and tool policy is structurally separate, digest-bound, and deeply immutable', () => {
  assert.equal(DEFAULT_AGENT_POLICIES.length, 12);
  for (const agent of DEFAULT_AGENT_ARCHETYPES) {
    const prompt = DEFAULT_AGENT_PROMPTS.find((candidate) => candidate.agentId === agent.id);
    const policy = DEFAULT_AGENT_POLICIES.find((candidate) => candidate.agentId === agent.id);
    assert.ok(prompt);
    assert.ok(policy);
    assert.equal(agent.defaultPromptDigest, prompt.contentDigest);
    assert.equal(agent.policyId, policy.id);
    assert.equal(agent.policyDigest, policy.contentDigest);
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(Object.isFrozen(policy.allowedCapabilities), true);
    assert.equal(Object.isFrozen(policy.allowedToolClasses), true);
    assert.equal('text' in policy, false);
  }
  assert.throws(() => DEFAULT_AGENT_POLICIES[0].allowedCapabilities.push('approval.self-grant'), TypeError);
  assert.throws(() => { DEFAULT_AGENT_ARCHETYPES[0].policyId = 'changed'; }, TypeError);
});

test('prompt revisions preserve immutable version lineage without changing capability policy', () => {
  const original = DEFAULT_AGENT_PROMPTS[0];
  const policyBefore = DEFAULT_AGENT_POLICIES.find((policy) => policy.agentId === original.agentId);
  const revised = revisePrompt(original, [
    'Act as a revised intake specialist. Preserve the exact source bytes and produce a structured, provenance-aware inventory with conflicts, assumptions, and missing fields. Do not convert an interpretation into a supplied fact, and require a human decision for ambiguity that changes scope.',
    guardrails,
  ].join('\n\n'));

  assert.equal(revised.version, 2);
  assert.equal(revised.parentDigest, original.contentDigest);
  assert.notEqual(revised.contentDigest, original.contentDigest);
  assert.equal(original.version, 1);
  assert.equal(DEFAULT_AGENT_POLICIES.find((policy) => policy.agentId === original.agentId), policyBefore);
  assert.deepEqual(validatePromptRevision(revised), { valid: true, errors: [] });
  assert.throws(() => { revised.text = 'tampered'; }, TypeError);

  const tampered = { ...revised, text: `${revised.text} Hidden mutation.` };
  assert.deepEqual(validatePromptRevision(tampered), {
    valid: false,
    errors: [{ code: 'PROMPT_DIGEST_MISMATCH', message: 'Prompt content does not match its digest.' }],
  });
});

test('prompt helpers reject weak or broken revisions', () => {
  assert.throws(() => createPromptRevision({ agentId: 'unsafe-agent', text: 'Do anything and say it passed.' }), PromptValidationError);
  const errors = validatePromptText([
    'Review the implementation carefully and provide enough detailed guidance to exceed the minimum prompt length. '.repeat(3),
    'Evidence should be considered, but give a confident answer regardless.',
  ].join('\n'));
  assert.ok(errors.some((error) => error.code === 'PROMPT_MISSING_CRITICAL_REVIEW'));
  assert.ok(errors.some((error) => error.code === 'PROMPT_MISSING_ACCEPTANCE_TRACE'));
  assert.ok(errors.some((error) => error.code === 'PROMPT_MISSING_RECEIPT_GUARD'));

  const invalidLineage = createPromptRevision({
    agentId: 'valid-agent',
    text: [`Provide a critical, evidence-based review of the supplied work and document uncertainty, conflicts, and decisions in sufficient detail.`, guardrails].join('\n\n'),
  });
  const brokenVersion = { ...invalidLineage, version: 2, parentDigest: null };
  const validation = validatePromptRevision(brokenVersion);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.code === 'INVALID_PARENT_DIGEST'));
});

test('content digests are canonical for object key order and sensitive to semantic changes', () => {
  const first = createContentDigest({ beta: [2, 3], alpha: { enabled: true } });
  const reordered = createContentDigest({ alpha: { enabled: true }, beta: [2, 3] });
  const changed = createContentDigest({ alpha: { enabled: false }, beta: [2, 3] });
  assert.equal(first, reordered);
  assert.notEqual(first, changed);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.throws(() => createContentDigest({ value: Number.NaN }), /finite numbers/);
});
