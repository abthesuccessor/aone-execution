import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { LocalRepository } from '../src/database.mjs';
import { ChatStore } from '../src/chat_store.mjs';
import { importLegacySqlite } from '../src/import_legacy_sqlite.mjs';
import { postgresParameters } from '../src/postgres_sync.mjs';
import { LocalObjectStore } from '../src/object_store.mjs';

test('native PostgreSQL persists transactions and ordered chat across clean restarts', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-postgres-storage-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const location = join(root, 'postgres');
  let repository = new LocalRepository(location);
  try {
    assert.equal(repository.storageInfo.engine, 'postgresql');
    assert.match(repository.database.prepare('SELECT version() AS version').get().version, /^PostgreSQL 18\.4 /);
    assert.equal(repository.database.prepare("SELECT current_setting('listen_addresses') AS value").get().value, '');
    assert.equal(repository.database.prepare("SELECT current_setting('synchronous_commit') AS value").get().value, 'on');
    assert.equal((await stat(location)).mode & 0o777, 0o700);
    assert.throws(() => new LocalRepository(location), { code: 'STORAGE_ALREADY_OPEN' });
    const graph = repository.createGraph({ name: 'Native durable graph' });
    assert.throws(() => repository.transaction(() => { repository.createGraph({ name: 'Rolled back' }); throw new Error('rollback'); }), /rollback/);
    const chat = new ChatStore(repository.database);
    const conversation = chat.createConversation(graph.id, [], 'Ordered');
    const first = chat.createMessage(conversation.id, { role: 'user', content: 'first' });
    const second = chat.createMessage(conversation.id, { role: 'assistant', content: 'second' });
    repository.database.prepare('UPDATE chat_messages SET created_at=?').run('2026-01-01T00:00:00.000Z');
    repository.close();
    repository = new LocalRepository(location);
    assert.equal(repository.listGraphs().length, 1);
    assert.equal(repository.getGraph(graph.id).name, 'Native durable graph');
    assert.deepEqual(new ChatStore(repository.database).listMessages(conversation.id).map((item) => item.id), [first.id, second.id]);
    repository.transaction(() => {
      assert.throws(() => repository.transaction(() => { repository.createGraph({ name: 'Nested rollback' }); throw new Error('savepoint'); }), /savepoint/);
      repository.createGraph({ name: 'Outer committed' });
    });
    assert.equal(repository.listGraphs().length, 2);
  } finally { repository.close(); }
});

test('explicit SQLite import verifies rows, preserves source, and refuses implicit fallback or overwrite', async (t) => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(join(tmpdir(), 'ege-postgres-import-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'legacy.db'); const destination = join(root, 'postgres');
  const legacy = new DatabaseSync(source);
  legacy.exec(`CREATE TABLE graphs(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,workspace_path TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE graph_drafts(graph_id TEXT NOT NULL REFERENCES graphs(id),revision INTEGER NOT NULL,nodes_json TEXT NOT NULL,edges_json TEXT NOT NULL,context TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(graph_id,revision));
    CREATE TABLE chat_conversations(id TEXT PRIMARY KEY,graph_id TEXT NOT NULL REFERENCES graphs(id),title TEXT NOT NULL,node_ids_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE chat_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES chat_conversations(id),role TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,action TEXT NOT NULL,provider_id TEXT,model TEXT,context_json TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    INSERT INTO graphs VALUES('graph','Legacy graph','Preserve me',NULL,'now','now');
    INSERT INTO graph_drafts VALUES('graph',1,'[]','[]','','now');
    INSERT INTO chat_conversations VALUES('conversation','graph','History','[]','now','now');
    INSERT INTO chat_messages VALUES('z','conversation','user','first','completed','discuss',NULL,NULL,'{}','{}','same','same');
    INSERT INTO chat_messages VALUES('a','conversation','assistant','second','completed','discuss',NULL,NULL,'{}','{}','same','same');`);
  legacy.exec('CREATE TABLE sources(id TEXT PRIMARY KEY,graph_id TEXT NOT NULL REFERENCES graphs(id),node_id TEXT,filename TEXT NOT NULL,media_type TEXT NOT NULL,byte_size INTEGER NOT NULL,sha256 TEXT NOT NULL,object_key TEXT NOT NULL,parser_id TEXT NOT NULL,parser_version TEXT NOT NULL,parse_status TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL)');
  const sourceObjects = new LocalObjectStore({ root: join(root, 'object-store') });
  const sourceObject = await sourceObjects.put('Preserved source evidence');
  legacy.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('source', 'graph', null, 'source.txt', 'text/plain', sourceObject.size, sourceObject.digest, sourceObject.key, 'text', '1', 'PARSED', '{}', 'now');
  legacy.close();
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const before = digest(await readFile(source));
  assert.throws(() => new LocalRepository(source), { code: 'LEGACY_SQLITE_IMPORT_REQUIRED' });
  const destinationObjectRoot = join(root, 'migrated-objects');
  const result = await importLegacySqlite({ source, destination, destinationObjectRoot });
  assert.equal(result.tables.find((item) => item.table === 'chat_messages').rows, 2);
  assert.equal(digest(await readFile(source)), before);
  assert.equal(JSON.parse(await readFile(join(destination, 'sqlite-import-manifest.json'), 'utf8')).sourcePreserved, true);
  assert.equal((await new LocalObjectStore({ root: destinationObjectRoot }).get(sourceObject.digest)).toString(), 'Preserved source evidence');
  const repository = new LocalRepository(destination);
  try {
    assert.equal(repository.getGraph('graph').description, 'Preserve me');
    assert.equal(repository.getSource('source').sha256, sourceObject.digest);
    const chat = new ChatStore(repository.database);
    assert.deepEqual(chat.listMessages('conversation').map((item) => item.content), ['first', 'second']);
    chat.createMessage('conversation', { role: 'user', content: 'third' });
    assert.deepEqual(chat.listMessages('conversation').map((item) => item.content), ['first', 'second', 'third']);
  } finally { repository.close(); }
  await rm(join(destination, 'sqlite-import-manifest.json'));
  const repaired = await importLegacySqlite({ source, destination });
  assert.equal(repaired.sourceDigest, result.sourceDigest);
  const untouched = new LocalRepository(destination);
  try { assert.equal(new ChatStore(untouched.database).listMessages('conversation').length, 3); } finally { untouched.close(); }
  assert.equal(digest(await readFile(source)), before);
});

test('guardian stops the private PostgreSQL process after engine SIGKILL', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-postgres-guardian-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/database.mjs', import.meta.url).href;
  const code = `import {LocalRepository} from ${JSON.stringify(moduleUrl)}; const r = new LocalRepository(${JSON.stringify(join(root, 'postgres'))}); console.log(JSON.stringify(r.storageInfo)); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  const info = await new Promise((done, reject) => {
    let buffer = ''; let errors = '';
    const timeout = setTimeout(() => reject(new Error(`Child startup timed out: ${errors}`)), 30_000);
    child.stderr.on('data', (chunk) => { errors += chunk; });
    child.stdout.on('data', (chunk) => { buffer += chunk; if (buffer.includes('\n')) { clearTimeout(timeout); done(JSON.parse(buffer.split('\n')[0])); } });
    child.on('error', reject);
  });
  child.kill('SIGKILL');
  const deadline = Date.now() + 20_000;
  let running = true;
  while (Date.now() < deadline) {
    try { process.kill(info.pid, 0); } catch (error) { if (error.code === 'ESRCH') { running = false; break; } }
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(running, false, 'Private PostgreSQL outlived its engine and guardian grace period');
  const reopened = new LocalRepository(join(root, 'postgres'));
  reopened.close();
});

test('parameter binding leaves quoted question marks unchanged', () => {
  assert.equal(postgresParameters("SELECT '?' AS literal, ? AS value, 'it''s ?' AS text"), "SELECT '?' AS literal, $1 AS value, 'it''s ?' AS text");
});
