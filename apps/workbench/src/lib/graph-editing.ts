import type { GraphEdge, TopicNode } from './types';
export const RELATION_TYPES = [
  { value: 'RELATED_TO', label: 'Related to', detail: 'A semantic connection; does not change execution order.' },
  { value: 'REQUIRES', label: 'Required before', detail: 'Each source must finish before its targets can run.' },
  { value: 'SUPPORTS', label: 'Supports', detail: 'Source provides evidence or context supporting the target.' },
  { value: 'CONTRADICTS', label: 'Contradicts', detail: 'Source challenges a claim in the target.' },
  { value: 'PRODUCES', label: 'Produces', detail: 'Describes a produced artifact; add Required before to enforce order.' },
  { value: 'VERIFIES', label: 'Verifies', detail: 'Describes verification responsibility, not a verification result.' },
];
export function previewRelations(nodes: TopicNode[], edges: GraphEdge[], sources: string[], targets: string[], type: string): { pairs: { source: string; target: string }[]; ignored: number; error?: string } {
  const ids = new Set(nodes.map((node) => node.id));
  const existing = new Set(edges.map((edge) => `${edge.source}:${edge.target}:${edge.type ?? 'RELATED_TO'}`));
  const pairs: { source: string; target: string }[] = [];
  let ignored = 0;
  for (const source of new Set(sources)) for (const target of new Set(targets)) {
    const key = `${source}:${target}:${type}`;
    if (source === target || !ids.has(source) || !ids.has(target) || existing.has(key)) { ignored++; continue; }
    existing.add(key); pairs.push({ source, target });
  }
  if (['REQUIRES', 'DEPENDS_ON', 'CONTROL'].includes(type)) {
    const all = [...edges.filter((edge) => ['REQUIRES', 'DEPENDS_ON', 'CONTROL'].includes(edge.type ?? '')), ...pairs];
    const adjacency = new Map<string, string[]>();
    all.forEach((edge) => adjacency.set(edge.source, [...(adjacency.get(edge.source) ?? []), edge.target]));
    const visiting = new Set<string>(); const visited = new Set<string>();
    const cycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      if ((adjacency.get(id) ?? []).some(cycle)) return true;
      visiting.delete(id); visited.add(id); return false;
    };
    if ([...ids].some(cycle)) return { pairs, ignored, error: 'These dependencies create a cycle. Use a semantic relationship or remove the conflicting dependency.' };
  }
  return { pairs, ignored };
}
