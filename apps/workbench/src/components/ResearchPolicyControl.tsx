import { Checkbox, Flex, Text, Tooltip } from '@radix-ui/themes';

export const LIVE_WEB_RESEARCH_CAPABILITY = 'research-live-web';

interface ResearchPolicyControlProps {
  providerId: string;
  providerCapabilities?: string[];
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  disabled?: boolean;
}

export function ResearchPolicyControl({
  providerId,
  providerCapabilities = [],
  enabled,
  onEnabledChange,
  disabled = false,
}: ResearchPolicyControlProps) {
  const supported = providerId === 'codex-cli'
    && providerCapabilities.includes(LIVE_WEB_RESEARCH_CAPABILITY);
  const unavailable = disabled || !supported;
  const tooltip = supported
    ? 'Allows Codex CLI to use the external network for live web research. Web-derived claims must include evidence and citations.'
    : providerId === 'codex-cli'
      ? 'This Codex CLI installation has not verified live web-search support.'
      : 'Live web research is available only through the verified Codex CLI adapter.';

  return (
    <Tooltip content={tooltip}>
      <label aria-disabled={unavailable}>
        <Flex align="center" gap="2">
          <Checkbox
            aria-label="Live web research"
            checked={supported && enabled}
            disabled={unavailable}
            onCheckedChange={(checked) => {
              if (supported && !disabled) onEnabledChange(checked === true);
            }}
          />
          <Text size="1" color={unavailable ? 'gray' : undefined}>Live web research</Text>
        </Flex>
      </label>
    </Tooltip>
  );
}
