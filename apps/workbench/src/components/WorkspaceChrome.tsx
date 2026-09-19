import { useEffect, useRef, useState } from 'react';
import { Dialog } from '@radix-ui/themes';
import { IconActivity, IconBook2, IconCommand, IconFiles, IconGitMerge, IconMessage, IconRobot, IconSettings, IconTerminal2, IconX, IconRoute } from '@tabler/icons-react';

export type EditorView = 'graph' | 'node' | 'relations' | 'agents' | 'skills' | 'prompts' | 'settings' | 'harness' | 'suggestions';
export interface WorkbenchCommand { id: string; label: string; detail?: string; shortcut?: string; run: () => void; disabled?: boolean }

export function ActivityBar({ view, onView, chatOpen, onChat, onTrace, onTerminal }: {
  view: EditorView; onView: (view: EditorView) => void; chatOpen: boolean; onChat: () => void; onTrace: () => void; onTerminal: () => void;
}) {
  const items = [
    { id: 'graph', label: 'Graph explorer', icon: IconFiles },
    { id: 'relations', label: 'Relationships', icon: IconGitMerge },
    { id: 'agents', label: 'Agents', icon: IconRobot },
    { id: 'skills', label: 'Skills', icon: IconBook2 },
    { id: 'harness', label: 'Engineering harness', icon: IconRoute },
  ] as const;
  return <nav className="activity-bar" aria-label="Workspace navigation">
    {items.map(({ id, label, icon: Icon }) => <button key={id} type="button" title={label} aria-label={label} aria-current={view === id ? 'page' : undefined} onClick={() => onView(id)}><Icon size={21} stroke={1.5} /></button>)}
    <button type="button" title="AI chat" aria-label="Toggle AI chat" aria-pressed={chatOpen} onClick={onChat}><IconMessage size={21} stroke={1.5} /></button>
    <button type="button" title="Traces" aria-label="Open traces" onClick={onTrace}><IconActivity size={21} stroke={1.5} /></button>
    <button type="button" title="Terminal" aria-label="Open terminal" onClick={onTerminal}><IconTerminal2 size={21} stroke={1.5} /></button>
    <div className="activity-spacer" />
    <button type="button" title="Settings" aria-label="Workspace settings" aria-current={view === 'settings' ? 'page' : undefined} onClick={() => onView('settings')}><IconSettings size={21} stroke={1.5} /></button>
  </nav>;
}

export function CommandPalette({ open, onOpenChange, commands }: { open: boolean; onOpenChange: (open: boolean) => void; commands: WorkbenchCommand[] }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const rows = useRef<HTMLDivElement>(null);
  const visible = commands.filter((command) => `${command.label} ${command.detail ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  useEffect(() => { if (open) { setQuery(''); setIndex(0); } }, [open]);
  useEffect(() => { rows.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView?.({ block: 'nearest' }); }, [index]);
  const run = (command?: WorkbenchCommand) => { if (!command || command.disabled) return; onOpenChange(false); command.run(); };
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Content className="command-dialog" maxWidth="640px" aria-describedby="command-help">
      <Dialog.Title className="sr-only">Workspace commands</Dialog.Title>
      <Dialog.Description id="command-help" className="sr-only">Search commands and nodes. Use arrow keys to select and Enter to open.</Dialog.Description>
      <div className="command-search"><IconCommand size={17} /><input autoFocus aria-label="Search commands" placeholder="Search commands or nodes…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} onKeyDown={(event) => {
        if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(value + 1, visible.length - 1)); }
        if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(value - 1, 0)); }
        if (event.key === 'Enter') { event.preventDefault(); run(visible[index]); }
      }} /><Dialog.Close><button type="button" aria-label="Close commands"><IconX size={16} /></button></Dialog.Close></div>
      <div ref={rows} className="command-results" aria-label="Matching commands">
        {visible.length ? visible.map((command, i) => <button type="button" key={command.id} data-index={i} className={i === index ? 'is-active' : ''} disabled={command.disabled} onFocus={() => setIndex(i)} onClick={() => run(command)}><span>{command.label}<small>{command.detail}</small></span><kbd>{command.shortcut}</kbd></button>) : <p>No matching commands.</p>}
      </div>
      <div className="command-footer">↑ ↓ Navigate <span>↵ Open</span><span>esc Close</span></div>
    </Dialog.Content>
  </Dialog.Root>;
}
