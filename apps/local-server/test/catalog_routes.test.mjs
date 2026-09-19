import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalRepository } from '../src/database.mjs';
import { SkillCatalog } from '../src/skills.mjs';
import { createCatalogRoutes } from '../src/catalog_routes.mjs';
import { DEFAULT_AGENT_PROMPTS, DEFAULT_AGENT_ARCHETYPES, DEFAULT_AGENT_POLICIES } from '../src/agents.mjs';

function seed(repository) {
  const catalog = DEFAULT_AGENT_ARCHETYPES.map((agent) => {
    const prompt = DEFAULT_AGENT_PROMPTS.find((item) => item.agentId === agent.id);
    const policy = DEFAULT_AGENT_POLICIES.find((item) => item.agentId === agent.id);
    return { id: agent.id, slug: agent.id, name: agent.name, description: agent.description, domain: agent.domainId, capabilities: policy.allowedCapabilities, toolPolicy: policy, prompt: prompt.text, promptDigest: prompt.contentDigest };
  });
  repository.syncAgentCatalog(catalog);
  return catalog;
}
async function fixture(context, { installed = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ege-catalog-'));
  const repository = new LocalRepository(join(root, 'catalog.sqlite'));
  context.after(async () => { repository.close(); await rm(root, { recursive: true, force: true }); });
  const seeds = seed(repository);
  if (installed) {
    await mkdir(join(root, 'skills', 'test-skill'), { recursive: true });
    await writeFile(join(root, 'skills', 'test-skill', 'SKILL.md'), '---\nname: test-skill\ndescription: A skill for test automation.\n---\n\nOriginal instructions.');
    await writeFile(join(root, 'skills', 'test-skill', 'helper.txt'), 'Pinned helper');
  }
  const skills = new SkillCatalog({ root: join(root, 'skills') });
  class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
  const routes = createCatalogRoutes({ repository, skills, currentProviders: () => [{ id: 'codex-cli', name: 'Codex CLI' }], readJson: async (request) => request.body, json: (response, status, body) => Object.assign(response, { status, body }), HttpError });
  const call = async (method, path, body) => { const response = {}; assert.equal(await routes.handle({ request: { body }, response, method, path, cors: {} }), true); return response.body; };
  return { repository, skills, seeds, call, root };
}

test('catalog agent changes are atomic, versioned, conflict-aware, and survive builtin seeding', async (context) => {
  const { repository, seeds, call } = await fixture(context);
  const original = repository.listAgents()[0];
  const body = { name: 'My configured reviewer', domain: original.domain, description: 'Custom configuration.', prompt: original.currentPrompt.prompt, providerId: 'codex-cli', model: 'configured-model', capabilities: original.capabilities, allowedToolClasses: ['workspace.read'], skillIds: [], status: 'DISABLED', expectedDigest: null, expectedPromptDigest: original.currentPrompt.digest };
  const updated = (await call('PATCH', `/api/catalog/agents/${original.id}`, body)).item;
  assert.equal(updated.configVersion, 1);
  assert.equal(updated.name, body.name);
  assert.equal(updated.status, 'DISABLED');
  assert.ok(updated.toolPolicy.deniedCapabilities.includes('approval.self-grant'));
  await assert.rejects(call('PATCH', `/api/catalog/agents/${original.id}`, body), { code: 'CATALOG_CHANGED', status: 409 });
  assert.equal(repository.getAgent(original.id).configVersion, 1);
  repository.syncAgentCatalog(seeds);
  assert.equal(repository.getAgent(original.id).name, body.name);
  assert.equal(repository.getAgent(original.id).model, body.model);
  const archived = (await call('PATCH', `/api/catalog/agents/${original.id}`, { ...body, archived: true, expectedDigest: updated.configDigest })).item;
  assert.equal(archived.archived, true);
  assert.equal((await call('GET', `/api/catalog/agents/${original.id}/history`)).items.length, 2);
});

test('agent create supports a custom domain and rejects invalid prompt without partial rows', async (context) => {
  const { repository, call } = await fixture(context);
  const domain = (await call('POST', '/api/catalog/domains', { name: 'My domain' })).item;
  const existing = repository.listAgents()[0];
  const body = { slug: 'custom-reviewer', name: 'Custom reviewer', domain: domain.id, description: 'Custom specialist.', prompt: existing.currentPrompt.prompt, allowedToolClasses: [], capabilities: [], skillIds: [] };
  const created = (await call('POST', '/api/catalog/agents', body)).item;
  assert.equal(created.domain, domain.id);
  assert.equal(created.configVersion, 1);
  await assert.rejects(call('POST', '/api/catalog/agents', { ...body, slug: 'broken-reviewer', prompt: 'bad' }), { code: 'INVALID_AGENT_PROMPT' });
  assert.equal(repository.getAgent('broken-reviewer'), null);
});

test('custom skill revisions work without installed root; disable removes routing and assignments', async (context) => {
  const { call, skills, repository } = await fixture(context);
  const body = { name: 'Browser quality', description: 'Accessible browser interface verification.', content: '---\nname: browser-quality\ndescription: Accessible browser interface verification.\n---\n\nCheck browser interactions and evidence.', enabled: true };
  const created = (await call('POST', '/api/catalog/skills', body)).item;
  assert.equal(created.valid, true);
  assert.equal(skills.catalogMetadata().length, 1);
  const changed = (await call('PATCH', `/api/catalog/skills/${created.id}`, { ...body, content: `${body.content}\nRequire screenshots.`, expectedDigest: created.configDigest })).item;
  assert.equal(changed.valid, true);
  assert.notEqual(changed.packageDigest, created.packageDigest);
  const pinned = await skills.readSelectedContents([changed.id]);
  assert.match(pinned[0].content, /Require screenshots/);
  await assert.rejects(call('PATCH', `/api/catalog/skills/${changed.id}`, { ...body, expectedDigest: created.configDigest }), { code: 'CATALOG_CHANGED' });
  await call('PATCH', `/api/catalog/skills/${changed.id}`, { ...body, enabled: false, expectedDigest: changed.configDigest });
  assert.equal(skills.catalogMetadata().length, 0);
  assert.equal(skills.validateSelection([changed.id]).valid, false);
  assert.equal(repository.catalogHistory('skills', changed.id).length, 3);
});

test('installed skill edits pin sibling package assets and fail closed if the package drifts', async (context) => {
  const { call, skills, root } = await fixture(context, { installed: true });
  const original = (await call('GET', '/api/catalog/skills')).items[0];
  const detail = (await call('GET', `/api/catalog/skills/${original.id}`)).item;
  const updated = (await call('PATCH', `/api/catalog/skills/${original.id}`, { name: detail.name, description: detail.description, content: `${detail.content}\nEdited instructions.`, expectedDigest: null })).item;
  assert.notEqual(updated.packageDigest, original.packageDigest);
  assert.equal(updated.basePackageDigest, original.packageDigest);
  assert.equal((await skills.readSelectedContents([original.id]))[0].packageFiles.length, 2);
  await writeFile(join(root, 'skills', 'test-skill', 'helper.txt'), 'Unexpected changed helper');
  await assert.rejects(skills.readSelectedContents([original.id]), { code: 'SKILL_CHANGED' });
  await skills.scan();
  assert.equal(skills.validateSelection([original.id]).valid, false);
});

test('action prompt overrides survive catalog initialization and retain history', async (context) => {
  const { call, repository, skills } = await fixture(context);
  const original = (await call('GET', '/api/catalog/prompts/ask')).item;
  const saved = (await call('PATCH', '/api/catalog/prompts/ask', { name: 'Discuss', description: 'My chat default', content: 'Cite selected evidence and identify uncertainties.', expectedDigest: original.configDigest })).item;
  createCatalogRoutes({ repository, skills });
  assert.equal(repository.getCatalogRevision('prompts', 'ask').data.content, saved.content);
  assert.equal(repository.catalogHistory('prompts', 'ask').length, 2);
});
