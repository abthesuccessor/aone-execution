export function createHarnessMemoryRoutes({ memory, repository, readJson, json, HttpError }) {
  return {
    async handle({ request, response, path, method, cors }) {
      const match = path.match(/^\/api\/graphs\/([^/]+)\/memory(?:\/(.*))?$/);
      if (!match) return false;
      const graphId = decodeURIComponent(match[1]);
      if (!repository.getGraph(graphId)) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
      const parts = (match[2] || '').split('/').filter(Boolean).map(decodeURIComponent);
      const send = (status, value) => { json(response, status, value, cors); return true; };
      try {
        if (!parts.length && method === 'GET') return send(200, { items: memory.list(graphId) });
        if (!parts.length && method === 'POST') return send(201, { item: memory.remember({ ...await readJson(request), graphId }) });
        if (parts[0] === 'settings' && parts.length === 1 && method === 'GET') return send(200, { settings: memory.getSettings(graphId) });
        if (parts[0] === 'settings' && parts.length === 1 && method === 'PATCH') return send(200, { settings: memory.updateSettings(graphId, await readJson(request)) });
        if (parts[0] === 'recall' && parts.length === 1 && method === 'POST') return send(200, await memory.recall({ ...await readJson(request), graphId }));
        if (parts[0] === 'compactions' && parts.length === 1 && method === 'GET') return send(200, { items: memory.listCompactions(graphId) });
        if (parts[0] === 'compact' && parts.length === 1 && method === 'POST') {
          const body = await readJson(request);
          const exists = repository.database.hasTable('chat_messages');
          const messages = exists ? repository.database.prepare("SELECT id,role,content,status FROM chat_messages WHERE conversation_id=? AND status='completed' ORDER BY sequence").all(body.conversationId) : [];
          return send(201, { compaction: memory.compactConversation({ graphId, conversationId: body.conversationId, messages, maxChars: body.maxChars }) });
        }
        if (parts.length === 1 && method === 'GET') return send(200, { item: memory.get(graphId, parts[0]) });
        if (parts.length === 1 && method === 'PATCH') return send(200, { item: memory.update(graphId, parts[0], await readJson(request)) });
        if (parts.length === 1 && method === 'DELETE') return send(200, memory.forget(graphId, parts[0]));
        if (parts.length === 2 && parts[1] === 'sync' && method === 'POST') return send(200, await memory.sync(graphId, parts[0]));
        throw new HttpError(404, 'MEMORY_ROUTE_NOT_FOUND', 'Memory route was not found.');
      } catch (error) { if (error.status && error.code) throw new HttpError(error.status, error.code, error.message); throw error; }
    },
    close: () => memory.close(),
  };
}
