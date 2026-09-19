import { useMemo, useRef, useState } from 'react';
import type { PlanVersion } from '../lib/types';
import { harnessApi } from '../lib/harness-api';
import './harness.css';

export function SuggestionReview({ graphId, revision, plan, disabled, onApplied, onBusy }: { graphId: string; revision?: number; plan: PlanVersion; disabled: boolean; onApplied: () => Promise<void>; onBusy: (value: boolean) => void }) {
  const nodes = plan.proposedGraph?.nodes ?? [];
  const [selected, setSelected] = useState(() => nodes.map((node) => node.id));
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const attempt = useRef<{ fingerprint: string; id: string } | undefined>(undefined);
  const missing = useMemo(() => nodes.filter((node) => selected.includes(node.id)).flatMap((node) => (node.dependsOn || []).filter((id) => !selected.includes(id)).map((id) => ({ node: node.title, dependency: nodes.find((item) => item.id === id)?.title ?? id }))), [nodes, selected]);
  const apply = async () => {
    setBusy(true); onBusy(true); setError('');
    const fingerprint = JSON.stringify([plan.id, revision, [...selected].sort()]);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, id: crypto.randomUUID() };
    try { await harnessApi.adopt(graphId, plan.id, { nodeIds: selected, expectedDraftRevision: revision, requestId: attempt.current.id }); await onApplied(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); onBusy(false); }
  };
  return <section className="suggestion-review" aria-label="Review suggested nodes"><header><h1>Shape the proposed system</h1><p>Plan v{plan.version} suggested {nodes.length} specialist nodes. Choose what belongs in your scope, then edit the resulting draft. Original ideas and evidence are preserved.</p><p>This creates editable nodes and makes the current plan stale. Request and approve a fresh plan before executing.</p></header><div className="harness-actions"><button type="button" className="quiet-button" disabled={busy} onClick={() => setSelected(nodes.map((node) => node.id))}>Select all</button><button type="button" className="quiet-button" disabled={busy} onClick={() => setSelected([])}>Clear selection</button></div>{nodes.map((node) => <article key={node.id}><label><input type="checkbox" aria-label={`Include ${node.title}`} checked={selected.includes(node.id)} disabled={busy} onChange={(e) => setSelected((current) => e.target.checked ? [...current, node.id] : current.filter((id) => id !== node.id))} /><strong>{node.title}</strong></label><small>{node.objective}</small><details><summary>Acceptance and dependencies</summary><ul>{node.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul><p>Depends on: {(node.dependsOn || []).map((id) => nodes.find((item) => item.id === id)?.title || id).join(', ') || 'No prerequisite'}</p></details></article>)}{missing.length > 0 && <div role="status"><p>Some selected nodes have omitted prerequisites. Include them or revise the dependencies in the draft before requesting the next plan.</p><ul>{missing.map((item, i) => <li key={i}>{item.node} → {item.dependency}</li>)}</ul></div>}{error && <p role="alert" className="harness-error">{error}</p>}<footer><button type="button" className="quiet-button" disabled={disabled || busy || !selected.length} onClick={() => void apply()}>{busy ? 'Creating editable draft…' : `Use ${selected.length} suggested nodes`}</button><small>Review → refine → plan → execute</small></footer></section>;
}
