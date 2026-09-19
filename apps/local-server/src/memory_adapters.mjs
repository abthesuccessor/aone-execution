import { memoryError } from './harness_memory_provenance.mjs';

// Protocol contracts inspected at these exact upstream commits. No upstream source is vendored.
export const MEMORY_ADAPTER_CONTRACTS = {
  hindsight: { revision: '4cc131c0b238c8f206def60804d7b6591f6a45e7', source: 'https://github.com/vectorize-io/hindsight/blob/4cc131c0b238c8f206def60804d7b6591f6a45e7/hindsight-docs/static/openapi.json', docs: 'https://hindsight.vectorize.io/api-reference' },
  mem0: { revision: 'c7ee362aff94a369af70f13f2b4f853f6793ff4c', source: 'https://github.com/mem0ai/mem0/blob/c7ee362aff94a369af70f13f2b4f853f6793ff4c/server/main.py', docs: 'https://docs.mem0.ai/open-source/features/rest-api' },
};
export function validateMemoryEndpoint(value) {
  let url; try { url = new URL(value); } catch { throw memoryError('Enter an absolute memory server URL.'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw memoryError('Memory endpoints require HTTPS or loopback HTTP, with no credentials, query, or fragment in the URL.');
  return url.href.replace(/\/$/, '');
}
async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw memoryError('Memory provider returned no response body.', 502, 'MEMORY_PROVIDER_FAILED');
  let total = 0; const chunks = [];
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > 512000) throw memoryError('Memory response exceeded 512 KB.', 502, 'MEMORY_PROVIDER_FAILED'); chunks.push(value); }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw memoryError('Memory provider returned invalid JSON.', 502, 'MEMORY_PROVIDER_FAILED'); }
}
export function createMemoryAdapter({ provider, endpoint, secret, fetchImpl = globalThis.fetch }) {
  if (!MEMORY_ADAPTER_CONTRACTS[provider]) throw memoryError('Unsupported memory provider.');
  const base = validateMemoryEndpoint(endpoint);
  const post = async (path, body, timeoutMs = 5000) => {
    const headers = { 'Content-Type': 'application/json' };
    if (secret) headers[provider === 'mem0' ? 'X-API-Key' : 'Authorization'] = provider === 'mem0' ? secret : `Bearer ${secret}`;
    const response = await fetchImpl(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw memoryError(`Memory provider returned HTTP ${response.status}.`, 502, 'MEMORY_PROVIDER_FAILED'); }
    return boundedJson(response);
  };
  const bank = (graphId) => `/v1/default/banks/${encodeURIComponent(`ege-${graphId}`)}`;
  return {
    async recall({ graphId, query }) {
      const body = provider === 'hindsight'
        ? await post(`${bank(graphId)}/memories/recall`, { query, budget: 'low', max_tokens: 1600, types: ['world', 'experience'], tags: [`ege:${graphId}`], tags_match: 'all' })
        : await post('/search', { query, filters: { user_id: `ege-${graphId}` }, top_k: 20 });
      const results = Array.isArray(body) ? body : body.results;
      if (!Array.isArray(results)) throw memoryError('Memory provider returned an unsupported recall shape.', 502, 'MEMORY_PROVIDER_FAILED');
      // Never return provider-generated text for injection. These are matching hints only.
      return results.slice(0, 50).map((item) => ({ id: item?.metadata?.ege_memory_id, graphId: item?.metadata?.ege_graph_id, digest: item?.metadata?.ege_digest }));
    },
    async retain(record) {
      const metadata = { ege_memory_id: record.id, ege_graph_id: record.graphId, ege_digest: record.digest };
      if (provider === 'hindsight') {
        const result = await post(`${bank(record.graphId)}/memories`, { async: false, items: [{ content: record.content, document_id: `ege-memory-${record.id}`, metadata, tags: [`ege:${record.graphId}`] }] }, 30000);
        if (result.success !== true || result.async !== false) throw memoryError('Hindsight did not confirm synchronous retention.', 502, 'MEMORY_PROVIDER_FAILED');
        return { remoteIds: [`ege-memory-${record.id}`] };
      }
      const result = await post('/memories', { messages: [{ role: 'user', content: record.content }], user_id: `ege-${record.graphId}`, metadata, infer: false }, 30000);
      const results = Array.isArray(result) ? result : result.results;
      if (!Array.isArray(results) || !results.length || results.some((item) => typeof item?.id !== 'string')) throw memoryError('Mem0 did not return retained memory IDs.', 502, 'MEMORY_PROVIDER_FAILED');
      return { remoteIds: results.slice(0, 100).map((item) => item.id) };
    },
  };
}
