import { apiUrl, ApiError } from './api';

export type CatalogSection = 'agents' | 'skills' | 'prompts';
export interface CatalogItem {
  id: string;
  name: string;
  description: string;
  configVersion?: number;
  configDigest?: string | null;
  content?: string;
  domain?: string;
  status?: 'ACTIVE' | 'DISABLED';
  enabled?: boolean;
  archived?: boolean;
  valid?: boolean;
  validationErrors?: string[];
  capabilities?: string[];
  providerId?: string;
  model?: string;
  skillIds?: string[];
  toolPolicy?: { allowedToolClasses?: string[] };
  currentPrompt?: { prompt: string; digest: string; version: number };
  packageDigest?: string;
  contentDigest?: string;
  sourceRoot?: string;
  relativePath?: string;
  sourceProvenance?: Array<{ source: 'codex' | 'agents'; path: string }>;
  packageFiles?: Array<{ path: string; sha256: string; size: number }>;
}
export interface CatalogDomain { id: string; name: string }
export interface CatalogProvider { id: string; name: string; capabilities?: string[]; profile?: { model?: string } }
export interface CatalogRevision { version: number; digest: string; createdAt: string; data: Record<string, unknown> }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = apiUrl(path);
  const response = await fetch(url, { ...init, credentials: url.startsWith('/') ? 'same-origin' : 'omit', headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const payload = await response.json();
  if (!response.ok) throw new ApiError(typeof payload.error === 'string' ? payload.error : payload.error?.message ?? 'Catalog request failed.', response.status, payload.error?.code);
  return payload as T;
}

export const catalogApi = {
  list: async (section: CatalogSection) => {
    const result = await request<{ items: CatalogItem[]; domains?: CatalogDomain[]; providers?: Array<Omit<CatalogProvider, 'name'> & { name?: string; label?: string }> }>(`/api/catalog/${section}`);
    return {
      ...result,
      providers: result.providers?.map((provider): CatalogProvider => ({
        ...provider,
        name: provider.name?.trim() || provider.label?.trim() || provider.id,
      })),
    };
  },
  get: (section: CatalogSection, id: string) => request<{ item: CatalogItem }>(`/api/catalog/${section}/${encodeURIComponent(id)}`),
  save: (section: CatalogSection, id: string | undefined, body: Record<string, unknown>) => request<{ item: CatalogItem }>(`/api/catalog/${section}${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) }),
  history: (section: CatalogSection, id: string) => request<{ items: CatalogRevision[] }>(`/api/catalog/${section}/${encodeURIComponent(id)}/history`),
  createDomain: (name: string) => request<{ item: CatalogDomain }>('/api/catalog/domains', { method: 'POST', body: JSON.stringify({ name, description: '' }) }),
};
