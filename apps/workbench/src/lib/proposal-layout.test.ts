import { beforeEach, describe, expect, it } from 'vitest';
import type { ProposedRelationship, ProposedSpecialistNode, TopicNode } from './types';
import { createProposalForceLayout, readStoredProposalPositions, storeProposalPositions } from './proposal-layout';

const intent: TopicNode = {
  id: 'intent:studio',
  kind: 'custom',
  title: 'Studio',
  objective: 'Build a studio.',
  context: '',
  status: 'draft',
  position: { x: 100, y: 80 },
};

const proposalNodes: ProposedSpecialistNode[] = ['discovery', 'architecture', 'interaction', 'verification'].map((domain, index) => ({
  id: `specialist:${domain}`,
  type: 'SPECIALIST_AGENT',
  domain,
  title: domain,
  objective: `Own ${domain}.`,
  agentId: `agent-${domain}`,
  promptDigest: `sha256:${String(index).repeat(64)}`,
  dependsOn: index === 0 ? [] : [`specialist:${['discovery', 'architecture', 'interaction'][index - 1]}`],
  acceptanceCriteria: ['Done with evidence.'],
  inputs: [{ id: `input:${domain}`, type: 'artifact', required: true }],
  outputs: [{ id: `output:${domain}`, type: 'artifact', required: true }],
  traceability: { intentNodeIds: [intent.id], evidenceIds: [] },
}));

const relationships: ProposedRelationship[] = proposalNodes.slice(1).map((node, index) => ({
  id: `relationship:${index}`,
  type: 'REQUIRES',
  source: proposalNodes[index].id,
  target: node.id,
  rationale: 'Ordered delivery.',
  traceability: { intentNodeIds: [intent.id], evidenceIds: [] },
}));

describe('proposal force layout', () => {
  beforeEach(() => localStorage.clear());

  it('is deterministic, finite, and distributes connected nodes', () => {
    const first = createProposalForceLayout([intent], proposalNodes, relationships);
    const second = createProposalForceLayout([intent], proposalNodes, relationships);

    expect([...second]).toEqual([...first]);
    expect(first.size).toBe(proposalNodes.length);
    const uniquePositions = new Set([...first.values()].map((position) => `${position.x}:${position.y}`));
    expect(uniquePositions.size).toBe(proposalNodes.length);
    for (const position of first.values()) {
      expect(Number.isFinite(position.x)).toBe(true);
      expect(Number.isFinite(position.y)).toBe(true);
      expect(position.y).toBeGreaterThan(intent.position.y);
    }
  });

  it('persists only finite positions for nodes in the current proposal', () => {
    const positions = new Map([
      [proposalNodes[0].id, { x: 42, y: 84 }],
      ['stale-node', { x: 1, y: 2 }],
    ]);
    storeProposalPositions('sha256:test', positions);

    expect([...readStoredProposalPositions('sha256:test', new Set(proposalNodes.map((node) => node.id)))])
      .toEqual([[proposalNodes[0].id, { x: 42, y: 84 }]]);
  });
});
