import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { catalogApi, type CatalogDomain, type CatalogItem, type CatalogProvider, type CatalogRevision, type CatalogSection } from '../lib/catalog-api';
import './catalog.css';

interface CatalogPanelProps { section: CatalogSection; onChanged?: () => void; settingsAction?: ReactNode }
type Draft = { name: string; description: string; domain: string; slug: string; content: string; capabilities: string; tools: string; providerId: string; model: string; skillIds: string[]; enabled: boolean; archived: boolean };
const DEFAULT_PROMPT = 'Review this work critically and base conclusions on evidence. Cite the relevant sources and acceptance criteria for each recommendation. Never claim tests or validation passed without a recorded receipt. Identify assumptions, unresolved questions, and verification limits. Work only within the selected task and its configured tool boundaries.';
const SKILL_TEMPLATE = '---\nname: custom-skill\ndescription: A focused skill for this workspace.\n---\n\n# Instructions\n\nReview the supplied context critically. Ground conclusions in evidence and cite sources. Explain what remains unverified.\n';
function draftFor(item?: CatalogItem, section: CatalogSection = 'agents'): Draft {
  return { name: item?.name ?? '', description: item?.description ?? '', domain: item?.domain ?? '', slug: '', content: item?.currentPrompt?.prompt ?? item?.content ?? (section === 'agents' ? DEFAULT_PROMPT : section === 'skills' ? SKILL_TEMPLATE : ''), capabilities: item?.capabilities?.join(', ') ?? '', tools: item?.toolPolicy?.allowedToolClasses?.join(', ') ?? '', providerId: item?.providerId ?? '', model: item?.model ?? '', skillIds: item?.skillIds ?? [], enabled: item ? item.status !== 'DISABLED' && item.enabled !== false : true, archived: item?.archived ?? false };
}
const commaList = (value: string) => [...new Set(value.split(',').map((part) => part.trim()).filter(Boolean))];
const skillSource = (item: CatalogItem) => item.sourceProvenance?.length
  ? [...new Set(item.sourceProvenance.map(({ source }) => source === 'codex' ? 'Codex' : 'Agents'))].join(' + ')
  : item.sourceRoot === 'workspace-catalog' ? 'User configuration' : 'Catalog copy';
const skillLocation = (item: CatalogItem) => [skillSource(item), item.relativePath].filter(Boolean).join(' · ');
const supportingFileCount = (item: CatalogItem) => item.packageFiles?.filter((file) => file.path !== 'SKILL.md').length;
const supportingFilesLabel = (item: CatalogItem) => { const count = supportingFileCount(item); return count === undefined ? 'Package file list unavailable' : `${count} supporting ${count === 1 ? 'file' : 'files'}`; };

export function CatalogPanel({ section, onChanged, settingsAction }: CatalogPanelProps) {
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [skills, setSkills] = useState<CatalogItem[]>([]);
  const [domains, setDomains] = useState<CatalogDomain[]>([]);
  const [providers, setProviders] = useState<CatalogProvider[]>([]);
  const [selected, setSelected] = useState<CatalogItem>();
  const [draft, setDraft] = useState<Draft>();
  const [baseline, setBaseline] = useState('');
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [domainName, setDomainName] = useState('');
  const [history, setHistory] = useState<CatalogRevision[]>();
  const requestId = useRef(0);
  const activeSection = useRef<CatalogSection | null>(section);
  activeSection.current = section;
  const isCurrent = useCallback((sequence: number, owner: CatalogSection) => sequence === requestId.current && activeSection.current === owner, []);
  const dirty = draft !== undefined && JSON.stringify(draft) !== baseline;

  const load = useCallback(async (sequence = requestId.current) => {
    const catalog = await catalogApi.list(section);
    if (!isCurrent(sequence, section)) return catalog.items;
    setItems(catalog.items);
    if (section === 'agents') {
      setDomains(catalog.domains ?? []);
      setProviders(catalog.providers ?? []);
      const available = await catalogApi.list('skills');
      if (isCurrent(sequence, section)) setSkills(available.items);
    }
    return catalog.items;
  }, [section, isCurrent]);

  useEffect(() => {
    activeSection.current = section;
    const sequence = ++requestId.current;
    setItems([]); setSkills([]); setDomains([]); setProviders([]); setBusy(false);
    setSelected(undefined); setDraft(undefined); setBaseline(''); setError(''); setMessage(''); setHistory(undefined); setQuery(''); setLoading(true);
    void load(sequence).catch((cause) => { if (isCurrent(sequence, section)) setError(errorMessage(cause)); }).finally(() => { if (isCurrent(sequence, section)) setLoading(false); });
    return () => { requestId.current += 1; activeSection.current = null; };
  }, [load, section, isCurrent]);

  const visible = useMemo(() => items.filter((item) => (showArchived || !item.archived) && `${item.name} ${item.description} ${item.relativePath || ''} ${(item.sourceProvenance || []).map(({ source, path }) => `${source} ${path}`).join(' ')}`.toLowerCase().includes(query.toLowerCase())), [items, query, showArchived]);
  const skillPickerLabel = (skill: CatalogItem) => `${skill.name}${skills.filter((item) => item.name === skill.name).length > 1 ? ` (${skillSource(skill)} · ${skill.relativePath || skill.id})` : ''}${skill.archived ? ' (archived)' : skill.enabled === false ? ' (disabled)' : ''}`;
  const patch = (value: Partial<Draft>) => { setDraft((current) => current ? { ...current, ...value } : current); setMessage(''); };
  const select = async (item: CatalogItem) => {
    if (dirty) { setError('Save or discard your current changes before selecting another item.'); return; }
    const sequence = ++requestId.current;
    setBusy(true); setError(''); setMessage(''); setHistory(undefined);
    try {
      const result = await catalogApi.get(section, item.id);
      if (!isCurrent(sequence, section)) return;
      const next = draftFor(result.item, section);
      setSelected(result.item); setDraft(next); setBaseline(JSON.stringify(next));
    } catch (cause) { if (isCurrent(sequence, section)) setError(errorMessage(cause)); } finally { if (isCurrent(sequence, section)) setBusy(false); }
  };
  const create = () => {
    if (busy || loading) return;
    if (dirty) { setError('Save or discard your current changes before creating another item.'); return; }
    requestId.current += 1;
    const next = draftFor(undefined, section);
    next.domain = domains[0]?.id ?? '';
    setSelected(undefined); setDraft(next); setBaseline(JSON.stringify(next)); setHistory(undefined); setError(''); setMessage('');
  };
  const save = async () => {
    if (!draft) return;
    const sequence = ++requestId.current;
    setBusy(true); setError(''); setMessage('');
    try {
      const shared = { name: draft.name, description: draft.description, archived: draft.archived, expectedDigest: selected?.configDigest ?? null };
      const body = section === 'agents' ? { ...shared, ...(draft.slug ? { slug: draft.slug } : {}), domain: draft.domain, prompt: draft.content, capabilities: commaList(draft.capabilities), allowedToolClasses: commaList(draft.tools), providerId: draft.providerId, model: draft.model, skillIds: draft.skillIds, status: draft.enabled ? 'ACTIVE' : 'DISABLED', expectedPromptDigest: selected?.currentPrompt?.digest } : { ...shared, content: draft.content, enabled: draft.enabled };
      const result = await catalogApi.save(section, selected?.id, body);
      onChanged?.();
      if (!isCurrent(sequence, section)) return;
      const next = draftFor(result.item, section);
      setSelected(result.item); setDraft(next); setBaseline(JSON.stringify(next));
      await load(sequence);
      if (!isCurrent(sequence, section)) return;
      setMessage(`Saved revision ${result.item.configVersion ?? 1}.`); setHistory(undefined);
    } catch (cause) { if (isCurrent(sequence, section)) setError(errorMessage(cause)); } finally { if (isCurrent(sequence, section)) setBusy(false); }
  };
  const duplicate = () => {
    if (!draft) return;
    requestId.current += 1;
    const next = { ...draft, name: `${draft.name} copy`, slug: '', archived: false, enabled: true };
    setSelected(undefined); setDraft(next); setBaseline(''); setHistory(undefined); setMessage('Save to create this copy.');
  };
  const discard = () => { const next = draftFor(selected, section); setDraft(next); setBaseline(JSON.stringify(next)); setError(''); setMessage('Changes discarded.'); };
  const importSkill = async (file: File | undefined) => {
    if (!file || busy || loading) return;
    if (dirty) { setError('Save or discard your current changes before importing.'); return; }
    if (file.size > 131072) { setError('Skill text must be smaller than 128 KiB.'); return; }
    const sequence = ++requestId.current;
    setBusy(true);
    try {
      const content = await file.text();
      if (!isCurrent(sequence, section)) return;
      const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, '');
      const name = unquote(content.match(/^name:\s*(.+)$/m)?.[1] ?? file.name.replace(/\.md$/i, ''));
      const description = unquote(content.match(/^description:\s*(.+)$/m)?.[1] ?? 'Imported skill');
      const next = { ...draftFor(undefined, 'skills'), name, description, content };
      setSelected(undefined); setDraft(next); setBaseline(''); setError(''); setMessage('Review the imported instructions, then save.');
    } catch (cause) { if (isCurrent(sequence, section)) setError(errorMessage(cause)); } finally { if (isCurrent(sequence, section)) setBusy(false); }
  };
  const addDomain = async () => {
    if (!domainName.trim()) return;
    const sequence = ++requestId.current;
    setBusy(true); setError('');
    try { const result = await catalogApi.createDomain(domainName.trim()); onChanged?.(); if (!isCurrent(sequence, section)) return; setDomains((current) => [...current, result.item]); patch({ domain: result.item.id }); setDomainName(''); } catch (cause) { if (isCurrent(sequence, section)) setError(errorMessage(cause)); } finally { if (isCurrent(sequence, section)) setBusy(false); }
  };
  const loadHistory = async () => {
    if (!selected || history) return;
    const sequence = requestId.current;
    try { const result = await catalogApi.history(section, selected.id); if (isCurrent(sequence, section)) setHistory(result.items); } catch (cause) { if (isCurrent(sequence, section)) setError(errorMessage(cause)); }
  };

  return (
    <section className="catalog-panel" aria-label={`${section} catalog`}>
      <aside className="catalog-list">
        <header><strong>{section === 'prompts' ? 'Prompt templates' : section === 'agents' ? 'Agents' : 'Skills'}</strong><button type="button" onClick={create} disabled={busy || loading} aria-label={`Create ${section.slice(0, -1)}`}>＋ New</button></header>
        {settingsAction}
        <input aria-label={`Search ${section}`} placeholder={`Search ${section}…`} value={query} onChange={(event) => setQuery(event.target.value)} />
        {section === 'skills' && <label className="catalog-import">Import SKILL.md<input aria-label="Import skill text" type="file" accept=".md,.txt" disabled={busy || loading} onChange={(event) => { void importSkill(event.target.files?.[0]); event.target.value = ''; }} /></label>}
        <label className="catalog-check"><input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived</label>
        <div className="catalog-items">
          {loading ? <p role="status">Loading catalog…</p> : visible.length === 0 ? <p>No matching {section}.</p> : visible.map((item) => <button type="button" key={item.id} disabled={busy} className={selected?.id === item.id ? 'is-selected' : ''} title={section === 'skills' ? skillLocation(item) : undefined} onClick={() => void select(item)}><span>{item.name}</span><small>{item.archived ? 'Archived' : item.status === 'DISABLED' || item.enabled === false ? 'Disabled' : item.configVersion ? `Revision ${item.configVersion}` : 'Built-in'}{item.valid === false ? ' · Needs review' : ''}</small>{section === 'skills' && <><small>{skillSource(item)} · {supportingFilesLabel(item)}</small>{item.relativePath && <span className="catalog-hint" style={{ whiteSpace: 'nowrap' }}>{item.relativePath}</span>}</>}</button>)}
        </div>
      </aside>
      <div className="catalog-editor">
        {error && <div className="catalog-error" role="alert">{error}<button type="button" onClick={() => { setError(''); }}>Dismiss</button></div>}
        {message && <p className="catalog-message" role="status">{message}</p>}
        {!draft ? <div className="catalog-empty"><strong>Select {section === 'agents' ? 'an agent' : section === 'skills' ? 'a skill' : 'a prompt template'}</strong><p>{section === 'agents' ? 'Built-in agents work with automatic routing. Customize their instructions, runtime defaults, tools, and skills here.' : section === 'skills' ? 'Browse installed skills or add your own. Saved edits retain a version history and package fingerprints.' : 'Customize the instructions used by Ask, Refine, Fact-check, and Develop.'}</p><button type="button" onClick={create}>Create {section.slice(0, -1)}</button></div> : <>
          <header className="catalog-editor-header"><div><strong>{selected ? draft.name : `New ${section.slice(0, -1)}`}</strong><small>{selected ? `${selected.id} · ${selected.configVersion ? `revision ${selected.configVersion}` : 'built-in defaults'}` : 'User configuration'}{dirty ? ' · Unsaved changes' : ''}</small></div><div className="catalog-actions">{selected && <button type="button" onClick={duplicate} disabled={busy}>Duplicate</button>}<button type="button" onClick={discard} disabled={busy || !dirty}>Discard</button><button type="button" className="catalog-save" onClick={() => void save()} disabled={busy || !draft.name.trim() || !draft.content.trim() || (selected !== undefined && !dirty)}>{busy ? 'Saving…' : 'Save'}</button></div></header>
          <div className="catalog-form">
            {section === 'skills' && selected && <div aria-label="Skill package details">
              {selected.relativePath && <p className="catalog-fingerprint">{selected.sourceRoot === 'agent-skill-catalog' ? 'Fixed-copy path' : 'Catalog path'}<code>{selected.relativePath}</code></p>}
              <p className="catalog-hint">{supportingFilesLabel(selected)}. Supporting files are packaged resources; scripts are not run automatically.</p>
              {selected.sourceProvenance?.length ? <><strong>Verified copy source</strong>{selected.sourceProvenance.map(({ source, path }) => <p className="catalog-fingerprint" key={`${source}:${path}`}>{source === 'codex' ? 'Codex' : 'Agents'}<code>{path}</code></p>)}<p className="catalog-hint">Current instructions and package files match the import manifest.</p></> : <p className="catalog-hint">{selected.sourceRoot === 'workspace-catalog' ? 'User-configured skill.' : 'No verified import source for this package revision.'}</p>}
            </div>}
            <label>Name<input value={draft.name} onChange={(event) => patch({ name: event.target.value })} /></label>
            <label>Description<textarea rows={2} value={draft.description} onChange={(event) => patch({ description: event.target.value })} /></label>
            <div className="catalog-inline"><label className="catalog-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => patch({ enabled: event.target.checked })} /> Enabled</label><label className="catalog-check"><input type="checkbox" checked={draft.archived} onChange={(event) => patch({ archived: event.target.checked })} /> Archived</label></div>
            {section === 'agents' && <>
              {!selected && <label>Agent ID <span>Optional lowercase name with hyphens</span><input value={draft.slug} onChange={(event) => patch({ slug: event.target.value })} placeholder="my-specialist" /></label>}
              <label>Domain<select value={draft.domain} onChange={(event) => patch({ domain: event.target.value })}>{domains.map((domain) => <option key={domain.id} value={domain.id}>{domain.name}</option>)}</select></label>
              <details><summary>Add a custom domain</summary><div className="catalog-inline"><input aria-label="Custom domain name" value={domainName} onChange={(event) => setDomainName(event.target.value)} /><button type="button" onClick={() => void addDomain()} disabled={busy || !domainName.trim()}>Add domain</button></div></details>
              <div className="catalog-field-pair"><label>Runtime default<select value={draft.providerId} onChange={(event) => patch({ providerId: event.target.value })}><option value="">Inherit workspace runtime</option>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label>Model default<input placeholder="Inherit runtime model" value={draft.model} onChange={(event) => patch({ model: event.target.value })} /></label></div>
              <label>Capabilities <span>Separate with commas</span><input value={draft.capabilities} onChange={(event) => patch({ capabilities: event.target.value })} /></label>
              <label>Requested tool classes <span>Passed to the agent as instructions; workspace access uses the CLI sandbox</span><input value={draft.tools} onChange={(event) => patch({ tools: event.target.value })} placeholder="workspace.read, workspace.write, command.execute" /></label>
              <details><summary>Default skills ({draft.skillIds.length})</summary><div className="catalog-skill-picker">{skills.filter((skill) => !skill.archived || draft.skillIds.includes(skill.id)).map((skill) => <label key={skill.id} className="catalog-check" title={skillLocation(skill)}><input type="checkbox" checked={draft.skillIds.includes(skill.id)} disabled={(skill.valid === false || skill.enabled === false || skill.archived) && !draft.skillIds.includes(skill.id)} onChange={(event) => patch({ skillIds: event.target.checked ? [...draft.skillIds, skill.id] : draft.skillIds.filter((id) => id !== skill.id) })} />{skillPickerLabel(skill)}</label>)}</div><p className="catalog-hint">Automatic skill selection remains available when no skills are assigned.</p></details>
            </>}
            <label>{section === 'agents' ? 'Agent instructions' : section === 'skills' ? 'SKILL.md' : 'Prompt template'}<textarea className="catalog-content" rows={16} spellCheck={false} value={draft.content} onChange={(event) => patch({ content: event.target.value })} /></label>
            {section === 'agents' && <p className="catalog-hint">Instructions must require critical, evidence-based review, cite acceptance criteria, and never claim validation passed without a receipt.</p>}
            {selected?.validationErrors?.length ? <p className="catalog-error">{selected.validationErrors.join(' ')}</p> : null}
            {selected?.packageDigest && <p className="catalog-fingerprint">Package SHA-256 <code>{selected.packageDigest}</code></p>}
            {selected?.configDigest && <p className="catalog-fingerprint">Configuration SHA-256 <code>{selected.configDigest}</code></p>}
            {selected && <details onToggle={(event) => { if (event.currentTarget.open) void loadHistory(); }}><summary>Revision history</summary>{history?.length ? <ol className="catalog-history">{history.map((revision) => <li key={revision.digest}><strong>Revision {revision.version}</strong><time>{new Date(revision.createdAt).toLocaleString()}</time><code>{revision.digest.slice(0, 16)}</code></li>)}</ol> : <p className="catalog-hint">No user configuration revisions yet.</p>}</details>}
          </div>
        </>}
      </div>
    </section>
  );
}
function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : 'Catalog request failed.'; }
