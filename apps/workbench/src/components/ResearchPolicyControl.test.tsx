import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResearchPolicyControl } from './ResearchPolicyControl';

function renderControl(overrides: Partial<React.ComponentProps<typeof ResearchPolicyControl>> = {}) {
  const onEnabledChange = vi.fn();
  render(
    <Theme appearance="dark" accentColor="cyan" radius="small">
      <ResearchPolicyControl
        providerId="codex-cli"
        providerCapabilities={['plan', 'research-live-web']}
        enabled={false}
        onEnabledChange={onEnabledChange}
        {...overrides}
      />
    </Theme>,
  );
  return onEnabledChange;
}

describe('ResearchPolicyControl', () => {
  afterEach(cleanup);

  it('requires an explicit opt-in for a verified Codex CLI adapter', async () => {
    const user = userEvent.setup();
    const onEnabledChange = renderControl();
    const control = screen.getByRole('checkbox', { name: 'Live web research' });

    expect(control).toBeEnabled();
    expect(control).not.toBeChecked();
    await user.click(control);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
  });

  it('discloses the external-network and citation boundary in its tooltip', async () => {
    const user = userEvent.setup();
    renderControl();
    await user.hover(screen.getByText('Live web research'));
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent(/external network/i);
    expect(tooltip).toHaveTextContent(/evidence and citations/i);
  });

  it.each(['simulation', 'openai-api', 'anthropic-api', 'claude-cli', 'ollama'])(
    'stays disabled for the %s provider',
    (providerId) => {
      const onEnabledChange = renderControl({
        providerId,
        providerCapabilities: ['plan', 'research-live-web'],
        enabled: true,
      });
      const control = screen.getByRole('checkbox', { name: 'Live web research' });

      expect(control).toBeDisabled();
      expect(control).not.toBeChecked();
      expect(onEnabledChange).not.toHaveBeenCalled();
    },
  );

  it('stays disabled when the installed Codex adapter did not verify the capability', () => {
    renderControl({ providerCapabilities: ['plan'], enabled: true });
    const control = screen.getByRole('checkbox', { name: 'Live web research' });
    expect(control).toBeDisabled();
    expect(control).not.toBeChecked();
  });
});
