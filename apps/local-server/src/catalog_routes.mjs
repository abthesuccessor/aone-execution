import { randomUUID } from 'node:crypto';
import { ENGINEERING_DOMAINS, createContentDigest, createPromptRevision, revisePrompt } from './agents.mjs';
import { parseSkillMetadata } from './skills.mjs';

export const DEFAULT_ACTION_PROMPTS = [
  { id: 'ask', name: 'Ask', description: 'Discuss the selected graph context.', content: 'Answer the question using the selected nodes and attached evidence. Distinguish observations, assumptions, and unknowns. Cite relevant sources. Explain proposed changes before applying them.' },
  { id: 'refine', name: 'Refine', description: 'Propose precise changes to a node or selection.', content: 'Refine the selected nodes into clear objectives, constraints, acceptance criteria, and relationships. Preserve intent. Return a reviewable proposal and explain each change with evidence. Do not apply changes automatically.' },
  { id: 'fact-check', name: 'Fact-check', description: 'Check claims against available evidence.', content: 'Critically fact-check the claims in the selected nodes. For each claim report supported, contradicted, or unverified, cite the evidence, and identify what further verification is needed. Never treat an AI response as proof.' },
  { id: 'develop', name: 'Develop', description: 'Plan a bounded implementation.', content: 'Develop a bounded implementation plan for the selected nodes. State affected files, dependencies, acceptance criteria, verification steps, and limits. Cite evidence. Never claim tests or validation passed without a recorded receipt. Propose changes for review.' },
];

const DENIED = ['approval.self-grant', 'policy.modify', 'receipt.fabricate', 'secret.read-raw', 'workspace.write-unscoped'];
export function createCatalogRoutes({ repository, skills, currentProviders = () => [], readJson, json, HttpError }) {
  skills.setRepository(repository);
  for (const seed of DEFAULT_ACTION_PROMPTS) {
    if (!repository.getCatalogRevision('prompts', seed.id)) repository.saveCatalogRevision('prompts', seed.id, { ...seed, enabled: true, archived: false });
  }
  const fail = (status, code, message) => { throw new HttpError(status, code, message); };
  const string = (value, name, maximum = 200, required = true) => {
    if (typeof value !== 'string' || value.length > maximum || value.includes('\0') || (required && !value.trim())) fail(422, 'VALIDATION_ERROR', `${name} must contain ${required ? '1' : '0'} to ${maximum} characters.`);
    return value.trim();
  };
  const strings = (value, name) => {
    if (!Array.isArray(value) || value.length > 128) fail(422, 'VALIDATION_ERROR', `${name} must be an array of at most 128 strings.`);
    return [...new Set(value.map((item) => string(item, name, 200)))];
  };
  const expected = (body, currentDigest) => {
    if (!Object.hasOwn(body, 'expectedDigest')) fail(422, 'EXPECTED_DIGEST_REQUIRED', 'Include the configuration digest you edited.');
    if (body.expectedDigest !== currentDigest) fail(409, 'CATALOG_CHANGED', 'This configuration changed. Reload its latest revision before saving.');
  };
  const envelope = (revision) => ({ ...revision.data, id: revision.id, configVersion: revision.version, configDigest: revision.digest, updatedAt: revision.createdAt });
  const domains = () => [...ENGINEERING_DOMAINS, ...repository.listCatalogRevisions('domains').map(envelope)];

  async function handle({ request, response, path, method, cors }) {
    if (!path.startsWith('/api/catalog/')) return false;
    const match = path.match(/^\/api\/catalog\/(agents|skills|prompts|domains)(?:\/([^/]+))?(?:\/(history))?$/);
    if (!match) fail(404, 'CATALOG_ROUTE_NOT_FOUND', 'Catalog route was not found.');
    const [, kind, encodedId, action] = match;
    const id = encodedId ? decodeURIComponent(encodedId) : null;
    const send = (status, value) => { json(response, status, value, cors); return true; };
    try {
      if (action === 'history' && method === 'GET') {
        const revisions = repository.catalogHistory(kind, id);
        const promptRevisions = kind === 'agents' ? repository.listAgentPrompts(id) : undefined;
        return send(200, { items: revisions, promptRevisions });
      }
      if (kind === 'skills') await skills.scan();
      if (!id && method === 'GET') {
        if (kind === 'agents') return send(200, { items: repository.listAgents(), domains: domains(), providers: currentProviders() });
        if (kind === 'skills') return send(200, { items: skills.items });
        if (kind === 'domains') return send(200, { items: domains() });
        return send(200, { items: repository.listCatalogRevisions(kind).map(envelope) });
      }
      const current = id ? kind === 'agents' ? repository.getAgent(id) : kind === 'skills' ? skills.items.find((item) => item.id === id) : repository.getCatalogRevision(kind, id) : null;
      if (id && !current) fail(404, 'CATALOG_ITEM_NOT_FOUND', 'This catalog item was not found.');
      if (id && method === 'GET') {
        if (kind === 'skills') return send(200, { item: { ...current, content: await skills.readCatalogContent(id) } });
        return send(200, { item: kind === 'agents' ? current : envelope(current) });
      }
      if ((id && method !== 'PATCH') || (!id && method !== 'POST')) fail(405, 'METHOD_NOT_ALLOWED', 'Use POST to create or PATCH to save a new revision.');
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(422, 'VALIDATION_ERROR', 'A JSON object is required.');
      const existingRevision = id ? repository.getCatalogRevision(kind, id) : null;
      if (id) expected(body, kind === 'agents' ? current.configDigest : existingRevision?.digest ?? null);
      const previous = existingRevision?.data ?? {};
      const newId = id ?? (kind === 'agents' ? string(body.slug ?? `agent-${randomUUID().slice(0, 8)}`, 'slug', 64) : `${kind.slice(0, -1)}-${randomUUID().slice(0, 12)}`);
      if (kind === 'agents') {
        if (!/^[a-z][a-z0-9-]{2,63}$/.test(newId)) fail(422, 'VALIDATION_ERROR', 'Agent slug must be a lowercase kebab-case identifier.');
        if (!id && repository.getAgent(newId)) fail(409, 'AGENT_EXISTS', 'An agent with this slug already exists.');
        const name = string(body.name ?? current?.name, 'name');
        const domain = string(body.domain ?? current?.domain, 'domain');
        if (!domains().some((item) => item.id === domain)) fail(422, 'UNKNOWN_DOMAIN', 'Choose a catalog domain or create a custom domain first.');
        const description = string(body.description ?? current?.description ?? '', 'description', 2000, false);
        const capabilities = strings(body.capabilities ?? current?.capabilities ?? [], 'capabilities');
        const allowedToolClasses = strings(body.allowedToolClasses ?? current?.toolPolicy?.allowedToolClasses ?? [], 'allowedToolClasses');
        const skillIds = strings(body.skillIds ?? current?.skillIds ?? [], 'skillIds');
        await skills.scan();
        const validation = skills.validateSelection(skillIds);
        if (!validation.valid) fail(422, 'INVALID_SKILL_SELECTION', `Unavailable skills: ${[...validation.missing, ...validation.invalid].join(', ')}`);
        const providerId = string(body.providerId ?? current?.providerId ?? '', 'providerId', 200, false);
        if (providerId && !currentProviders().some((provider) => provider.id === providerId)) fail(422, 'UNKNOWN_PROVIDER', 'Choose a configured provider.');
        const model = string(body.model ?? current?.model ?? '', 'model', 200, false);
        const status = body.status ?? current?.status ?? 'ACTIVE';
        if (!['ACTIVE', 'DISABLED'].includes(status)) fail(422, 'VALIDATION_ERROR', 'Agent status must be ACTIVE or DISABLED.');
        const archived = body.archived ?? current?.archived ?? false;
        if (typeof archived !== 'boolean') fail(422, 'VALIDATION_ERROR', 'archived must be a boolean.');
        const promptText = string(body.prompt ?? current?.currentPrompt.prompt, 'prompt', 20000);
        if (id && body.expectedPromptDigest !== current.currentPrompt.digest) fail(409, 'PROMPT_CHANGED', 'The prompt changed. Reload before saving.');
        const promptRevision = id ? (promptText === current.currentPrompt.prompt ? null : revisePrompt({ agentId: id, version: current.currentPrompt.version, parentDigest: current.currentPrompt.parentDigest, text: current.currentPrompt.prompt, contentDigest: current.currentPrompt.digest }, promptText)) : createPromptRevision({ agentId: newId, text: promptText });
        const version = (existingRevision?.version ?? 0) + 1;
        const corePolicy = { id: `${newId}-policy`, agentId: newId, version, authority: 'proposal-or-bounded-execution', allowedCapabilities: capabilities, allowedToolClasses, deniedCapabilities: [...new Set([...DENIED, ...(current?.toolPolicy?.deniedCapabilities ?? [])])] };
        const data = { name, domain, description, capabilities, providerId, model, skillIds, status, archived, toolPolicy: { ...corePolicy, contentDigest: createContentDigest(corePolicy) } };
        repository.transaction(() => {
          if (!id) repository.createAgent({ id: newId, slug: newId, ...data, prompt: promptRevision.text, promptDigest: promptRevision.contentDigest });
          else if (promptRevision) repository.createAgentPromptRevision(id, { prompt: promptRevision.text, outputSchema: current.currentPrompt.outputSchema, digest: promptRevision.contentDigest, expectedCurrentDigest: current.currentPrompt.digest });
          repository.saveCatalogRevision(kind, newId, data, existingRevision?.digest ?? null);
        });
        return send(id ? 200 : 201, { item: repository.getAgent(newId) });
      }
      if (kind === 'skills') {
        const name = string(body.name ?? current?.name, 'name', 100);
        const description = string(body.description ?? current?.description, 'description', 1024);
        const content = string(body.content ?? await skills.readCatalogContent(id), 'content', 131072);
        const parsed = parseSkillMetadata(content, 'custom/SKILL.md');
        const relativePath = current?.sourceRoot === 'agent-skill-catalog' ? current.relativePath : `custom/${parsed.name}/SKILL.md`;
        const validation = parseSkillMetadata(content, relativePath);
        if (!validation.valid) fail(422, 'INVALID_SKILL', validation.validationErrors.join(' '));
        const enabled = body.enabled ?? current?.enabled ?? true;
        const archived = body.archived ?? current?.archived ?? false;
        if (typeof enabled !== 'boolean' || typeof archived !== 'boolean') fail(422, 'VALIDATION_ERROR', 'enabled and archived must be booleans.');
        repository.saveCatalogRevision(kind, newId, { name, description, content, enabled, archived, relativePath,
          basePackageDigest: existingRevision ? previous.basePackageDigest : current?.packageDigest ?? null,
          basePackageFiles: existingRevision ? previous.basePackageFiles : current?.packageFiles ?? [],
        }, existingRevision?.digest ?? null);
        await skills.scan();
        return send(id ? 200 : 201, { item: { ...skills.items.find((item) => item.id === newId), content } });
      }
      const name = string(body.name ?? previous.name, 'name');
      const description = string(body.description ?? previous.description ?? '', 'description', 2000, false);
      const content = kind === 'prompts' ? string(body.content ?? previous.content, 'content', 20000) : undefined;
      const enabled = body.enabled ?? previous.enabled ?? true;
      const archived = body.archived ?? previous.archived ?? false;
      if (typeof enabled !== 'boolean' || typeof archived !== 'boolean') fail(422, 'VALIDATION_ERROR', 'enabled and archived must be booleans.');
      const revision = repository.saveCatalogRevision(kind, newId, { name, description, ...(content === undefined ? {} : { content }), enabled, archived }, existingRevision?.digest ?? null);
      return send(id ? 200 : 201, { item: envelope(revision) });
    } catch (error) {
      if (error.code === 'CATALOG_CHANGED' || error.code === 'PROMPT_CHANGED') throw new HttpError(409, error.code, error.message);
      if (error.code === 'INVALID_AGENT_PROMPT') throw new HttpError(422, error.code, error.message);
      throw error;
    }
  }
  return { handle };
}
