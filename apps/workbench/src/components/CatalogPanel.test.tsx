import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CatalogPanel } from './CatalogPanel';
import { catalogApi, type CatalogItem } from '../lib/catalog-api';

vi.mock('../lib/catalog-api', () => ({ catalogApi: { list: vi.fn(), get: vi.fn(), save: vi.fn(), history: vi.fn(), createDomain: vi.fn() } }));
const packageFiles = [{ path: 'SKILL.md', sha256: 'skill-hash', size: 100 }, { path: 'references/guide.md', sha256: 'guide-hash', size: 90 }, { path: 'scripts/check.py', sha256: 'script-hash', size: 60 }];
const skills: CatalogItem[] = [
  { id: 'codex-review', name: 'Evidence review', description: 'Check evidence.', enabled: true, valid: true, sourceRoot: 'agent-skill-catalog', relativePath: 'codex/evidence-review/SKILL.md', sourceProvenance: [{ source: 'codex', path: 'quality/evidence-review/SKILL.md' }], packageFiles, content: '# Review\nRead the supplied evidence.', configDigest: 'config-one' },
  { id: 'agents-review', name: 'Evidence review', description: 'Review a system.', enabled: true, valid: true, sourceRoot: 'agent-skill-catalog', relativePath: 'evidence-review/SKILL.md', sourceProvenance: [{ source: 'agents', path: 'evidence-review/SKILL.md' }], packageFiles: [packageFiles[0]], content: '# Review\nCheck the system.' },
  { id: 'edited', name: 'Edited local skill', description: 'Current user instructions.', sourceRoot: 'agent-skill-catalog', relativePath: 'customized/SKILL.md', packageFiles: [packageFiles[0]], content: '# Changed\nUse local conventions.' },
];
const agent: CatalogItem = { id: 'reviewer', name: 'Reviewer', description: 'Evidence-based review.', domain: 'engineering', status: 'ACTIVE', skillIds: ['agents-review'], configDigest: 'agent-config', currentPrompt: { prompt: 'Cite evidence and identify limits.', digest: 'prompt-hash', version: 1 } };
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(catalogApi.list).mockImplementation(async (section) => section === 'agents' ? { items: [agent], domains: [{ id: 'engineering', name: 'Engineering' }], providers: [] } : { items: skills, providers: undefined });
  vi.mocked(catalogApi.get).mockImplementation(async (section, id) => ({ item: section === 'agents' ? agent : skills.find((skill) => skill.id === id)! }));
  vi.mocked(catalogApi.history).mockResolvedValue({ items: [] });
  vi.mocked(catalogApi.save).mockResolvedValue({ item: { ...skills[0], content: '# Review\nUse current project evidence.', sourceProvenance: undefined, configVersion: 1, configDigest: 'config-two' } });
});

it.each(['success', 'failure'])('ignores late agent save %s after switching to and opening a skill', async (outcome) => {
  const user = userEvent.setup(); const onChanged = vi.fn();
  let finish!: (value: { item: CatalogItem }) => void; let fail!: (cause: Error) => void;
  vi.mocked(catalogApi.save).mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  const view = render(<CatalogPanel section="agents" onChanged={onChanged} />);
  await user.click(await screen.findByRole('button', { name: /Reviewer/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Archived reviewer' } });
  await user.click(screen.getByRole('button', { name: 'Save' }));
  view.rerender(<CatalogPanel section="skills" onChanged={onChanged} />);
  await screen.findByText('codex/evidence-review/SKILL.md');
  await user.type(screen.getByRole('textbox', { name: 'Search skills' }), 'codex/evidence-review');
  await user.click(screen.getByRole('button', { name: /Evidence review.*Codex/ }));
  await act(async () => { if (outcome === 'success') finish({ item: { ...agent, name: 'Archived reviewer', configVersion: 2 } }); else fail(new Error('Late agent save failure')); });
  expect(screen.getByRole('textbox', { name: 'SKILL.md' })).toHaveValue(skills[0].content);
  expect(screen.getByRole('textbox', { name: 'Search skills' })).toHaveValue('codex/evidence-review');
  expect(screen.getByRole('button', { name: /Evidence review.*Codex/ })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.queryByText('Saved revision 2.')).not.toBeInTheDocument();
  expect(catalogApi.list).toHaveBeenCalledTimes(3);
  expect(onChanged).toHaveBeenCalledTimes(outcome === 'success' ? 1 : 0);
});

it('ignores a late agent catalog reload after a completed save and section change', async () => {
  const user = userEvent.setup(); let release!: (value: Awaited<ReturnType<typeof catalogApi.list>>) => void;
  let agentLoads = 0;
  vi.mocked(catalogApi.list).mockImplementation(async (section) => {
    if (section !== 'agents') return { items: skills, providers: undefined };
    agentLoads += 1;
    if (agentLoads > 1) return new Promise((resolve) => { release = resolve; });
    return { items: [agent], domains: [{ id: 'engineering', name: 'Engineering' }], providers: [] };
  });
  vi.mocked(catalogApi.save).mockResolvedValue({ item: { ...agent, name: 'Saved agent', configVersion: 2 } });
  const view = render(<CatalogPanel section="agents" />);
  await user.click(await screen.findByRole('button', { name: /Reviewer/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Saved agent' } });
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(agentLoads).toBe(2);
  view.rerender(<CatalogPanel section="skills" />);
  await user.click(await screen.findByRole('button', { name: /Evidence review.*Codex/ }));
  await act(async () => { release({ items: [{ ...agent, name: 'Saved agent' }], providers: [] }); });
  expect(screen.getByRole('textbox', { name: 'SKILL.md' })).toHaveValue(skills[0].content);
  expect(screen.getByRole('button', { name: /Evidence review.*Codex/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Saved agent/ })).not.toBeInTheDocument();
  expect(screen.queryByText('Saved revision 2.')).not.toBeInTheDocument();
});

it('finds fixed skills by verified source and original path, then displays package origin and editable instructions', async () => {
  const user = userEvent.setup(); render(<CatalogPanel section="skills" />);
  await screen.findByText('codex/evidence-review/SKILL.md');
  const search = screen.getByRole('textbox', { name: 'Search skills' });
  await user.type(search, 'codex');
  expect(screen.getByRole('button', { name: /Evidence review.*Codex/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Evidence review.*Agents/ })).not.toBeInTheDocument();
  await user.clear(search); await user.type(search, 'quality/evidence-review');
  await user.click(screen.getByRole('button', { name: /Evidence review.*Codex/ }));
  const details = await screen.findByLabelText('Skill package details');
  expect(within(details).getByText('Fixed-copy path')).toBeInTheDocument();
  expect(within(details).getByText('codex/evidence-review/SKILL.md')).toBeInTheDocument();
  expect(within(details).getByText('quality/evidence-review/SKILL.md')).toBeInTheDocument();
  expect(within(details).getByText('Verified copy source')).toBeInTheDocument();
  expect(within(details).getByText(/2 supporting files/)).toBeInTheDocument();
  expect(within(details).getByText(/scripts are not run automatically/)).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'SKILL.md' })).toHaveValue(skills[0].content);
  fireEvent.change(screen.getByRole('textbox', { name: 'SKILL.md' }), { target: { value: '# Review\nUse current project evidence.' } });
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(catalogApi.save).toHaveBeenCalledWith('skills', 'codex-review', expect.objectContaining({ content: '# Review\nUse current project evidence.', expectedDigest: 'config-one' }));
  await screen.findByText('Saved revision 1.');
  expect(screen.queryByText('Verified copy source')).not.toBeInTheDocument();
  expect(screen.getByText('No verified import source for this package revision.')).toBeInTheDocument();
});

it('does not infer verified origin from a fixed path and reports zero supporting files accurately', async () => {
  const user = userEvent.setup(); render(<CatalogPanel section="skills" />);
  await user.click(await screen.findByRole('button', { name: /Edited local skill/ }));
  const details = screen.getByLabelText('Skill package details');
  expect(within(details).queryByText('Verified copy source')).not.toBeInTheDocument();
  expect(within(details).getByText(/0 supporting files/)).toBeInTheDocument();
  expect(within(details).getByText('customized/SKILL.md')).toBeInTheDocument();
});

it('distinguishes duplicate agent default skill names by source and path while preserving skill IDs', async () => {
  const user = userEvent.setup(); render(<CatalogPanel section="agents" />);
  await user.click(await screen.findByRole('button', { name: /Reviewer/ }));
  await user.click(screen.getByText('Default skills (1)'));
  const codex = screen.getByRole('checkbox', { name: 'Evidence review (Codex · codex/evidence-review/SKILL.md)' });
  const agents = screen.getByRole('checkbox', { name: 'Evidence review (Agents · evidence-review/SKILL.md)' });
  expect(agents).toBeChecked(); expect(codex).not.toBeChecked();
  expect(codex.closest('label')).toHaveAttribute('title', 'Codex · codex/evidence-review/SKILL.md');
  await user.click(codex); await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(catalogApi.save).toHaveBeenCalledWith('agents', 'reviewer', expect.objectContaining({ skillIds: ['agents-review', 'codex-review'] }));
});
