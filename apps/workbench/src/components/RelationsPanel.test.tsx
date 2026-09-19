import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RelationsPanel } from './RelationsPanel';
import type { EngineeringGraph } from '../lib/types';
afterEach(cleanup);
const graph: EngineeringGraph = { id: 'graph', name: 'Work', status: 'draft', nodes: [{ id: 'a', kind: 'engineering', title: 'Implementation', objective: 'Build', context: '', status: 'draft', position: { x: 0, y: 0 } }, { id: 'b', kind: 'engineering', title: 'Verification', objective: 'Verify', context: '', status: 'draft', position: { x: 0, y: 0 } }], edges: [{ id: 'edge', source: 'a', target: 'b', type: 'REQUIRES', label: 'REQUIRES', rationale: 'Verification needs the implementation artifact.' }] };
it('shows and searches the pinned AI relationship explanation instead of its default type label', () => {
  render(<RelationsPanel graph={graph} readOnly onChange={vi.fn()} onSuggest={vi.fn()} />);
  expect(screen.getByLabelText('Explanation for Implementation to Verification')).toHaveValue('Verification needs the implementation artifact.');
  expect(screen.getByLabelText('Explanation for Implementation to Verification')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Filter relationships'), { target: { value: 'artifact' } });
  expect(screen.getByLabelText('Explanation for Implementation to Verification')).toBeInTheDocument();
  expect(screen.getByLabelText('Type for Implementation to Verification')).toBeDisabled();
});
