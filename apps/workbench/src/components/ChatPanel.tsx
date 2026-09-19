import { useEffect, useRef, useState } from 'react';
import { chatApi, type ChatAction, type ChatActionRequest, type ChatConversation, type ChatMessage, type ChatSource, type ChatTemplate } from '../lib/chat-api';
import type { ProviderStatus } from '../lib/types';
import { harnessApi, type HarnessOptions } from '../lib/harness-api';
import { HarnessRunDetails } from './HarnessRunDetails';
import './chat.css';

export type { ChatActionRequest } from '../lib/chat-api';
interface ChatPanelProps {
  engineeringHarness?: HarnessOptions;
  onHarnessSettings?: () => void;
  graphId: string;
  graphRevision?: number;
  catalogVersion?: number;
  contextStale?: boolean;
  canApply?: boolean;
  providerId: string;
  providers?: ProviderStatus[];
  nodeIds?: string[];
  actionRequest?: ChatActionRequest | null;
  onBeforeSend?: () => Promise<void>;
  onApplied?: () => Promise<void> | void;
  onApplyingChange?: (applying: boolean) => void;
}
const SUPPORTED = new Set(['openai-api', 'anthropic-api', 'ollama', 'codex-cli']);
const ACTION_LABELS: Record<ChatAction, string> = { discuss: 'Discuss', refine: 'Refine', 'fact-check': 'Fact-check', develop: 'Develop' };
const sameScope = (left: string[], right: string[]) => [...left].sort().join('|') === [...right].sort().join('|');

export function ChatPanel({ graphId, graphRevision, catalogVersion, contextStale = false, canApply = true, providerId, providers = [], nodeIds = [], actionRequest, onBeforeSend, onApplied, onApplyingChange, engineeringHarness, onHarnessSettings }: ChatPanelProps) {
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [conversation, setConversation] = useState<ChatConversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [scope, setScope] = useState<string[]>(nodeIds);
  const [nodes, setNodes] = useState<Array<{ id: string; title: string }>>([]);
  const [sources, setSources] = useState<ChatSource[]>([]);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [templates, setTemplates] = useState<ChatTemplate[]>([]);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [action, setAction] = useState<ChatAction>('discuss');
  const [content, setContent] = useState('');
  const [selectedProvider, setSelectedProvider] = useState(providerId);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState('');
  const [error, setError] = useState('');
  const [pendingUser, setPendingUser] = useState('');
  const [stopRequested, setStopRequested] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState('');
  const graphRef = useRef(graphId); graphRef.current = graphId;
  const active = useRef<AbortController | null>(null);
  const streamStarted = useRef(false);
  const generation = useRef(0);
  const conversationRef = useRef<ChatConversation | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const lastAction = useRef('');
  const scopePinned = useRef(false);
  const lastCatalogVersion = useRef(catalogVersion);
  const initialSources = useRef('');

  useEffect(() => { setSelectedProvider(providerId); }, [providerId]);
  useEffect(() => {
    generation.current += 1;
    setMemoryNotice('');
    active.current?.abort(); active.current = null;
    setMessages([]); setConversation(null); conversationRef.current = null; setConversations([]); setScope(nodeIds); setError(''); setBusy(false); setContent(''); setPendingUser(''); setTemplatesLoaded(false); scopePinned.current = false; initialSources.current = '';
    const current = generation.current;
    void Promise.all([chatApi.list(graphId), chatApi.templates(graphId), chatApi.context(graphId)]).then(([list, promptList, context]) => {
      if (current !== generation.current) return;
      setConversations(list.items); setTemplates(promptList.items); setTemplatesLoaded(true); setSources(context.sources); setNodes(context.nodes);
    }).catch((cause: Error) => { if (current === generation.current) { setTemplatesLoaded(true); setError(cause.message); } });
    return () => { generation.current += 1; active.current?.abort(); };
    // A graph switch resets the context; selection changes are explicit New/Discuss actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId]);

  useEffect(() => {
    if (lastCatalogVersion.current === catalogVersion) return;
    lastCatalogVersion.current = catalogVersion;
    let cancelled = false;
    void chatApi.templates(graphId).then(({ items }) => { if (!cancelled) setTemplates(items); }).catch((cause: Error) => { if (!cancelled) setError(cause.message); });
    return () => { cancelled = true; };
  }, [catalogVersion, graphId]);

  useEffect(() => {
    if (!actionRequest || lastAction.current === actionRequest.id || busy || (!templatesLoaded && !actionRequest.prompt)) return;
    lastAction.current = actionRequest.id; scopePinned.current = true;
    setScope(actionRequest.nodeIds); setConversation(null); conversationRef.current = null; setMessages([]); setError(''); setAction(actionRequest.action);
    const template = templates.find((item) => item.action === actionRequest.action);
    setTemplateId(template?.id || ''); setContent(actionRequest.prompt || template?.prompt || `${ACTION_LABELS[actionRequest.action]} the selected nodes.`);
  }, [actionRequest, busy, templates, templatesLoaded]);

  useEffect(() => {
    if (!conversation && !busy && !content.trim() && !scopePinned.current && !sameScope(scope, nodeIds)) setScope(nodeIds);
  }, [conversation, busy, content, scope, nodeIds]);

  useEffect(() => {
    const key = `${graphId}:${[...scope].sort().join('|')}`;
    if (initialSources.current !== key && sources.length) {
      initialSources.current = key;
      setSourceIds(sources.filter((source) => !source.nodeId || !scope.length || scope.includes(source.nodeId)).slice(0, 10).map((source) => source.id));
    }
  }, [scope, sources, graphId]);

  useEffect(() => {
    let cancelled = false;
    void chatApi.context(graphId).then((context) => { if (!cancelled) { setSources(context.sources); setNodes(context.nodes); } }).catch(() => {});
    if (conversation?.graphId === graphId && !busy) void chatApi.get(graphId, conversation.id).then((data) => { if (!cancelled) setMessages(data.messages); }).catch(() => {});
    return () => { cancelled = true; };
    // Refresh persisted assessments when the draft changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graphId, graphRevision]);
  useEffect(() => { transcript.current?.scrollTo?.({ top: transcript.current.scrollHeight }); }, [messages, pendingUser]);

  const visibleSources = sources.filter((source) => !source.nodeId || !scope.length || scope.includes(source.nodeId));
  const connectedProvider = providers.find((provider) => provider.id === selectedProvider);
  const canChat = SUPPORTED.has(selectedProvider) && (!providers.length || connectedProvider?.connection?.status === 'CONNECTED');
  const scopeLabel = scope.length ? scope.map((id) => nodes.find((node) => node.id === id)?.title || id).join(', ') : 'Workspace';

  async function selectConversation(id: string) {
    if (!id) { scopePinned.current = false; setConversation(null); conversationRef.current = null; setMessages([]); setScope(nodeIds); return; }
    setError(''); const current = ++generation.current;
    try {
      const result = await chatApi.get(graphId, id);
      if (current !== generation.current) return;
      scopePinned.current = true;
      initialSources.current = `${graphId}:${[...result.conversation.nodeIds].sort().join('|')}`;
      setConversation(result.conversation); conversationRef.current = result.conversation; setScope(result.conversation.nodeIds); setMessages(result.messages);
      const last = result.messages.at(-1);
      if (last?.context.evidence) setSourceIds(last.context.evidence.map((source) => source.id));
    } catch (cause) { if (current === generation.current) setError((cause as Error).message); }
  }

  async function send(text = content, retryAction = action, resumeRunId?: string) {
    if (!text.trim() || busy || active.current || !canChat) return;
    const taskGraph = graphId; const current = generation.current; setBusy(true); setStopRequested(false); setError('');
    let target = conversation;
    const controller = new AbortController(); active.current = controller; streamStarted.current = false;
    try {
      onApplyingChange?.(true);
      try { await onBeforeSend?.(); } finally { onApplyingChange?.(false); }
      if (current !== generation.current || controller.signal.aborted) return;
      if (!target || !sameScope(target.nodeIds, scope)) {
        target = (await chatApi.create(taskGraph, scope)).conversation;
        if (current !== generation.current || controller.signal.aborted) return;
        setConversation(target); conversationRef.current = target; setConversations((previous) => [target!, ...previous]);
      }
      streamStarted.current = true;
      setContent(''); setPendingUser(text); let messageId = '';
      await chatApi.send(taskGraph, target.id, { content: text.trim(), providerId: selectedProvider, action: retryAction, sourceIds: sourceIds.filter((id) => visibleSources.some((source) => source.id === id)), ...(templateId ? { templateId } : {}), ...(engineeringHarness ? { engineeringHarness: { ...engineeringHarness, ...(resumeRunId ? { enabled: true, resumeRunId } : {}) } } : {}) }, (type, event) => {
        if (current !== generation.current) return;
        if (type === 'message' && event.message) { messageId = event.message.id; setMessages((previous) => [...previous.filter((item) => item.id !== event.message!.id), event.message!]); }
        if (type === 'harness' && event.run) setMessages((previous) => previous.map((message) => message.id === messageId ? { ...message, harness: event.run } : message));
        if (type === 'delta') setMessages((previous) => previous.map((message) => message.id === messageId ? { ...message, content: message.content + (event.text || '') } : message));
        if (type === 'activity') setMessages((previous) => previous.map((message) => message.id === messageId ? { ...message, activities: [...(message.activities || []), event.activity!] } : message));
        if (type === 'usage') setMessages((previous) => previous.map((message) => message.id === messageId ? { ...message, usage: event.usage } : message));
        if (type === 'done' && event.message) setMessages((previous) => previous.map((message) => message.id === event.message!.id ? event.message! : message));
      }, controller.signal);
    } catch (cause) {
      if (current === generation.current) { setError((cause as Error).message); setContent(text); }
    } finally {
      if (current === generation.current) {
        active.current = null; setBusy(false); setStopRequested(false); setPendingUser('');
        if (target) try { const latest = await chatApi.get(taskGraph, target.id); if (current === generation.current) setMessages(latest.messages); } catch { /* Keep already received data visible. */ }
      }
    }
  }

  async function stop() {
    const target = conversationRef.current;
    setStopRequested(true);
    if (!target || !streamStarted.current) { active.current?.abort(); return; }
    try { await chatApi.stop(graphId, target.id); } catch (cause) { setError((cause as Error).message); active.current?.abort(); }
  }
  async function apply(message: ChatMessage) {
    if (!message.proposal || applying || busy || !canApply || contextStale) return;
    const appliedGraphId = graphId;
    setApplying(message.proposal.id); setError(''); onApplyingChange?.(true);
    try {
      await onBeforeSend?.();
      if (graphRef.current !== appliedGraphId) return;
      const result = await chatApi.apply(appliedGraphId, message.proposal.id);
      if (graphRef.current !== appliedGraphId) return;
      setMessages((previous) => previous.map((item) => item.id === message.id ? { ...item, proposal: result.proposal } : item));
      await onApplied?.();
    } catch (cause) { setError((cause as Error).message); }
    finally { setApplying(''); onApplyingChange?.(false); }
  }

  async function remember(message: ChatMessage) {
    const current = generation.current;
    setError(''); setMemoryNotice('');
    try { await harnessApi.remember(graphId, { kind: 'decision', content: message.content.slice(0, 8000), nodeIds: message.context.nodes.map((node) => node.id), provenance: { messages: [{ id: message.id }] }, validation: { state: 'suggested', reason: 'AI response retained for user review; not an accepted fact.' } }); if (current === generation.current) setMemoryNotice('Saved as candidate memory. Review it in Harness → Memory before reuse.'); }
    catch (cause) { if (current === generation.current) setError((cause as Error).message); }
  }

  return <section className="ai-chat-panel" aria-label="AI chat">
    <div className="ai-chat-toolbar">
      <select aria-label="Conversation history" value={conversation?.id || ''} disabled={busy} onChange={(event) => void selectConversation(event.target.value)}>
        <option value="">New conversation</option>
        {conversations.map((item) => <option key={item.id} value={item.id}>{item.title} · {new Date(item.updatedAt).toLocaleDateString()}</option>)}
      </select>
      <button type="button" disabled={busy} title="New conversation with current node selection" onClick={() => { void selectConversation(''); setContent(''); }}>New</button>
    </div>
    <details className="ai-chat-context" onToggle={(event) => { if (event.currentTarget.open) void chatApi.context(graphId).then((data) => { setSources(data.sources); setNodes(data.nodes); }).catch(() => {}); }}>
      <summary title={scopeLabel}>Context · {scope.length === 1 ? scopeLabel : scope.length ? `${scope.length} selected nodes` : 'Workspace'} · {sourceIds.length} attachments</summary>
      <p>{scopeLabel}</p>
      <p className="ai-chat-muted">Saved graph context and chosen evidence are sent to the selected provider.</p>
      {visibleSources.length ? visibleSources.map((source) => <label className="ai-chat-source" key={source.id}>
        <input type="checkbox" disabled={busy} checked={sourceIds.includes(source.id)} onChange={(event) => setSourceIds((previous) => event.target.checked ? [...previous, source.id] : previous.filter((id) => id !== source.id))} />
        <span>{source.filename}<small>{source.parseStatus === 'PARSED' ? `${source.chunkCount} excerpts available` : source.parseStatus.toLowerCase()}</small></span>
      </label>) : <p className="ai-chat-muted">No attached evidence. Add files in the node inspector or workspace Sources.</p>}
      {!sameScope(scope, nodeIds) && <button type="button" disabled={busy} onClick={() => void selectConversation('')}>Use current node selection in a new conversation</button>}
    </details>
    <div className="ai-chat-transcript" ref={transcript} aria-label="Conversation messages" aria-busy={busy}>
      {!messages.length && !pendingUser && <div className="ai-chat-empty"><strong>{nodes.length ? 'Work through your graph' : 'Create your first nodes with AI'}</strong>{!nodes.length && <><p>Describe what you want to build. AI can propose nodes and relationships for you to review.</p><button type="button" onClick={() => { setAction('refine'); setTemplateId(''); setContent('Create a small graph for my project with clear objectives, acceptance criteria, and useful relationships. My project: '); }}>Draft a graph</button></>}<p>Discuss a node, refine its requirements, check evidence, or prepare implementation work.</p><p>Review proposed changes before Apply. Use Plan and Run to execute accepted work.</p></div>}
      {messages.map((message) => {
        const isStale = message.stale || contextStale || (graphRevision !== undefined && message.context.draftRevision !== graphRevision);
        const previousUser = messages.slice(0, messages.indexOf(message)).filter((item) => item.role === 'user').at(-1);
        return <article className={`ai-chat-message ai-chat-${message.role}`} key={message.id}>
          <header><strong>{message.role === 'user' ? 'You' : 'Assistant'}</strong><span>{message.role === 'assistant' ? message.status : ACTION_LABELS[message.action]}</span></header>
          {message.role === 'assistant' && message.providerId && <div className="ai-chat-muted">{message.providerId}{message.model ? ` · ${message.model}` : ''}</div>}
          <div className="ai-chat-text">{message.content || (message.status === 'running' ? 'Waiting for provider…' : 'No text returned.')}</div>
          {message.harness && <HarnessRunDetails run={message.harness} disabled={busy || !canChat || isStale} onResume={() => { if (previousUser) void send(previousUser.content, previousUser.action, message.harness!.id); }} />}
          {message.error && <p className="ai-chat-error">{message.error}</p>}
          {message.claims && message.claims.length > 0 && <section className="ai-chat-claims" aria-label="Claim assessments"><div className="ai-chat-muted">AI assessment of attached evidence{isStale ? ' · Stale context — check again' : ''}</div>{message.claims.map((claim, index) => <div className="ai-chat-claim" key={index}><strong>{claim.status.replaceAll('_', ' ')}</strong><p>{claim.text}</p><p>{claim.reasoning}</p>{claim.evidenceIds.length > 0 && <small>{claim.evidenceIds.length} cited excerpt{claim.evidenceIds.length === 1 ? '' : 's'}</small>}</div>)}</section>}
          {message.citations && message.citations.length > 0 && <details><summary>Evidence · {message.citations.length} excerpts</summary>{message.citations.map((citation) => <blockquote key={citation.id}><strong>{citation.filename}</strong><p>{citation.text}</p><small>Excerpt {citation.id}</small></blockquote>)}</details>}
          {message.proposal && <section className="ai-chat-proposal" aria-label="Proposed graph changes"><strong>Proposed changes</strong><p>{message.proposal.summary}</p>
            {message.proposal.nodeUpdates.map((patch) => {
              const before = message.context.nodes.find((node) => node.id === patch.id);
              return <details key={patch.id}><summary>{before?.title || patch.id} · {Object.keys(patch).length - 1} changes</summary>{Object.entries(patch).filter(([key]) => key !== 'id').map(([key, value]) => <div className="ai-chat-diff" key={key}><strong>{key === 'description' ? 'Objective' : key}</strong><del>{JSON.stringify(before?.[key as keyof typeof before] ?? '')}</del><ins>{Array.isArray(value) ? value.join('\n') : String(value)}</ins></div>)}</details>;
            })}
            {(message.proposal.nodeAdditions || []).map((node) => <details key={node.id} className="ai-chat-new-node"><summary>Add node · {node.title}</summary><p>{node.description}</p>{node.context && <p>{node.context}</p>}{node.acceptanceCriteria && node.acceptanceCriteria.length > 0 && <ul>{node.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>}</details>)}
            {message.proposal.edgeAdditions.map((edge) => <p className="ai-chat-relation" key={edge.id}>{nodes.find((node) => node.id === edge.source)?.title || message.proposal?.nodeAdditions?.find((node) => node.id === edge.source)?.title || edge.source} → {nodes.find((node) => node.id === edge.target)?.title || message.proposal?.nodeAdditions?.find((node) => node.id === edge.target)?.title || edge.target}<small>{edge.type.toLowerCase().replaceAll('_', ' ')} · {edge.rationale}</small></p>)}
            <button type="button" disabled={busy || Boolean(applying) || !canApply || isStale || message.proposal.status === 'applied'} onClick={() => void apply(message)}>{applying === message.proposal.id ? 'Applying…' : message.proposal.status === 'applied' ? 'Applied to draft' : isStale ? 'Context changed · refine again' : 'Apply to draft'}</button>
          </section>}
          {message.proposalError && <p className="ai-chat-error">Proposal rejected: {message.proposalError}</p>}
          {message.formatWarning && <p className="ai-chat-muted">{message.formatWarning}</p>}
          {message.role === 'assistant' && <details className="ai-chat-trace"><summary>Activity & context · draft {message.context.draftRevision}{message.durationMs !== undefined ? ` · ${(message.durationMs / 1000).toFixed(1)}s` : ''}</summary>
            <p>{message.context.boundary}</p>
            {(message.activities || []).map((activity, index) => <p key={index}>{activity.label} · {activity.status}{activity.exitCode !== undefined ? ` · exit ${activity.exitCode}` : ''}</p>)}
            {message.usage && Object.keys(message.usage).length > 0 && <pre>{JSON.stringify(message.usage, null, 2)}</pre>}
            <p>{message.context.nodes.length} pinned nodes · {message.context.evidence.length} sources</p>
            {message.context.agents.map((agent) => <p key={agent.id}>{agent.name} · prompt {agent.promptDigest?.slice(0, 12) || 'unavailable'}</p>)}
            {message.context.skills.map((skill) => <p key={skill.id}>{skill.name} · {skill.contentDigest.slice(0, 12)}</p>)}
            {isStale && <p>Context changed after this response.</p>}
          </details>}
          {message.role === 'assistant' && message.status !== 'running' && previousUser && <button className="ai-chat-retry" type="button" disabled={busy || !canChat} onClick={() => void send(previousUser.content, previousUser.action)}>Retry with current context</button>}
          {message.role === 'assistant' && message.status === 'completed' && message.content && <button className="ai-chat-retry" type="button" disabled={busy || isStale} onClick={() => void remember(message)}>Keep as candidate memory</button>}
        </article>;
      })}
      {pendingUser && <div className="ai-chat-pending"><span>Sending</span> {pendingUser}</div>}
    </div>
    {error && <div className="ai-chat-error" role="alert">{error}</div>}
    {memoryNotice && <div className="ai-chat-muted" role="status">{memoryNotice}</div>}
    <div className="ai-chat-compose">
      {engineeringHarness && <div className="harness-compose-badge"><span>{engineeringHarness.enabled ? `Harness · ${engineeringHarness.profile.toUpperCase()}` : 'Direct chat'}</span><button type="button" onClick={onHarnessSettings}>Configure harness</button></div>}
      <div className="ai-chat-actions">{(Object.keys(ACTION_LABELS) as ChatAction[]).map((value) => <button key={value} type="button" aria-pressed={action === value} disabled={busy} onClick={() => { setAction(value); const template = templates.find((item) => item.action === value); setTemplateId(template?.id || ''); if (!content.trim() && template) setContent(template.prompt); }}>{ACTION_LABELS[value]}</button>)}</div>
      <div className="ai-chat-controls"><select aria-label="Chat provider" value={selectedProvider} disabled={busy} onChange={(event) => setSelectedProvider(event.target.value)}><option value="" disabled>Choose chat provider</option>{providers.length ? providers.map((provider) => <option key={provider.id} value={provider.id} disabled={!SUPPORTED.has(provider.id)}>{provider.name}{!SUPPORTED.has(provider.id) ? ' · no chat adapter' : provider.connection?.status !== 'CONNECTED' ? ' · connect in Settings' : ''}</option>) : <option value={providerId}>{providerId}</option>}</select>
        <select aria-label="Prompt template" disabled={busy} value={templateId} onChange={(event) => { const template = templates.find((item) => item.id === event.target.value); setTemplateId(event.target.value); if (template) { setAction(template.action); setContent(template.prompt); } }}><option value="">Prompt template</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}</select></div>
      {!canChat && <p className="ai-chat-muted">Connect an API provider, Ollama, or Codex CLI in Settings to chat.</p>}
      <textarea aria-label="Message AI" value={content} disabled={busy} placeholder={nodes.length ? `${ACTION_LABELS[action]} ${scope.length ? 'selected nodes' : 'your workspace'}…` : 'Describe your project to propose its first nodes…'} onChange={(event) => setContent(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />
      <div className="ai-chat-send"><small>{busy ? stopRequested ? 'Stop requested…' : 'Provider responding…' : '⌘/Ctrl + Enter to send'}</small>{busy ? <button type="button" disabled={stopRequested} onClick={() => void stop()}>Stop</button> : <button type="button" disabled={!content.trim() || !canChat || Boolean(applying)} onClick={() => void send()}>Send</button>}</div>
    </div>
  </section>;
}
