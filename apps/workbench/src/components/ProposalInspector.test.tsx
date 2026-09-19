import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlanVersion, ProposedSpecialistNode, SourceRecord, TopicNode } from '../lib/types';
import { PROPOSAL_REFINEMENT_LIMIT, ProposalInspector } from './ProposalInspector';

const intent: TopicNode = {
  id: 'intent:portal',
  kind: 'custom',
  title: 'Customer portal',
  objective: 'Ship an accessible customer experience.',
  context: 'Keyboard navigation is required.',
  status: 'draft',
  position: { x: 20, y: 30 },
};

const dependency: ProposedSpecialistNode = {
  id: 'specialist:product',
  type: 'SPECIALIST_AGENT',
  domain: 'product',
  title: 'Requirements engineering',
  objective: 'Bound the product contract.',
  agentId: 'product-agent',
  promptDigest: 'sha256:product',
  dependsOn: [],
  acceptanceCriteria: [],
  inputs: [],
  outputs: [],
  traceability: { intentNodeIds: [intent.id], evidenceIds: [] },
};

const proposal: ProposedSpecialistNode = {
  id: 'specialist:experience',
  type: 'SPECIALIST_AGENT',
  domain: 'experience',
  title: 'Experience engineering',
  objective: 'Build the accessible browser experience.',
  agentId: 'experience-agent',
  agentAssignment: 'Senior experience systems engineer',
  promptDigest: 'sha256:experience',
  dependsOn: [dependency.id],
  acceptanceCriteria: ['Every control is keyboard accessible.', 'The responsive layout has no hidden fields.'],
  inputs: [],
  outputs: [],
  traceability: { intentNodeIds: [intent.id], evidenceIds: ['source:brd'] },
  budget: { maxIterations: 6, maxToolCalls: 24 },
  stop: { condition: 'acceptance_criteria_satisfied' },
};

const source: SourceRecord = {
  id: 'source:brd',
  graphId: 'graph:portal',
  nodeId: intent.id,
  filename: 'portal-brd.xlsx',
  mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  byteSize: 1_024,
  sha256: 'a'.repeat(64),
  parseStatus: 'PARSED',
  parserId: 'xlsx-parser',
  parserVersion: '1',
  chunkCount: 8,
  metadata: {},
  createdAt: '2026-08-22T08:00:00.000Z',
};

const plan: PlanVersion = {
  id: 'plan:1',
  graphId: 'graph:portal',
  version: 1,
  provider: 'simulation',
  status: 'proposed',
  contentHash: 'b'.repeat(64),
  summary: 'Build the customer portal.',
  proposedEdges: [],
  workItems: [],
  proposedGraph: {
    proposalId: 'proposal:1',
    schemaVersion: 'intent-proposed-graph/v1',
    status: 'PROPOSED',
    compilerVersion: 'intent-map-compiler/1.0.0',
    contentDigest: `sha256:${'c'.repeat(64)}`,
    selectedDomains: ['product', 'experience'],
    nodes: [dependency, proposal],
    relationships: [],
  },
};

describe('ProposalInspector', () => {
  afterEach(cleanup);

  it('keeps the inspector renderable for a legacy proposal with missing detail arrays', () => {
    const legacyNode = {
      ...proposal,
      domain: undefined,
      traceability: undefined,
      acceptanceCriteria: undefined,
      dependsOn: undefined,
    } as unknown as ProposedSpecialistNode;
    render(
      <Theme appearance="dark">
        <ProposalInspector
          node={legacyNode}
          plan={plan}
          nextPlanVersion={2}
          sourceIntents={[]}
          evidenceSources={[]}
          proposalNodes={[legacyNode]}
          onRefine={vi.fn(async () => false)}
        />
      </Theme>,
    );

    expect(screen.getByRole('complementary', { name: 'Proposal inspector for Experience engineering' })).toBeInTheDocument();
    expect(screen.getByText('No acceptance criteria were generated.')).toBeInTheDocument();
    expect(screen.getByText('This specialist has no proposal dependencies.')).toBeInTheDocument();
  });

  it('shows bound proposal details and submits one bounded refinement request', async () => {
    const user = userEvent.setup();
    const onRefine = vi.fn(async () => true);
    render(
      <Theme appearance="dark">
        <ProposalInspector
          node={proposal}
          plan={plan}
          nextPlanVersion={3}
          sourceIntents={[intent]}
          evidenceSources={[source]}
          proposalNodes={[dependency, proposal]}
          onRefine={onRefine}
        />
      </Theme>,
    );

    const inspector = screen.getByRole('complementary', { name: 'Proposal inspector for Experience engineering' });
    expect(within(inspector).getByText('Plan v1 immutable')).toBeInTheDocument();
    expect(within(inspector).getByText('Senior experience systems engineer')).toBeInTheDocument();
    expect(within(inspector).getByText('Customer portal')).toBeInTheDocument();
    expect(within(inspector).getByText('Keyboard navigation is required.')).toBeInTheDocument();
    expect(within(inspector).getByText('portal-brd.xlsx')).toBeInTheDocument();
    expect(within(inspector).getByText('Every control is keyboard accessible.')).toBeInTheDocument();
    expect(within(inspector).getByText('Requirements engineering')).toBeInTheDocument();
    expect(within(inspector).getByText('max iterations')).toBeInTheDocument();
    expect(within(inspector).getByText('acceptance_criteria_satisfied')).toBeInTheDocument();

    const input = within(inspector).getByRole('textbox', { name: 'Refinement request for Experience engineering' });
    expect(input).toHaveAttribute('maxlength', String(PROPOSAL_REFINEMENT_LIMIT));
    await user.type(input, 'Include focus recovery after modal navigation.');
    await user.click(within(inspector).getByRole('button', { name: 'Save refinement and create Plan v3' }));

    expect(onRefine).toHaveBeenCalledWith('Include focus recovery after modal navigation.');
    expect(input).toHaveValue('');
  });
});
