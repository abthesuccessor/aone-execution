import { render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import type { NodeProps } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { ProposedFlowNode, type ProposedFlowNodeType } from './ProposedFlowNode';

vi.mock('@xyflow/react', () => ({ Handle: () => null, Position: { Top: 'top', Bottom: 'bottom' } }));

const props: NodeProps<ProposedFlowNodeType> = {
  id: 'proposal', type: 'proposal', selected: false, dragging: false, draggable: true, selectable: true, deletable: false, isConnectable: false,
  zIndex: 0, positionAbsoluteX: 0, positionAbsoluteY: 0,
  data: { specialist: { id: 'verify', type: 'SPECIALIST_AGENT', title: 'Verification specialist', domain: 'quality', objective: 'Verify the result.', agentId: 'qa', promptDigest: 'digest', dependsOn: [], acceptanceCriteria: [], inputs: [], outputs: [], traceability: { intentNodeIds: ['intent'], evidenceIds: [] } } },
};

describe('proposed specialist status', () => {
  it('shows the execution result in its visible badge and accessible label', () => {
    const { rerender } = render(<Theme><ProposedFlowNode {...props} data={{ ...props.data, status: 'failed' }} /></Theme>);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('article')).toHaveAccessibleName(/Verification specialist, Failed/);
    expect(screen.queryByText('Agent proposal')).not.toBeInTheDocument();

    rerender(<Theme><ProposedFlowNode {...props} data={{ ...props.data, status: 'completed' }} /></Theme>);
    expect(screen.getByText('Complete')).toBeInTheDocument();
  });

  it('distinguishes a fresh proposal from a specialist excluded by the admitted selection', () => {
    const { rerender } = render(<Theme><ProposedFlowNode {...props} /></Theme>);
    expect(screen.getByText('Agent proposal')).toBeInTheDocument();
    rerender(<Theme><ProposedFlowNode {...props} data={{ ...props.data, status: 'draft' }} /></Theme>);
    expect(screen.getByText('Not selected')).toBeInTheDocument();
  });
});
