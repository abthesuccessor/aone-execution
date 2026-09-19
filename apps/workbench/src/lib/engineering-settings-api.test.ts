import { afterEach, expect, it, vi } from 'vitest';
import { configureApiOrigin } from './api';
import { engineeringSettingsApi, type EngineeringSettings } from './engineering-settings-api';

afterEach(() => { configureApiOrigin(); vi.unstubAllGlobals(); });

it('routes settings through the desktop origin and binds writes to the read revision', async () => {
  const settings: EngineeringSettings = { revision: 3, harness: { compression: 'full' }, context: { compactionEnabled: true, maxCharacters: 48000 }, memory: { enabled: false }, skills: { disabledIds: ['package'] } };
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...settings, revision: 4 }), { headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  configureApiOrigin('http://127.0.0.1:43210');
  await engineeringSettingsApi.save(settings);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe('http://127.0.0.1:43210/api/engineering/settings');
  expect(options.credentials).toBe('omit');
  expect(options.method).toBe('PUT');
  expect(JSON.parse(options.body)).toEqual({ expectedRevision: 3, harness: settings.harness, context: settings.context, memory: settings.memory, skills: settings.skills });
});
