import { apiUrl, ApiError } from './api';
export interface TerminalSession { id: string; graphId: string; workspacePath: string; status: 'starting' | 'running' | 'stopping' | 'exited' | 'failed'; startedAt: string; endedAt?: string; exitCode?: number; signal?: string; error?: string; lastSequence: number; firstSequence: number; output: string; truncated: boolean }
async function request<T>(path: string, body?: Record<string, unknown>) {
  const url = apiUrl(path);
  const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, credentials: url.startsWith('/') ? 'same-origin' : 'omit', body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(typeof payload.error === 'string' ? payload.error : payload.error?.message ?? 'Terminal request failed.', response.status, payload.error?.code);
  return payload as T;
}
export const terminalApi = {
  get: (graphId: string) => request<{ session: TerminalSession | null }>(`/api/graphs/${encodeURIComponent(graphId)}/terminal`),
  open: (graphId: string) => request<{ session: TerminalSession }>(`/api/graphs/${encodeURIComponent(graphId)}/terminal`, {}),
  input: (id: string, input: string) => request<{ accepted: boolean }>(`/api/terminals/${encodeURIComponent(id)}/input`, { input }),
  interrupt: (id: string) => request<{ session: TerminalSession }>(`/api/terminals/${encodeURIComponent(id)}/interrupt`, {}),
  stop: (id: string) => request<{ session: TerminalSession }>(`/api/terminals/${encodeURIComponent(id)}/stop`, {}),
  eventsUrl: (id: string) => apiUrl(`/api/terminals/${encodeURIComponent(id)}/events`),
};
