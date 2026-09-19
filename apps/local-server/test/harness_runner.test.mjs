import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalRepository } from '../src/database.mjs';
import { ChatStore } from '../src/chat_store.mjs';
import { HarnessStore } from '../src/harness_store.mjs';
import { harnessConfiguration, selectHarnessAgents } from '../src/harness_profiles.mjs';
import { harnessDigest, runEngineeringHarness } from '../src/harness_runner.mjs';
import { validateChatProposal } from '../src/chat_routes.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ege-harness-'));
  const repository = new LocalRepository(join(directory, 'db.sqlite'));
  const graph = repository.createGraph({ name: 'Harness test' });
  const chats = new ChatStore(repository.database);
  const conversation = chats.createConversation(graph.id, [], 'Engineering');
  const store = new HarnessStore(repository.database);
  const config = harnessConfiguration({ profile: 'poc' });
  const input = { graphId: graph.id, config, content: 'Build a small catalog API.', action: 'refine', providerId: 'openai-api', providerProfile: { model: 'model-one' }, agents: selectHarnessAgents([]), promptContext: { graphId: graph.id, nodes: [{ id: 'a', title: 'Catalog' }], evidence: [{ id: 'source', sha256: 'one' }], skills: [{ id: 'skill', packageDigest: 'skill-one' }] }, conversationContext: { summary: 'The user decided on a local prototype.', digest: 'history-one' }, historyPins: [], finalSystemPrompt: 'Return JSON with answer, claims, proposal. Proposals remain subject to review.' };
  const createRun = (request = input) => store.create({ graphId: graph.id, conversationId: conversation.id, messageId: chats.createMessage(conversation.id, { role: 'assistant', status: 'running' }).id, inputDigest: harnessDigest(request), request: { config: request.config } });
  t.after(async () => { repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { repository, store, input, createRun };
}
function response(stage) {
  return stage === 'compose' ? { answer: 'A practical proposal.', claims: [], proposal: { nodeUpdates: [{ id: 'a', context: 'Use one modular application.' }] }, decisions: ['Propose one modular application.'], questions: [], assumptions: ['Local development first.'], critique: ['A queue is unnecessary.'], alternatives: ['Add a queue only for measured workload needs.'] } : { summary: stage === 'brief' ? 'A local catalog API with fixtures.' : 'A modular API is adequate.', decisions: ['Propose one modular application.'], questions: [], assumptions: ['No production SLO was supplied.'], critique: stage === 'review' ? ['Avoid microservices for this scope.'] : [], alternatives: ['Start with a single process.'] };
}
const stageOf = (messages) => messages[0].content.match(/Stage: (brief|review|compose)\./)[1];
const validator = (raw) => validateChatProposal(JSON.parse(raw).proposal, { graphId: 'graph', nodes: [{ id: 'a' }], evidencePins: [], evidenceDigest: 'none', draftRevision: 1 });
const options = (value, run, streamImpl, extra = {}) => ({ store: value.store, runId: run.id, input: value.input, streamImpl, providerOptions: { profile: { model: 'fixture' } }, signal: new AbortController().signal, validateFinal: validator, ...extra });

test('real StateGraph emits three bounded agent handoffs and reuses only identical successful stage cache', async (t) => {
  const value = await fixture(t); const calls = []; const events = [];
  const provider = async ({ messages, onEvent, maxOutputTokens }) => {
    const stage = stageOf(messages); calls.push(stage);
    assert.ok(maxOutputTokens >= 256);
    assert.match(messages[0].content, /spec\.md, README\.md, AGENTS\.md/);
    assert.match(messages[0].content, /Do not invent current or latest software versions/);
    if (stage === 'review') assert.match(messages[1].content, /A local catalog API with fixtures/);
    if (stage === 'compose') assert.match(messages[1].content, /Avoid microservices/);
    onEvent({ type: 'delta', text: JSON.stringify(response(stage)) });
    onEvent({ type: 'usage', usage: { input_tokens: 30, output_tokens: 20, input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 3 } } });
  };
  const firstRun = value.createRun();
  const first = await runEngineeringHarness(options(value, firstRun, provider, { onEvent: (event) => events.push(event) }));
  assert.deepEqual(calls, ['brief', 'review', 'compose']);
  assert.deepEqual(first.harness.completedStages, calls);
  assert.equal(first.harness.handoffs[1].parentHandoffId, first.harness.handoffs[0].id);
  assert.equal(first.harness.handoffs[1].parentAgentId, first.harness.handoffs[0].agentId);
  assert.equal(first.harness.handoffs[2].toAgentId, null);
  assert.deepEqual(first.harness.usage.providerReported, { input_tokens: 90, output_tokens: 60, input_tokens_details: { cached_tokens: 30 }, output_tokens_details: { reasoning_tokens: 9 } });
  assert.ok(first.harness.usage.estimatedInputTokens > 90);
  assert.equal(events.filter((event) => event.type === 'delta').length, 1, 'Only the composer streams answer text.');
  const second = await runEngineeringHarness(options(value, value.createRun(), provider));
  assert.equal(calls.length, 3, 'Cache reuse makes no new provider calls.');
  assert.equal(second.harness.usage.cachedStages, 3);
  assert.deepEqual(second.harness.usage.providerReported, {});
  assert.equal(second.harness.usage.estimatedInputTokens, 0);
  assert.equal(second.harness.handoffs[0].sourceRunId, firstRun.id);
  assert.equal(second.text, first.text);
  for (const mutate of [
    (input) => { input.providerProfile.model = 'model-two'; },
    (input) => { input.promptContext.evidence[0].sha256 = 'changed-source'; },
    (input) => { input.agents.review.prompt = 'A changed editable review prompt.'; },
    (input) => { input.promptContext.skills[0].packageDigest = 'changed-skill'; },
    (input) => { input.conversationContext.digest = 'changed-history'; },
  ]) {
    const changed = structuredClone(value.input); mutate(changed); const previous = calls.length;
    await runEngineeringHarness(options(value, value.createRun(changed), provider, { input: changed }));
    assert.equal(calls.length, previous + 3, 'Changed pins invalidate stage cache.');
  }
});

test('cancelled review resumes from its durable checkpoint and accounts for failed provider usage without caching failure', async (t) => {
  const value = await fixture(t); const run = value.createRun(); const controller = new AbortController(); const calls = [];
  await assert.rejects(runEngineeringHarness(options(value, run, async ({ messages, onEvent, signal }) => {
    const stage = stageOf(messages); calls.push(stage);
    if (stage === 'review') {
      onEvent({ type: 'usage', usage: { input_tokens: 70, output_tokens: 5 } });
      onEvent({ type: 'delta', text: 'Partial review' }); controller.abort(new Error('User stopped.')); throw signal.reason;
    }
    onEvent({ type: 'delta', text: JSON.stringify(response(stage)) });
  }, { signal: controller.signal })), /User stopped/);
  const stopped = value.store.public(value.store.get(run.id));
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.canResume, true);
  assert.deepEqual(stopped.completedStages, ['brief']); assert.equal(stopped.nextStage, 'review');
  assert.deepEqual(stopped.usage.providerReported, { input_tokens: 70, output_tokens: 5 });
  assert.equal(stopped.failedAttempts.length, 1);
  value.store.update(run.id, { status: 'running' });
  const restarted = new HarnessStore(value.repository.database);
  assert.equal(restarted.get(run.id).status, 'interrupted');
  const resumed = await runEngineeringHarness(options(value, run, async ({ messages, onEvent }) => {
    const stage = stageOf(messages); calls.push(stage); onEvent({ type: 'delta', text: JSON.stringify(response(stage)) });
  }, { store: restarted }));
  assert.deepEqual(calls, ['brief', 'review', 'review', 'compose']);
  assert.equal(resumed.harness.status, 'completed');
  assert.equal(resumed.harness.failedAttempts.length, 1);
  assert.equal(resumed.harness.usage.providerReported.input_tokens, 70);
});

test('invalid final proposal is never checkpointed or cached and resume retries only composer', async (t) => {
  const value = await fixture(t); const run = value.createRun(); const calls = [];
  await assert.rejects(runEngineeringHarness(options(value, run, async ({ messages, onEvent }) => {
    const stage = stageOf(messages); calls.push(stage); const data = response(stage);
    if (stage === 'compose') data.proposal.nodeUpdates[0].id = 'outside-selection';
    onEvent({ type: 'delta', text: JSON.stringify(data) });
  })), /unselected/);
  assert.deepEqual(value.store.get(run.id).completedStages, ['brief', 'review']);
  const finished = await runEngineeringHarness(options(value, run, async ({ messages, onEvent }) => {
    const stage = stageOf(messages); calls.push(stage); onEvent({ type: 'delta', text: JSON.stringify(response(stage)) });
  }));
  assert.deepEqual(calls, ['brief', 'review', 'compose', 'compose']);
  assert.equal(finished.harness.status, 'completed');
});

test('mid-stage pin drift and output budget exhaustion cannot produce checkpoints or accepted proposals', async (t) => {
  const value = await fixture(t); let current = true;
  const run = value.createRun();
  await assert.rejects(runEngineeringHarness(options(value, run, async ({ onEvent }) => { onEvent({ type: 'delta', text: JSON.stringify(response('brief')) }); current = false; }, { assertPinsCurrent: () => current })), { code: 'HARNESS_PINS_CHANGED' });
  assert.equal(value.store.get(run.id).status, 'stale');
  assert.deepEqual(value.store.get(run.id).completedStages, []);
  const budgetRun = value.createRun();
  await assert.rejects(runEngineeringHarness(options(value, budgetRun, async ({ onEvent }) => { onEvent({ type: 'delta', text: 'x'.repeat(20000) }); onEvent({ type: 'usage', usage: { output_tokens: 5000 } }); })), { code: 'HARNESS_BUDGET_EXCEEDED' });
  const budget = value.store.public(value.store.get(budgetRun.id));
  assert.equal(budget.status, 'budget_exceeded'); assert.equal(budget.canResume, false);
  assert.equal(budget.usage.providerReported.output_tokens, 5000);
  assert.deepEqual(budget.completedStages, []);
});

test('only enabled editable catalog agents are selected and profiles keep configuration bounded', () => {
  assert.equal(harnessConfiguration().tokenBudget, 80000);
  const selected = selectHarnessAgents([{ id: 'disabled', name: 'Quality API architecture', status: 'DISABLED', currentPrompt: { prompt: 'Must not run.' } }, { id: 'enabled', name: 'API engineering', currentPrompt: { prompt: 'Project-specific guidance.', digest: 'prompt-one' }, configDigest: 'config-one' }], 'API');
  assert.ok(Object.values(selected).every((agent) => agent.id === 'enabled' && agent.origin === 'editable_catalog'));
  assert.equal(selected.review.promptDigest, 'prompt-one');
  assert.throws(() => harnessConfiguration({ profile: 'unknown' }), /Choose/);
  assert.throws(() => harnessConfiguration({ tokenBudget: 1 }), /budget/);
});

for (const phase of ['before', 'after']) test(`Stop during ${phase}-stage asynchronous pin validation cannot invoke later work or save a checkpoint`, async (t) => {
  const value = await fixture(t); const run = value.createRun(); const controller = new AbortController();
  let entered; const checking = new Promise((resolve) => { entered = resolve; });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let checks = 0; let calls = 0;
  const task = runEngineeringHarness(options(value, run, async ({ onEvent }) => { calls += 1; onEvent({ type: 'delta', text: JSON.stringify(response('brief')) }); }, {
    signal: controller.signal,
    assertPinsCurrent: async () => { checks += 1; if (checks === (phase === 'before' ? 1 : 2)) { entered(); await gate; } return true; },
  }));
  await checking; controller.abort(new Error('Stopped during pin capture.')); release();
  await assert.rejects(task, /Stopped|Aborted/i);
  assert.equal(calls, phase === 'before' ? 0 : 1);
  assert.deepEqual(value.store.get(run.id).completedStages, []);
  assert.equal(value.store.get(run.id).status, 'stopped');
});

test('complete harness prompt bounds include the current request and accumulated handoffs', async (t) => {
  const value = await fixture(t); let calls = 0;
  const input = structuredClone(value.input);
  input.promptContext.engineeringSettings = { context: { maxCharacters: 14000 }, harness: { compression: 'off' } };
  input.content = 'x'.repeat(14000);
  await assert.rejects(runEngineeringHarness(options(value, value.createRun(input), async () => { calls += 1; }, { input })), { code: 'CHAT_CONTEXT_LIMIT' });
  assert.equal(calls, 0);
  input.content = value.input.content;
  const run = value.createRun(input);
  await assert.rejects(runEngineeringHarness(options(value, run, async ({ messages, onEvent }) => {
    calls += 1; assert.ok(JSON.stringify(messages).length <= 14000);
    onEvent({ type: 'delta', text: JSON.stringify({ summary: 's'.repeat(7600), decisions: ['d'.repeat(600), 'e'.repeat(600), 'f'.repeat(600)] }) });
  }, { input })), { code: 'CHAT_CONTEXT_LIMIT' });
  assert.equal(calls, 2, 'Oversized composer prompt must not reach the provider.');
  assert.deepEqual(value.store.get(run.id).completedStages, ['brief', 'review']);
});

for (const phase of ['provider', 'before-pins', 'after-pins']) test(`stage timeout bounds ${phase} even when asynchronous work ignores abort`, async (t) => {
  const value = await fixture(t); const run = value.createRun(); let calls = 0; let checks = 0; let lateEvent;
  let release; const blocked = new Promise((resolve) => { release = resolve; });
  await assert.rejects(runEngineeringHarness(options(value, run, async ({ onEvent }) => {
    calls += 1; lateEvent = onEvent;
    if (phase === 'provider') await blocked;
    onEvent({ type: 'delta', text: JSON.stringify(response('brief')) });
  }, { stageTimeoutMs: 50, assertPinsCurrent: async () => {
    checks += 1;
    if ((phase === 'before-pins' && checks === 1) || (phase === 'after-pins' && checks === 2)) await blocked;
    return true;
  } })), { code: 'HARNESS_TIMEOUT' });
  release(); lateEvent?.({ type: 'delta', text: 'late output must be ignored' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, phase === 'before-pins' ? 0 : 1);
  assert.equal(value.store.get(run.id).status, 'failed');
  assert.deepEqual(value.store.get(run.id).completedStages, []);
});
