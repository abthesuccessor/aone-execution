import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalRepository } from '../src/database.mjs';
import { ChatStore } from '../src/chat_store.mjs';
import { createChatRoutes, normalizeChatResult, validateChatProposal, previewChatAnswer } from '../src/chat_routes.mjs';
import { streamChat, buildCodexChatArguments } from '../src/chat_adapters.mjs';
import { createHarnessMemory } from '../src/harness_memory.mjs';
import { defaultEngineeringSettings } from '../src/engineering_settings.mjs';

const evidenceContext = { graphId: 'graph', draftRevision: 1, evidenceDigest: 'evidence-digest', evidencePins: [], nodes: [{ id: 'a' }, { id: 'b' }], evidence: [{ id: 'source', filename: 'requirements.md', excerpts: [{ id: 'excerpt', text: 'The service must retry twice.' }] }] };

test('fact-check claims require known attached excerpt IDs and retain AI assessment boundary', () => {
  const result = normalizeChatResult(JSON.stringify({ answer: 'Checked attached context.', claims: [{ text: 'retry twice', status: 'supported', evidenceIds: ['excerpt'] }, { text: 'deployed', status: 'supported', evidenceIds: ['fabricated'] }, { text: 'secure', status: 'contradicted', evidenceIds: [] }] }), evidenceContext);
  assert.equal(result.claims[0].status, 'supported');
  assert.equal(result.claims[1].status, 'insufficient_evidence');
  assert.equal(result.claims[2].status, 'insufficient_evidence');
  assert.equal(result.citations.length, 1);
  assert.match(result.claims[0].assessment, /AI assessment/);
  assert.equal(normalizeChatResult('plain answer', evidenceContext).proposal, null);
});

test('proposal validation limits edits to pinned selected nodes and excludes permission changes', () => {
  const result = validateChatProposal({ nodeUpdates: [{ id: 'a', title: 'Clear title', providerId: 'unexpected', tools: ['workspace.write'] }], edgeAdditions: [{ source: 'a', target: 'b', type: 'SUPPORTS', rationale: 'Evidence relation' }] }, evidenceContext);
  assert.deepEqual(result.nodeUpdates, [{ id: 'a', title: 'Clear title' }]);
  assert.equal(result.baseDraftRevision, 1);
  assert.throws(() => validateChatProposal({ nodeUpdates: [{ id: 'outside', title: 'Changed' }] }, evidenceContext), /unselected/);
  assert.throws(() => validateChatProposal({ edgeAdditions: [{ source: 'a', target: 'outside', type: 'REQUIRES' }] }, evidenceContext), /endpoints/);
});

test('provider streams are decoded into observed deltas and usage with fixed hosted destinations', async () => {
  for (const providerId of ['openai-api', 'anthropic-api', 'ollama']) {
    const events = []; let sent;
    const records = providerId === 'openai-api' ? [{ type: 'response.output_text.delta', delta: 'Hello ' }, { type: 'response.output_text.delta', delta: 'world' }, { type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 2 } } }] : providerId === 'anthropic-api' ? [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello world' } }, { type: 'message_delta', usage: { output_tokens: 2 } }, { type: 'message_stop' }] : [{ message: { content: 'Hello world' } }, { done: true, prompt_eval_count: 4, eval_count: 2 }];
    const text = records.map((record) => providerId === 'ollama' ? `${JSON.stringify(record)}\n` : `data: ${JSON.stringify(record)}\n\n`).join('');
    await streamChat({ providerId, profile: { model: 'test-model', baseUrl: 'http://127.0.0.1:11434' }, secret: 'test-secret', messages: [{ role: 'system', content: 'context' }, { role: 'user', content: 'hello' }], maxOutputTokens: 1400, signal: new AbortController().signal, onEvent: (event) => events.push(event), fetchImpl: async (url, options) => { sent = { url, ...options }; return new Response(new ReadableStream({ start(controller) { for (let offset = 0; offset < text.length; offset += 11) controller.enqueue(new TextEncoder().encode(text.slice(offset, offset + 11))); controller.close(); } })); } });
    assert.equal(events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), 'Hello world');
    assert.equal(events.filter((event) => event.type === 'usage').at(-1).usage.output_tokens, 2);
    assert.equal(sent.redirect, 'error');
    if (providerId === 'openai-api') { assert.equal(sent.url, 'https://api.openai.com/v1/responses'); assert.equal(JSON.parse(sent.body).store, false); }
    if (providerId === 'anthropic-api') assert.equal(JSON.parse(sent.body).system, 'context');
    const payload = JSON.parse(sent.body);
    assert.equal(providerId === 'openai-api' ? payload.max_output_tokens : providerId === 'anthropic-api' ? payload.max_tokens : payload.options.num_predict, 1400);
  }
});

test('Codex chat uses isolated read-only arguments and disables live search', () => {
  const args = buildCodexChatArguments({ directory: '/temporary/chat', model: 'configured-model' });
  assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
  assert.equal(args[args.indexOf('-C') + 1], '/temporary/chat');
  assert.ok(args.includes('web_search="disabled"'));
  assert.ok(args.includes('--json'));
  assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
});

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
class ResponseCapture extends EventEmitter {
  constructor() { super(); this.chunks = []; this.destroyed = false; this.writableEnded = false; }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) { this.chunks.push(chunk); }
  end() { this.writableEnded = true; }
  finalMessage() { const chunk = this.chunks.findLast((value) => value.startsWith('event: done')); return JSON.parse(chunk.split('\ndata: ')[1].trim()).message; }
}
async function harness(context, streamImpl, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ege-chat-test-'));
  const repository = new LocalRepository(join(directory, 'chat.db'));
  const graph = repository.createGraph({ name: 'Chat tests' });
  repository.saveDraft(graph.id, { nodes: [{ id: 'a', title: 'First', description: 'Build a service', skills: [] }, { id: 'b', title: 'Second', description: 'Verify it', skills: [] }], edges: [] });
  const profile = { id: 'openai-api', label: 'Test OpenAI', kind: 'api', enabled: true, model: 'test-model' };
  const routes = createChatRoutes({ repository, skills: { catalogMetadata: () => [] }, currentProviders: () => [{ id: 'openai-api', profile }], providerConnections: { connection: () => ({ status: 'CONNECTED', verified: true }), runtimeSecret: () => 'private-test-key' }, environment: {}, readJson: async (request) => request.body, json: (response, status, body) => { response.status = status; response.body = body; }, HttpError, streamImpl, ...options });
  repository.upsertProviderProfile?.(profile);
  // Persist the supported provider profile without touching real credentials.
  repository.database.prepare('UPDATE provider_profiles SET enabled=1,model=? WHERE id=?').run('test-model', 'openai-api');
  const call = async (suffix = '', method = 'GET', body) => { const response = new ResponseCapture(); await routes.handle({ request: { body }, response, path: `/api/graphs/${graph.id}/chat${suffix}`, method, cors: {} }); return response; };
  context.after(async () => { await routes.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  return { repository, graph, routes, call, directory };
}

test('chat persists scoped conversations, returns real completion, applies once, and rejects stale proposals', async (context) => {
  const { repository, graph, call } = await harness(context, async ({ onEvent, messages, secret }) => {
    assert.match(messages[0].content, /Pinned context/); assert.equal(secret, 'private-test-key');
    onEvent({ type: 'activity', activity: { kind: 'provider', label: 'Mock provider actually called', status: 'running' } });
    onEvent({ type: 'delta', text: JSON.stringify({ answer: 'Refinement ready.', proposal: { nodeUpdates: [{ id: 'a', title: 'Refined first' }], edgeAdditions: [] } }) });
    onEvent({ type: 'usage', usage: { output_tokens: 11 } });
  });
  const created = await call('', 'POST', { nodeIds: ['a'] }); const id = created.body.conversation.id;
  const completed = (await call(`/${id}/messages`, 'POST', { providerId: 'openai-api', action: 'refine', content: 'Refine this node.', sourceIds: [] })).finalMessage();
  assert.equal(completed.status, 'completed'); assert.equal(completed.content, 'Refinement ready.'); assert.equal(completed.context.nodes.length, 1);
  assert.equal(completed.proposal.status, 'pending'); assert.equal(repository.getLatestDraft(graph.id).revision, 2);
  const applied = await call(`/proposals/${completed.proposal.id}/apply`, 'POST');
  assert.equal(applied.body.draft.revision, 3); assert.equal(applied.body.draft.nodes[0].title, 'Refined first');
  assert.equal((await call(`/proposals/${completed.proposal.id}/apply`, 'POST')).body.draft.revision, 3);
  const next = (await call(`/${id}/messages`, 'POST', { providerId: 'openai-api', action: 'refine', content: 'Refine again.', sourceIds: [] })).finalMessage();
  repository.saveDraft(graph.id, repository.getLatestDraft(graph.id));
  await assert.rejects(call(`/proposals/${next.proposal.id}/apply`, 'POST'), (error) => error.code === 'CHAT_PROPOSAL_STALE');
  const detail = (await call(`/${id}`)).body;
  assert.equal(detail.messages.length, 4); assert.equal(detail.messages.at(-1).stale, true);
});

test('stop aborts active request, preserves partial text, and creates no actionable proposal', async (context) => {
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const { call } = await harness(context, async ({ signal, onEvent }) => {
    onEvent({ type: 'delta', text: 'Partial text' }); started();
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const id = (await call('', 'POST', { nodeIds: [] })).body.conversation.id;
  const running = call(`/${id}/messages`, 'POST', { providerId: 'openai-api', action: 'refine', content: 'refine', sourceIds: [] });
  await ready;
  await assert.rejects(call(`/${id}/messages`, 'POST', { providerId: 'openai-api', content: 'duplicate' }), (error) => error.code === 'CHAT_BUSY');
  assert.equal((await call(`/${id}/stop`, 'POST')).body.status, 'stop_requested');
  const message = (await running).finalMessage();
  assert.equal(message.status, 'stopped'); assert.equal(message.content, 'Partial text'); assert.equal(message.proposal, undefined);
});

test('restart marks interrupted responses honestly while retaining history', async (context) => {
  const { repository, graph } = await harness(context, async () => {});
  const first = new ChatStore(repository.database); const conversation = first.createConversation(graph.id, [], 'History');
  const message = first.createMessage(conversation.id, { role: 'assistant', status: 'running', content: 'partial' });
  const second = new ChatStore(repository.database);
  assert.equal(second.getMessage(message.id).status, 'interrupted'); assert.equal(second.getMessage(message.id).content, 'partial');
  assert.equal(second.listConversations(graph.id).length, 1);
});


test('streaming preview exposes received answer text while retaining proposed patches for review', () => {
  assert.equal(previewChatAnswer('{"answer":"Hello'), 'Hello');
  assert.equal(previewChatAnswer('{"answer":"Hello world","proposal":{"nodeUpdates":'), 'Hello world');
  assert.equal(previewChatAnswer('Plain provider text'), 'Plain provider text');
  assert.equal(previewChatAnswer('{"claims":['), '');
});

test('deleted attached evidence makes the assessment and pending proposal stale', async (context) => {
  const { repository, graph, call } = await harness(context, async ({ onEvent }) => onEvent({ type: 'delta', text: JSON.stringify({ answer: 'Based on the attachment.', proposal: { nodeUpdates: [{ id: 'a', description: 'Use attached requirements' }] } }) }));
  const source = repository.createSource({ graphId: graph.id, nodeId: 'a', filename: 'requirements.md', mediaType: 'text/markdown', byteSize: 7, sha256: 'a'.repeat(64), objectKey: 'test-only-key', parserId: 'text', parserVersion: '1', parseStatus: 'PARSED', chunks: [] });
  const id = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const message = (await call(`/${id}/messages`, 'POST', { providerId: 'openai-api', action: 'refine', content: 'Refine from evidence', sourceIds: [source.id] })).finalMessage();
  assert.equal(message.stale, false);
  assert.equal(message.context.evidence[0].sha256, 'a'.repeat(64));
  repository.deleteSource(source.id);
  assert.equal((await call(`/${id}`)).body.messages.at(-1).stale, true);
  await assert.rejects(call(`/proposals/${message.proposal.id}/apply`, 'POST'), (error) => error.code === 'CHAT_PROPOSAL_STALE');
});

test('truncated provider streams are rejected instead of claiming completion', async () => {
  await assert.rejects(streamChat({ providerId: 'openai-api', profile: { model: 'test-model' }, secret: 'mock-secret', messages: [], signal: new AbortController().signal, onEvent: () => {}, fetchImpl: async () => new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\n') }), /before its completion event/);
});


test('AI node additions use generated IDs, map temporary relationships, and require scoped linkage', () => {
  const input = { nodeAdditions: [{ id: 'new:implementation', title: 'Implementation', description: 'Build the agreed feature.', acceptanceCriteria: ['The feature meets the requirement.'] }], edgeAdditions: [{ source: 'a', target: 'new:implementation', type: 'REQUIRES', rationale: 'Refines the selected intent' }] };
  const proposal = validateChatProposal(input, { ...evidenceContext, scopeNodeIds: ['a', 'b'] });
  assert.equal(proposal.nodeAdditions.length, 1);
  assert.notEqual(proposal.nodeAdditions[0].id, 'new:implementation');
  assert.equal(proposal.edgeAdditions[0].target, proposal.nodeAdditions[0].id);
  assert.throws(() => validateChatProposal({ ...input, edgeAdditions: [] }, { ...evidenceContext, scopeNodeIds: ['a'] }), /must connect/);
  assert.throws(() => validateChatProposal({ ...input, edgeAdditions: [{ source: 'unselected-existing', target: 'new:implementation', type: 'REQUIRES' }] }, evidenceContext), /endpoints/);
  assert.throws(() => validateChatProposal({ nodeAdditions: [{ id: 'a', title: 'Collision', description: 'Bad' }] }, evidenceContext), /temporary IDs/);
});

test('workspace AI creation is reviewed before adding nodes and relationships to an empty graph', async (context) => {
  const { repository, graph, call } = await harness(context, async ({ onEvent }) => onEvent({ type: 'delta', text: JSON.stringify({ answer: 'Two nodes proposed.', proposal: { summary: 'Create implementation and verification', nodeAdditions: [{ id: 'new:build', title: 'Build', description: 'Implement a bounded change.' }, { id: 'new:verify', title: 'Verify', description: 'Verify the implementation.' }], edgeAdditions: [{ source: 'new:build', target: 'new:verify', type: 'REQUIRES', rationale: 'Build precedes verification' }] } }) }));
  repository.saveDraft(graph.id, { nodes: [], edges: [] });
  const id = (await call('', 'POST', { nodeIds: [] })).body.conversation.id;
  const message = (await call(`/${id}/messages`, 'POST', { providerId: 'openai-api', action: 'refine', content: 'Create build and verify nodes.', sourceIds: [] })).finalMessage();
  assert.equal(message.status, 'completed');
  assert.equal(message.proposal.nodeAdditions.length, 2);
  assert.equal(repository.getLatestDraft(graph.id).nodes.length, 0);
  const applied = await call(`/proposals/${message.proposal.id}/apply`, 'POST');
  assert.equal(applied.body.draft.nodes.length, 2);
  assert.equal(applied.body.draft.edges[0].source, applied.body.draft.nodes[0].id);
  assert.equal(applied.body.draft.edges[0].target, applied.body.draft.nodes[1].id);
});

test('chat Apply cannot mutate a graph with active execution', async (context) => {
  const { repository, graph, call } = await harness(context, async ({ onEvent }) => onEvent({ type: 'delta', text: JSON.stringify({ answer: 'Change proposed.', proposal: { nodeUpdates: [{ id: 'a', title: 'Updated title' }] } }) }));
  const id = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const message = (await call(`/${id}/messages`, 'POST', { providerId: 'openai-api', action: 'refine', content: 'Refine', sourceIds: [] })).finalMessage();
  repository.listExecutions = () => [{ status: 'RUNNING' }];
  await assert.rejects(call(`/proposals/${message.proposal.id}/apply`, 'POST'), (error) => error.code === 'GRAPH_EXECUTION_ACTIVE');
  assert.equal(repository.getLatestDraft(graph.id).nodes[0].title, 'First');
});

const engineeringStage = (messages) => messages[0].content.match(/Stage: (brief|review|compose)\./)?.[1];
const engineeringResponse = (stage) => stage === 'compose'
  ? { answer: 'An editable local prototype proposal.', claims: [], decisions: ['Use one modular application.'], proposal: { summary: 'Prototype work', nodeUpdates: [{ id: 'a', context: 'Deliver spec.md, README.md, AGENTS.md, setup instructions, relevant skills, API contract generation, fixtures and meaningful tests.' }] } }
  : { summary: `${stage} conclusion`, decisions: ['Propose a modular application.'], questions: ['Which users need access?'], assumptions: ['Local prototype initially.'], critique: ['Avoid unnecessary services.'], alternatives: ['Add a worker only if measurements justify it.'] };

test('engineering chat runs real staged orchestration with confirmed memory, derived history and read-only neighbors before reviewed Apply', async (context) => {
  const calls = [];
  const { repository, graph, call } = await harness(context, async ({ messages, onEvent }) => {
    const stage = engineeringStage(messages); calls.push(stage);
    assert.match(messages[0].content, /readOnlyNeighbors/);
    assert.match(messages[0].content, /"id":"b","title":"Second"/);
    assert.match(messages[0].content, /Always use synthetic fixture data/);
    assert.doesNotMatch(messages[0].content, /Invent a verified deployment/);
    assert.match(messages[1].content, /Use a local-first prototype/);
    onEvent({ type: 'delta', text: JSON.stringify(engineeringResponse(stage)) });
    onEvent({ type: 'usage', usage: { input_tokens: 20, output_tokens: 10 } });
  });
  const draft = repository.getLatestDraft(graph.id);
  repository.saveDraft(graph.id, { ...draft, edges: [{ id: 'edge-ab', source: 'a', target: 'b', type: 'SUPPORTS' }] });
  const id = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  new ChatStore(repository.database).createMessage(id, { role: 'user', content: 'Use a local-first prototype.' });
  const memory = createHarnessMemory({ repository });
  memory.remember({ graphId: graph.id, nodeIds: ['a'], content: 'Always use synthetic fixture data.', validation: { state: 'user_confirmed' } });
  memory.remember({ graphId: graph.id, content: 'Invent a verified deployment.' });
  const response = await call(`/${id}/messages`, 'POST', { content: 'Engineer this idea.', providerId: 'openai-api', action: 'refine', engineeringHarness: { enabled: true, profile: 'poc', tokenBudget: 24000, conventions: 'Use generated API contracts.' } });
  const message = response.finalMessage();
  assert.deepEqual(calls, ['brief', 'review', 'compose']);
  assert.equal(message.status, 'completed', message.error);
  assert.equal(message.harness.status, 'completed');
  assert.equal(message.harness.handoffs.length, 3);
  assert.deepEqual(message.harness.usage.providerReported, { input_tokens: 60, output_tokens: 30 });
  assert.ok(message.activities.some((activity) => activity.kind === 'memory' && activity.includedCount === 1));
  assert.equal(message.proposal.status, 'pending');
  assert.ok(response.chunks.some((chunk) => chunk.startsWith('event: harness')));
  assert.equal(repository.getLatestDraft(graph.id).nodes[0].context ?? '', '');
  assert.equal((await call(`/${id}`)).body.messages.at(-1).harness.id, message.harness.id);
  const applied = await call(`/proposals/${message.proposal.id}/apply`, 'POST');
  assert.match(applied.body.draft.nodes[0].context, /spec\.md/);
  assert.equal(applied.body.draft.nodes[1].title, 'Second');
});

test('engineering chat stops and resumes the same message from a checkpoint without duplicate history', async (context) => {
  let release; const reviewStarted = new Promise((resolve) => { release = resolve; });
  let blocked = true; const calls = [];
  const { call } = await harness(context, async ({ messages, onEvent, signal }) => {
    const stage = engineeringStage(messages); calls.push(stage);
    if (stage === 'review' && blocked) { blocked = false; release(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
    onEvent({ type: 'delta', text: JSON.stringify(engineeringResponse(stage)) });
  });
  const id = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const request = call(`/${id}/messages`, 'POST', { content: 'Create a practical prototype.', providerId: 'openai-api', action: 'refine', engineeringHarness: { enabled: true, profile: 'poc' } });
  await reviewStarted; await call(`/${id}/stop`, 'POST');
  const stopped = (await request).finalMessage();
  assert.equal(stopped.status, 'stopped'); assert.equal(stopped.harness.nextStage, 'review');
  assert.equal(stopped.harness.canResume, true); assert.equal(stopped.proposal, undefined);
  const resumed = (await call(`/${id}/messages`, 'POST', { engineeringHarness: { enabled: true, resumeRunId: stopped.harness.id } })).finalMessage();
  assert.equal(resumed.id, stopped.id);
  assert.equal(resumed.status, 'completed', resumed.error);
  assert.deepEqual(calls, ['brief', 'review', 'review', 'compose']);
  assert.equal((await call(`/${id}`)).body.messages.length, 2);
});

test('engineering checkpoint resume rejects changed draft pins before a new provider invocation', async (context) => {
  let calls = 0;
  const { call, repository, graph } = await harness(context, async ({ messages, onEvent }) => {
    calls += 1; const stage = engineeringStage(messages);
    if (stage === 'review') throw new Error('Provider temporarily unavailable.');
    onEvent({ type: 'delta', text: JSON.stringify(engineeringResponse(stage)) });
  });
  const id = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const failed = (await call(`/${id}/messages`, 'POST', { content: 'Create a prototype.', providerId: 'openai-api', action: 'refine', engineeringHarness: { enabled: true, profile: 'mvp' } })).finalMessage();
  assert.equal(failed.status, 'failed'); assert.equal(calls, 2);
  repository.saveDraft(graph.id, repository.getLatestDraft(graph.id));
  await assert.rejects(call(`/${id}/messages`, 'POST', { engineeringHarness: { enabled: true, resumeRunId: failed.harness.id } }), { code: 'HARNESS_PINS_CHANGED' });
  assert.equal(calls, 2);
  assert.equal((await call(`/${id}`)).body.messages.at(-1).harness.status, 'stale');
});

for (const engineering of [false, true]) test(`Stop during initial ${engineering ? 'harness' : 'chat'} context capture reserves cancellation before provider invocation`, async (context) => {
  let entered; const capturing = new Promise((resolve) => { entered = resolve; });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { call } = await harness(context, async () => { calls += 1; }, { skills: { catalogMetadata: () => [], scan: async () => { entered(); await gate; } } });
  const id = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const task = call(`/${id}/messages`, 'POST', { content: 'Refine after capture.', providerId: 'openai-api', action: 'refine', engineeringHarness: { enabled: engineering, profile: 'poc' } });
  await capturing;
  await assert.rejects(call(`/${id}/messages`, 'POST', { content: 'Concurrent request', providerId: 'openai-api' }), { code: 'CHAT_BUSY' });
  assert.equal((await call(`/${id}/stop`, 'POST')).body.status, 'stop_requested');
  release();
  await assert.rejects(task, { code: 'CHAT_STOPPED' });
  assert.equal(calls, 0);
  assert.equal((await call(`/${id}`)).body.messages.length, 0);
});

test('harness proposal Apply rejects changed confirmed memory after its final review', async (context) => {
  const { call, repository, graph } = await harness(context, async ({ messages, onEvent }) => onEvent({ type: 'delta', text: JSON.stringify(engineeringResponse(engineeringStage(messages))) }));
  const id = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const message = (await call(`/${id}/messages`, 'POST', { content: 'Create a prototype.', providerId: 'openai-api', action: 'refine', engineeringHarness: { enabled: true, profile: 'poc' } })).finalMessage();
  assert.equal(message.status, 'completed', message.error);
  createHarnessMemory({ repository }).remember({ graphId: graph.id, content: 'Use a different persistence model.', validation: { state: 'user_confirmed' } });
  await assert.rejects(call(`/proposals/${message.proposal.id}/apply`, 'POST'), { code: 'CHAT_PROPOSAL_STALE' });
  assert.equal(repository.getLatestDraft(graph.id).nodes[0].context, undefined);
});

test('identical engineering requests in fresh conversations reuse cache without volatile capture IDs in the key', async (context) => {
  let calls = 0;
  const { call } = await harness(context, async ({ messages, onEvent }) => { calls += 1; onEvent({ type: 'delta', text: JSON.stringify(engineeringResponse(engineeringStage(messages))) }); });
  const request = { content: 'Create a local prototype.', providerId: 'openai-api', action: 'refine', engineeringHarness: { enabled: true, profile: 'poc' } };
  const firstId = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const first = (await call(`/${firstId}/messages`, 'POST', request)).finalMessage();
  assert.equal(first.status, 'completed', first.error); assert.equal(calls, 3);
  const secondId = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const second = (await call(`/${secondId}/messages`, 'POST', request)).finalMessage();
  assert.equal(second.status, 'completed', second.error); assert.equal(calls, 3);
  assert.equal(second.harness.contextDigest, first.harness.contextDigest);
  assert.equal(second.harness.usage.cachedStages, 3);
  assert.notEqual(first.proposal.id, second.proposal.id);
});

test('mandatory chat prompt cannot bypass a small context budget even with compaction enabled', async (context) => {
  const controls = defaultEngineeringSettings(); controls.context.maxCharacters = 4000;
  let calls = 0;
  const { call } = await harness(context, async () => { calls += 1; }, { engineeringSettings: { get: () => structuredClone(controls) } });
  const id = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  await assert.rejects(call(`/${id}/messages`, 'POST', { providerId: 'openai-api', content: 'x'.repeat(4000) }), { code: 'CHAT_CONTEXT_LIMIT' });
  assert.equal(calls, 0);
  assert.equal((await call(`/${id}`)).body.messages.at(-1).status, 'failed');
});

for (const change of ['settings', 'provider']) test(`${change} changes during context capture prevent the first provider invocation`, async (context) => {
  const controls = defaultEngineeringSettings(); let revision = 1; let calls = 0;
  let entered; const preparing = new Promise((resolve) => { entered = resolve; });
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const { call } = await harness(context, async () => { calls += 1; }, {
    engineeringSettings: { get: () => structuredClone(controls) },
    providerConnections: { connection: () => ({ status: 'CONNECTED', verified: true, revision }), runtimeSecret: () => 'private-test-key' },
    skills: { catalogMetadata: () => [], scan: async () => { entered(); await gate; } },
  });
  const id = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const task = call(`/${id}/messages`, 'POST', { providerId: 'openai-api', content: 'Prepare a response.' });
  await preparing;
  if (change === 'settings') controls.revision += 1; else revision += 1;
  release();
  await assert.rejects(task, { code: change === 'settings' ? 'CHAT_SETTINGS_CHANGED' : 'CHAT_PROVIDER_CHANGED' });
  assert.equal(calls, 0);
  assert.equal((await call(`/${id}/stop`, 'POST')).body.status, 'idle');
});

test('harness provider credential revision invalidates Apply and stage cache even with the same model', async (context) => {
  let revision = 1; let calls = 0;
  const { call } = await harness(context, async ({ messages, onEvent }) => {
    calls += 1; onEvent({ type: 'delta', text: JSON.stringify(engineeringResponse(engineeringStage(messages))) });
  }, { providerConnections: { connection: () => ({ status: 'CONNECTED', verified: true, revision }), runtimeSecret: () => 'private-test-key' } });
  const request = { content: 'Create a local prototype.', providerId: 'openai-api', action: 'refine', engineeringHarness: { enabled: true, profile: 'poc' } };
  const firstId = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const first = (await call(`/${firstId}/messages`, 'POST', request)).finalMessage();
  assert.equal(first.status, 'completed', first.error); assert.equal(calls, 3);
  revision += 1;
  await assert.rejects(call(`/proposals/${first.proposal.id}/apply`, 'POST'), { code: 'CHAT_PROPOSAL_STALE' });
  const secondId = (await call('', 'POST', { nodeIds: ['a'] })).body.conversation.id;
  const second = (await call(`/${secondId}/messages`, 'POST', request)).finalMessage();
  assert.equal(second.status, 'completed', second.error); assert.equal(calls, 6);
  assert.equal(second.harness.usage.cachedStages, 0);
  assert.notEqual(second.harness.contextDigest, first.harness.contextDigest);
});
