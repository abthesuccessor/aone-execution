import { useState } from 'react';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ConnectProviderConnectionInput,
  DiscoverProviderConnectionInput,
  ProviderConnection,
  ProviderConnectionResult,
  ProviderStatus,
} from '../lib/types';
import { ProviderSettings } from './ProviderSettings';

function connection(
  kind: ProviderConnection['kind'],
  providerId: string,
  overrides: Partial<ProviderConnection> = {},
): ProviderConnection {
  return {
    kind,
    providerId,
    status: 'NOT_CHECKED',
    verified: false,
    secretStorage: 'NONE',
    selectedModel: null,
    baseUrl: null,
    capabilities: [],
    detail: 'Connection has not been verified in this server session.',
    ...overrides,
  };
}

const initialProviders: ProviderStatus[] = [
  {
    id: 'openai-api',
    name: 'OpenAI API',
    kind: 'api',
    available: false,
    configured: false,
    detected: false,
    capabilities: [],
    detail: 'Provider profile is disabled.',
    profile: { id: 'openai-api', label: 'OpenAI API', kind: 'api', enabled: false, model: 'gpt-5.6-terra' },
    connection: connection('hosted', 'openai-api'),
  },
  {
    id: 'anthropic-api',
    name: 'Anthropic API',
    kind: 'api',
    available: false,
    configured: false,
    detected: false,
    capabilities: [],
    detail: 'Provider profile is disabled.',
    profile: { id: 'anthropic-api', label: 'Anthropic API', kind: 'api', enabled: false, model: 'claude-sonnet-4-5' },
    connection: connection('hosted', 'anthropic-api'),
  },
  {
    id: 'ollama',
    name: 'Ollama',
    kind: 'local-api',
    available: false,
    configured: false,
    detected: false,
    capabilities: [],
    detail: 'Ollama is not verified.',
    profile: {
      id: 'ollama',
      label: 'Ollama',
      kind: 'local-api',
      enabled: false,
      model: 'qwen3-coder',
      baseUrl: 'http://127.0.0.1:11434',
    },
    connection: connection('local', 'ollama', { baseUrl: 'http://127.0.0.1:11434' }),
  },
  {
    id: 'codex-cli',
    name: 'Codex CLI',
    kind: 'cli',
    available: false,
    configured: false,
    detected: false,
    capabilities: [],
    detail: 'codex executable not detected in PATH.',
    profile: { id: 'codex-cli', label: 'Codex CLI', kind: 'cli', enabled: false },
    connection: connection('cli', 'codex-cli'),
  },
  {
    id: 'claude-cli',
    name: 'Claude Code CLI',
    kind: 'cli',
    available: false,
    configured: false,
    detected: true,
    capabilities: [],
    detail: 'claude executable detected, but no adapter is implemented.',
    profile: { id: 'claude-cli', label: 'Claude Code CLI', kind: 'cli', enabled: false },
    connection: connection('cli', 'claude-cli'),
  },
];

function replaceProvider(providers: ProviderStatus[], result: ProviderConnectionResult): ProviderStatus[] {
  if (!result.provider) return providers;
  return providers.map((provider) => provider.id === result.provider?.id ? result.provider : provider);
}

function renderSettings({
  providers = initialProviders,
  onDiscover = vi.fn(),
  onConnect = vi.fn(),
  onRefresh = vi.fn(),
  onDisconnect = vi.fn(),
}: {
  providers?: ProviderStatus[];
  onDiscover?: (input: DiscoverProviderConnectionInput) => Promise<ProviderConnectionResult>;
  onConnect?: (input: ConnectProviderConnectionInput) => Promise<ProviderConnectionResult>;
  onRefresh?: (providerId: string) => Promise<ProviderConnectionResult>;
  onDisconnect?: (providerId: string) => Promise<ProviderConnectionResult>;
} = {}) {
  function Harness() {
    const [items, setItems] = useState(providers);
    const apply = async (resultPromise: Promise<ProviderConnectionResult>) => {
      const result = await resultPromise;
      setItems((current) => replaceProvider(current, result));
      return result;
    };
    return (
      <Theme appearance="dark" accentColor="cyan" radius="small">
        <ProviderSettings
          providers={items}
          onDiscover={(input) => apply(onDiscover(input))}
          onConnect={(input) => apply(onConnect(input))}
          onRefreshModels={(providerId) => apply(onRefresh(providerId))}
          onDisconnect={(providerId) => apply(onDisconnect(providerId))}
        />
      </Theme>
    );
  }
  return render(<Harness />);
}

describe('ProviderSettings', () => {
  afterEach(() => {
    cleanup();
    delete window.egeDesktop;
  });

  it('keeps hosted keys masked and session-only, discovers real models, then connects the selected provider', async () => {
    const user = userEvent.setup();
    const secret = 'sk-ant-session-only';
    const discoveredConnection = connection('hosted', 'anthropic-api', {
      status: 'DISCOVERED',
      verified: true,
      secretStorage: 'SESSION_ONLY',
      detail: 'Hosted credential verified and retained only in this server session; select a model to connect.',
    });
    const models = [
      { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', source: 'provider' as const, recommended: true },
      { id: 'claude-opus-4-1', label: 'Claude Opus 4.1', source: 'provider' as const, recommended: false },
    ];
    const onDiscover = vi.fn(async () => ({ connection: discoveredConnection, models }));
    const onConnect = vi.fn(async () => {
      const connected = connection('hosted', 'anthropic-api', {
        status: 'CONNECTED',
        verified: true,
        secretStorage: 'SESSION_ONLY',
        selectedModel: 'claude-sonnet-4-5',
        capabilities: ['plan'],
        detail: 'Agent runtime connection and model prerequisites are verified.',
      });
      return {
        connection: connected,
        models,
        provider: {
          ...initialProviders[1],
          available: true,
          configured: true,
          ready: true,
          connectionVerified: true,
          capabilities: ['plan'],
          connection: connected,
        },
      };
    });

    renderSettings({ onDiscover, onConnect });

    const providerSelect = screen.getByRole('combobox', { name: 'Hosted provider' });
    await user.click(providerSelect);
    await user.click(await screen.findByRole('option', { name: 'Anthropic API' }));

    const keyInput = screen.getByLabelText('Anthropic API key');
    expect(keyInput).toHaveAttribute('type', 'password');
    expect(keyInput).toHaveValue('');
    await user.type(keyInput, secret);
    await user.click(screen.getByRole('button', { name: 'Show API key' }));
    expect(keyInput).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide API key' }));
    expect(keyInput).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Verify key and load models' }));
    await waitFor(() => expect(onDiscover).toHaveBeenCalledWith({
      kind: 'hosted',
      providerId: 'anthropic-api',
      apiKey: secret,
    }));
    expect(keyInput).toHaveValue('');
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Anthropic API model' })).toHaveTextContent('Claude Sonnet 4.5');
    expect(screen.getByText('Verified, choose model')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith({
      kind: 'hosted',
      providerId: 'anthropic-api',
      model: 'claude-sonnet-4-5',
    }));
    expect(await screen.findByText('Connected', { selector: '.rt-Badge' })).toBeInTheDocument();
    expect(screen.getByText(/cleared on server restart/i)).toBeInTheDocument();
    expect(screen.getByText(/built-in agents compile plans locally/i)).toBeInTheDocument();
    expect(screen.queryByText(/skill contents/i)).not.toBeInTheDocument();
  });

  it('refreshes a literal loopback Ollama endpoint and connects an installed model', async () => {
    const user = userEvent.setup();
    const models = [
      { id: 'qwen3-coder', label: 'qwen3-coder', source: 'installed' as const, recommended: true },
      { id: 'llama3.3', label: 'llama3.3', source: 'installed' as const, recommended: false },
    ];
    const onDiscover = vi.fn(async () => ({
      connection: connection('local', 'ollama', {
        status: 'DISCOVERED',
        verified: true,
        baseUrl: 'http://127.0.0.1:11434',
        detail: 'Loopback Ollama endpoint answered /api/tags; select an installed model to connect.',
      }),
      models,
    }));
    const onConnect = vi.fn(async () => {
      const connected = connection('local', 'ollama', {
        status: 'CONNECTED',
        verified: true,
        selectedModel: 'llama3.3',
        baseUrl: 'http://127.0.0.1:11434',
        capabilities: ['plan'],
        detail: 'Agent runtime connection and model prerequisites are verified.',
      });
      return {
        connection: connected,
        models,
        provider: {
          ...initialProviders[2],
          available: true,
          configured: true,
          ready: true,
          connectionVerified: true,
          capabilities: ['plan'],
          connection: connected,
        },
      };
    });

    renderSettings({ onDiscover, onConnect });
    await user.click(screen.getByRole('tab', { name: 'Local' }));

    expect(screen.getByRole('textbox', { name: 'Ollama endpoint' })).toHaveValue('http://127.0.0.1:11434');
    await user.click(screen.getByRole('button', { name: 'Refresh models' }));
    await waitFor(() => expect(onDiscover).toHaveBeenCalledWith({
      kind: 'local',
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
    }));

    const modelSelect = screen.getByRole('combobox', { name: 'Installed Ollama model' });
    expect(modelSelect).toBeEnabled();
    await user.click(modelSelect);
    await user.click(await screen.findByRole('option', { name: 'llama3.3' }));
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith({
      kind: 'local',
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'llama3.3',
    }));
    expect(await screen.findByText('Connected', { selector: '.rt-Badge' })).toBeInTheDocument();
    expect(screen.getByText(/only a loopback HTTP endpoint is accepted/i)).toBeInTheDocument();
  });

  it('shows CLI install and action states, then keeps a verified Claude CLI adapter unavailable', async () => {
    const user = userEvent.setup();
    const onConnect = vi.fn(async (input: ConnectProviderConnectionInput) => {
      if (input.providerId !== 'claude-cli') throw new Error('codex executable was not detected in PATH.');
      const connected = connection('cli', 'claude-cli', {
        status: 'CONNECTED',
        verified: true,
        capabilities: [],
        detail: 'Claude Code CLI is verified, but no execution adapter is implemented.',
      });
      return {
        connection: connected,
        models: [],
        provider: {
          ...initialProviders[4],
          available: false,
          configured: true,
          ready: false,
          connectionVerified: true,
          capabilities: [],
          connection: connected,
        },
      };
    });

    renderSettings({ onConnect });
    await user.click(screen.getByRole('tab', { name: 'CLI' }));

    const codexCard = screen.getByText('Codex CLI').closest('article');
    const claudeCard = screen.getByText('Claude Code CLI').closest('article');
    expect(codexCard).not.toBeNull();
    expect(claudeCard).not.toBeNull();
    expect(within(codexCard as HTMLElement).getByText('Not installed')).toBeInTheDocument();
    expect(within(claudeCard as HTMLElement).getByText('Action required')).toBeInTheDocument();

    await user.click(within(claudeCard as HTMLElement).getByRole('button', { name: 'Connect CLI' }));
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith({ kind: 'cli', providerId: 'claude-cli' }));
    expect(await within(claudeCard as HTMLElement).findByText('Verified, adapter unavailable')).toBeInTheDocument();
    expect(within(claudeCard as HTMLElement).queryByText('Connected')).not.toBeInTheDocument();
    expect(screen.getByText(/CLI describes the connection method, not data residency/i)).toBeInTheDocument();
  });

  it('shows Codex execution readiness directly without an application authorization control', async () => {
    const user = userEvent.setup();
    const codexConnected = connection('cli', 'codex-cli', {
      status: 'CONNECTED',
      verified: true,
      capabilities: ['plan', 'execute'],
      detail: 'Codex CLI planning and execution adapters are verified.',
    });
    const providers = initialProviders.map((provider) => provider.id === 'codex-cli' ? {
      ...provider,
      available: true,
      configured: true,
      detected: true,
      ready: true,
      connectionVerified: true,
      executionEnabled: true,
      capabilities: ['plan', 'execute'],
      connection: codexConnected,
    } : provider);

    renderSettings({ providers });
    await user.click(screen.getByRole('tab', { name: 'CLI' }));

    expect(screen.getByText('Planning + execution ready')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Allow Codex workspace writes' })).not.toBeInTheDocument();
  });
});
