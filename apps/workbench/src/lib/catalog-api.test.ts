import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureApiOrigin } from './api';
import { catalogApi } from './catalog-api';

describe('catalog API adapter', () => {
  afterEach(() => {
    configureApiOrigin();
    vi.unstubAllGlobals();
  });

  it('normalizes runtime labels into visible provider names and preserves their configuration', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      items: [],
      providers: [
        { id: 'codex-cli', label: 'Codex CLI', profile: { model: 'configured-model' } },
        { id: 'openai-api', name: 'OpenAI API', label: 'Legacy OpenAI label' },
        { id: 'anthropic-api', name: '  ', label: 'Anthropic API' },
        { id: 'unknown-runtime' },
      ],
    }), { status: 200 })));

    const catalog = await catalogApi.list('agents');

    expect(catalog.providers?.map((provider) => provider.name)).toEqual([
      'Codex CLI', 'OpenAI API', 'Anthropic API', 'unknown-runtime',
    ]);
    expect(catalog.providers?.[0].profile).toEqual({ model: 'configured-model' });
  });

  it('uses the desktop loopback origin without requiring provider data for other catalogs', async () => {
    configureApiOrigin('http://127.0.0.1:45821');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const catalog = await catalogApi.list('skills');

    expect(catalog.items).toEqual([]);
    expect(catalog.providers).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:45821/api/catalog/skills',
      expect.objectContaining({ credentials: 'omit' }),
    );
  });
});
