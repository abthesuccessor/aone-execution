import { request } from './api';

export type EngineeringProfile = 'poc' | 'mvp' | 'production';
export interface HarnessOptions { enabled: boolean; profile: EngineeringProfile; tokenBudget: number; conventions: string }
export const DEFAULT_HARNESS: HarnessOptions = { enabled: true, profile: 'mvp', tokenBudget: 80000, conventions: 'Prefer small cohesive modules, functional composition, and files under 300 lines where practical. Separate reusable UI components from feature containers. Explain exceptions and avoid unnecessary dependencies.' };
export interface HarnessRun {
  id: string; status: string; profile: string; completedStages: string[]; nextStage?: string; canResume?: boolean; contextDigest?: string;
  handoffs?: Array<{ id?: string; stage?: string; fromAgentId?: string; toAgentId?: string; agentId?: string; agentName?: string; summary?: string; decisions?: string[]; questions?: string[]; assumptions?: string[]; critique?: string[]; alternatives?: string[]; content?: string; output?: unknown; cached?: boolean; [key: string]: unknown }>;
  usage?: Record<string, unknown>; [key: string]: unknown;
}
export interface MemoryRecord {
  id: string; graphId: string; nodeIds: string[]; kind: string; content: string; digest?: string; updatedAt?: string;
  validation: { state: 'suggested' | 'user_confirmed' | 'validated' | 'rejected' | 'stale' | 'forgotten'; reason?: string };
  provenance: Record<string, unknown>;
}
export interface MemorySettings { provider: 'local' | 'hindsight' | 'mem0'; endpoint?: string; remoteRecallEnabled: boolean; apiKeyConfigured?: boolean; [key: string]: unknown }
export interface EnvironmentReport {
  workspacePath?: string; checkedAt: string; summary: string;
  execution?: { providerId: string; ready: boolean; detail: string; setupOptions?: string[] };
  tools: Array<{ id: string; label: string; available: boolean; version?: string; command?: string | string[]; detail?: string; setupOptions?: Array<string | { label?: string; url?: string; command?: string; description?: string }> }>;
}
const path = (graphId: string, suffix = '') => `/api/graphs/${encodeURIComponent(graphId)}/memory${suffix}`;
export const harnessApi = {
  environment: (graphId: string) => request<{ environment: EnvironmentReport }>(`/api/graphs/${encodeURIComponent(graphId)}/environment`),
  adopt: (graphId: string, planId: string, input: { nodeIds: string[]; expectedDraftRevision?: number; requestId: string }) => request(`/api/graphs/${encodeURIComponent(graphId)}/plans/${encodeURIComponent(planId)}/adopt`, { method: 'POST', body: JSON.stringify(input) }),
  memory: (graphId: string) => request<{ items: MemoryRecord[] }>(path(graphId)),
  remember: (graphId: string, input: Record<string, unknown>) => request<{ item: MemoryRecord }>(path(graphId), { method: 'POST', body: JSON.stringify(input) }),
  updateMemory: (graphId: string, id: string, input: Record<string, unknown>) => request<{ item: MemoryRecord }>(path(graphId, `/${encodeURIComponent(id)}`), { method: 'PATCH', body: JSON.stringify(input) }),
  forget: (graphId: string, id: string) => request(path(graphId, `/${encodeURIComponent(id)}`), { method: 'DELETE' }),
  sync: (graphId: string, id: string) => request<{ status?: string; warning?: string }>(path(graphId, `/${encodeURIComponent(id)}/sync`), { method: 'POST', body: '{}' }),
  memorySettings: (graphId: string) => request<{ settings: MemorySettings }>(path(graphId, '/settings')),
  saveMemorySettings: (graphId: string, input: Record<string, unknown>) => request<{ settings: MemorySettings }>(path(graphId, '/settings'), { method: 'PATCH', body: JSON.stringify(input) }),
  compactions: (graphId: string) => request<{ items: Array<{ id: string; summary?: string; content?: string; [key: string]: unknown }> }>(path(graphId, '/compactions')),
};
