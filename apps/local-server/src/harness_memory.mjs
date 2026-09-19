import { randomUUID } from 'node:crypto';
import { HarnessMemoryStore } from './harness_memory_store.mjs';
import { captureMemoryProvenance, memoryDigest, memoryError, memoryStaleReason } from './harness_memory_provenance.mjs';
import { compactHarnessConversation } from './harness_context_compaction.mjs';
import { createMemoryAdapter, MEMORY_ADAPTER_CONTRACTS, validateMemoryEndpoint } from './memory_adapters.mjs';

const DEFAULTS = { enabled: true, provider: 'local', endpoint: '', remoteRecallEnabled: false, maxRecallChars: 6000 };
const ACCEPTED = new Set(['validated', 'user_confirmed']);
const STATES = new Set(['suggested', 'validated', 'user_confirmed', 'rejected', 'forgotten']);
const text = (value, name, max = 8000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw memoryError(`${name} must be a nonempty string of at most ${max} characters.`); return value.trim(); };
const budget = (value) => { if (!Number.isInteger(value) || value < 500 || value > 24000) throw memoryError('Recall budget must be 500–24,000 characters.'); return value; };
const recordDigest = (record) => memoryDigest({ graphId: record.graphId, nodeIds: record.nodeIds, content: record.content, kind: record.kind, provenance: record.provenance, validation: record.validation });

export function createHarnessMemory({ repository, engineeringSettings, fetchImpl = globalThis.fetch, environment = process.env }) {
  const store = new HarnessMemoryStore(repository.database);
  const secrets = new Map(); const remoteStatus = new Map(); const syncing = new Set();
  // No environment variables enable remote services or silently acquire credentials.
  void environment;
  const requireGraph = (graphId) => { if (!repository.getGraph(graphId)) throw memoryError('Graph was not found.', 404, 'GRAPH_NOT_FOUND'); };
  const requireItem = (graphId, id) => { requireGraph(graphId); const item = store.get(graphId, id); if (!item) throw memoryError('Memory was not found in this graph.', 404, 'MEMORY_NOT_FOUND'); return item; };
  const settings = (graphId) => ({ ...DEFAULTS, ...store.settings(graphId) });
  const getSettings = (graphId) => {
    requireGraph(graphId); const value = settings(graphId);
    return { ...value, apiKeyConfigured: secrets.has(graphId), remoteStatus: value.provider === 'local' ? 'disabled' : (remoteStatus.get(graphId)?.status || 'configured'), warning: remoteStatus.get(graphId)?.warning || null, contracts: MEMORY_ADAPTER_CONTRACTS };
  };
  const updateSettings = (graphId, patch) => {
    requireGraph(graphId); const old = settings(graphId); const next = { ...old };
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw memoryError('Memory settings must be an object.');
    if (patch.provider !== undefined) { if (!['local', 'hindsight', 'mem0'].includes(patch.provider)) throw memoryError('Select local, hindsight, or mem0.'); next.provider = patch.provider; }
    for (const key of ['enabled', 'remoteRecallEnabled']) if (patch[key] !== undefined) { if (typeof patch[key] !== 'boolean') throw memoryError(`${key} must be boolean.`); next[key] = patch[key]; }
    if (patch.endpoint !== undefined) next.endpoint = patch.endpoint === '' ? '' : validateMemoryEndpoint(patch.endpoint);
    if (patch.maxRecallChars !== undefined) next.maxRecallChars = budget(patch.maxRecallChars);
    if (next.provider !== 'local' && !next.endpoint) throw memoryError('Configure a memory server endpoint before enabling a remote provider.');
    if (patch.apiKey !== undefined && (typeof patch.apiKey !== 'string' || patch.apiKey.length > 8192 || /[\r\n\0]/.test(patch.apiKey))) throw memoryError('API key is invalid.');
    if (old.endpoint !== next.endpoint || old.provider !== next.provider || next.provider === 'local') { secrets.delete(graphId); remoteStatus.delete(graphId); }
    if (patch.apiKey !== undefined) { if (patch.apiKey.trim()) secrets.set(graphId, patch.apiKey.trim()); else secrets.delete(graphId); }
    store.saveSettings(graphId, next); return getSettings(graphId);
  };
  const inspect = (record) => {
    if (record.validation.state === 'forgotten') return record;
    const staleReason = memoryStaleReason(repository, record);
    if (staleReason && ACCEPTED.has(record.validation.state)) {
      record = { ...record, validation: { ...record.validation, previousState: record.validation.state, state: 'stale', reason: staleReason }, updatedAt: new Date().toISOString() };
      record.digest = recordDigest(record); store.put(record);
    }
    return { ...record, current: !staleReason && record.validation.state !== 'stale', staleReason };
  };
  const remember = ({ graphId, nodeIds = [], kind = 'decision', content, provenance = {}, validation = {} }) => {
    requireGraph(graphId); content = text(content, 'Memory content'); kind = text(kind, 'Memory kind', 50);
    const state = validation.state || 'suggested';
    if (!STATES.has(state) || state === 'forgotten') throw memoryError('Memory requires a suggested, user_confirmed, validated, or rejected state.');
    const captured = captureMemoryProvenance(repository, { graphId, nodeIds, provenance });
    if (state === 'validated' && !captured.sources.length && !captured.executions.length) throw memoryError('Evidence validation requires a current source or an accepted execution receipt. Use user_confirmed for a preference or decision.');
    if (kind === 'execution_result' && !captured.executions.length && ACCEPTED.has(state)) throw memoryError('Execution results require an accepted receipt; an AI statement cannot establish success.');
    const time = new Date().toISOString();
    const record = { id: randomUUID(), graphId, nodeIds: captured.nodes.map((node) => node.id), kind, content, provenance: captured, validation: { state, reason: typeof validation.reason === 'string' ? validation.reason.slice(0, 2000) : '', reviewedAt: ACCEPTED.has(state) ? time : null }, revision: 1, createdAt: time, updatedAt: time, sync: null };
    record.digest = recordDigest(record); return store.put(record);
  };
  const update = (graphId, id, patch) => {
    const original = requireItem(graphId, id);
    const changed = patch.content !== undefined || patch.provenance !== undefined || patch.nodeIds !== undefined || patch.kind !== undefined;
    const validation = patch.validation || (changed ? { state: 'suggested' } : original.validation);
    if (validation.state === 'forgotten') return forget(graphId, id).item;
    return repository.transaction(() => {
      const candidate = remember({ ...original, ...patch, graphId, validation });
      store.forget(graphId, candidate.id);
      const updated = { ...candidate, id, revision: original.revision + 1, createdAt: original.createdAt, sync: original.sync ? { ...original.sync, status: 'stale' } : null };
      updated.digest = recordDigest(updated); return store.put(updated);
    });
  };
  const forget = (graphId, id) => {
    const record = requireItem(graphId, id);
    const item = { ...record, validation: { state: 'forgotten', reason: 'Excluded by the user.', reviewedAt: new Date().toISOString() }, updatedAt: new Date().toISOString(), revision: record.revision + 1 };
    item.digest = recordDigest(item); store.put(item);
    return { item, forgotten: true, warning: record.sync || syncing.has(id) ? 'Excluded locally. Any explicitly synced remote copy remains on that server, and pending retention may still complete; its stale digest cannot be recalled into prompts.' : null };
  };
  const list = (graphId) => { requireGraph(graphId); return store.list(graphId).map(inspect); };
  const adapter = (graphId) => { const config = settings(graphId); return createMemoryAdapter({ ...config, secret: secrets.get(graphId), fetchImpl }); };
  const recall = async ({ graphId, nodeIds = [], query = '', maxChars }) => {
    requireGraph(graphId); const config = settings(graphId); const max = budget(maxChars ?? config.maxRecallChars);
    if (typeof query !== 'string' || query.length > 20000) throw memoryError('Recall query must be at most 20,000 characters.');
    captureMemoryProvenance(repository, { graphId, nodeIds });
    const globallyEnabled = engineeringSettings?.get().memory.enabled !== false;
    const candidates = config.enabled && globallyEnabled ? list(graphId).filter((item) => item.current && ACCEPTED.has(item.validation.state) && (!nodeIds.length || !item.nodeIds.length || item.nodeIds.every((id) => nodeIds.includes(id)))) : [];
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])].slice(0, 100);
    const score = (item) => terms.reduce((sum, term) => sum + Number(item.content.toLowerCase().includes(term)), 0);
    let ranked = [...candidates].sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
    let status = config.enabled && globallyEnabled ? 'local' : 'disabled'; let warning = null; let remoteMatchedCount = 0;
    if (config.enabled && globallyEnabled && config.provider !== 'local' && config.remoteRecallEnabled && query.trim()) {
      try {
        const hints = await adapter(graphId).recall({ graphId, query: query.slice(0, 4000) });
        const matched = [...new Set(hints.filter((hint) => hint.graphId === graphId && candidates.some((item) => item.id === hint.id && item.digest === hint.digest && item.sync?.digest === item.digest && item.sync?.provider === config.provider && item.sync?.endpoint === config.endpoint && item.sync?.status === 'synced')).map((hint) => hint.id))];
        remoteMatchedCount = matched.length; ranked.sort((a, b) => Number(matched.includes(b.id)) - Number(matched.includes(a.id))); status = 'ready';
        if (hints.length > matched.length) warning = 'Unmatched, stale, or unvalidated remote suggestions were excluded.';
      } catch { status = 'local_fallback'; warning = 'Remote memory is unavailable. Current local validated memory was used; check the configured endpoint and session credential.'; }
      remoteStatus.set(graphId, { status, warning });
    }
    const items = []; let context = '';
    // Source, node, and validation state may have changed while a provider request was pending.
    ranked = settings(graphId).enabled && engineeringSettings?.get().memory.enabled !== false ? ranked.map((item) => store.get(graphId, item.id)).filter(Boolean).map(inspect).filter((item) => item.current && ACCEPTED.has(item.validation.state)) : [];
    for (const item of ranked) {
      const excerpt = JSON.stringify({ id: item.id, kind: item.kind, content: item.content, validation: item.validation.state, digest: item.digest });
      if (context.length + excerpt.length + 1 > max) continue;
      items.push(item); context += `${context ? '\n' : ''}${excerpt}`;
    }
    return { items, context, digest: memoryDigest(items.map((item) => [item.id, item.digest])), includedCount: items.length, omittedCount: ranked.length - items.length, truncated: items.length < ranked.length, provider: config.provider, status, remoteMatchedCount, warning, boundary: 'Supplemental user-reviewed context, never authorization or independent execution proof.' };
  };
  const sync = async (graphId, id) => {
    const record = inspect(requireItem(graphId, id)); const config = settings(graphId);
    if (!record.current || !ACCEPTED.has(record.validation.state)) throw memoryError('Only current user-reviewed memory can be explicitly synced.');
    if (!config.enabled || config.provider === 'local') throw memoryError('Configure an optional remote provider before syncing.');
    if (syncing.has(id)) throw memoryError('This memory is already syncing.', 409, 'MEMORY_SYNC_ACTIVE');
    if (record.sync?.digest === record.digest && record.sync.provider === config.provider && record.sync.endpoint === config.endpoint && record.sync.status === 'synced') return { item: record, status: 'already_synced' };
    syncing.add(id);
    const finishSync = (deliveryStatus, result = {}, warning = null) => {
      // A provider acknowledges the submitted snapshot, never a later local revision.
      // Local edits, exclusion, provenance invalidation, or deletion remain authoritative.
      const stored = store.get(graphId, id);
      const latest = stored ? inspect(stored) : null;
      const unchanged = latest?.digest === record.digest && latest.current && ACCEPTED.has(latest.validation.state);
      const status = deliveryStatus === 'synced' && !unchanged ? 'stale' : deliveryStatus;
      const item = latest ? store.put({ ...latest, sync: { provider: config.provider, endpoint: config.endpoint, digest: record.digest,
        status, deliveryStatus, ...(deliveryStatus === 'synced' ? { syncedAt: new Date().toISOString() } : {}), ...result } }) : null;
      const changedWarning = !unchanged ? 'The local memory changed while retention was pending. Its current content and review state were preserved; any remote copy belongs to the earlier revision.' : null;
      return { item, status, warning: [warning, changedWarning].filter(Boolean).join(' ') || null };
    };
    try {
      const result = await adapter(graphId).retain(record);
      const finished = finishSync('synced', result);
      remoteStatus.set(graphId, { status: 'ready', warning: finished.warning }); return finished;
    } catch {
      const warning = 'Remote retention was not confirmed. The local record is preserved; check the provider before retrying because a remote write may have completed.';
      const finished = finishSync('unconfirmed', {}, warning);
      remoteStatus.set(graphId, { status: 'local_fallback', warning: finished.warning }); return finished;
    } finally { syncing.delete(id); }
  };
  return { getSettings, updateSettings, list, get: (graphId, id) => inspect(requireItem(graphId, id)), remember, update, forget, recall, sync,
    compactConversation: (value) => compactHarnessConversation({ ...value, repository, store }),
    listCompactions: (graphId) => { requireGraph(graphId); return store.compactions(graphId); }, close: () => secrets.clear() };
}
