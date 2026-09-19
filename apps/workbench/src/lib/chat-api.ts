import { apiUrl } from './api';
import type { HarnessOptions, HarnessRun } from './harness-api';

export type ChatAction = 'discuss' | 'refine' | 'fact-check' | 'develop';
export interface ChatActionRequest { id: string; action: ChatAction; nodeIds: string[]; prompt?: string }
export interface ChatConversation { id: string; graphId: string; title: string; nodeIds: string[]; updatedAt: string }
export interface ChatProposal {
  id: string; graphId: string; baseDraftRevision: number; summary: string; status: 'pending' | 'applied'; appliedRevision?: number;
  nodeUpdates: Array<{ id: string; title?: string; description?: string; context?: string; inputs?: string[]; outputs?: string[]; acceptanceCriteria?: string[] }>;
  nodeAdditions?: Array<{ id: string; title: string; description: string; context?: string; inputs?: string[]; outputs?: string[]; acceptanceCriteria?: string[] }>;
  edgeAdditions: Array<{ id: string; source: string; target: string; type: string; rationale: string }>;
}
export interface ChatContext {
  draftRevision: number; boundary: string; capturedAt: string;
  nodes: Array<{ id: string; title: string; description?: string; context?: string; inputs?: string[]; outputs?: string[]; acceptanceCriteria?: string[] }>;
  evidence: Array<{ id: string; filename: string; sha256: string; excerpts: Array<{ id: string; text: string; truncated: boolean }> }>;
  agents: Array<{ id: string; name: string; promptDigest?: string; configDigest?: string }>;
  skills: Array<{ id: string; name: string; contentDigest: string }>;
}
export interface ChatMessage {
  harness?: HarnessRun;
  id: string; conversationId: string; role: 'user' | 'assistant'; content: string;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'; action: ChatAction; providerId?: string; model?: string;
  context: ChatContext; createdAt: string; stale?: boolean; error?: string; durationMs?: number;
  activities?: Array<{ kind: string; label: string; status: string; at: string; exitCode?: number }>;
  usage?: Record<string, number>; claims?: Array<{ text: string; status: string; reasoning: string; evidenceIds: string[] }>;
  citations?: Array<{ id: string; sourceId: string; filename: string; text: string; location?: Record<string, unknown> }>;
  proposal?: ChatProposal; proposalError?: string; formatWarning?: string;
}
export interface ChatTemplate { id: string; name: string; action: ChatAction; prompt: string }
export interface ChatSource { id: string; nodeId?: string; filename: string; sha256: string; parseStatus: string; chunkCount: number }
interface ChatStreamEvent { message?: ChatMessage; text?: string; activity?: NonNullable<ChatMessage['activities']>[number]; usage?: Record<string, number>; run?: HarnessRun }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(data?.error?.message || `Chat request failed (${response.status}).`);
  }
  return response.json() as Promise<T>;
}
const path = (graphId: string, suffix = '') => `/api/graphs/${encodeURIComponent(graphId)}/chat${suffix}`;
export const chatApi = {
  list: (graphId: string) => request<{ items: ChatConversation[] }>(path(graphId)),
  create: (graphId: string, nodeIds: string[]) => request<{ conversation: ChatConversation }>(path(graphId), { method: 'POST', body: JSON.stringify({ nodeIds }) }),
  get: (graphId: string, id: string) => request<{ conversation: ChatConversation; messages: ChatMessage[] }>(path(graphId, `/${id}`)),
  context: (graphId: string) => request<{ draftRevision: number; sources: ChatSource[]; nodes: Array<{ id: string; title: string }> }>(path(graphId, '/context')),
  templates: (graphId: string) => request<{ items: ChatTemplate[] }>(path(graphId, '/templates')),
  stop: (graphId: string, id: string) => request<{ status: string }>(path(graphId, `/${id}/stop`), { method: 'POST', body: '{}' }),
  apply: (graphId: string, id: string) => request<{ proposal: ChatProposal }>(path(graphId, `/proposals/${id}/apply`), { method: 'POST', body: '{}' }),
  async send(graphId: string, id: string, input: { content: string; providerId: string; action: ChatAction; sourceIds: string[]; templateId?: string; engineeringHarness?: HarnessOptions & { resumeRunId?: string } }, onEvent: (type: string, data: ChatStreamEvent) => void, signal?: AbortSignal) {
    const response = await fetch(apiUrl(path(graphId, `/${id}/messages`)), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(data?.error?.message || `Chat request failed (${response.status}).`);
    }
    if (!response.body) throw new Error('Chat response stream is unavailable.');
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let doneEvent = false;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const type = block.split('\n').find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
          const json = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!json) continue;
          onEvent(type, JSON.parse(json) as ChatStreamEvent); if (type === 'done') doneEvent = true;
        }
      }
    } finally { reader.releaseLock(); }
    if (!doneEvent) throw new Error('Chat connection ended before a final status. Reload this conversation to inspect the saved response.');
  },
};
