import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, Tabs } from '@radix-ui/themes';
import { IconX } from '@tabler/icons-react';
import { ApiError } from '../lib/api';
import { catalogApi, type CatalogItem } from '../lib/catalog-api';
import { engineeringSettingsApi, type CompressionLevel, type EngineeringSettings } from '../lib/engineering-settings-api';
import './engineering-settings.css';

export type EngineeringSettingsTab = 'harness' | 'memory' | 'context' | 'skills';
interface Props {
  open: boolean;
  initialTab?: EngineeringSettingsTab;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}

const compressionLevels: Array<{ value: CompressionLevel; label: string; description: string }> = [
  { value: 'off', label: 'Off', description: 'Use normal reply wording.' },
  { value: 'lite', label: 'Lite', description: 'Trim repetition and conversational filler.' },
  { value: 'full', label: 'Full', description: 'Use concise instructions and short explanations.' },
  { value: 'ultra', label: 'Ultra', description: 'Keep prose to the minimum needed for the task.' },
];

export function EngineeringSettingsDialog({ open, initialTab = 'skills', onOpenChange, onSaved }: Props) {
  const [tab, setTab] = useState<EngineeringSettingsTab>(initialTab);
  const [baseline, setBaseline] = useState<EngineeringSettings>();
  const [draft, setDraft] = useState<EngineeringSettings>();
  const [skills, setSkills] = useState<CatalogItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [catalogError, setCatalogError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const requestSequence = useRef(0);
  const dirty = Boolean(draft && baseline && JSON.stringify(draft) !== JSON.stringify(baseline));
  const validLimit = Boolean(draft && Number.isInteger(draft.context.maxCharacters) && draft.context.maxCharacters >= 4_000 && draft.context.maxCharacters <= 200_000);

  useEffect(() => {
    if (!open) return;
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    setTab(initialTab); setLoading(true); setBaseline(undefined); setDraft(undefined);
    setSkills([]); setQuery(''); setError(''); setCatalogError(''); setMessage(''); setConflict(false);
    void engineeringSettingsApi.get(controller.signal).then((value) => {
      if (sequence !== requestSequence.current) return;
      setBaseline(value); setDraft(structuredClone(value));
    }).catch((cause: unknown) => {
      if (sequence === requestSequence.current) setError(errorText(cause));
    }).finally(() => { if (sequence === requestSequence.current) setLoading(false); });
    void catalogApi.list('skills').then((value) => {
      if (sequence === requestSequence.current) setSkills(value.items);
    }).catch((cause: unknown) => {
      if (sequence === requestSequence.current) setCatalogError(errorText(cause));
    });
    return () => { requestSequence.current += 1; controller.abort(); };
  }, [open, initialTab, loadVersion]);

  const visibleSkills = useMemo(() => skills.filter((skill) => `${skill.name} ${skill.description} ${skill.id}`.toLowerCase().includes(query.toLowerCase())), [skills, query]);
  const unavailableIds = draft?.skills.disabledIds.filter((id) => !skills.some((skill) => skill.id === id)) ?? [];

  function patch(next: Partial<EngineeringSettings>) {
    setDraft((current) => current ? { ...current, ...next } : current);
    setMessage('');
  }
  function toggleSkill(id: string, enabled: boolean) {
    if (!draft) return;
    patch({ skills: { disabledIds: enabled ? draft.skills.disabledIds.filter((item) => item !== id) : [...new Set([...draft.skills.disabledIds, id])] } });
  }
  function changeOpen(next: boolean) {
    if (!next && saving) return;
    if (!next && dirty) { setError('Save or discard your changes before closing this window.'); return; }
    onOpenChange(next);
  }
  function discard() {
    if (!baseline) return;
    setDraft(structuredClone(baseline)); setMessage('Changes discarded.'); setError('');
  }
  async function save() {
    if (!draft || !dirty || !validLimit || saving || conflict) return;
    const sequence = requestSequence.current;
    setSaving(true); setError(''); setMessage('');
    try {
      const saved = await engineeringSettingsApi.save(draft);
      if (sequence !== requestSequence.current) return;
      setBaseline(saved); setDraft(structuredClone(saved)); setMessage(`Saved revision ${saved.revision}.`);
      onSaved?.();
    } catch (cause) {
      if (sequence !== requestSequence.current) return;
      if (cause instanceof ApiError && cause.status === 409) {
        setConflict(true);
        setError('Settings changed in another window. Your unsaved choices are still shown. Reload the latest settings before editing again.');
      } else setError(errorText(cause));
    } finally { if (sequence === requestSequence.current) setSaving(false); }
  }

  return <Dialog.Root open={open} onOpenChange={changeOpen}>
    <Dialog.Content maxWidth="900px" className="engineering-settings-window" onEscapeKeyDown={(event) => { if (dirty || saving) event.preventDefault(); }}>
      <header className="engineering-settings-heading">
        <div><Dialog.Title>Skills &amp; engineering</Dialog.Title><Dialog.Description>Manage skill availability and how the harness prepares context.</Dialog.Description></div>
        <button type="button" className="engineering-close" aria-label="Close engineering settings" onClick={() => changeOpen(false)} disabled={saving}><IconX size={18} /></button>
      </header>
      <Tabs.Root value={tab} onValueChange={(value) => setTab(value as EngineeringSettingsTab)} className="engineering-settings-tabs">
        <Tabs.List aria-label="Engineering settings sections"><Tabs.Trigger value="skills" aria-label="Skills">Skills</Tabs.Trigger><Tabs.Trigger value="harness" aria-label="Harness">Harness</Tabs.Trigger><Tabs.Trigger value="memory" aria-label="Memory">Memory</Tabs.Trigger><Tabs.Trigger value="context" aria-label="Context">Context</Tabs.Trigger></Tabs.List>
        <div className="engineering-settings-body" aria-busy={loading || saving}>
          {loading && <p role="status">Loading engineering settings…</p>}
          {error && <div className="engineering-settings-error" role="alert"><p>{error}</p>{(conflict || !draft) && <button type="button" disabled={saving || loading} onClick={() => setLoadVersion((value) => value + 1)}>{conflict ? 'Discard changes and reload' : 'Retry loading settings'}</button>}</div>}
          {draft && <fieldset className="engineering-settings-fields" disabled={saving || conflict}>
            <legend className="sr-only">Engineering configuration</legend>
            <Tabs.Content value="harness">
              <h2>Caveman · prose compression</h2>
              <p>Choose how concise model replies should be.</p>
              <div className="compression-choices" role="radiogroup" aria-label="Caveman compression level">{compressionLevels.map((level) => <label key={level.value} className={draft.harness.compression === level.value ? 'is-selected' : ''}><input type="radio" name="caveman-compression" value={level.value} checked={draft.harness.compression === level.value} onChange={() => patch({ harness: { compression: level.value } })} /><span><strong>{level.label}</strong><small>{level.description}</small></span></label>)}</div>
              <div className="engineering-settings-note"><strong>Keep exact technical evidence</strong><p>Caveman changes reply prose only. Code, paths, identifiers, commands, citations, and execution receipts must retain their exact meaning and values.</p><p>Concise output may reduce output tokens. The policy adds input tokens, so net savings require a matched usage comparison. No fixed reduction is guaranteed.</p></div>
            </Tabs.Content>
            <Tabs.Content value="context">
              <h2>Context engineering</h2><p>Bound the context sent into new conversations and harness stages.</p>
              <label className="engineering-toggle"><input type="checkbox" checked={draft.context.compactionEnabled} onChange={(event) => patch({ context: { ...draft.context, compactionEnabled: event.target.checked } })} /><span><strong>Enable context compaction</strong><small>Use bounded history excerpts in harness stages and select whole messages in normal chat. Original conversations remain stored.</small></span></label>
              <label className="engineering-number">Maximum context characters<input type="number" min={4000} max={200000} step={1000} value={Number.isNaN(draft.context.maxCharacters) ? '' : draft.context.maxCharacters} onChange={(event) => patch({ context: { ...draft.context, maxCharacters: event.target.value === '' ? Number.NaN : Number(event.target.value) } })} aria-invalid={!validLimit} aria-describedby="context-limit-help" /></label>
              <p id="context-limit-help" className={validLimit ? 'engineering-settings-muted' : 'engineering-settings-error'}>Use a whole number from 4,000 to 200,000. This is a character limit; model token budgets can impose a smaller limit.</p>
              <p className="engineering-settings-note">Compacted summaries are derived context. They do not replace original evidence, a reviewed decision, or an execution receipt.</p>
            </Tabs.Content>
            <Tabs.Content value="memory">
              <h2>Memory engineering</h2><p>Control whether accepted memory can supplement context.</p>
              <label className="engineering-toggle"><input type="checkbox" checked={draft.memory.enabled} onChange={(event) => patch({ memory: { enabled: event.target.checked } })} /><span><strong>Enable memory in engineering context</strong><small>Include current, reviewed memory when it is relevant to the active task.</small></span></label>
              <div className="engineering-settings-note"><strong>Memory stays reviewable</strong><p>Manage individual records, provenance, and optional remote services in Harness → Memory. Disabling memory here does not delete local records or remote copies.</p><p>Recalled memory supplies context; it does not grant approval or prove that a check passed.</p></div>
            </Tabs.Content>
            <Tabs.Content value="skills">
              <div className="engineering-skill-heading"><div><h2>Skill availability</h2><p>Enable or disable skills for engineering context. Edit their instructions in the Skills catalog.</p></div><span>{skills.length} catalog skills</span></div>
              <label className="engineering-search">Search skills<input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name, description, or ID" /></label>
              <label className="engineering-toggle engineering-caveman"><input type="checkbox" checked={draft.harness.compression !== 'off'} onChange={(event) => patch({ harness: { compression: event.target.checked ? 'lite' : 'off' } })} /><span><strong>Caveman</strong><small>Built-in prose compression · {draft.harness.compression === 'off' ? 'Off' : draft.harness.compression}. Choose the level in Harness.</small></span></label>
              {catalogError && <p role="alert" className="engineering-settings-error">The catalog could not be loaded: {catalogError}. Existing disabled skill IDs are preserved.</p>}
              <div className="engineering-skill-list">{visibleSkills.map((skill) => {
                const unavailable = skill.enabled === false || skill.archived || skill.valid === false;
                return <label key={skill.id} className="engineering-toggle" title={skill.id}><input type="checkbox" aria-label={`Enable skill ${skill.name}`} checked={!unavailable && !draft.skills.disabledIds.includes(skill.id)} disabled={unavailable} onChange={(event) => toggleSkill(skill.id, event.target.checked)} /><span><strong>{skill.name}</strong><small>{skill.description}</small><code>{skill.id}</code>{unavailable && <small>Unavailable in the catalog. Review and enable the package there first.</small>}</span></label>;
              })}{!catalogError && visibleSkills.length === 0 && <p className="engineering-settings-muted">{query ? 'No skills match this search.' : 'No catalog skills are available.'}</p>}</div>
              {unavailableIds.length > 0 && <details className="engineering-missing-skills"><summary>{unavailableIds.length} disabled IDs outside the loaded catalog</summary><p>These choices remain saved, including when a package is temporarily unavailable.</p><ul>{unavailableIds.map((id) => <li key={id}><code>{id}</code><button type="button" onClick={() => toggleSkill(id, true)}>Remove disabled override</button></li>)}</ul></details>}
            </Tabs.Content>
          </fieldset>}
        </div>
      </Tabs.Root>
      <footer className="engineering-settings-footer"><div aria-live="polite">{message ? <span role="status">{message}</span> : baseline ? <span>Revision {baseline.revision}{dirty ? ' · Unsaved changes' : ' · Saved'}</span> : null}</div><button type="button" onClick={discard} disabled={!dirty || saving}>Discard</button><button type="button" className="engineering-save" onClick={() => void save()} disabled={!dirty || saving || conflict || !validLimit}>{saving ? 'Saving…' : 'Save settings'}</button></footer>
    </Dialog.Content>
  </Dialog.Root>;
}

function errorText(cause: unknown): string { return cause instanceof Error ? cause.message : 'Engineering settings could not be saved.'; }
