import { describe, expect, it } from 'vitest';
import { previewRelations } from './graph-editing';
import type { TopicNode } from './types';
const nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, title: id, kind: 'engineering', objective: id, context: '', status: 'draft', position: { x: 0, y: 0 } } as TopicNode));
describe('many-to-many relationship preview', () => {
  it('creates six distinct relationships from two sources and three targets', () => {
    const result = previewRelations(nodes, [], ['a', 'b'], ['c', 'd', 'e'], 'SUPPORTS');
    expect(result.pairs).toHaveLength(6); expect(result.ignored).toBe(0); expect(result.error).toBeUndefined();
  });
  it('excludes duplicate and self connections while permitting a second semantic type', () => {
    const existing = [{ id: 'old', source: 'a', target: 'b', type: 'SUPPORTS' }];
    expect(previewRelations(nodes, existing, ['a', 'a'], ['a', 'b'], 'SUPPORTS')).toMatchObject({ pairs: [], ignored: 2 });
    expect(previewRelations(nodes, existing, ['a'], ['b'], 'CONTRADICTS').pairs).toHaveLength(1);
  });
  it('rejects an indirect dependency cycle but allows the same cycle as evidence relationships', () => {
    const edges = [{ id: 'ab', source: 'a', target: 'b', type: 'REQUIRES' }, { id: 'bc', source: 'b', target: 'c', type: 'REQUIRES' }];
    expect(previewRelations(nodes, edges, ['c'], ['a'], 'REQUIRES').error).toContain('cycle');
    expect(previewRelations(nodes, edges, ['c'], ['a'], 'SUPPORTS').error).toBeUndefined();
  });
});
