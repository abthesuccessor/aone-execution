import { createHash } from 'node:crypto';

export const memoryDigest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const memoryError = (message, status = 422, code = 'MEMORY_VALIDATION_ERROR') => Object.assign(new Error(message), { status, code });
export const nodeMemoryDigest = ({ position, status, ...node }) => memoryDigest(node);
export const messageMemoryDigest = (message) => memoryDigest({ id: message.id, role: message.role, content: message.content, status: message.status });
const pins = (value, name) => {
  if (!Array.isArray(value) || value.length > 100 || value.some((item) => !item || typeof item.id !== 'string' || !item.id || item.id.length > 200)) throw memoryError(`${name} must contain at most 100 valid provenance references.`);
  return [...new Map(value.map((item) => [item.id, item])).values()].sort((a, b) => a.id.localeCompare(b.id));
};
export function readMemoryMessage(repository, id) {
  if (!repository.database.hasTable('chat_messages')) return null;
  return repository.database.prepare('SELECT m.id,m.role,m.content,m.status,m.conversation_id AS "conversationId",c.graph_id AS "graphId",c.node_ids_json AS "nodeIdsJson" FROM chat_messages m JOIN chat_conversations c ON c.id=m.conversation_id WHERE m.id=?').get(id) || null;
}
export function captureMemoryProvenance(repository, { graphId, nodeIds = [], provenance = {} }) {
  const draft = repository.getLatestDraft(graphId);
  if (!repository.getGraph(graphId) || !draft) throw memoryError('Graph and saved draft are required.', 404, 'GRAPH_NOT_FOUND');
  if (!Array.isArray(nodeIds) || nodeIds.length > 100 || nodeIds.some((id) => typeof id !== 'string')) throw memoryError('nodeIds must contain at most 100 IDs.');
  const nodes = [...new Set(nodeIds)].sort().map((id) => {
    const node = draft.nodes.find((item) => item.id === id);
    if (!node) throw memoryError('A memory node is outside this graph.');
    return { id, sha256: nodeMemoryDigest(node) };
  });
  const assertHash = (pin, sha256) => { if (pin.sha256 && pin.sha256 !== sha256) throw memoryError('A provenance hash changed. Review current evidence before remembering it.', 409, 'MEMORY_PROVENANCE_STALE'); return sha256; };
  const sources = pins(provenance.sources || [], 'sources').map((pin) => {
    const source = repository.getSource(pin.id);
    if (!source || source.graphId !== graphId || source.parseStatus !== 'PARSED' || (nodeIds.length && source.nodeId && !nodeIds.includes(source.nodeId))) throw memoryError('A source is outside this memory scope or has not been parsed.');
    return { id: pin.id, sha256: assertHash(pin, source.sha256), nodeId: source.nodeId };
  });
  const messages = pins(provenance.messages || [], 'messages').map((pin) => {
    const message = readMemoryMessage(repository, pin.id);
    const messageNodes = message ? JSON.parse(message.nodeIdsJson) : [];
    if (!message || message.graphId !== graphId || (nodeIds.length && messageNodes.some((id) => !nodeIds.includes(id)))) throw memoryError('A message is outside this memory scope.');
    if (message.status !== 'completed') throw memoryError('Only completed messages can be memory provenance.');
    return { id: pin.id, sha256: assertHash(pin, messageMemoryDigest(message)), conversationId: message.conversationId, role: message.role };
  });
  const executions = pins(provenance.executions || [], 'executions').map((pin) => {
    const execution = repository.getExecution(pin.id);
    const artifact = pin.artifactId ? repository.getArtifact(pin.artifactId) : null;
    let receipt; try { receipt = JSON.parse(artifact?.content || 'null'); } catch { receipt = null; }
    if (!execution || execution.graphId !== graphId || execution.status !== 'COMPLETED' || !artifact || artifact.executionId !== execution.id || receipt?.result !== 'PASS' || receipt?.planId !== execution.planId || receipt?.nodeId !== artifact.nodeId || receipt?.verificationMode !== 'CODEX_CLI' || receipt?.changedFilesMatch !== true || !execution.completedNodeIds.includes(artifact.nodeId)) throw memoryError('Execution memory requires a completed run and an accepted PASS receipt; failed runs cannot self-validate.');
    if (nodeIds.length) {
      const plan = repository.getPlan?.(execution.planId)?.plan;
      const step = plan?.steps?.find((node) => node.nodeId === artifact.nodeId);
      const linked = step?.traceability?.intentNodeIds || step?.sourceIntentNodeIds || [artifact.nodeId];
      if (!linked.some((id) => nodeIds.includes(id))) throw memoryError('Execution receipt is outside this memory node scope.');
    }
    return { id: execution.id, artifactId: artifact.id, nodeId: artifact.nodeId, sha256: assertHash(pin, memoryDigest(artifact.content)), planId: execution.planId };
  });
  return { graphId, draftRevision: draft.revision, nodes, sources, messages, executions, origin: ['user', 'assistant', 'execution'].includes(provenance.origin) ? provenance.origin : 'user' };
}
export function memoryStaleReason(repository, record) {
  try {
    const current = captureMemoryProvenance(repository, record);
    if (memoryDigest(current.nodes) !== memoryDigest(record.provenance.nodes)) return 'A referenced node changed or was removed.';
    return null;
  } catch (error) { return error.message; }
}
