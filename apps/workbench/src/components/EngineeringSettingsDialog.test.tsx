import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EngineeringSettingsDialog } from './EngineeringSettingsDialog';
import { ApiError } from '../lib/api';
import { catalogApi } from '../lib/catalog-api';
import { engineeringSettingsApi, type EngineeringSettings } from '../lib/engineering-settings-api';

vi.mock('../lib/catalog-api', () => ({ catalogApi: { list: vi.fn() } }));
vi.mock('../lib/engineering-settings-api', () => ({ engineeringSettingsApi: { get: vi.fn(), save: vi.fn() } }));
const settings: EngineeringSettings = { revision: 7, harness: { compression: 'lite' }, context: { compactionEnabled: true, maxCharacters: 48000 }, memory: { enabled: true }, skills: { disabledIds: ['unavailable-package'] } };
const catalog = [{ id: 'architecture', name: 'Architecture', description: 'Plan service boundaries.', enabled: true }, { id: 'old', name: 'Old package', description: 'Unavailable package', enabled: false }];
const show = (props: Partial<Parameters<typeof EngineeringSettingsDialog>[0]> = {}) => render(<Theme><EngineeringSettingsDialog open onOpenChange={vi.fn()} {...props} /></Theme>);

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(engineeringSettingsApi.get).mockResolvedValue(structuredClone(settings));
  vi.mocked(engineeringSettingsApi.save).mockImplementation(async (value) => ({ ...value, revision: value.revision + 1 }));
  vi.mocked(catalogApi.list).mockResolvedValue({ items: catalog, providers: undefined });
});

it('saves all settings together with the loaded revision and preserves unseen disabled skills', async () => {
  const user = userEvent.setup(); const saved = vi.fn();
  show({ onSaved: saved });
  await user.click(await screen.findByLabelText('Enable skill Architecture'));
  expect(screen.getByLabelText('Enable skill Old package')).toBeDisabled();
  await user.click(screen.getByRole('tab', { name: 'Harness' }));
  await user.click(screen.getByRole('radio', { name: /Ultra/ }));
  expect(screen.getByText(/No fixed reduction is guaranteed/)).toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: 'Memory' }));
  await user.click(screen.getByRole('checkbox', { name: /Enable memory in engineering context/ }));
  await user.click(screen.getByRole('tab', { name: 'Context' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum context characters' }), { target: { value: '64000' } });
  await user.click(screen.getByRole('checkbox', { name: /Enable context compaction/ }));
  await user.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Saved revision 8.');
  expect(engineeringSettingsApi.save).toHaveBeenCalledWith({ revision: 7, harness: { compression: 'ultra' }, context: { compactionEnabled: false, maxCharacters: 64000 }, memory: { enabled: false }, skills: { disabledIds: ['unavailable-package', 'architecture'] } });
  expect(saved).toHaveBeenCalledOnce();
});

it('switches Caveman off and on from the skill menu', async () => {
  const user = userEvent.setup(); show();
  const caveman = await screen.findByRole('checkbox', { name: /^Caveman/ });
  await user.click(caveman);
  await user.click(screen.getByRole('tab', { name: 'Harness' }));
  expect(screen.getByRole('radio', { name: /Off/ })).toBeChecked();
  await user.click(screen.getByRole('tab', { name: 'Skills' }));
  await user.click(screen.getByRole('checkbox', { name: /^Caveman/ }));
  await user.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(engineeringSettingsApi.save).not.toHaveBeenCalled();
});

it('validates the context limit and keeps edits until explicit save or discard', async () => {
  const user = userEvent.setup(); const close = vi.fn();
  show({ initialTab: 'context', onOpenChange: close });
  const limit = await screen.findByRole('spinbutton', { name: 'Maximum context characters' });
  fireEvent.change(limit, { target: { value: '3999' } });
  expect(limit).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Close engineering settings' }));
  expect(close).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Save or discard');
  await user.click(screen.getByRole('button', { name: 'Discard' }));
  expect(limit).toHaveValue(48000);
  await user.click(screen.getByRole('button', { name: 'Close engineering settings' }));
  expect(close).toHaveBeenCalledWith(false);
});

it('preserves local choices on a revision conflict and requires a reload before another save', async () => {
  const user = userEvent.setup();
  vi.mocked(engineeringSettingsApi.save).mockRejectedValueOnce(new ApiError('Conflict', 409, 'SETTINGS_REVISION_CONFLICT'));
  show({ initialTab: 'harness' });
  await user.click(await screen.findByRole('radio', { name: /Full/ }));
  await user.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Your unsaved choices are still shown');
  expect(screen.getByRole('radio', { name: /Full/ })).toBeChecked();
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  vi.mocked(engineeringSettingsApi.get).mockResolvedValue({ ...settings, revision: 9 });
  await user.click(screen.getByRole('button', { name: 'Discard changes and reload' }));
  await waitFor(() => expect(screen.getByText('Revision 9 · Saved')).toBeInTheDocument());
  expect(screen.getByRole('radio', { name: /Lite/ })).toBeChecked();
});

it('reports a settings load failure without fabricating editable defaults', async () => {
  vi.mocked(engineeringSettingsApi.get).mockRejectedValue(new Error('Engine unavailable'));
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('Engine unavailable');
  expect(screen.getByRole('button', { name: 'Retry loading settings' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  expect(screen.queryByRole('checkbox', { name: /^Caveman/ })).not.toBeInTheDocument();
});

it('retains existing overrides when catalog loading fails', async () => {
  const user = userEvent.setup();
  vi.mocked(catalogApi.list).mockRejectedValue(new Error('Catalog unavailable'));
  show();
  expect(await screen.findByRole('alert')).toHaveTextContent('Existing disabled skill IDs are preserved');
  await user.click(screen.getByRole('checkbox', { name: /^Caveman/ }));
  await user.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(engineeringSettingsApi.save).toHaveBeenCalledWith({ ...settings, harness: { compression: 'off' } }));
});
