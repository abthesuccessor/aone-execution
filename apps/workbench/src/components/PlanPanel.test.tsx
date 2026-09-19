import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineeringGraph, PlanVersion, ProposedSpecialistNode } from '../lib/types';
import '../styles.css';
import { PlanPanel } from './PlanPanel';

const requirementsNode: ProposedSpecialistNode = {
  id: 'specialist:product',
  type: 'SPECIALIST_AGENT',
  domain: 'product',
  title: 'Requirements and traceability',
  objective: 'Turn supplied intent into testable requirements.',
  agentId: 'requirements-analyst',
  promptDigest: `sha256:${'a'.repeat(64)}`,
  dependsOn: ['specialist:application'],
  acceptanceCriteria: ['Every requirement traces to its source intent.'],
  inputs: [{ id: 'input:product', type: 'intent_evidence_bundle', required: true }],
  outputs: [{ id: 'artifact:product', type: 'requirements_contract', required: true, provenanceRequired: true }],
  traceability: { intentNodeIds: ['intent-order-status'], evidenceIds: ['source-brd', 'source-flow'] },
};

const applicationNode: ProposedSpecialistNode = {
  ...requirementsNode,
  id: 'specialist:application',
  domain: 'application',
  title: 'Application and service engineering',
  objective: 'Implement the application contract.',
  agentId: 'backend-systems-engineer',
  dependsOn: [],
  inputs: [{ id: 'input:application', type: 'upstream_contract_bundle', required: true }],
  outputs: [{ id: 'artifact:application', type: 'application_artifact', required: true, provenanceRequired: true }],
  traceability: { intentNodeIds: ['intent-order-status'], evidenceIds: [] },
};

const graph: EngineeringGraph = {
  id: 'graph-orders',
  name: 'Order status graph',
  status: 'draft',
  nodes: [{
    id: 'intent-order-status',
    kind: 'custom',
    title: 'Renamed current draft intent',
    objective: 'Current draft objective that was not part of plan v1.',
    context: '',
    status: 'draft',
    position: { x: 0, y: 0 },
  }],
  edges: [],
};

const plan: PlanVersion = {
  id: 'plan-1',
  graphId: graph.id,
  version: 1,
  provider: 'simulation',
  status: 'proposed',
  contentHash: 'b'.repeat(64),
  baseDraftRevision: 3,
  summary: 'Compile order status intent into specialist work.',
  proposedEdges: [],
  workItems: [{
    id: 'step:product',
    nodeId: requirementsNode.id,
    title: requirementsNode.title,
    description: requirementsNode.objective,
    acceptanceCriteria: requirementsNode.acceptanceCriteria,
    dependencies: requirementsNode.dependsOn,
    sourceIntents: [{
      id: 'intent-order-status',
      title: 'Order status requirements',
      objective: 'Define the approved order status behavior.',
    }],
  }],
  proposedGraph: {
    proposalId: 'proposal:orders',
    schemaVersion: 'intent-proposed-graph/v1',
    status: 'PROPOSED',
    compilerVersion: 'intent-map-compiler/1.0.0',
    contentDigest: `sha256:${'c'.repeat(64)}`,
    selectedDomains: ['product', 'application'],
    nodes: [requirementsNode, applicationNode],
    relationships: [],
  },
  rawDocument: {
    id: 'plan-1',
    contentHash: 'b'.repeat(64),
    baseDraftRevision: 3,
    plan: {
      exactStoredPlan: true,
      steps: [{
        id: 'step:product',
        sourceIntents: [{
          id: 'intent-order-status',
          title: 'Order status requirements',
          objective: 'Define the approved order status behavior.',
        }],
      }],
    },
  },
};

describe('PlanPanel work items', () => {
  afterEach(cleanup);

  it('renders immutable source intent snapshots even when the current draft title changed', async () => {
    const user = userEvent.setup();
    render(
      <Theme>
        <PlanPanel
          graph={graph}
          plan={plan}
          approvalContext=""
          onApprovalContextChange={vi.fn()}
          onApprove={vi.fn()}
        />
      </Theme>,
    );

    const workItems = screen.getByRole('region', { name: 'WORK ITEMS' });
    expect(within(workItems).getAllByText('Requirements and traceability')).toHaveLength(1);
    expect(within(workItems).getByText('Source intent:')).toBeInTheDocument();
    expect(within(workItems).getByText('Order status requirements')).toBeInTheDocument();
    expect(within(workItems).queryByText('Renamed current draft intent')).not.toBeInTheDocument();
    expect(within(workItems).getByText('Source objective: Define the approved order status behavior.')).toBeInTheDocument();
    expect(within(workItems).getByText('2 evidence refs')).toBeInTheDocument();
    expect(within(workItems).getByText('Depends on: Application and service engineering')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Inspect exact plan' }));
    expect(screen.getByTestId('code-editor')).toHaveTextContent('"exactStoredPlan": true');
    expect(screen.getByTestId('code-editor')).toHaveTextContent('"sourceIntents"');
    expect(screen.getByTestId('code-editor')).toHaveTextContent('Order status requirements');
  });

  it('labels live graph lookup as a current-draft fallback for a legacy plan', () => {
    const { sourceIntents: _snapshot, ...legacyWorkItem } = plan.workItems[0];
    render(
      <Theme>
        <PlanPanel
          graph={graph}
          plan={{ ...plan, id: 'legacy-plan', workItems: [legacyWorkItem], rawDocument: undefined }}
          approvalContext=""
          onApprovalContextChange={vi.fn()}
          onApprove={vi.fn()}
        />
      </Theme>,
    );

    const workItems = screen.getByRole('region', { name: 'WORK ITEMS' });
    expect(within(workItems).getByText('Source intent (current draft):')).toBeInTheDocument();
    expect(within(workItems).getByText('Renamed current draft intent')).toBeInTheDocument();
    expect(within(workItems).getByText('Current draft objective: Current draft objective that was not part of plan v1.')).toBeInTheDocument();
    expect(within(workItems).getByText('Plan base draft r3')).toBeInTheDocument();
  });

  it('keeps nested acceptance criteria out of the work-item grid selector', () => {
    render(
      <Theme>
        <PlanPanel
          graph={graph}
          plan={plan}
          approvalContext=""
          onApprovalContextChange={vi.fn()}
          onApprove={vi.fn()}
        />
      </Theme>,
    );

    const workItems = screen.getByRole('region', { name: 'WORK ITEMS' });
    const topLevelItem = workItems.querySelector('.work-items > .work-item');
    const criteriaList = within(workItems).getByRole('list', {
      name: 'Acceptance criteria for Requirements and traceability',
    });
    const criterion = within(criteriaList).getByRole('listitem');

    expect(topLevelItem).not.toBeNull();
    expect(topLevelItem).toHaveClass('work-item');
    expect(criterion).not.toHaveClass('work-item');
    expect(criterion.matches('.work-items > .work-item')).toBe(false);
    expect(window.getComputedStyle(topLevelItem as Element).display).toBe('grid');
    expect(window.getComputedStyle(criterion).display).not.toBe('grid');
  });
});
