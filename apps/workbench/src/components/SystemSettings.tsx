import { useEffect, useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Dialog,
  Flex,
  Select,
  Tabs,
  Text,
  TextArea,
} from '@radix-ui/themes';
import { IconCheck, IconSettings } from '@tabler/icons-react';
import type {
  ConnectProviderConnectionInput,
  DiscoverProviderConnectionInput,
  EngineeringAgent,
  EngineeringDomain,
  ProviderConnectionResult,
  ProviderStatus,
} from '../lib/types';
import { ProviderSettings } from './ProviderSettings';

interface SystemSettingsProps {
  agents: EngineeringAgent[];
  domains: EngineeringDomain[];
  providers: ProviderStatus[];
  onSavePrompt: (agentId: string, prompt: string, expectedDigest: string) => Promise<void>;
  onDiscoverProvider: (input: DiscoverProviderConnectionInput) => Promise<ProviderConnectionResult>;
  onConnectProvider: (input: ConnectProviderConnectionInput) => Promise<ProviderConnectionResult>;
  onRefreshProviderModels: (providerId: string) => Promise<ProviderConnectionResult>;
  onDisconnectProvider: (providerId: string) => Promise<ProviderConnectionResult>;
}

export function SystemSettings({
  agents,
  domains,
  providers,
  onSavePrompt,
  onDiscoverProvider,
  onConnectProvider,
  onRefreshProviderModels,
  onDisconnectProvider,
}: SystemSettingsProps) {
  const [selectedAgentId, setSelectedAgentId] = useState(agents[0]?.id ?? '');
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId) ?? agents[0];
  const [prompt, setPrompt] = useState(selectedAgent?.currentPrompt.prompt ?? '');
  const [saving, setSaving] = useState<'agent'>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!selectedAgentId && agents[0]) setSelectedAgentId(agents[0].id);
  }, [agents, selectedAgentId]);

  useEffect(() => { setPrompt(selectedAgent?.currentPrompt.prompt ?? ''); }, [selectedAgent]);

  const domain = useMemo(
    () => domains.find((item) => item.id === selectedAgent?.domain),
    [domains, selectedAgent],
  );

  const savePrompt = async () => {
    if (!selectedAgent || prompt.trim() === selectedAgent.currentPrompt.prompt) return;
    setSaving('agent');
    setError(undefined);
    try {
      await onSavePrompt(selectedAgent.id, prompt.trim(), selectedAgent.currentPrompt.digest);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Prompt save failed.');
    } finally {
      setSaving(undefined);
    }
  };

  return (
    <Dialog.Root>
      <Dialog.Trigger>
        <Button size="1" variant="soft" color="gray"><IconSettings size={15} /> System</Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="820px" className="system-settings-dialog">
        <Dialog.Title>Engineering system</Dialog.Title>
        <Tabs.Root defaultValue="agents">
          <Tabs.List>
            <Tabs.Trigger value="agents">Agents</Tabs.Trigger>
            <Tabs.Trigger value="providers">Providers</Tabs.Trigger>
          </Tabs.List>

          {error && <Text as="p" size="1" color="red" mt="3">{error}</Text>}

          <Tabs.Content value="agents" className="settings-tab-content">
            {selectedAgent ? (
              <div className="settings-grid">
                <div className="settings-sidebar">
                  <Text size="1" weight="medium">Agent</Text>
                  <Select.Root value={selectedAgent.id} onValueChange={setSelectedAgentId}>
                    <Select.Trigger aria-label="Engineering agent" />
                    <Select.Content>
                      {agents.map((agent) => <Select.Item key={agent.id} value={agent.id}>{agent.name}</Select.Item>)}
                    </Select.Content>
                  </Select.Root>
                  <Text size="1" color="gray">{domain?.name}</Text>
                  <Text size="1">{selectedAgent.description}</Text>
                  <Flex wrap="wrap" gap="1">
                    {selectedAgent.capabilities.map((capability) => (
                      <Badge key={capability} variant="outline" color="gray">{capability}</Badge>
                    ))}
                  </Flex>
                  <Text size="1" color="gray">Tool policy is governed separately from the editable prompt.</Text>
                </div>
                <label className="field-label settings-prompt-field">
                  <Flex justify="between" align="center">
                    <Text size="1" weight="medium">Prompt revision {selectedAgent.currentPrompt.version}</Text>
                    <Text size="1" color="gray">{selectedAgent.currentPrompt.digest.slice(0, 12)}</Text>
                  </Flex>
                  <TextArea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    aria-label="Agent prompt"
                    rows={18}
                  />
                  <Flex justify="end">
                    <Button
                      color="cyan"
                      disabled={saving !== undefined || !prompt.trim() || prompt.trim() === selectedAgent.currentPrompt.prompt}
                      onClick={() => void savePrompt()}
                    >
                      <IconCheck size={15} /> {saving === 'agent' ? 'Saving' : 'Save new revision'}
                    </Button>
                  </Flex>
                </label>
              </div>
            ) : <Text size="2" color="gray">No agent definitions are available.</Text>}
          </Tabs.Content>

          <Tabs.Content value="providers" className="settings-tab-content">
            <ProviderSettings
              providers={providers}
              onDiscover={onDiscoverProvider}
              onConnect={onConnectProvider}
              onRefreshModels={onRefreshProviderModels}
              onDisconnect={onDisconnectProvider}
            />
          </Tabs.Content>
        </Tabs.Root>
      </Dialog.Content>
    </Dialog.Root>
  );
}
