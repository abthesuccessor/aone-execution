import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NodeConfiguration } from './NodeConfiguration';
import { request } from '../lib/api';
import type { EngineeringAgent, ProviderStatus, TopicNode } from '../lib/types';
vi.mock('../lib/api', () => ({ request: vi.fn() }));
const node: TopicNode = { id: 'node', title: 'Requirements', objective: 'Build a service', context: '', kind: 'engineering', status: 'draft', position: { x: 0, y: 0 }, skills: ['archived-skill'], acceptanceCriteria: ['Existing criterion'] };
const agents = [{ id: 'developer', name: 'Developer', status: 'ACTIVE' }, { id: 'disabled-agent', name: 'Old developer', status: 'DISABLED' }] as EngineeringAgent[];
const providers = [{ id: 'codex-cli', name: 'Codex CLI', available: true }, { id: 'openai-api', name: 'OpenAI API', available: true }] as ProviderStatus[];
afterEach(cleanup);
beforeEach(() => { vi.mocked(request).mockResolvedValue({ items: [{ id: 'archived-skill', name: 'Archived skill', archived: true }, { id: 'quality', name: 'Quality', enabled: true }] }); });

it('selects explicit overrides and exposes unavailable assignments instead of hiding them', async () => {
  const onChange = vi.fn();
  const view = render(<NodeConfiguration node={{ ...node, agentId: 'missing-agent' }} agents={agents} providers={providers} onChange={onChange} />);
  expect(screen.getByRole('option', { name: 'missing-agent (unavailable)' })).toBeDisabled();
  expect(screen.getByLabelText('Node agent')).toHaveValue('missing-agent');
  expect(screen.getByRole('option', { name: 'Old developer (disabled)' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Node agent'), { target: { value: 'developer' } });
  expect(onChange).toHaveBeenLastCalledWith({ agentId: 'developer' });
  fireEvent.change(screen.getByLabelText('Node provider'), { target: { value: 'openai-api' } });
  expect(onChange).toHaveBeenLastCalledWith({ providerId: 'openai-api' });
  view.rerender(<NodeConfiguration node={{ ...node, agentId: 'developer', providerId: 'openai-api' }} agents={agents} providers={providers} onChange={onChange} />);
  expect(screen.getByLabelText('Node provider')).toHaveValue('openai-api');
  fireEvent.change(screen.getByLabelText('Node provider'), { target: { value: '' } });
  expect(onChange).toHaveBeenLastCalledWith({ providerId: undefined });
  await screen.findByLabelText('Archived skill (unavailable — remove override)');
});

it('allows removing an inactive selected skill and locks every override during Apply', async () => {
  const user = userEvent.setup(); const onChange = vi.fn();
  const props = { node, agents, providers, onChange };
  const view = render(<NodeConfiguration {...props} />);
  await screen.findByLabelText('Archived skill (unavailable — remove override)');
  await user.click(screen.getByText('Skills', { exact: false, selector: 'summary' }));
  await user.click(screen.getByLabelText('Archived skill (unavailable — remove override)'));
  expect(onChange).toHaveBeenLastCalledWith({ skills: [] });
  onChange.mockClear();
  view.rerender(<NodeConfiguration {...props} readOnly />);
  await user.type(screen.getByLabelText('Node model'), 'different-model');
  expect(onChange).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Node agent')).toBeDisabled();
  expect(screen.getByLabelText('Node provider')).toBeDisabled();
  expect(screen.getByLabelText('Node acceptance criteria')).toBeDisabled();
  expect(screen.getByLabelText('Quality')).toBeDisabled();
});

it('retains multiline editing but updates acceptance criteria after an external Apply', async () => {
  const user = userEvent.setup(); const onChange = vi.fn();
  const view = render(<NodeConfiguration node={node} agents={agents} providers={providers} onChange={onChange} />);
  await user.click(screen.getByText('Inputs, outputs, and acceptance criteria'));
  const field = screen.getByLabelText('Node acceptance criteria');
  await user.click(field); await user.keyboard('{End}{Enter}');
  expect(field).toHaveValue('Existing criterion\n');
  await user.tab();
  view.rerender(<NodeConfiguration node={{ ...node, acceptanceCriteria: ['AI-refined criterion', 'Second accepted criterion'] }} agents={agents} providers={providers} onChange={onChange} />);
  expect(field).toHaveValue('AI-refined criterion\nSecond accepted criterion');
});

it('configures a bounded independent peer review without adding scheduling relationships', async () => {
  const user = userEvent.setup(); const onChange = vi.fn();
  const reviewers = Array.from({ length: 5 }, (_, index) => ({ ...node, id: `reviewer-${index}`, title: `Reviewer ${index}` }));
  const view = render(<NodeConfiguration node={{ ...node, review: { required: true, reviewerNodeIds: [] } }} nodes={[node, ...reviewers]} agents={agents} providers={providers} onChange={onChange} />);
  await user.click(screen.getByText('Peer review', { exact: false, selector: 'summary' }));
  expect(screen.getByText('Select at least one reviewer before planning.')).toBeInTheDocument();
  expect(screen.queryByLabelText('Reviewer Requirements')).not.toBeInTheDocument();
  await user.click(screen.getByLabelText('Reviewer Reviewer 0'));
  expect(onChange).toHaveBeenLastCalledWith({ review: { required: true, reviewerNodeIds: ['reviewer-0'] } });
  view.rerender(<NodeConfiguration node={{ ...node, review: { required: true, reviewerNodeIds: reviewers.slice(0, 4).map((item) => item.id) } }} nodes={[node, ...reviewers]} agents={agents} providers={providers} onChange={onChange} />);
  expect(screen.getByLabelText('Reviewer Reviewer 4')).toBeDisabled();
  expect(screen.getByLabelText('Reviewer Reviewer 0')).toBeEnabled();
  expect(screen.getByText(/Codex CLI cannot act as a reviewer/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Node review provider'), { target: { value: 'openai-api' } });
  expect(onChange).toHaveBeenLastCalledWith({ review: { required: true, reviewerNodeIds: reviewers.slice(0, 4).map((item) => item.id), providerId: 'openai-api' } });
});

it('lets users remove a missing reviewer and locks peer review during execution', async () => {
  const user = userEvent.setup(); const onChange = vi.fn();
  const configured = { ...node, review: { required: true, reviewerNodeIds: ['missing'] } };
  const view = render(<NodeConfiguration node={configured} nodes={[node]} agents={agents} providers={providers} onChange={onChange} />);
  await user.click(screen.getByText('Peer review', { exact: false, selector: 'summary' }));
  await user.click(screen.getByLabelText('Missing reviewer: missing (remove selection)'));
  expect(onChange).toHaveBeenLastCalledWith({ review: { required: true, reviewerNodeIds: [] } });
  view.rerender(<NodeConfiguration node={configured} nodes={[node]} agents={agents} providers={providers} readOnly onChange={onChange} />);
  expect(screen.getByRole('checkbox', { name: 'Require peer review before accepting this node' })).toBeDisabled();
  expect(screen.getByLabelText('Missing reviewer: missing (remove selection)')).toBeDisabled();
});
