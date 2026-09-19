import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TopicNode } from '../lib/types';
import { NodeInspector } from './NodeInspector';

const firstNode: TopicNode = {
  id: 'intent:first',
  kind: 'custom',
  title: 'Checkout requirements',
  objective: 'Produce an approved checkout design.',
  context: 'Preserve idempotency and accessible keyboard flows.',
  status: 'draft',
  position: { x: 90, y: 90 },
};

function props(node: TopicNode, onChange = vi.fn()) {
  return {
    node,
    sources: [],
    sourcesLoading: false,
    retrievalHits: [],
    onChange,
    onDelete: vi.fn(),
    onUploadSources: vi.fn(async () => undefined),
    onSearchSources: vi.fn(async () => undefined),
  };
}

describe('NodeInspector', () => {
  it('keeps editable context before evidence and exposes no skill configuration', () => {
    const onChange = vi.fn();
    const { container } = render(<NodeInspector {...props(firstNode, onChange)} />);

    const context = screen.getByRole('region', { name: 'Editable node context' });
    expect(within(context).getByRole('textbox', { name: 'Node title' })).toHaveValue('Checkout requirements');
    expect(within(context).getByRole('textbox', { name: 'Node desired outcome' })).toHaveAttribute('rows', '3');
    expect(within(context).getByRole('textbox', { name: 'Node known context' })).toHaveAttribute('rows', '6');
    expect(context.compareDocumentPosition(screen.getByRole('region', { name: 'Source evidence' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/local skills/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(container.querySelector('.node-inspector-content')).toBeInTheDocument();

    fireEvent.change(within(context).getByRole('textbox', { name: 'Node desired outcome' }), {
      target: { value: 'Reviewable HLD and LLD' },
    });
    expect(onChange).toHaveBeenLastCalledWith({ objective: 'Reviewable HLD and LLD' });
  });

  it('remounts its scroll area when another node is selected', () => {
    const { container, rerender } = render(<NodeInspector {...props(firstNode)} />);
    const firstViewport = container.querySelector('[data-radix-scroll-area-viewport]');
    const secondNode = { ...firstNode, id: 'intent:second', title: 'API contracts', objective: 'Specify API contracts.' };

    rerender(<NodeInspector {...props(secondNode)} />);

    expect(within(container).getByRole('textbox', { name: 'Node title' })).toHaveValue('API contracts');
    expect(container.querySelector('[data-radix-scroll-area-viewport]')).not.toBe(firstViewport);
  });
});
