import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HarnessPanel } from './HarnessPanel';
import { MemoryPanel } from './MemoryPanel';
import { SuggestionReview } from './SuggestionReview';
import { DEFAULT_HARNESS, harnessApi } from '../lib/harness-api';
import type { PlanVersion } from '../lib/types';

vi.mock('../lib/harness-api', async (original) => ({ ...await original<typeof import('../lib/harness-api')>(), harnessApi: { memory: vi.fn(), memorySettings: vi.fn(), compactions: vi.fn(), saveMemorySettings: vi.fn(), forget: vi.fn(), adopt: vi.fn() } }));
afterEach(cleanup);
beforeEach(() => { vi.resetAllMocks(); vi.mocked(harnessApi.memory).mockResolvedValue({ items: [] }); vi.mocked(harnessApi.memorySettings).mockResolvedValue({ settings: { provider: 'local', endpoint: '', remoteRecallEnabled: false } }); vi.mocked(harnessApi.compactions).mockResolvedValue({ items: [] }); });

it('lets the user choose delivery scope and invokes design without executing', () => {
  const change = vi.fn(); const design = vi.fn();
  render(<HarnessPanel graphId="g" options={DEFAULT_HARNESS} onChange={change} onDesign={design} />);
  fireEvent.change(screen.getByLabelText('Engineering profile'), { target: { value: 'poc' } });
  expect(change).toHaveBeenCalledWith({ ...DEFAULT_HARNESS, profile: 'poc' });
  fireEvent.click(screen.getByRole('button', { name: 'Design the system in chat' }));
  expect(design).toHaveBeenCalledOnce();
});

it('clears unsaved credentials when a different memory service is selected', async () => {
  vi.mocked(harnessApi.memorySettings).mockResolvedValue({ settings: { provider: 'hindsight', endpoint: 'http://127.0.0.1:8888', remoteRecallEnabled: false } });
  render(<MemoryPanel graphId="g" />);
  const key = await screen.findByLabelText('Memory API key');
  fireEvent.change(key, { target: { value: 'session-secret-not-for-mem0' } });
  fireEvent.change(screen.getByLabelText('Memory provider'), { target: { value: 'mem0' } });
  expect(screen.getByLabelText('Memory API key')).toHaveValue('');
  expect(screen.getByLabelText('Memory endpoint')).toHaveValue('');
  expect(harnessApi.saveMemorySettings).not.toHaveBeenCalled();
});

it('shows the retained remote-copy warning after forgetting local memory', async () => {
  vi.mocked(harnessApi.memory).mockResolvedValue({ items: [{ id: 'm', graphId: 'g', content: 'Use REST', kind: 'decision', nodeIds: [], validation: { state: 'user_confirmed' }, provenance: {} }] });
  vi.mocked(harnessApi.forget).mockResolvedValue({ warning: 'A remote copy remains, but is excluded from recall.' });
  render(<MemoryPanel graphId="g" />);
  fireEvent.click(await screen.findByRole('button', { name: /^Forget$/ }));
  expect(await screen.findByRole('status')).toHaveTextContent('A remote copy remains');
});

it('adopts only the reviewed scope and reuses its idempotency key after an uncertain failure', async () => {
  const node = (id: string) => ({ id, title: id, objective: `Implement ${id}`, acceptanceCriteria: ['Prove it'], dependsOn: [], inputs: [], outputs: [], traceability: { intentNodeIds: ['idea'], evidenceIds: [] } });
  const plan = { id: 'p', version: 1, proposedGraph: { nodes: [node('UI'), node('Backend')] } } as unknown as PlanVersion;
  const applied = vi.fn().mockResolvedValue(undefined); const lock = vi.fn();
  vi.mocked(harnessApi.adopt).mockRejectedValueOnce(new Error('Connection ended after request')).mockResolvedValue({ draft: {} });
  render(<SuggestionReview graphId="g" revision={4} plan={plan} disabled={false} onApplied={applied} onBusy={lock} />);
  fireEvent.click(screen.getByLabelText('Include Backend'));
  fireEvent.click(screen.getByRole('button', { name: 'Use 1 suggested nodes' }));
  await screen.findByRole('alert');
  expect(applied).not.toHaveBeenCalled();
  const attempt = vi.mocked(harnessApi.adopt).mock.calls[0][2];
  expect(attempt.nodeIds).toEqual(['UI']); expect(attempt.expectedDraftRevision).toBe(4);
  fireEvent.click(screen.getByRole('button', { name: 'Use 1 suggested nodes' }));
  await waitFor(() => expect(applied).toHaveBeenCalledOnce());
  expect(vi.mocked(harnessApi.adopt).mock.calls[1][2].requestId).toBe(attempt.requestId);
  expect(lock).toHaveBeenLastCalledWith(false);
});
