import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineeringGraph } from '../lib/types';
import { WorkspaceControls } from './WorkspaceControls';

const workspaces: EngineeringGraph[] = [
  { id: 'workspace-1', name: 'Payments platform', nodes: [], edges: [], status: 'draft' },
  { id: 'workspace-2', name: 'Customer portal', nodes: [], edges: [], status: 'draft' },
];

afterEach(() => {
  cleanup();
  delete window.egeDesktop;
});

function renderControls(props: Partial<React.ComponentProps<typeof WorkspaceControls>> = {}) {
  const callbacks = {
    onSelect: vi.fn(),
    onCreate: vi.fn(async () => undefined),
    onRename: vi.fn(async () => undefined),
    onRebind: vi.fn(async () => undefined),
    onDelete: vi.fn(async () => undefined),
  };
  render(
    <Theme appearance="dark">
      <WorkspaceControls
        workspaces={workspaces}
        activeWorkspace={workspaces[0]}
        {...callbacks}
        {...props}
      />
    </Theme>,
  );
  return callbacks;
}

describe('WorkspaceControls', () => {
  it('switches only between supplied workspaces and creates an empty workspace by name', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onCreate = vi.fn(async () => undefined);

    renderControls({ onSelect, onCreate });

    await user.click(screen.getByRole('combobox', { name: 'Select workspace' }));
    await user.click(await screen.findByRole('option', { name: 'Customer portal' }));
    expect(onSelect).toHaveBeenCalledWith('workspace-2');

    await user.click(screen.getByRole('button', { name: 'New' }));
    expect(screen.getByText('The workspace starts empty. You can bind it to a local project folder, then add context nodes.')).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Workspace name' }), '  Order operations  ');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Order operations'));
    expect(screen.queryByRole('dialog', { name: 'Create workspace' })).not.toBeInTheDocument();
  });

  it('binds a new desktop workspace to a folder selected through the narrow desktop bridge', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => undefined);
    window.egeDesktop = {
      platform: 'darwin',
      appVersion: '0.1.0',
      selectWorkspaceDirectory: vi.fn(async () => '/Users/example/Projects/orders'),
    };

    renderControls({ onCreate });
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(screen.getByRole('textbox', { name: 'Workspace name' }), 'Order operations');
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Choose' }));
    expect(window.egeDesktop.selectWorkspaceDirectory).toHaveBeenCalledWith(undefined);
    expect(await screen.findByRole('textbox', { name: 'Local project folder' })).toHaveValue('/Users/example/Projects/orders');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Order operations', '/Users/example/Projects/orders'));
  });

  it('stays responsive and restores the create dialog when Finder is cancelled', async () => {
    const user = userEvent.setup();
    let finishSelection: (path?: string) => void = () => undefined;
    const selectWorkspaceDirectory = vi.fn(() => new Promise<string | undefined>((resolve) => {
      finishSelection = resolve;
    }));
    window.egeDesktop = {
      platform: 'macos',
      appVersion: '0.1.0',
      selectWorkspaceDirectory,
    };

    renderControls();
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'Choose' }));

    expect(selectWorkspaceDirectory).toHaveBeenCalledWith(undefined);
    expect(screen.getByRole('button', { name: 'Finder open' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Select a folder or cancel there to continue');
    expect(screen.getByRole('dialog', { name: 'Create workspace' })).toBeInTheDocument();

    finishSelection(undefined);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose' })).toBeEnabled());
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a recoverable error when the native folder picker rejects', async () => {
    const user = userEvent.setup();
    window.egeDesktop = {
      platform: 'macos',
      appVersion: '0.1.0',
      selectWorkspaceDirectory: vi.fn(async () => {
        throw new Error('Native dialog unavailable');
      }),
    };

    renderControls();
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.click(screen.getByRole('button', { name: 'Choose' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not open the local project folder picker. Native dialog unavailable',
    );
    expect(screen.getByRole('button', { name: 'Choose' })).toBeEnabled();
    expect(screen.getByRole('dialog', { name: 'Create workspace' })).toBeInTheDocument();
  });

  it('renames the active workspace and requires destructive confirmation before deletion', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn(async () => undefined);
    const onDelete = vi.fn(async () => undefined);

    renderControls({ onRename, onDelete });

    await user.click(screen.getByRole('button', { name: 'Rename workspace' }));
    const nameField = screen.getByRole('textbox', { name: 'New workspace name' });
    await user.clear(nameField);
    await user.type(nameField, 'Billing workspace');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Billing workspace'));

    await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete workspace?' })).toHaveTextContent('Payments platform');
    expect(screen.getByRole('alertdialog', { name: 'Delete workspace?' })).toHaveTextContent('Uploaded content objects remain in local content-addressed storage.');
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
  });

  it('blocks deletion while an execution is active', () => {
    renderControls({ deleteBlockedReason: 'Pause or finish the active execution before deleting this workspace.' });

    expect(screen.getByRole('button', {
      name: 'Delete workspace unavailable. Pause or finish the active execution before deleting this workspace.',
    })).toBeDisabled();
  });

  it('shows and safely changes the desktop local project binding', async () => {
    const user = userEvent.setup();
    const onRebind = vi.fn(async () => undefined);
    window.egeDesktop = {
      platform: 'darwin',
      appVersion: '0.1.0',
      selectWorkspaceDirectory: vi.fn(async () => '/Users/example/Projects/orders-v2'),
    };

    renderControls({
      activeWorkspace: { ...workspaces[0], workspacePath: '/Users/example/Projects/orders' },
      onRebind,
    });

    await user.click(screen.getByRole('button', { name: /Change local project folder/ }));
    expect(screen.getByText('/Users/example/Projects/orders')).toBeInTheDocument();
    expect(screen.getByText(/makes existing plans stale/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose' }));
    expect(window.egeDesktop.selectWorkspaceDirectory).toHaveBeenCalledWith('/Users/example/Projects/orders');
    expect(screen.getByRole('textbox', { name: 'New local project folder' })).toHaveValue('/Users/example/Projects/orders-v2');
    await user.click(screen.getByRole('button', { name: 'Use folder' }));

    await waitFor(() => expect(onRebind).toHaveBeenCalledWith('/Users/example/Projects/orders-v2'));
  });

  it('blocks project rebind while an execution is paused or active', () => {
    window.egeDesktop = {
      platform: 'darwin',
      appVersion: '0.1.0',
      selectWorkspaceDirectory: vi.fn(async () => undefined),
    };
    renderControls({
      activeWorkspace: { ...workspaces[0], workspacePath: '/Users/example/Projects/orders' },
      rebindBlockedReason: 'Finish or supersede the active execution before changing its project folder.',
    });

    expect(screen.getByRole('button', {
      name: 'Change local project folder unavailable. Finish or supersede the active execution before changing its project folder.',
    })).toBeDisabled();
  });

  it('keeps the confirmation open when the server rejects a raced active execution', async () => {
    const user = userEvent.setup();
    renderControls({
      onDelete: vi.fn(async () => {
        throw new Error('Pause or finish active executions before deleting the workspace.');
      }),
    });

    await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
    await user.click(screen.getByRole('button', { name: 'Delete workspace' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Pause or finish active executions before deleting the workspace.');
    expect(screen.getByRole('alertdialog', { name: 'Delete workspace?' })).toBeInTheDocument();
  });
});
