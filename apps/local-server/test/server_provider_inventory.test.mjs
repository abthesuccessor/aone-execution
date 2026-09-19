import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/index.mjs';

test('catalog inventory caches CLI probes while profiles stay fresh, explicit connection checks refresh, and auth expires', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-inventory-cache-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  const probeLog = join(root, 'probes');
  const ready = join(root, 'authenticated');
  await writeFile(ready, 'ready');
  const cli = join(bin, 'codex');
  await writeFile(cli, [
    '#!/bin/sh',
    `printf 'probe\\n' >> '${probeLog}'`,
    `if [ "$1" = "login" ]; then [ -f '${ready}' ]; exit $?; fi`,
    'if [ "$1" = "--help" ]; then printf "  --search\\n"; fi',
    'exit 0',
  ].join('\n'));
  await chmod(cli, 0o700);
  let clock = 1_700_000_000_000;
  const server = createLocalServer({
    port: 0, databasePath: join(root, 'local.db'), workspaceRoot: root, skillsRoot: join(root, 'skills'),
    environment: { PATH: bin, HOME: root, EGE_ENABLE_WORKSPACE_WRITE: '1' },
    providerInventoryClock: () => clock,
  });
  await server.start();
  context.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`${server.address}${path}`, {
      method, headers: { Origin: 'http://127.0.0.1:5173', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  const count = async () => (await readFile(probeLog, 'utf8')).trim().split('\n').length;
  assert.equal((await api('/api/catalog/agents')).status, 200);
  assert.equal(await count(), 3);
  for (let index = 0; index < 4; index += 1) assert.equal((await api('/api/catalog/agents')).status, 200);
  assert.equal(await count(), 3, 'Repeated catalog reads must not spawn authentication/help commands.');
  const disabled = await api('/api/provider-profiles/codex-cli', 'PUT', { enabled: false });
  assert.equal(disabled.body.provider.available, false);
  assert.deepEqual(disabled.body.provider.capabilities, []);
  const enabled = await api('/api/provider-profiles/codex-cli', 'PUT', { enabled: true, model: 'selected-model' });
  assert.equal(enabled.body.provider.profile.enabled, true);
  assert.equal(enabled.body.provider.available, false, 'Re-enabling a disconnected profile still requires reconnecting.');
  assert.equal(enabled.body.provider.profile.model, 'selected-model');
  assert.equal(await count(), 3, 'Profile edits recompute metadata without repeating unrelated CLI probes.');
  const body = { kind: 'cli', providerId: 'codex-cli' };
  assert.equal((await api('/api/provider-connections/discover', 'POST', body)).status, 200);
  assert.equal(await count(), 6);
  assert.equal((await api('/api/provider-connections/connect', 'POST', body)).status, 200);
  assert.equal(await count(), 9, 'Connect probes once and reuses that result for its response.');
  await rm(ready);
  assert.equal((await api('/api/provider-connections/connect', 'POST', body)).status, 422);
  assert.equal(await count(), 12);
  let inventory = (await api('/api/providers')).body.items.find((item) => item.id === 'codex-cli');
  assert.equal(inventory.available, false, 'Failed forced authentication replaces a prior ready snapshot.');
  assert.equal(await count(), 12);
  await writeFile(ready, 'ready again');
  clock += 30_001;
  inventory = (await api('/api/providers')).body.items.find((item) => item.id === 'codex-cli');
  assert.equal(inventory.configured, true, 'Expired readiness observes the restored CLI authentication.');
  assert.equal(inventory.available, false, 'An invalidated connection still requires an explicit reconnect.');
  assert.equal(await count(), 15, 'Expired CLI readiness must be rechecked.');
  assert.equal(Date.parse(inventory.readinessExpiresAt) - Date.parse(inventory.readinessCheckedAt), 30_000);
  assert.equal((await api('/api/providers?refresh=1')).status, 200);
  assert.equal(await count(), 18);
});
