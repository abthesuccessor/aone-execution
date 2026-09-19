import type { TopicNode } from './types';

export interface NewTopicNodeInput {
  title: string;
  objective: string;
  context?: string;
}

export function newTopicNode(input: NewTopicNodeInput, index: number): TopicNode {
  return {
    id: crypto.randomUUID(),
    kind: 'custom',
    title: input.title.trim(),
    objective: input.objective.trim(),
    context: input.context?.trim() ?? '',
    status: 'draft',
    position: {
      x: 90 + (index % 3) * 270,
      y: 90 + Math.floor(index / 3) * 190,
    },
  };
}
