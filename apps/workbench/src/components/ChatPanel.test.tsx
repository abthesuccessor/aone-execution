import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';
import { chatApi, type ChatMessage } from '../lib/chat-api';
import type { ProviderStatus } from '../lib/types';

vi.mock('../lib/chat-api', () => ({ chatApi: { list: vi.fn(), templates: vi.fn(), context: vi.fn(), create: vi.fn(), get: vi.fn(), send: vi.fn(), stop: vi.fn(), apply: vi.fn() } }));
const provider = { id: 'openai-api', name: 'OpenAI API', available: true, connection: { status: 'CONNECTED' } } as ProviderStatus;
const conversation = { id: 'conversation', graphId: 'graph', nodeIds: ['a'], title: 'A node', updatedAt: '2026-09-12T00:00:00Z' };
const pinnedContext = { draftRevision: 2, boundary: 'Supplied evidence only.', capturedAt: '2026-09-12T00:00:00Z', nodes: [{ id: 'a', title: 'First node', description: 'Old objective' }], evidence: [], agents: [], skills: [] };
const assistant: ChatMessage = { id: 'assistant', conversationId: 'conversation', role: 'assistant', action: 'refine', content: 'Here is the refinement.', status: 'completed', providerId: 'openai-api', context: pinnedContext, createdAt: '2026-09-12T00:00:00Z', proposal: { id: 'proposal', graphId: 'graph', baseDraftRevision: 2, status: 'pending', summary: 'Make the objective specific', nodeUpdates: [{ id: 'a', description: 'New objective' }], edgeAdditions: [] } };
const user: ChatMessage = { ...assistant, id: 'user', role: 'user', content: 'Refine this node', proposal: undefined };

afterEach(cleanup);

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(chatApi.list).mockResolvedValue({ items: [] });
  vi.mocked(chatApi.templates).mockResolvedValue({ items: [{ id: 'refine', name: 'Refine', action: 'refine', prompt: 'Refine the selected nodes.' }] });
  vi.mocked(chatApi.context).mockResolvedValue({ draftRevision: 2, sources: [], nodes: [{ id: 'a', title: 'First node' }] });
  vi.mocked(chatApi.create).mockResolvedValue({ conversation });
  vi.mocked(chatApi.get).mockResolvedValue({ conversation, messages: [user, assistant] });
  vi.mocked(chatApi.apply).mockResolvedValue({ proposal: { ...assistant.proposal!, status: 'applied', appliedRevision: 3 } });
});

describe('AI chat', () => {
  it('sends custom scoped action only after saving draft, then shows reviewable changes', async () => {
    const before = vi.fn().mockResolvedValue(undefined);
    vi.mocked(chatApi.send).mockImplementation(async (_graph, _id, _input, receive) => { expect(before).toHaveBeenCalledTimes(1); receive('message', { message: { ...assistant, content: '', status: 'running' } }); receive('delta', { text: 'Here is the refinement.' }); receive('done', { message: assistant }); });
    render(<ChatPanel graphId="graph" graphRevision={2} providerId="openai-api" providers={[provider]} nodeIds={['a']} onBeforeSend={before} actionRequest={{ id: 'request', action: 'refine', nodeIds: ['a'], prompt: 'Suggest useful relationships.' }} />);
    await waitFor(() => expect(screen.getByLabelText('Message AI')).toHaveValue('Suggest useful relationships.'));
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Here is the refinement.');
    await waitFor(() => expect(chatApi.send).toHaveBeenCalledWith('graph', 'conversation', expect.objectContaining({ action: 'refine', content: 'Suggest useful relationships.', sourceIds: [] }), expect.any(Function), expect.any(AbortSignal)));
    expect(screen.getByRole('button', { name: 'Apply to draft' })).toBeEnabled();
    expect(chatApi.apply).not.toHaveBeenCalled();
  });

  it('requires review Apply and disables stale proposals when local context changes', async () => {
    vi.mocked(chatApi.list).mockResolvedValue({ items: [conversation] });
    const onApplied = vi.fn().mockResolvedValue(undefined);
    const props = { graphId: 'graph', graphRevision: 2, providerId: 'openai-api', providers: [provider], onApplied };
    const view = render(<ChatPanel {...props} />);
    await screen.findByRole('option', { name: /A node/ });
    fireEvent.change(screen.getByLabelText('Conversation history'), { target: { value: 'conversation' } });
    const apply = await screen.findByRole('button', { name: 'Apply to draft' });
    view.rerender(<ChatPanel {...props} contextStale />);
    expect(screen.getByRole('button', { name: /Context changed/ })).toBeDisabled();
    view.rerender(<ChatPanel {...props} contextStale={false} />);
    fireEvent.click(apply);
    await waitFor(() => expect(chatApi.apply).toHaveBeenCalledWith('graph', 'proposal'));
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Applied to draft' })).toBeDisabled();
  });

  it('stops an active response and retains the saved stopped state', async () => {
    let finish: (() => void) | undefined;
    vi.mocked(chatApi.send).mockImplementation(async (_graph, _id, _input, receive) => { receive('message', { message: { ...assistant, status: 'running', content: 'Partial response', proposal: undefined } }); await new Promise<void>((resolve) => { finish = resolve; }); });
    vi.mocked(chatApi.stop).mockImplementation(async () => { finish?.(); return { status: 'stop_requested' }; });
    vi.mocked(chatApi.get).mockResolvedValue({ conversation, messages: [user, { ...assistant, status: 'stopped', content: 'Partial response', proposal: undefined }] });
    render(<ChatPanel graphId="graph" providerId="openai-api" providers={[provider]} nodeIds={['a']} />);
    fireEvent.change(screen.getByLabelText('Message AI'), { target: { value: 'Discuss this node' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Partial response');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop' })); });
    expect(chatApi.stop).toHaveBeenCalledWith('graph', 'conversation');
    await screen.findByText('stopped');
    expect(screen.queryByRole('button', { name: 'Apply to draft' })).not.toBeInTheDocument();
  });

  it('previews AI-created nodes and relationships without applying them automatically', async () => {
    vi.mocked(chatApi.list).mockResolvedValue({ items: [conversation] });
    vi.mocked(chatApi.get).mockResolvedValue({ conversation, messages: [user, { ...assistant, proposal: { ...assistant.proposal!, nodeUpdates: [], nodeAdditions: [{ id: 'generated-id', title: 'Verification node', description: 'Verify the implementation.', acceptanceCriteria: ['All required checks pass.'] }], edgeAdditions: [{ id: 'relation', source: 'a', target: 'generated-id', type: 'REQUIRES', rationale: 'Implementation before verification.' }] } }] });
    render(<ChatPanel graphId="graph" graphRevision={2} providerId="openai-api" providers={[provider]} />);
    await screen.findByRole('option', { name: /A node/ });
    fireEvent.change(screen.getByLabelText('Conversation history'), { target: { value: 'conversation' } });
    await screen.findByText('Add node · Verification node');
    expect(screen.getByText('First node → Verification node')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply to draft' })).toBeEnabled();
    expect(chatApi.apply).not.toHaveBeenCalled();
  });

  it('locks the draft through Apply and ignores a late callback after switching graphs', async () => {
    vi.mocked(chatApi.list).mockResolvedValue({ items: [conversation] });
    let finish: ((result: { proposal: NonNullable<ChatMessage['proposal']> }) => void) | undefined;
    vi.mocked(chatApi.apply).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const lock = vi.fn(); const onApplied = vi.fn();
    const props = { providerId: 'openai-api', providers: [provider], onApplyingChange: lock, onApplied };
    const view = render(<ChatPanel graphId="graph" {...props} />);
    await screen.findByRole('option', { name: /A node/ });
    fireEvent.change(screen.getByLabelText('Conversation history'), { target: { value: 'conversation' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Apply to draft' }));
    await waitFor(() => expect(chatApi.apply).toHaveBeenCalled());
    expect(lock).toHaveBeenLastCalledWith(true);
    vi.mocked(chatApi.list).mockResolvedValue({ items: [] });
    view.rerender(<ChatPanel graphId="another-graph" {...props} />);
    await act(async () => { finish?.({ proposal: { ...assistant.proposal!, status: 'applied' } }); });
    expect(onApplied).not.toHaveBeenCalled();
    expect(lock).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText('Here is the refinement.')).not.toBeInTheDocument();
  });

  it('aborts a graph conversation on switch and discards late stream events', async () => {
    let receiveLate: Parameters<typeof chatApi.send>[3] | undefined;
    let finish: (() => void) | undefined;
    let signal: AbortSignal | undefined;
    vi.mocked(chatApi.send).mockImplementation(async (_graph, _id, _input, receive, abortSignal) => { receiveLate = receive; signal = abortSignal; receive('message', { message: { ...assistant, content: 'Old partial answer', status: 'running', proposal: undefined } }); await new Promise<void>((resolve) => { finish = resolve; }); });
    const props = { providerId: 'openai-api', providers: [provider] };
    const view = render(<ChatPanel graphId="graph" {...props} />);
    fireEvent.change(screen.getByLabelText('Message AI'), { target: { value: 'Discuss' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Old partial answer');
    expect(screen.getByRole('button', { name: 'New' })).toBeDisabled();
    view.rerender(<ChatPanel graphId="another-graph" {...props} />);
    expect(signal?.aborted).toBe(true);
    await act(async () => { receiveLate?.('done', { message: { ...assistant, content: 'Late old answer' } }); finish?.(); });
    expect(screen.queryByText('Late old answer')).not.toBeInTheDocument();
    expect(screen.queryByText('Old partial answer')).not.toBeInTheDocument();
  });

  it('makes creating an empty graph discoverable through a draft prompt', async () => {
    vi.mocked(chatApi.context).mockResolvedValue({ draftRevision: 1, sources: [], nodes: [] });
    render(<ChatPanel graphId="empty" providerId="openai-api" providers={[provider]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Draft a graph' }));
    expect((screen.getByLabelText('Message AI') as HTMLTextAreaElement).value).toContain('Create a small graph');
    expect(screen.getByRole('button', { name: 'Refine' })).toHaveAttribute('aria-pressed', 'true');
    expect(chatApi.send).not.toHaveBeenCalled();
  });

  it('follows selection for an empty new chat and visibly pins an explicit node action', async () => {
    vi.mocked(chatApi.context).mockResolvedValue({ draftRevision: 2, sources: [], nodes: [{ id: 'a', title: 'Requirements' }, { id: 'b', title: 'Tests' }] });
    const props = { graphId: 'graph', providerId: 'openai-api', providers: [provider] };
    const view = render(<ChatPanel {...props} nodeIds={['a']} />);
    await screen.findByText('Context · Requirements · 0 attachments');
    view.rerender(<ChatPanel {...props} nodeIds={['b']} />);
    await screen.findByText('Context · Tests · 0 attachments');
    const actionRequest = { id: 'pinned', action: 'refine' as const, nodeIds: ['a'], prompt: 'Refine Requirements only.' };
    view.rerender(<ChatPanel {...props} nodeIds={['b']} actionRequest={actionRequest} />);
    await screen.findByText('Context · Requirements · 0 attachments');
    expect(screen.getByLabelText('Message AI')).toHaveValue('Refine Requirements only.');
  });

  it('refreshes edited catalog templates without resetting the open conversation', async () => {
    vi.mocked(chatApi.list).mockResolvedValue({ items: [conversation] });
    const props = { graphId: 'graph', providerId: 'openai-api', providers: [provider] };
    const view = render(<ChatPanel {...props} catalogVersion={0} />);
    await screen.findByRole('option', { name: /A node/ });
    fireEvent.change(screen.getByLabelText('Conversation history'), { target: { value: 'conversation' } });
    await screen.findByText('Here is the refinement.');
    vi.mocked(chatApi.templates).mockResolvedValue({ items: [{ id: 'refine', name: 'Updated refine', action: 'refine', prompt: 'Use the newly saved refinement template.' }] });
    view.rerender(<ChatPanel {...props} catalogVersion={1} />);
    await screen.findByRole('option', { name: 'Updated refine' });
    fireEvent.change(screen.getByLabelText('Prompt template'), { target: { value: 'refine' } });
    expect(screen.getByLabelText('Message AI')).toHaveValue('Use the newly saved refinement template.');
    expect(screen.getByText('Here is the refinement.')).toBeInTheDocument();
    expect(screen.getByLabelText('Conversation history')).toHaveValue('conversation');
  });

  it('does not advertise deterministic local planning as AI chat', async () => {
    render(<ChatPanel graphId="graph" providerId="local-agents" providers={[{ id: 'local-agents', name: 'Local agents', available: true }]} />);
    fireEvent.change(screen.getByLabelText('Message AI'), { target: { value: 'Hello' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByText(/Connect an API provider/)).toBeInTheDocument();
    await waitFor(() => expect(chatApi.context).toHaveBeenCalled());
  });
});
