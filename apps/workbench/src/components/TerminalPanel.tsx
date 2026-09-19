import { useEffect, useRef, useState } from 'react';
import { terminalApi, type TerminalSession } from '../lib/terminal-api';
import './terminal.css';

interface TerminalPanelProps { graphId: string; workspacePath?: string; disabledReason?: string }
// Render output as text. Terminal control sequences never become HTML or links.
function plainOutput(value: string) { return value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ''); }

export function TerminalPanel({ graphId, workspacePath, disabledReason }: TerminalPanelProps) {
  const [session, setSession] = useState<TerminalSession | null>(null);
  const [output, setOutput] = useState('');
  const [input, setInput] = useState('');
  const [raw, setRaw] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [follow, setFollow] = useState(true);
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const outputRef = useRef<HTMLPreElement>(null);
  const sequence = useRef(0);
  const running = session?.status === 'running' || session?.status === 'starting';
  const blockedReason = disabledReason || (!workspacePath ? 'Bind a local project folder to use the terminal.' : '');
  useEffect(() => {
    let active = true;
    setSession(null); setOutput(''); setError(''); setInput(''); setCommandHistory([]); sequence.current = 0;
    void terminalApi.get(graphId).then((result) => { if (active) { setSession(result.session); setOutput(result.session?.output ?? ''); sequence.current = result.session?.lastSequence ?? 0; } }).catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, [graphId]);
  useEffect(() => {
    if (!session || !['starting', 'running', 'stopping'].includes(session.status)) { setConnected(false); return; }
    const stream = new EventSource(terminalApi.eventsUrl(session.id));
    stream.onopen = () => setConnected(true);
    stream.onerror = () => setConnected(false);
    stream.addEventListener('snapshot', (event) => {
      const next = JSON.parse((event as MessageEvent).data) as TerminalSession;
      setSession(next); setOutput(next.output); sequence.current = next.lastSequence;
    });
    stream.addEventListener('output', (event) => {
      const record = JSON.parse((event as MessageEvent).data) as { sequence: number; text: string };
      if (record.sequence <= sequence.current) return;
      sequence.current = record.sequence;
      setOutput((current) => (current + record.text).slice(-1024 * 1024));
    });
    stream.addEventListener('state', (event) => {
      const next = JSON.parse((event as MessageEvent).data) as TerminalSession;
      setSession(next);
      if (next.status === 'exited' || next.status === 'failed') { stream.close(); setConnected(false); }
    });
    return () => { stream.close(); setConnected(false); };
  }, [session?.id, Boolean(session && ['starting', 'running', 'stopping'].includes(session.status))]);
  useEffect(() => { if (follow && outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight; }, [output, follow]);
  const open = async () => {
    setBusy(true); setError('');
    try { const result = await terminalApi.open(graphId); setSession(result.session); setOutput(result.session.output); sequence.current = result.session.lastSequence; } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const send = async (value = input, eof = false) => {
    if (!session || (!value && !eof)) return;
    setBusy(true); setError('');
    try { await terminalApi.input(session.id, eof ? '\x04' : raw ? value : `${value}\n`); if (!eof) { setCommandHistory((current) => [...current.filter((command) => command !== value), value].slice(-100)); setInput(''); setHistoryIndex(-1); } } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };
  const control = async (action: 'interrupt' | 'stop') => {
    if (!session) return;
    setBusy(true); setError('');
    try { const result = await terminalApi[action](session.id); setSession(result.session); } catch (cause) { setError(errorMessage(cause)); } finally { setBusy(false); }
  };

  return <section className="terminal-panel" aria-label="Workspace terminal">
    <header className="terminal-toolbar"><div><strong>Shell</strong><span>{session?.status ?? 'Closed'}{running ? connected ? ' · Live' : ' · Connecting' : session?.exitCode !== null && session?.exitCode !== undefined ? ` · exit ${session.exitCode}` : ''}</span><code title={session?.workspacePath ?? workspacePath}>{session?.workspacePath ?? workspacePath ?? 'No project folder'}</code></div><div className="terminal-actions"><label><input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} /> Follow</label><button type="button" onClick={() => setOutput('')}>Clear</button>{running || session?.status === 'stopping' ? <><button type="button" onClick={() => void control('interrupt')} disabled={busy || session?.status !== 'running'}>Ctrl+C</button><button type="button" onClick={() => void control('stop')} disabled={busy || session?.status === 'stopping'}>Stop shell</button></> : <button type="button" onClick={() => void open()} disabled={busy || Boolean(blockedReason)}>{busy ? 'Opening…' : 'Open shell'}</button>}</div></header>
    {blockedReason && <p className="terminal-notice">{blockedReason}</p>}
    {error && <p className="terminal-error" role="alert">{error}</p>}
    {session?.error && <p className={session.status === 'failed' ? 'terminal-error' : 'terminal-notice'}>{session.error}</p>}
    {session?.truncated && <p className="terminal-notice">Earlier output was trimmed to keep the latest 1 MiB.</p>}
    <pre ref={outputRef} className="terminal-output" aria-label="Shell output" tabIndex={0}>{plainOutput(output) || (running ? 'Waiting for shell output…' : 'Open an interactive local shell in this project folder. Commands run on your computer. Stop the shell before executing an approved plan.')}</pre>
    <form className="terminal-input" onSubmit={(event) => { event.preventDefault(); void send(); }}><span aria-hidden="true">❯</span><input aria-label="Shell input" value={input} placeholder={raw ? 'Raw stdin, without a newline' : 'Enter a shell command'} disabled={session?.status !== 'running' || Boolean(blockedReason) || busy} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'c') { event.preventDefault(); void control('interrupt'); }
      if (event.key === 'ArrowUp' && commandHistory.length) { event.preventDefault(); const index = historyIndex < 0 ? commandHistory.length - 1 : Math.max(0, historyIndex - 1); setHistoryIndex(index); setInput(commandHistory[index]); }
      if (event.key === 'ArrowDown' && historyIndex >= 0) { event.preventDefault(); const index = historyIndex + 1; setHistoryIndex(index >= commandHistory.length ? -1 : index); setInput(commandHistory[index] ?? ''); }
    }} /><label><input type="checkbox" checked={raw} onChange={(event) => setRaw(event.target.checked)} /> Raw</label><button type="submit" disabled={session?.status !== 'running' || Boolean(blockedReason) || busy || !input}>Send</button><button type="button" title="Send end of input" onClick={() => void send('', true)} disabled={session?.status !== 'running' || Boolean(blockedReason) || busy}>EOF</button></form>
    <p className="terminal-caption">Interactive PTY · line input · output view does not emulate full-screen terminal applications</p>
  </section>;
}
function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : 'Terminal request failed.'; }
