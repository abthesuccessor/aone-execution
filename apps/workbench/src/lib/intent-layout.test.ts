import { describe, expect, it } from 'vitest';
import type { TopicNode } from './types';
import {
  createIntentCollisionLayout,
  hasIntentPositionCollisions,
  nearestAvailableIntentPosition,
} from './intent-layout';

function node(id: string, x: number, y: number): TopicNode {
  return {
    id,
    kind: 'custom',
    title: id,
    objective: `Refine ${id}.`,
    context: '',
    status: 'draft',
    position: { x, y },
  };
}

describe('intent node layout', () => {
  it('keeps already separated positions unchanged', () => {
    const nodes = [node('one', 90, 90), node('two', 360, 90)];
    expect([...createIntentCollisionLayout(nodes, [])]).toEqual(nodes.map((item) => [item.id, item.position]));
  });

  it('deterministically separates overlapping draft nodes', () => {
    const nodes = [node('one', -207, 84), node('two', -244, 90), node('three', -220, 100)];
    const first = createIntentCollisionLayout(nodes, []);
    const second = createIntentCollisionLayout(nodes, []);

    expect([...second]).toEqual([...first]);
    expect(first.size).toBe(3);
    expect(hasIntentPositionCollisions([...first.values()])).toBe(false);
  });

  it('snaps a dropped node to the nearest open grid position', () => {
    const occupied = [{ x: 100, y: 100 }, { x: 356, y: 100 }];
    const result = nearestAvailableIntentPosition({ x: 120, y: 110 }, occupied);

    expect(result).not.toEqual({ x: 120, y: 110 });
    expect(hasIntentPositionCollisions([...occupied, result])).toBe(false);
  });
});
