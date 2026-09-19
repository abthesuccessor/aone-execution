import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { LocalRepository } from '../src/database.mjs';
import { EngineeringSettingsStore } from '../src/engineering_settings.mjs';
import { createHarnessMemory } from '../src/harness_memory.mjs';

test('engineering controls persist in PostgreSQL and reject stale concurrent window saves', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-controls-'));
  let repository = new LocalRepository(join(root, 'postgres'));
  t.after(async () => { repository.close(); await rm(root, { recursive: true, force: true }); });
  let store = new EngineeringSettingsStore(repository);
  const initial = store.get();
  assert.equal(repository.storageInfo.engine, 'postgresql');
  const updated = store.update({ ...initial, expectedRevision: initial.revision, harness: { compression: 'ultra' }, skills: { disabledIds: ['reviewer'] } });
  assert.equal(updated.revision, 1);
  assert.throws(() => store.update({ ...initial, expectedRevision: 0 }), { code: 'ENGINEERING_SETTINGS_STALE' });
  assert.deepEqual(store.get(), updated);
  repository.close();
  repository = new LocalRepository(join(root, 'postgres'));
  store = new EngineeringSettingsStore(repository);
  assert.deepEqual(store.get(), updated);
});

test('global memory switch suppresses both prompt recall and optional remote recall', async (t) => {
  const repository = new LocalRepository(':memory:');
  const controls = new EngineeringSettingsStore(repository);
  let remoteCalls = 0;
  const memory = createHarnessMemory({ repository, engineeringSettings: controls, fetchImpl: async () => { remoteCalls += 1; return Response.json({ results: [] }); } });
  t.after(() => { memory.close(); repository.close(); });
  const graph = repository.createGraph({ name: 'Memory switch' });
  memory.remember({ graphId: graph.id, content: 'Use fixture data.', validation: { state: 'user_confirmed' } });
  memory.updateSettings(graph.id, { provider: 'mem0', endpoint: 'https://memory.example.test', remoteRecallEnabled: true });
  const initial = controls.get();
  controls.update({ ...initial, expectedRevision: initial.revision, memory: { enabled: false } });
  const disabled = await memory.recall({ graphId: graph.id, query: 'fixture' });
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.context, '');
  assert.equal(remoteCalls, 0);
  assert.equal(memory.list(graph.id).length, 1, 'switch does not delete preserved memory');
});
