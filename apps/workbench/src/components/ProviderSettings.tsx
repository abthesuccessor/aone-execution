import { useEffect, useId, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Callout,
  Flex,
  IconButton,
  Select,
  Tabs,
  Text,
  TextField,
  Tooltip,
} from '@radix-ui/themes';
import {
  IconAlertCircle,
  IconCheck,
  IconCloud,
  IconEye,
  IconEyeOff,
  IconKey,
  IconLoader2,
  IconPlugConnected,
  IconRefresh,
  IconServer,
  IconTerminal2,
  IconUnlink,
} from '@tabler/icons-react';
import type {
  ConnectProviderConnectionInput,
  DiscoverProviderConnectionInput,
  ProviderConnection,
  ProviderConnectionResult,
  ProviderModel,
  ProviderStatus,
} from '../lib/types';

type ProviderMode = 'hosted' | 'local' | 'cli';
type Operation = `discover:${string}` | `connect:${string}` | `refresh:${string}` | `disconnect:${string}`;
type ConnectionMap = Record<string, ProviderConnection>;
type ModelMap = Record<string, ProviderModel[]>;
type ModelChoice = Pick<ProviderModel, 'id' | 'label' | 'recommended'>;

interface ProviderSettingsProps {
  providers: ProviderStatus[];
  onDiscover: (input: DiscoverProviderConnectionInput) => Promise<ProviderConnectionResult>;
  onConnect: (input: ConnectProviderConnectionInput) => Promise<ProviderConnectionResult>;
  onRefreshModels: (providerId: string) => Promise<ProviderConnectionResult>;
  onDisconnect: (providerId: string) => Promise<ProviderConnectionResult>;
}

export function ProviderSettings({
  providers,
  onDiscover,
  onConnect,
  onRefreshModels,
  onDisconnect,
}: ProviderSettingsProps) {
  const hostedProviders = useMemo(
    () => providers.filter((provider) => provider.id === 'openai-api' || provider.id === 'anthropic-api'),
    [providers],
  );
  const localProvider = providers.find((provider) => provider.id === 'ollama');
  const cliProviders = useMemo(
    () => providers.filter((provider) => provider.id === 'codex-cli' || provider.id === 'claude-cli'),
    [providers],
  );
  const [mode, setMode] = useState<ProviderMode>('hosted');
  const [hostedProviderId, setHostedProviderId] = useState(hostedProviders[0]?.id ?? '');
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [hostedModel, setHostedModel] = useState('');
  const [localBaseUrl, setLocalBaseUrl] = useState(localProvider?.profile?.baseUrl ?? '');
  const [localModel, setLocalModel] = useState(localProvider?.profile?.model ?? '');
  const [connections, setConnections] = useState<ConnectionMap>(() => providerConnections(providers));
  const [models, setModels] = useState<ModelMap>({});
  const [operation, setOperation] = useState<Operation>();
  const [error, setError] = useState<string>();
  const apiKeyHelpId = useId();
  const localEndpointHelpId = useId();

  const hostedProvider = hostedProviders.find((provider) => provider.id === hostedProviderId) ?? hostedProviders[0];
  const hostedConnection = hostedProvider
    ? connections[hostedProvider.id] ?? connectionFallback(hostedProvider, 'hosted')
    : undefined;
  const localConnection = localProvider
    ? connections[localProvider.id] ?? connectionFallback(localProvider, 'local')
    : undefined;
  const hostedModels = hostedProvider ? modelChoices(hostedProvider, models[hostedProvider.id]) : [];
  const localModels = localProvider ? modelChoices(localProvider, models[localProvider.id]) : [];
  const localEndpointVerified = Boolean(
    localConnection?.verified
      && localConnection.baseUrl
      && sameEndpoint(localConnection.baseUrl, localBaseUrl),
  );

  useEffect(() => {
    if (!hostedProviderId && hostedProviders[0]) setHostedProviderId(hostedProviders[0].id);
    if (hostedProviderId && !hostedProviders.some((provider) => provider.id === hostedProviderId)) {
      setHostedProviderId(hostedProviders[0]?.id ?? '');
    }
  }, [hostedProviderId, hostedProviders]);

  useEffect(() => {
    setConnections((current) => ({ ...current, ...providerConnections(providers) }));
  }, [providers]);

  useEffect(() => {
    if (!hostedProvider) return;
    setApiKey('');
    setShowApiKey(false);
    setHostedModel(hostedProvider.connection?.selectedModel ?? hostedProvider.profile?.model ?? '');
    setError(undefined);
  }, [hostedProvider?.id]);

  useEffect(() => {
    if (!localProvider) return;
    setLocalBaseUrl(localProvider.connection?.baseUrl ?? localProvider.profile?.baseUrl ?? '');
    setLocalModel(localProvider.connection?.selectedModel ?? localProvider.profile?.model ?? '');
  }, [localProvider?.id]);

  const applyResult = (result: ProviderConnectionResult) => {
    setConnections((current) => ({ ...current, [result.connection.providerId]: result.connection }));
    setModels((current) => ({ ...current, [result.connection.providerId]: result.models }));
    return result;
  };

  const perform = async (nextOperation: Operation, task: () => Promise<ProviderConnectionResult>) => {
    setOperation(nextOperation);
    setError(undefined);
    try {
      return applyResult(await task());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Provider connection failed.');
      return undefined;
    } finally {
      setOperation(undefined);
    }
  };

  const discoverHosted = async () => {
    if (!hostedProvider || !apiKey.trim()) return;
    const providerId = hostedProvider.id as 'openai-api' | 'anthropic-api';
    const result = await perform(`discover:${providerId}`, () => onDiscover({
      kind: 'hosted',
      providerId,
      apiKey: apiKey.trim(),
    }));
    if (!result) return;
    setApiKey('');
    setShowApiKey(false);
    setHostedModel(preferredModel(result.models, hostedModel || hostedProvider.profile?.model));
  };

  const connectHosted = async () => {
    if (!hostedProvider || !hostedModel || !hostedConnection?.verified) return;
    const providerId = hostedProvider.id as 'openai-api' | 'anthropic-api';
    const result = await perform(`connect:${providerId}`, () => onConnect({
      kind: 'hosted',
      providerId,
      model: hostedModel,
    }));
    if (result) {
      setApiKey('');
      setShowApiKey(false);
      setHostedModel(result.connection.selectedModel ?? hostedModel);
    }
  };

  const refreshHostedModels = async () => {
    if (!hostedProvider) return;
    const result = await perform(`refresh:${hostedProvider.id}`, () => onRefreshModels(hostedProvider.id));
    if (result) setHostedModel(preferredModel(result.models, hostedModel));
  };

  const discoverLocal = async () => {
    if (!localProvider || !localBaseUrl.trim()) return;
    const result = await perform('discover:ollama', () => onDiscover({
      kind: 'local',
      providerId: 'ollama',
      baseUrl: localBaseUrl.trim(),
    }));
    if (result) setLocalModel(preferredModel(result.models, localModel || localProvider.profile?.model));
  };

  const connectLocal = async () => {
    if (!localProvider || !localModel || !localEndpointVerified) return;
    const result = await perform('connect:ollama', () => onConnect({
      kind: 'local',
      providerId: 'ollama',
      baseUrl: localBaseUrl.trim(),
      model: localModel,
    }));
    if (result) setLocalModel(result.connection.selectedModel ?? localModel);
  };

  const checkCli = async (provider: ProviderStatus) => {
    if (provider.id !== 'codex-cli' && provider.id !== 'claude-cli') return;
    const providerId = provider.id;
    await perform(`connect:${providerId}`, () => onConnect({ kind: 'cli', providerId }));
  };

  const disconnect = async (providerId: string) => {
    const result = await perform(`disconnect:${providerId}`, () => onDisconnect(providerId));
    if (!result) return;
    if (providerId === hostedProvider?.id) {
      setApiKey('');
      setShowApiKey(false);
    }
  };

  const hostedConnected = Boolean(
    hostedProvider
      && hostedConnection?.status === 'CONNECTED'
      && hostedConnection.verified
      && hostedProvider.available,
  );
  const hostedModelChanged = hostedConnection?.selectedModel !== hostedModel;
  const localConnected = Boolean(
    localProvider
      && localConnection?.status === 'CONNECTED'
      && localConnection.verified
      && localProvider.available,
  );
  const localSettingsChanged = localConnection?.selectedModel !== localModel
    || !sameEndpoint(localConnection?.baseUrl ?? '', localBaseUrl);

  return (
    <div className="provider-settings">
      <Tabs.Root value={mode} onValueChange={(value) => {
        setMode(value as ProviderMode);
        setError(undefined);
      }}>
        <Tabs.List className="provider-mode-tabs" aria-label="Provider connection mode">
          <Tabs.Trigger value="hosted" aria-label="Hosted"><IconCloud size={14} /> Hosted</Tabs.Trigger>
          <Tabs.Trigger value="local" aria-label="Local"><IconServer size={14} /> Local</Tabs.Trigger>
          <Tabs.Trigger value="cli" aria-label="CLI"><IconTerminal2 size={14} /> CLI</Tabs.Trigger>
        </Tabs.List>

        {error && (
          <Callout.Root color="red" size="1" mt="3" role="alert">
            <Callout.Icon><IconAlertCircle size={14} /></Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}

        <Tabs.Content value="hosted" className="provider-mode-content">
          {hostedProvider && hostedConnection ? (
            <div className="provider-section">
              <ProviderStatusLine provider={hostedProvider} connection={hostedConnection} />

              <div className="provider-field-grid">
                <label className="field-label">
                  <Text size="1" weight="medium">Hosted provider</Text>
                  <Select.Root value={hostedProvider.id} onValueChange={setHostedProviderId}>
                    <Select.Trigger aria-label="Hosted provider" />
                    <Select.Content>
                      {hostedProviders.map((provider) => (
                        <Select.Item key={provider.id} value={provider.id}>{provider.name}</Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                </label>

                <label className="field-label">
                  <Text size="1" weight="medium">API key</Text>
                  <TextField.Root
                    type={showApiKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    aria-label={`${hostedProvider.name} key`}
                    aria-describedby={apiKeyHelpId}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Enter a key for this session"
                  >
                    <TextField.Slot><IconKey size={14} /></TextField.Slot>
                    <TextField.Slot side="right">
                      <Tooltip content={showApiKey ? 'Hide API key' : 'Show API key'}>
                        <IconButton
                          type="button"
                          size="1"
                          variant="ghost"
                          color="gray"
                          aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                          onClick={() => setShowApiKey((value) => !value)}
                        >
                          {showApiKey ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                        </IconButton>
                      </Tooltip>
                    </TextField.Slot>
                  </TextField.Root>
                  <Text id={apiKeyHelpId} size="1" color="gray">
                    Kept only in the local server process. It is cleared on server restart and is never returned.
                  </Text>
                </label>
              </div>

              <Flex justify="end">
                <Button
                  variant="soft"
                  color="gray"
                  disabled={!apiKey.trim() || operation !== undefined}
                  onClick={() => void discoverHosted()}
                >
                  {operation === `discover:${hostedProvider.id}`
                    ? <IconLoader2 className="spin-icon" size={15} />
                    : <IconKey size={15} />}
                  {operation === `discover:${hostedProvider.id}` ? 'Verifying key' : 'Verify key and load models'}
                </Button>
              </Flex>

              <div className="provider-model-row">
                <ProviderModelSelect
                  label={`${hostedProvider.name} model`}
                  value={hostedModel}
                  models={hostedModels}
                  placeholder={hostedConnection.verified ? 'Select a model' : 'Verify a key to load models'}
                  disabled={!hostedConnection.verified || operation !== undefined}
                  onChange={setHostedModel}
                />
                <Tooltip content="Refresh models from the provider">
                  <IconButton
                    type="button"
                    variant="soft"
                    color="gray"
                    aria-label={`Refresh ${hostedProvider.name} models`}
                    disabled={!hostedConnection.verified || operation !== undefined}
                    onClick={() => void refreshHostedModels()}
                  >
                    <IconRefresh className={operation === `refresh:${hostedProvider.id}` ? 'spin-icon' : undefined} size={15} />
                  </IconButton>
                </Tooltip>
              </div>

              <ProviderDataNotice mode="hosted" />
              <Text size="1" color="gray">Connecting saves the provider and model. Existing plans may require replanning.</Text>
              <ProviderActions
                provider={hostedProvider}
                connection={hostedConnection}
                operation={operation}
                connected={hostedConnected}
                canConnect={Boolean(hostedConnection.verified && hostedModel && (!hostedConnected || hostedModelChanged))}
                onConnect={() => void connectHosted()}
                onDisconnect={() => void disconnect(hostedProvider.id)}
              />
            </div>
          ) : <ProviderEmpty message="No hosted providers were reported by the local server." />}
        </Tabs.Content>

        <Tabs.Content value="local" className="provider-mode-content">
          {localProvider && localConnection ? (
            <div className="provider-section">
              <ProviderStatusLine provider={localProvider} connection={localConnection} />

              <label className="field-label">
                <Text size="1" weight="medium">Ollama endpoint</Text>
                <TextField.Root
                  value={localBaseUrl}
                  onChange={(event) => setLocalBaseUrl(event.target.value)}
                  aria-label="Ollama endpoint"
                  aria-describedby={localEndpointHelpId}
                  placeholder="http://127.0.0.1:11434"
                />
                <Text id={localEndpointHelpId} size="1" color="gray">
                  Only a loopback HTTP endpoint is accepted. Refresh models after changing it.
                </Text>
              </label>

              <div className="provider-model-row">
                <ProviderModelSelect
                  label="Installed Ollama model"
                  value={localModel}
                  models={localModels}
                  placeholder="Refresh to load installed models"
                  disabled={!localEndpointVerified || operation !== undefined}
                  onChange={setLocalModel}
                />
                <Button
                  type="button"
                  variant="soft"
                  color="gray"
                  disabled={!localBaseUrl.trim() || operation !== undefined}
                  onClick={() => void discoverLocal()}
                >
                  <IconRefresh className={operation === 'discover:ollama' ? 'spin-icon' : undefined} size={15} />
                  {operation === 'discover:ollama' ? 'Refreshing' : 'Refresh models'}
                </Button>
              </div>

              <ProviderDataNotice mode="local" />
              <Text size="1" color="gray">Connecting saves the endpoint and model. Existing plans may require replanning.</Text>
              <ProviderActions
                provider={localProvider}
                connection={localConnection}
                operation={operation}
                connected={localConnected}
                canConnect={Boolean(localEndpointVerified && localModel && (!localConnected || localSettingsChanged))}
                onConnect={() => void connectLocal()}
                onDisconnect={() => void disconnect(localProvider.id)}
              />
            </div>
          ) : <ProviderEmpty message="Ollama was not reported by the local server." />}
        </Tabs.Content>

        <Tabs.Content value="cli" className="provider-mode-content">
          <div className="provider-section">
            <ProviderDataNotice mode="cli" />
            {cliProviders.length > 0 ? (
              <div className="provider-cli-list" role="list" aria-label="CLI providers">
                {cliProviders.map((provider) => {
                  const connection = connections[provider.id] ?? connectionFallback(provider, 'cli');
                  const status = statusMeta(provider, connection);
                  const checking = operation === `connect:${provider.id}`;
                  return (
                    <article key={provider.id} className="provider-cli-card" role="listitem">
                      <Flex justify="between" align="start" gap="2">
                        <div>
                          <Flex align="center" gap="2">
                            <IconTerminal2 size={16} />
                            <Text size="2" weight="medium">{provider.name}</Text>
                          </Flex>
                          <Text as="p" size="1" color="gray">{connection.detail || provider.detail}</Text>
                        </div>
                        <Badge color={status.color} variant="soft">{status.label}</Badge>
                      </Flex>
                      <CapabilityBadges capabilities={provider.capabilities ?? []} />
                      <Button
                        type="button"
                        variant="soft"
                        color="gray"
                        disabled={operation !== undefined}
                        onClick={() => void checkCli(provider)}
                      >
                        {checking ? <IconLoader2 className="spin-icon" size={15} /> : <IconPlugConnected size={15} />}
                        {checking ? 'Connecting' : 'Connect CLI'}
                      </Button>
                    </article>
                  );
                })}
              </div>
            ) : <ProviderEmpty message="No supported CLI providers were reported by the local server." />}
          </div>
        </Tabs.Content>
      </Tabs.Root>
    </div>
  );
}

function ProviderModelSelect({ label, value, models, placeholder, disabled, onChange }: {
  label: string;
  value: string;
  models: ModelChoice[];
  placeholder: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field-label provider-model-select">
      <Text size="1" weight="medium">Model</Text>
      <Select.Root value={value} onValueChange={onChange} disabled={disabled || models.length === 0}>
        <Select.Trigger aria-label={label} placeholder={placeholder} />
        <Select.Content>
          {models.map((model) => (
            <Select.Item key={model.id} value={model.id}>
              {model.label}{model.recommended ? ' (recommended)' : ''}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
    </label>
  );
}

function ProviderStatusLine({ provider, connection }: { provider: ProviderStatus; connection: ProviderConnection }) {
  const status = statusMeta(provider, connection);
  return (
    <div className="provider-status-line" aria-live="polite">
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="2" weight="medium">{provider.name}</Text>
        <Badge color={status.color} variant="soft">{status.label}</Badge>
        <CapabilityBadges capabilities={provider.capabilities ?? []} />
      </Flex>
      <Text size="1" color="gray">{connection.detail || provider.detail || 'Connection has not been checked.'}</Text>
    </div>
  );
}

function ProviderActions({ provider, connection, operation, connected, canConnect, onConnect, onDisconnect }: {
  provider: ProviderStatus;
  connection: ProviderConnection;
  operation?: Operation;
  connected: boolean;
  canConnect: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connecting = operation === `connect:${provider.id}`;
  const disconnecting = operation === `disconnect:${provider.id}`;
  const canDisconnect = connection.status === 'DISCOVERED'
    || connection.status === 'CONNECTED'
    || Boolean(provider.profile?.enabled);
  return (
    <Flex justify="end" align="center" gap="2" wrap="wrap" className="provider-actions">
      {canDisconnect && (
        <Button type="button" variant="ghost" color="gray" disabled={operation !== undefined} onClick={onDisconnect}>
          {disconnecting ? <IconLoader2 className="spin-icon" size={15} /> : <IconUnlink size={15} />}
          {disconnecting ? 'Disconnecting' : 'Disconnect'}
        </Button>
      )}
      <Button type="button" color="cyan" disabled={!canConnect || operation !== undefined} onClick={onConnect}>
        {connecting
          ? <IconLoader2 className="spin-icon" size={15} />
          : connected ? <IconCheck size={15} /> : <IconPlugConnected size={15} />}
        {connecting ? 'Saving connection' : connected ? 'Connected' : 'Connect'}
      </Button>
    </Flex>
  );
}

function ProviderDataNotice({ mode }: { mode: ProviderMode }) {
  const copy = mode === 'hosted'
    ? 'Built-in agents compile plans locally. A connected hosted runtime receives context only when an approved runtime adapter invokes it.'
    : mode === 'local'
      ? 'Loopback Ollama is local. The endpoint is restricted to this machine.'
      : 'CLI describes the connection method, not data residency. Built-in agents compile plans locally; an approved CLI run may use remote inference.';
  return (
    <Callout.Root color="gray" size="1" className="provider-data-notice">
      <Callout.Icon>{mode === 'hosted' ? <IconCloud size={14} /> : mode === 'local' ? <IconServer size={14} /> : <IconTerminal2 size={14} />}</Callout.Icon>
      <Callout.Text>{copy}</Callout.Text>
    </Callout.Root>
  );
}

function CapabilityBadges({ capabilities }: { capabilities: string[] }) {
  if (capabilities.length === 0) return null;
  return (
    <Flex gap="1" wrap="wrap">
      {capabilities.map((capability) => (
        <Badge key={capability} size="1" variant="outline" color="gray">{capability}</Badge>
      ))}
    </Flex>
  );
}

function ProviderEmpty({ message }: { message: string }) {
  return <Text as="p" size="2" color="gray" className="provider-empty">{message}</Text>;
}

function statusMeta(provider: ProviderStatus, connection: ProviderConnection): {
  label: string;
  color: 'green' | 'amber' | 'cyan' | 'gray';
} {
  if (connection.status === 'CONNECTED' && connection.verified && provider.available) {
    if (provider.id === 'codex-cli') {
      return provider.executionEnabled
        ? { label: provider.capabilities?.includes('chat') ? 'Chat, planning + execution ready' : 'Planning + execution ready', color: 'green' }
        : { label: provider.capabilities?.includes('chat') ? 'Chat + planning ready' : 'Planning only', color: 'cyan' };
    }
    return { label: 'Connected', color: 'green' };
  }
  if (connection.status === 'CONNECTED' && connection.verified && !provider.available) {
    return { label: 'Verified, adapter unavailable', color: 'amber' };
  }
  if (connection.status === 'DISCOVERED' && connection.verified) {
    return { label: 'Verified, choose model', color: 'cyan' };
  }
  if (connection.status === 'DISCONNECTED') return { label: 'Disconnected', color: 'gray' };
  if (connection.kind === 'cli' && provider.detected === false) return { label: 'Not installed', color: 'gray' };
  if (provider.configured) return { label: 'Configured, not verified', color: 'amber' };
  if (connection.kind === 'cli' && provider.detected) return { label: 'Action required', color: 'amber' };
  return { label: 'Not checked', color: 'gray' };
}

function providerConnections(providers: ProviderStatus[]): ConnectionMap {
  return Object.fromEntries(providers.flatMap((provider) => provider.connection ? [[provider.id, provider.connection]] : []));
}

function connectionFallback(provider: ProviderStatus, kind: ProviderConnection['kind']): ProviderConnection {
  return {
    kind,
    providerId: provider.id,
    status: 'NOT_CHECKED',
    verified: false,
    secretStorage: 'NONE',
    selectedModel: null,
    baseUrl: null,
    capabilities: [],
    detail: provider.detail ?? 'Connection has not been checked.',
  };
}

function modelChoices(provider: ProviderStatus, discovered?: ProviderModel[]): ModelChoice[] {
  if (discovered && discovered.length > 0) return dedupeModels(discovered);
  const configured = provider.connection?.selectedModel ?? provider.profile?.model;
  return configured ? [{ id: configured, label: `${configured} (configured)`, recommended: false }] : [];
}

function dedupeModels(models: ProviderModel[]): ProviderModel[] {
  return [...new Map(models.filter((model) => model.id).map((model) => [model.id, model])).values()];
}

function preferredModel(models: ProviderModel[], current?: string): string {
  if (current && models.some((model) => model.id === current)) return current;
  return models.find((model) => model.recommended)?.id ?? models[0]?.id ?? current ?? '';
}

function sameEndpoint(left: string, right: string): boolean {
  return left.trim().replace(/\/$/, '') === right.trim().replace(/\/$/, '');
}
