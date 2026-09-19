import { request } from './api';

export type CompressionLevel = 'off' | 'lite' | 'full' | 'ultra';
export interface EngineeringSettings {
  revision: number;
  harness: { compression: CompressionLevel };
  context: { compactionEnabled: boolean; maxCharacters: number };
  memory: { enabled: boolean };
  skills: { disabledIds: string[] };
}

export const engineeringSettingsApi = {
  get: (signal?: AbortSignal) => request<EngineeringSettings>('/api/engineering/settings', { signal }),
  save: (settings: EngineeringSettings) => {
    const { revision, ...fields } = settings;
    return request<EngineeringSettings>('/api/engineering/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: revision, ...fields }),
    });
  },
};
