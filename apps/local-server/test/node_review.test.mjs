import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNodeReviewPins, nodeReviewEvidence, normalizeNodeReview, pinNodeReview, runNodeReviews, validateNodeReviewResult } from '../src/node_review.mjs';

const criteria = ['The implementation has a passing command receipt.'];
function fixture() {
  const agent = { id: 'reviewer-agent', status: 'ACTIVE', currentPrompt: { prompt: 'Review carefully.', digest: 'prompt-one' }, configDigest: 'config-one', toolPolicy: { contentDigest: 'policy-one' } };
  const reviewerNode = { id: 'reviewer', title: 'Independent QA', agentId: agent.id, providerId: 'codex-cli', review: { required: true, reviewerNodeIds: ['target'], providerId: 'ollama' } };
  const draft = { nodes: [{ id: 'target', title: 'Implementation' }, reviewerNode] };
  const provider = { id: 'ollama', enabled: true, model: 'review-model', baseUrl: 'http://127.0.0.1:11434', revision: 1 };
  const step = { nodeId: 'target-step', title: 'Implementation', objective: 'Implement output', acceptanceCriteria: criteria, sourceIntentNodeIds: ['target'], review: { required: true, reviewerNodeIds: ['reviewer'], providerId: 'ollama' } };
  const pin = pinNodeReview({ step, draft, steps: [step], agents: [agent], defaultProviderId: 'codex-cli', getProviderPin: () => provider });
  const result = { accepted: true, actualVerification: [{ command: 'npm test', status: 'PASS', exitCode: 0, output: '1 test passed.' }], workspaceArtifacts: { artifacts: [{ name: 'result.js', content: 'export const answer = 42;' }] } };
  const assertCurrent = () => assertNodeReviewPins(pin, { draft, getAgent: () => agent, getProviderPin: () => provider });
  return { agent, reviewerNode, draft, provider, step, pin, result, assertCurrent,
    providerOptions: async () => ({ providerId: provider.id, profile: provider }), signal: new AbortController().signal };
}
const answer = (status = 'supported', support = 'recorded_evidence', quote = '1 test passed.') => JSON.stringify({ summary: 'Compared the recorded test output.', assessments: criteria.map((criterion) => ({ criterion, status, support, reasoning: 'The observed command output records a passing test.', citations: [{ evidenceId: 'command:1', quote }] })) });
const stream = (raw) => async ({ onEvent }) => onEvent({ type: 'delta', text: raw });

test('review configuration validates existing distinct non-self reviewers and a separate API transport', () => {
  assert.deepEqual(normalizeNodeReview({ required: true, reviewerNodeIds: ['b'], providerId: 'ollama' }, 'a', new Set(['a', 'b'])), { required: true, reviewerNodeIds: ['b'], providerId: 'ollama' });
  for (const value of [{ required: true, reviewerNodeIds: [] }, { required: true, reviewerNodeIds: ['a'] }, { required: true, reviewerNodeIds: ['b', 'b'] }, { required: true, reviewerNodeIds: ['missing'] }, { required: true, reviewerNodeIds: ['b'], providerId: 'codex-cli' }]) assert.throws(() => normalizeNodeReview(value, 'a', new Set(['a', 'b'])), { code: 'NODE_REVIEW_INVALID' });
});

test('separate review provider preserves ordinary Codex execution and mutual assignments do not recurse', async () => {
  const input = fixture(); let calls = 0;
  assert.equal(input.reviewerNode.providerId, 'codex-cli');
  assert.equal(input.pin.reviewers[0].provider.id, 'ollama');
  const reviewed = await runNodeReviews({ ...input, streamImpl: async (options) => { calls++; assert.equal(options.messages.length, 3); await stream(answer())(options); } });
  assert.equal(reviewed.passed, true);
  assert.equal(calls, 1);
  assert.equal(reviewed.reviews[0].assessments[0].citations[0].quote, '1 test passed.');
});

test('invented evidence, mismatched quotations and inferred support cannot pass the gate', () => {
  const evidence = nodeReviewEvidence(fixture().result);
  for (const raw of [answer('supported', 'inferred'), answer('supported', 'recorded_evidence', '100 tests passed.'), answer().replace('command:1', 'unknown')]) {
    const value = validateNodeReviewResult(raw, criteria, evidence);
    assert.equal(value.passed, false);
    assert.equal(value.assessments[0].status, 'insufficient_evidence');
  }
  assert.equal(validateNodeReviewResult(answer('contradicted'), criteria, evidence).passed, false);
  assert.equal(validateNodeReviewResult(answer('insufficient_evidence'), criteria, evidence).passed, false);
  assert.throws(() => validateNodeReviewResult(answer().replace(criteria[0], 'Different criterion'), criteria, evidence), { code: 'NODE_REVIEW_OUTPUT_INVALID' });
});

test('failed target execution and absent recorded evidence prevent any reviewer call', async () => {
  for (const result of [{ accepted: false }, { accepted: true }]) {
    const reviewed = await runNodeReviews({ ...fixture(), result, streamImpl: async () => assert.fail('Must not invoke review') });
    assert.equal(reviewed.passed, false);
    assert.equal(reviewed.error.code, 'NODE_REVIEW_EVIDENCE_MISSING');
  }
});

test('review timeout and cancellation return a blocked result even if transport ignores abort', async () => {
  const hanging = async () => new Promise(() => {});
  const timedOut = await runNodeReviews({ ...fixture(), timeoutMs: 10, streamImpl: hanging });
  assert.equal(timedOut.passed, false);
  assert.equal(timedOut.error.code, 'NODE_REVIEW_TIMEOUT');
  const controller = new AbortController();
  const pending = runNodeReviews({ ...fixture(), signal: controller.signal, streamImpl: hanging });
  controller.abort();
  assert.equal((await pending).passed, false);
  const preCancelled = new AbortController(); preCancelled.abort();
  const result = await runNodeReviews({ ...fixture(), signal: preCancelled.signal, streamImpl: async () => assert.fail('Already cancelled') });
  assert.equal(result.passed, false);
});

test('provider, reviewer node, preset and pin tampering fail stale before or after review', async () => {
  for (const mutate of [(f) => { f.provider.model = 'changed'; }, (f) => { f.reviewerNode.title = 'changed'; }, (f) => { f.agent.currentPrompt.digest = 'changed'; }]) {
    const input = fixture();
    // Persisted plan snapshots do not share references with mutable live records.
    input.pin = structuredClone(input.pin);
    input.assertCurrent = () => assertNodeReviewPins(input.pin, { draft: input.draft, getAgent: () => input.agent, getProviderPin: () => input.provider });
    const result = await runNodeReviews({ ...input, streamImpl: async (options) => { await stream(answer())(options); mutate(input); } });
    assert.equal(result.passed, false);
    assert.equal(result.error.code, 'NODE_REVIEW_STALE');
  }
  const input = fixture(); input.pin.reviewers[0].prompt = 'Tampered';
  assert.throws(() => input.assertCurrent(), { code: 'NODE_REVIEW_STALE' });
});

test('review artifacts are bounded and unsupported CLI provider cannot execute', async () => {
  const input = fixture();
  const evidence = nodeReviewEvidence({ actualVerification: [], workspaceArtifacts: { artifacts: Array.from({ length: 100 }, (_, i) => ({ name: `${i}.txt`, content: 'x'.repeat(20000) })) } });
  assert.ok(evidence.reduce((sum, entry) => sum + entry.content.length, 0) <= 48000);
  assert.ok(evidence.every((entry) => entry.truncated));
  const value = await runNodeReviews({ ...input, providerOptions: () => ({ providerId: 'codex-cli' }), streamImpl: async () => assert.fail('No CLI invocation') });
  assert.equal(value.passed, false);
  assert.equal(value.error.code, 'NODE_REVIEW_PROVIDER_UNSUPPORTED');
});
