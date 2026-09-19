import { useState } from 'react';
import { IconArrowRight, IconTrash } from '@tabler/icons-react';
import type { EngineeringGraph, GraphEdge } from '../lib/types';
import { previewRelations, RELATION_TYPES } from '../lib/graph-editing';
export function RelationsPanel({ graph, initialSelection = [], readOnly, onChange, onSuggest }: {
  graph: EngineeringGraph; initialSelection?: string[]; readOnly?: boolean; onChange: (edges: GraphEdge[]) => void; onSuggest: (ids: string[]) => void;
}) {
  const [sources, setSources] = useState<string[]>(initialSelection);
  const [targets, setTargets] = useState<string[]>([]);
  const [type, setType] = useState('RELATED_TO');
  const [label, setLabel] = useState('');
  const [filter, setFilter] = useState('');
  const [editError, setEditError] = useState('');
  const preview = previewRelations(graph.nodes, graph.edges, sources, targets, type);
  const title = (id: string) => graph.nodes.find((node) => node.id === id)?.title ?? id;
  const toggle = (ids: string[], id: string) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
  const add = () => { if (readOnly || preview.error) return; onChange([...graph.edges, ...preview.pairs.map((pair) => ({ ...pair, id: crypto.randomUUID(), type, label: label.trim(), rationale: label.trim() }))]); setTargets([]); };
  const update = (edge: GraphEdge, patch: Partial<GraphEdge>) => {
    const next = { ...edge, ...patch };
    const validation = previewRelations(graph.nodes, graph.edges.filter((item) => item.id !== edge.id), [next.source], [next.target], next.type ?? 'RELATED_TO');
    if (validation.error || validation.pairs.length === 0) { setEditError(validation.error ?? 'This relationship already exists.'); return; }
    setEditError(''); onChange(graph.edges.map((item) => item.id === edge.id ? next : item));
  };
  return <section className="relations-editor editor-page" aria-label="Relationship editor">
    <header className="editor-page-heading"><div><h1>Relationships</h1><p>Connect context, evidence, and work. Preview every connection before applying.</p></div><button type="button" className="quiet-button" onClick={() => onSuggest([...new Set([...sources, ...targets])])}>Suggest with AI</button></header>
    <div className="relation-builder">
      <fieldset disabled={readOnly}><legend>Source nodes <span>{sources.length}</span></legend>{graph.nodes.map((node) => <label key={node.id}><input type="checkbox" checked={sources.includes(node.id)} onChange={() => setSources(toggle(sources, node.id))} />{node.title}</label>)}</fieldset>
      <div className="relation-type"><IconArrowRight size={20} /><label>Relationship<select aria-label="Relationship type" value={type} onChange={(event) => setType(event.target.value)} disabled={readOnly}>{RELATION_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><small>{RELATION_TYPES.find((item) => item.value === type)?.detail}</small></div>
      <fieldset disabled={readOnly}><legend>Target nodes <span>{targets.length}</span></legend>{graph.nodes.map((node) => <label key={node.id}><input type="checkbox" checked={targets.includes(node.id)} onChange={() => setTargets(toggle(targets, node.id))} />{node.title}</label>)}</fieldset>
    </div>
    <div className="relation-apply"><label>Explanation <input aria-label="Relationship explanation" placeholder="Why are these nodes connected?" value={label} disabled={readOnly} onChange={(event) => setLabel(event.target.value)} /></label><button type="button" className="primary-button" disabled={readOnly || !preview.pairs.length || Boolean(preview.error)} onClick={add}>Add {preview.pairs.length} relationships</button></div>
    {preview.ignored > 0 && <p className="muted">{preview.ignored} self or existing connections excluded.</p>}
    {(preview.error || editError) && <p role="alert" className="inline-error">{preview.error ?? editError}</p>}
    <div className="relation-list-heading"><h2>All relationships <span>{graph.edges.length}</span></h2><input aria-label="Filter relationships" placeholder="Filter relationships…" value={filter} onChange={(event) => setFilter(event.target.value)} /></div>
    <div className="relation-table"><table><thead><tr><th>Source</th><th>Relationship</th><th>Target</th><th>Explanation</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{graph.edges.filter((edge) => `${title(edge.source)} ${title(edge.target)} ${edge.type} ${edge.label} ${edge.rationale}`.toLowerCase().includes(filter.toLowerCase())).map((edge) => <tr key={edge.id}><td>{title(edge.source)}</td><td><select aria-label={`Type for ${title(edge.source)} to ${title(edge.target)}`} value={edge.type ?? 'RELATED_TO'} disabled={readOnly} onChange={(event) => update(edge, { type: event.target.value })}>{RELATION_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}{!RELATION_TYPES.some((item) => item.value === edge.type) && edge.type && <option value={edge.type}>{edge.type}</option>}</select></td><td>{title(edge.target)}</td><td><input aria-label={`Explanation for ${title(edge.source)} to ${title(edge.target)}`} value={edge.rationale ?? (edge.label === edge.type ? '' : edge.label) ?? ''} disabled={readOnly} onChange={(event) => update(edge, { label: event.target.value, rationale: event.target.value })} /></td><td><button type="button" aria-label={`Remove relationship ${title(edge.source)} to ${title(edge.target)}`} disabled={readOnly} onClick={() => onChange(graph.edges.filter((item) => item.id !== edge.id))}><IconTrash size={15} /></button></td></tr>)}</tbody></table>{graph.edges.length === 0 && <p className="muted">Select sources and targets to create your first relationship.</p>}</div>
  </section>;
}
