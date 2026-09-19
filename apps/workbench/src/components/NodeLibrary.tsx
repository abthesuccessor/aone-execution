import { useState } from 'react';
import { Button, Dialog, Flex, Text, TextArea, TextField, Tooltip } from '@radix-ui/themes';
import { IconCheck, IconFilePlus, IconPlus } from '@tabler/icons-react';
import type { NewTopicNodeInput } from '../lib/templates';
import type { TopicNode } from '../lib/types';

export interface NewNodeRequest extends NewTopicNodeInput {
  files: File[];
}

interface NodeLibraryProps {
  nodes: TopicNode[];
  selectedNodeId?: string;
  onSelectNode: (nodeId: string) => void;
  onAdd: (input: NewNodeRequest) => Promise<boolean>;
  disabled?: boolean;
  creating?: boolean;
  search?: string;
  onSearch?: (value: string) => void;
  onOpenNode?: (nodeId: string) => void;
}

export function NodeLibrary({ nodes, selectedNodeId, onSelectNode, onAdd, disabled, creating, search = '', onSearch, onOpenNode }: NodeLibraryProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [context, setContext] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const reset = () => {
    setTitle('');
    setObjective('');
    setContext('');
    setFiles([]);
  };

  const submit = async () => {
    if (!title.trim() || !objective.trim()) return;
    const created = await onAdd({ title, objective, context, files });
    if (!created) return;
    reset();
    setOpen(false);
  };

  return (
    <aside className="node-library" aria-label="Topic node library">
      <div className="panel-heading">
        <Text size="1" weight="bold">Explorer</Text>
        <Dialog.Root open={open} onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) reset();
        }}>
          <Tooltip content="Create node">
            <Dialog.Trigger>
              <Button
                size="1"
                variant="ghost"
                color="gray"
                className="node-library-add"
                disabled={disabled}
                aria-label="Create node"
              >
                <IconPlus size={16} stroke={1.8} />
              </Button>
            </Dialog.Trigger>
          </Tooltip>
          <Dialog.Content maxWidth="480px">
            <Dialog.Title>Create node</Dialog.Title>
            <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
              <Flex direction="column" gap="3" mt="3">
                <label className="field-label">
                  <Text size="1" weight="medium">Name</Text>
                  <TextField.Root
                    autoFocus
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="Customer onboarding"
                    aria-label="Node name"
                  />
                </label>
                <label className="field-label">
                  <Text size="1" weight="medium">Objective</Text>
                  <TextArea
                    value={objective}
                    onChange={(event) => setObjective(event.target.value)}
                    placeholder="Describe the outcome for this node"
                    aria-label="Node objective"
                    rows={3}
                  />
                </label>
                <label className="field-label">
                  <Text size="1" weight="medium">Context</Text>
                  <TextArea
                    value={context}
                    onChange={(event) => setContext(event.target.value)}
                    placeholder="Optional constraints, references, or known details"
                    aria-label="Node context"
                    rows={4}
                  />
                </label>
                <label className="field-label">
                  <Text size="1" weight="medium">Source evidence</Text>
                  <span className="source-file-control">
                    <IconFilePlus size={15} aria-hidden="true" />
                    <span>{files.length > 0 ? `${files.length} ${files.length === 1 ? 'file' : 'files'} selected` : 'Choose files'}</span>
                    <input
                      type="file"
                      multiple
                      onChange={(event) => setFiles(Array.from(event.target.files ?? []))}
                      aria-label="Source files for new node"
                      disabled={creating}
                    />
                  </span>
                  <Text size="1" color="gray">Any bounded file is retained. Text, data, Markdown, and XLSX sources are parsed; other formats remain opaque.</Text>
                  {files.length > 0 && (
                    <span className="selected-file-list" aria-live="polite">
                      {files.map((file) => <span key={`${file.name}:${file.size}`}>{file.name}</span>)}
                    </span>
                  )}
                </label>
              </Flex>
              <Flex justify="end" gap="2" mt="4">
                <Dialog.Close><Button type="button" variant="soft" color="gray">Cancel</Button></Dialog.Close>
                <Button type="submit" color="cyan" disabled={!title.trim() || !objective.trim() || creating}>
                  <IconCheck size={15} /> {creating ? 'Creating' : files.length > 0 ? 'Create and upload' : 'Create node'}
                </Button>
              </Flex>
            </form>
          </Dialog.Content>
        </Dialog.Root>
      </div>
      {onSearch && <input className="explorer-search" aria-label="Find nodes" placeholder="Find nodes…" value={search} onChange={(event) => onSearch(event.target.value)} />}
      <div className="node-library-list" aria-label="Workspace nodes">
        {nodes.length > 0 ? nodes.filter((node) => `${node.title} ${node.objective} ${node.group ?? ''}`.toLowerCase().includes(search.toLowerCase())).map((node) => (
          <button
            key={node.id}
            type="button"
            className={`node-library-item${node.id === selectedNodeId ? ' is-selected' : ''}`}
            aria-label={`Refine node ${node.title}`}
            aria-pressed={node.id === selectedNodeId}
            onClick={() => onSelectNode(node.id)}
            onDoubleClick={() => onOpenNode?.(node.id)}
          >
            <span className="node-library-item-title">{node.breakpoint ? '● ' : ''}{node.title}</span>
            <span className="node-library-item-objective">{node.objective || 'No objective yet'}</span>
          </button>
        )) : (
          <p className="node-library-empty">No nodes yet. Use + to create one.</p>
        )}
      </div>
    </aside>
  );
}
