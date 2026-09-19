import { useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  Button,
  Dialog,
  Flex,
  Select,
  Text,
  TextField,
  Tooltip,
} from '@radix-ui/themes';
import {
  IconCheck,
  IconCirclePlus,
  IconFolder,
  IconPencil,
  IconTrash,
} from '@tabler/icons-react';
import type { EngineeringGraph } from '../lib/types';

interface WorkspaceControlsProps {
  workspaces: EngineeringGraph[];
  activeWorkspace?: EngineeringGraph;
  busy?: boolean;
  creating?: boolean;
  renaming?: boolean;
  deleting?: boolean;
  rebinding?: boolean;
  deleteBlockedReason?: string;
  rebindBlockedReason?: string;
  onSelect: (workspaceId: string) => void;
  onCreate: (name: string, workspacePath?: string) => Promise<void>;
  onRename: (name: string) => Promise<void>;
  onRebind: (workspacePath: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

export function WorkspaceControls({
  workspaces,
  activeWorkspace,
  busy,
  creating,
  renaming,
  deleting,
  rebinding,
  deleteBlockedReason,
  rebindBlockedReason,
  onSelect,
  onCreate,
  onRename,
  onRebind,
  onDelete,
}: WorkspaceControlsProps) {
  return (
    <div className="workspace-controls" aria-label="Workspace controls">
      {activeWorkspace && (
        <Select.Root value={activeWorkspace.id} onValueChange={onSelect} disabled={busy}>
          <Select.Trigger aria-label="Select workspace" className="workspace-select" />
          <Select.Content>
            {workspaces.map((workspace) => (
              <Select.Item key={workspace.id} value={workspace.id}>{workspace.name}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
      )}
      <CreateWorkspaceDialog onCreate={onCreate} creating={creating} compact={workspaces.length > 0} disabled={busy} />
      {activeWorkspace && (
        <>
          {window.egeDesktop && (
            <WorkspacePathDialog
              workspace={activeWorkspace}
              onRebind={onRebind}
              rebinding={rebinding}
              disabled={Boolean(busy || rebindBlockedReason)}
              blockedReason={rebindBlockedReason}
            />
          )}
          <RenameWorkspaceDialog workspace={activeWorkspace} onRename={onRename} renaming={renaming} disabled={busy} />
          <DeleteWorkspaceDialog
            workspace={activeWorkspace}
            onDelete={onDelete}
            deleting={deleting}
            disabled={Boolean(busy || deleteBlockedReason)}
            blockedReason={deleteBlockedReason}
          />
        </>
      )}
    </div>
  );
}

interface WorkspacePathDialogProps {
  workspace: EngineeringGraph;
  onRebind: (workspacePath: string) => Promise<void>;
  rebinding?: boolean;
  disabled?: boolean;
  blockedReason?: string;
}

function WorkspacePathDialog({ workspace, onRebind, rebinding, disabled, blockedReason }: WorkspacePathDialogProps) {
  const [open, setOpen] = useState(false);
  const [workspacePath, setWorkspacePath] = useState(workspace.workspacePath ?? '');
  const [actionError, setActionError] = useState<string>();
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  const desktop = window.egeDesktop;
  const currentPath = workspace.workspacePath ?? '';
  const pickerOpenLabel = folderPickerOpenLabel(desktop?.platform);
  const pickerOpenStatus = folderPickerOpenStatus(desktop?.platform);

  useEffect(() => setWorkspacePath(currentPath), [workspace.id, currentPath]);

  const submit = async () => {
    if (!workspacePath || workspacePath === currentPath || rebinding || selectingDirectory) return;
    setActionError(undefined);
    try {
      await onRebind(workspacePath);
      setOpen(false);
    } catch (cause) {
      setActionError(messageFrom(cause));
    }
  };

  const chooseDirectory = async () => {
    if (!desktop || rebinding || selectingDirectoryRef.current) return;
    selectingDirectoryRef.current = true;
    setSelectingDirectory(true);
    setActionError(undefined);
    try {
      const path = await desktop.selectWorkspaceDirectory(workspacePath || currentPath || undefined);
      if (path) setWorkspacePath(path);
    } catch (cause) {
      setActionError(folderPickerError(cause));
    } finally {
      selectingDirectoryRef.current = false;
      setSelectingDirectory(false);
    }
  };

  const accessibleLabel = blockedReason
    ? `Change local project folder unavailable. ${blockedReason}`
    : currentPath
      ? `Change local project folder. Current folder ${currentPath}`
      : 'Choose local project folder';

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && selectingDirectoryRef.current) return;
      setOpen(nextOpen);
      setWorkspacePath(currentPath);
      setActionError(undefined);
    }}>
      <Tooltip content={(blockedReason ?? currentPath) || 'Choose local project folder'}>
        <Dialog.Trigger>
          <Button
            size="1"
            variant="soft"
            color="gray"
            className="workspace-path-trigger"
            aria-label={accessibleLabel}
            disabled={disabled}
          >
            <IconFolder size={15} />
            <span>{currentPath ? pathLeaf(currentPath) : 'Choose project'}</span>
          </Button>
        </Dialog.Trigger>
      </Tooltip>
      <Dialog.Content maxWidth="560px">
        <Dialog.Title>Local project folder</Dialog.Title>
        <Dialog.Description size="2" color="gray">
          Graph nodes execute inside this folder. Changing it saves the current draft first and makes existing plans stale.
        </Dialog.Description>
        <div className="workspace-binding-summary">
          <Text size="1" color="gray">Current binding</Text>
          <code>{currentPath || 'No folder selected'}</code>
        </div>
        <label className="field-label dialog-field">
          <Text size="1" weight="medium">New project folder</Text>
          <Flex gap="2" align="center">
            <TextField.Root
              value={workspacePath}
              readOnly
              placeholder="Choose a project folder"
              aria-label="New local project folder"
              className="workspace-path-field"
            />
            <Button
              type="button"
              variant="soft"
              color="gray"
              onClick={() => void chooseDirectory()}
              disabled={rebinding || selectingDirectory}
            >
              <IconFolder size={15} /> {selectingDirectory ? pickerOpenLabel : 'Choose'}
            </Button>
          </Flex>
          {selectingDirectory && (
            <Text as="p" size="1" color="gray" role="status">{pickerOpenStatus}</Text>
          )}
        </label>
        <Text as="p" size="1" color="amber" className="workspace-binding-warning">
          Execution history stays attached to this workspace. A new plan is required before work can run in the new folder.
        </Text>
        {actionError && <Text as="p" size="1" color="red" role="alert" className="workspace-dialog-error">{actionError}</Text>}
        <Flex justify="end" gap="2" mt="4">
          <Dialog.Close><Button type="button" variant="soft" color="gray" disabled={rebinding || selectingDirectory}>Cancel</Button></Dialog.Close>
          <Button type="button" color="cyan" onClick={() => void submit()} disabled={!workspacePath || workspacePath === currentPath || rebinding || selectingDirectory}>
            <IconCheck size={15} /> {rebinding ? 'Changing folder' : 'Use folder'}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

interface CreateWorkspaceDialogProps {
  onCreate: (name: string, workspacePath?: string) => Promise<void>;
  creating?: boolean;
  compact?: boolean;
  disabled?: boolean;
}

export function CreateWorkspaceDialog({ onCreate, creating, compact, disabled }: CreateWorkspaceDialogProps) {
  const [name, setName] = useState('');
  const [workspacePath, setWorkspacePath] = useState('');
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  const desktop = window.egeDesktop;
  const pickerOpenLabel = folderPickerOpenLabel(desktop?.platform);
  const pickerOpenStatus = folderPickerOpenStatus(desktop?.platform);

  const submit = async () => {
    if (!name.trim() || creating || selectingDirectory) return;
    setActionError(undefined);
    try {
      if (workspacePath) await onCreate(name.trim(), workspacePath);
      else await onCreate(name.trim());
      setName('');
      setWorkspacePath('');
      setOpen(false);
    } catch (cause) {
      setActionError(messageFrom(cause));
    }
  };

  const chooseDirectory = async () => {
    if (!desktop || creating || selectingDirectoryRef.current) return;
    selectingDirectoryRef.current = true;
    setSelectingDirectory(true);
    setActionError(undefined);
    try {
      const path = await desktop.selectWorkspaceDirectory(workspacePath || undefined);
      if (path) setWorkspacePath(path);
    } catch (cause) {
      setActionError(folderPickerError(cause));
    } finally {
      selectingDirectoryRef.current = false;
      setSelectingDirectory(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      if (!nextOpen && selectingDirectoryRef.current) return;
      setOpen(nextOpen);
      if (!nextOpen) {
        setName('');
        setWorkspacePath('');
        setActionError(undefined);
      }
    }}>
      <Dialog.Trigger>
        <Button size={compact ? '1' : '2'} variant="soft" color="gray" disabled={disabled}>
          <IconCirclePlus size={15} /> {compact ? 'New' : 'Create workspace'}
        </Button>
      </Dialog.Trigger>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>Create workspace</Dialog.Title>
        <Dialog.Description size="2" color="gray">The workspace starts empty. You can bind it to a local project folder, then add context nodes.</Dialog.Description>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="field-label dialog-field">
            <Text size="1" weight="medium">Workspace name</Text>
            <TextField.Root
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Payments platform"
              aria-label="Workspace name"
              disabled={creating}
            />
          </label>
          {desktop && (
            <label className="field-label dialog-field">
              <Text size="1" weight="medium">Local project folder</Text>
              <Flex gap="2" align="center">
                <TextField.Root
                  value={workspacePath}
                  readOnly
                  placeholder="Choose a project folder"
                  aria-label="Local project folder"
                  className="workspace-path-field"
                />
                <Button
                  type="button"
                  variant="soft"
                  color="gray"
                  onClick={() => void chooseDirectory()}
                  disabled={creating || selectingDirectory}
                >
                  <IconFolder size={15} /> {selectingDirectory ? pickerOpenLabel : 'Choose'}
                </Button>
              </Flex>
              {selectingDirectory && (
                <Text as="p" size="1" color="gray" role="status">{pickerOpenStatus}</Text>
              )}
              <Text size="1" color="gray">The desktop app only grants this workspace access to the folder you select.</Text>
            </label>
          )}
          {actionError && <Text as="p" size="1" color="red" role="alert" className="workspace-dialog-error">{actionError}</Text>}
          <Flex justify="end" gap="2" mt="4">
            <Dialog.Close><Button type="button" variant="soft" color="gray" disabled={creating || selectingDirectory}>Cancel</Button></Dialog.Close>
            <Button type="submit" color="cyan" disabled={!name.trim() || creating || selectingDirectory || Boolean(desktop && !workspacePath)}>
              <IconCheck size={15} /> {creating ? 'Creating' : 'Create workspace'}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

interface RenameWorkspaceDialogProps {
  workspace: EngineeringGraph;
  onRename: (name: string) => Promise<void>;
  renaming?: boolean;
  disabled?: boolean;
}

function RenameWorkspaceDialog({ workspace, onRename, renaming, disabled }: RenameWorkspaceDialogProps) {
  const [name, setName] = useState(workspace.name);
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => setName(workspace.name), [workspace.id, workspace.name]);

  const submit = async () => {
    const nextName = name.trim();
    if (!nextName || nextName === workspace.name || renaming) return;
    setActionError(undefined);
    try {
      await onRename(nextName);
      setOpen(false);
    } catch (cause) {
      setActionError(messageFrom(cause));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      setName(workspace.name);
      setActionError(undefined);
    }}>
      <Tooltip content="Rename workspace">
        <Dialog.Trigger>
          <Button size="1" variant="ghost" color="gray" aria-label="Rename workspace" disabled={disabled}>
            <IconPencil size={15} />
          </Button>
        </Dialog.Trigger>
      </Tooltip>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>Rename workspace</Dialog.Title>
        <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <label className="field-label dialog-field">
            <Text size="1" weight="medium">Workspace name</Text>
            <TextField.Root
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="New workspace name"
              disabled={renaming}
            />
          </label>
          {actionError && <Text as="p" size="1" color="red" role="alert" className="workspace-dialog-error">{actionError}</Text>}
          <Flex justify="end" gap="2" mt="4">
            <Dialog.Close><Button type="button" variant="soft" color="gray" disabled={renaming}>Cancel</Button></Dialog.Close>
            <Button type="submit" color="cyan" disabled={!name.trim() || name.trim() === workspace.name || renaming}>
              <IconCheck size={15} /> {renaming ? 'Renaming' : 'Rename'}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

interface DeleteWorkspaceDialogProps {
  workspace: EngineeringGraph;
  onDelete: () => Promise<void>;
  deleting?: boolean;
  disabled?: boolean;
  blockedReason?: string;
}

function DeleteWorkspaceDialog({ workspace, onDelete, deleting, disabled, blockedReason }: DeleteWorkspaceDialogProps) {
  const [open, setOpen] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const submit = async () => {
    if (deleting || disabled) return;
    setActionError(undefined);
    try {
      await onDelete();
      setOpen(false);
    } catch (cause) {
      setActionError(messageFrom(cause));
    }
  };

  const accessibleLabel = blockedReason
    ? `Delete workspace unavailable. ${blockedReason}`
    : 'Delete workspace';

  return (
    <AlertDialog.Root open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      setActionError(undefined);
    }}>
      <Tooltip content={blockedReason ?? 'Delete workspace'}>
        <AlertDialog.Trigger>
          <Button size="1" variant="ghost" color="red" aria-label={accessibleLabel} disabled={disabled}>
            <IconTrash size={15} />
          </Button>
        </AlertDialog.Trigger>
      </Tooltip>
      <AlertDialog.Content maxWidth="460px">
        <AlertDialog.Title>Delete workspace?</AlertDialog.Title>
        <AlertDialog.Description size="2">
          This removes <strong>{workspace.name}</strong>, its drafts, plans, executions, and source metadata from the workbench. Uploaded content objects remain in local content-addressed storage. This action cannot be undone in the workbench.
        </AlertDialog.Description>
        {actionError && <Text as="p" size="1" color="red" role="alert" className="workspace-dialog-error">{actionError}</Text>}
        <Flex justify="end" gap="2" mt="4">
          <AlertDialog.Cancel><Button variant="soft" color="gray" disabled={deleting}>Cancel</Button></AlertDialog.Cancel>
          <Button color="red" onClick={() => void submit()} disabled={deleting}>
            <IconTrash size={15} /> {deleting ? 'Deleting' : 'Delete workspace'}
          </Button>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The workspace action failed.';
}

function folderPickerError(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause || 'Unknown desktop error');
  return `Could not open the local project folder picker. ${detail}`;
}

function folderPickerOpenLabel(platform?: string): string {
  return platform === 'macos' || platform === 'darwin' ? 'Finder open' : 'Folder picker open';
}

function folderPickerOpenStatus(platform?: string): string {
  const picker = platform === 'macos' || platform === 'darwin' ? 'Finder' : 'The system folder picker';
  return `${picker} is open. Select a folder or cancel there to continue.`;
}

function pathLeaf(value: string): string {
  const parts = value.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts.at(-1) || value;
}
