import { memoryDigest, memoryError, messageMemoryDigest, readMemoryMessage } from './harness_memory_provenance.mjs';

// Extracts remain attributable task data. A matching word is not an accepted decision.
export function compactHarnessConversation({ repository, store, graphId, conversationId, messages, maxChars = 12000 }) {
  const conversation = repository.database.hasTable('chat_conversations')
    ? repository.database.prepare('SELECT graph_id AS "graphId" FROM chat_conversations WHERE id=?').get(conversationId) : null;
  if (!conversation || conversation.graphId !== graphId) throw memoryError('Conversation was not found in this graph.', 404, 'CHAT_NOT_FOUND');
  if (!Array.isArray(messages) || messages.length > 10000) throw memoryError('Compaction requires at most 10,000 preserved messages.');
  if (!Number.isInteger(maxChars) || maxChars < 500 || maxChars > 48000) throw memoryError('Compaction budget must be 500–48,000 characters.');
  const seen = new Set();
  const originals = messages.map((message) => {
    const saved = readMemoryMessage(repository, message.id);
    if (!saved || saved.graphId !== graphId || saved.conversationId !== conversationId || seen.has(saved.id) || saved.status !== 'completed' || saved.content !== message.content || saved.role !== message.role) throw memoryError('Compaction only accepts distinct, unchanged, completed messages from this conversation.');
    seen.add(saved.id); return saved;
  });
  const originalChars = originals.reduce((sum, message) => sum + message.content.length, 0);
  const candidates = originals.length > 1000 ? [originals[0], ...originals.slice(-999)] : originals;
  const messagePins = candidates.map((message) => ({ id: message.id, sha256: messageMemoryDigest(message), role: message.role, status: message.status }));
  const decisions = []; const openQuestions = []; const extracts = [];
  for (const message of candidates) {
    const sha256 = messageMemoryDigest(message);
    for (const match of message.content.matchAll(/[^\n]+/g)) {
      const excerpt = match[0]; const reference = { messageId: message.id, sha256, offset: match.index, length: excerpt.length, classification: 'candidate' };
      if (/\b(decid(?:e|ed|ing)|chosen|prefer|must|constraint|use|approved)\b/i.test(excerpt) && decisions.length < 60) decisions.push(reference);
      if ((excerpt.includes('?') || /\b(unknown|open question|undecided|clarify)\b/i.test(excerpt)) && openQuestions.length < 60) openQuestions.push(reference);
    }
  }
  // Initial intent plus recent turns are predictable and reviewable. No extra LLM request.
  const order = candidates.length > 1 ? [candidates[0], ...candidates.slice(1).reverse()] : candidates;
  let remaining = maxChars;
  for (const message of order) {
    const header = `[${message.id} ${message.role}; completed]\n`;
    const available = Math.min(remaining - header.length - 2, Math.max(200, Math.floor(maxChars / Math.min(12, candidates.length || 1))));
    if (available < 40) continue;
    const text = message.content.slice(0, available);
    extracts.push({ messageId: message.id, text: header + text, truncated: text.length < message.content.length });
    remaining -= header.length + text.length + 2;
  }
  extracts.sort((a, b) => candidates.findIndex((item) => item.id === a.messageId) - candidates.findIndex((item) => item.id === b.messageId));
  const summary = extracts.map((item) => item.text).join('\n\n');
  const extractedIds = new Set(extracts.map((item) => item.messageId));
  const manifest = {
    graphId, conversationId, method: 'extractive-v1', summary, decisions, openQuestions, messagePins,
    originalChars, compactedChars: summary.length, originalMessageCount: originals.length,
    includedMessageCount: extracts.length, omittedMessageCount: originals.length - extracts.length,
    truncated: originals.length > extracts.length || extracts.some((item) => item.truncated),
    omittedManifestCount: originals.length - candidates.length,
    boundary: 'Derived verbatim excerpts; decision and question labels are candidates, not approvals or verified facts. Original messages remain unchanged.',
  };
  // All originals contribute to identity, including messages omitted from bounded manifests.
  manifest.originalDigest = memoryDigest(originals.map((message) => [message.id, messageMemoryDigest(message)]));
  manifest.digest = memoryDigest({ ...manifest, extractedMessageIds: [...extractedIds] });
  return store.compact(manifest);
}
