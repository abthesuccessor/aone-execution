import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createChatRoutes } from '../src/chat_routes.mjs';
import { LocalRepository } from '../src/database.mjs';
import { SkillCatalog } from '../src/skills.mjs';
import { EngineeringSettingsStore } from '../src/engineering_settings.mjs';

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
class CapturedResponse extends EventEmitter {
  chunks = [];
  destroyed = false;
  writableEnded = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(chunk) { this.chunks.push(chunk); }
  end() { this.writableEnded = true; }
}

async function setup(context, sizes, streamImpl, maxCharacters = 200000) {
  const directory = await mkdtemp(join(tmpdir(), 'ege-chat-skill-context-'));
  const repository = new LocalRepository(join(directory, 'chat.db'));
  const skills = new SkillCatalog({ root: join(directory, 'skills') });
  const contents = [];
  for (const [index, size] of sizes.entries()) {
    const name = `fixture-skill-${index}`;
    const packagePath = join(skills.root, name);
    await mkdir(packagePath, { recursive: true });
    const prefix = `---\nname: ${name}\ndescription: Complete imported instructions.\n---\n`;
    const suffix = `\nFINAL_REQUIRED_INSTRUCTION_${index}\n`;
    const content = prefix + 'x'.repeat(size - Buffer.byteLength(prefix + suffix)) + suffix;
    contents.push(content);
    await writeFile(join(packagePath, 'SKILL.md'), content);
  }
  const metadata = await skills.scan();
  assert.ok(metadata.every((item) => item.valid));
  const graph = repository.createGraph({ name: 'Imported skill chat' });
  repository.saveDraft(graph.id, { nodes: [{ id: 'intent', title: 'Build interface', description: 'Develop an accessible interface.', skills: metadata.map((item) => item.id) }], edges: [] });
  const profile = { id: 'openai-api', enabled: true, model: 'fixture-model' };
  const engineeringSettings = new EngineeringSettingsStore(repository);
  const controls = engineeringSettings.get();
  engineeringSettings.update({ ...controls, expectedRevision: controls.revision, context: { ...controls.context, maxCharacters } });
  const routes = createChatRoutes({ repository, skills, engineeringSettings, currentProviders: () => [{ id: profile.id, profile }], providerConnections: { connection: () => ({ status: 'CONNECTED', verified: true }), runtimeSecret: () => null }, environment: {}, HttpError, streamImpl, readJson: async (request) => request.body, json: (response, status, body) => { response.status = status; response.body = body; } });
  const call = async (suffix, method, body) => {
    const response = new CapturedResponse();
    await routes.handle({ request: { body }, response, path: `/api/graphs/${graph.id}/chat${suffix}`, method, cors: {} });
    return response;
  };
  context.after(async () => { await routes.close(); repository.close(); await rm(directory, { recursive: true, force: true }); });
  const conversation = (await call('', 'POST', { nodeIds: [] })).body.conversation;
  const send = () => call(`/${conversation.id}/messages`, 'POST', { providerId: profile.id, content: 'Discuss the configured instructions.' });
  const history = async () => (await call(`/${conversation.id}`, 'GET')).body.messages;
  return { repository, graph, contents, send, history };
}

test('chat supplies all 87253 bytes of valid skill instructions to the provider and persisted context', async (context) => {
  let calls = 0;
  let providerContext;
  const fixture = await setup(context, [87253], async ({ messages, onEvent }) => {
    calls += 1;
    providerContext = JSON.parse(messages[0].content.split('Pinned context: ')[1]);
    onEvent({ type: 'delta', text: JSON.stringify({ answer: 'Complete instructions received.', claims: [], proposal: null }) });
  });
  const response = await fixture.send();
  assert.equal(response.status, 200);
  assert.equal(calls, 1);
  assert.equal(providerContext.skills[0].content, fixture.contents[0]);
  assert.equal(Buffer.byteLength(providerContext.skills[0].content), 87253);
  const assistant = (await fixture.history()).at(-1);
  assert.equal(assistant.status, 'completed');
  assert.equal(assistant.context.skills[0].content, fixture.contents[0]);
  assert.ok(response.chunks.some((chunk) => chunk.startsWith('event: done')));
});

test('combined skill instructions over 128 KiB return actionable 422 before creating messages or invoking a provider', async (context) => {
  let calls = 0;
  const fixture = await setup(context, [87253, 50000], async () => { calls += 1; });
  await assert.rejects(fixture.send(), (error) => {
    assert.equal(error.status, 422);
    assert.equal(error.code, 'CHAT_SKILL_CONTEXT_LIMIT');
    assert.match(error.message, /128 KiB combined/);
    assert.match(error.message, /Select fewer skills/);
    assert.match(error.message, /No partial skill instructions/);
    return true;
  });
  assert.equal(calls, 0);
  assert.deepEqual(await fixture.history(), []);
});

test('smaller configured context budgets reject a complete oversized skill without truncation or provider calls', async (context) => {
  let calls = 0;
  const fixture = await setup(context, [87253], async () => { calls += 1; }, 48000);
  await assert.rejects(fixture.send(), { status: 422, code: 'CHAT_CONTEXT_LIMIT' });
  assert.equal(calls, 0);
  assert.deepEqual(await fixture.history(), []);
});

test('large accepted skills still obey the 200000-character whole-context bound before provider invocation', async (context) => {
  let calls = 0;
  const fixture = await setup(context, [87253], async () => { calls += 1; });
  const draft = fixture.repository.getLatestDraft(fixture.graph.id);
  fixture.repository.saveDraft(fixture.graph.id, { ...draft, nodes: [{ ...draft.nodes[0], context: 'a'.repeat(60000) }, { id: 'second', title: 'Related context', context: 'b'.repeat(60000), skills: [] }] });
  await assert.rejects(fixture.send(), { status: 422, code: 'CHAT_CONTEXT_LIMIT' });
  assert.equal(calls, 0);
  assert.deepEqual(await fixture.history(), []);
});
