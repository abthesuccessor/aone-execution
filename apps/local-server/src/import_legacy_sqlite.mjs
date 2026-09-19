import { createHash } from 'node:crypto';
import { mkdir, realpath, writeFile, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalRepository } from './database.mjs';
import { ChatStore } from './chat_store.mjs';
import { HarnessStore } from './harness_store.mjs';
import { HarnessMemoryStore } from './harness_memory_store.mjs';
import { LocalObjectStore } from './object_store.mjs';

const TABLES = ['graphs', 'graph_drafts', 'plan_versions', 'approvals', 'executions', 'execution_events', 'artifacts', 'sources', 'source_chunks', 'catalog_revisions', 'agent_definitions', 'agent_prompt_revisions', 'provider_profiles', 'traces', 'trace_spans', 'trace_events', 'chat_conversations', 'chat_messages', 'chat_proposals', 'engineering_harness_runs', 'engineering_harness_cache', 'harness_memory', 'harness_memory_settings', 'harness_compactions'];
const ORDERED = new Set(['chat_messages', 'engineering_harness_runs', 'harness_compactions']);
const quote = (name) => `"${name.replaceAll('"', '""')}"`;
const rowHash = (row) => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map((key) => [key, row[key]])));
async function publishManifest(target, report) {
  const manifestPath = join(target, 'sqlite-import-manifest.json');
  await mkdir(target, { recursive: true, mode: 0o700 });
  await writeFile(`${manifestPath}.tmp`, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(`${manifestPath}.tmp`, manifestPath);
  return { ...report, manifestPath };
}

/** Explicit offline migration only. SQLite is never used by the running server. */
export async function importLegacySqlite({ source, destination, sourceObjectRoot, destinationObjectRoot } = {}) {
  if (!source || !destination) throw new Error('Both --source and --destination are required. Stop the old application before importing.');
  const sourcePath = await realpath(source);
  const target = resolve(destination);
  if (sourcePath === target) throw new Error('PostgreSQL destination must differ from the legacy SQLite file.');
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(sourcePath, { readOnly: true });
  let repository;
  try {
    legacy.exec('BEGIN');
    if (legacy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Legacy SQLite integrity check failed. No data was imported.');
    if (legacy.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Legacy SQLite foreign-key check failed. No data was imported.');
    const present = new Set(legacy.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name));
    const unknown = [...present].filter((name) => !TABLES.includes(name));
    if (unknown.length) throw new Error(`Unsupported legacy tables require a reviewed migration: ${unknown.join(', ')}.`);
    // Snapshot identity includes rows and their insertion order, not just the main
    // SQLite file (which may have a WAL). The read transaction pins this snapshot.
    const sourceHash = createHash('sha256');
    for (const table of TABLES.filter((name) => present.has(name))) {
      sourceHash.update(table);
      for (const row of legacy.prepare(`SELECT rowid AS __legacy_order, * FROM ${quote(table)} ORDER BY rowid`).iterate()) sourceHash.update(rowHash(row));
    }
    const sourceDigest = sourceHash.digest('hex');
    repository = new LocalRepository(target);
    if (repository.database.hasTable('ege_legacy_imports')) {
      const completed = repository.database.prepare('SELECT manifest_json FROM ege_legacy_imports WHERE id=1').get();
      if (completed) {
        const prior = JSON.parse(completed.manifest_json);
        if (prior.source !== sourcePath || prior.sourceDigest !== sourceDigest) throw new Error('Destination belongs to a different legacy snapshot. Existing PostgreSQL data is preserved.');
        const priorObjects = new LocalObjectStore({ root: prior.destinationObjectRoot });
        for (const object of prior.objects) {
          const verified = await priorObjects.stat(object.digest);
          if (verified.size !== object.size) throw new Error('An imported object no longer matches its verified manifest. Restore the object before publishing the import marker.');
        }
        legacy.exec('COMMIT');
        return await publishManifest(target, prior);
      }
    }
    new ChatStore(repository.database); new HarnessStore(repository.database); new HarnessMemoryStore(repository.database);
    for (const table of TABLES) if (repository.database.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get().count !== 0) throw new Error('Destination contains application data. Import only into a new empty PostgreSQL directory.');
    const sourceObjects = new LocalObjectStore({ root: resolve(sourceObjectRoot || join(dirname(sourcePath), 'object-store')) });
    const targetObjectsPath = resolve(destinationObjectRoot || join(dirname(target), 'object-store'));
    const targetObjects = new LocalObjectStore({ root: targetObjectsPath });
    const objects = [];
    if (present.has('sources')) for (const row of legacy.prepare('SELECT DISTINCT sha256,byte_size FROM sources').all()) {
      const bytes = await sourceObjects.get(row.sha256);
      if (bytes.length !== row.byte_size) throw new Error(`Legacy source size differs for ${row.sha256}.`);
      const stored = await targetObjects.put(bytes);
      objects.push({ digest: stored.digest, size: stored.size });
    }
    const report = { schemaVersion: 1, source: sourcePath, sourceDigest, destination: target, importedAt: new Date().toISOString(), storage: 'native-postgresql', postgresVersion: repository.storageInfo.version, sourcePreserved: true, destinationObjectRoot: targetObjectsPath, tables: [], objects, externalProjectFilesIncluded: false };
    repository.transaction(() => {
      for (const table of TABLES.filter((name) => present.has(name))) {
        const destinationColumns = new Set(repository.database.prepare('SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?').all(table).map((row) => row.column_name));
        let count = 0; const expected = createHash('sha256'); const actual = createHash('sha256');
        for (const sourceRow of legacy.prepare(`SELECT rowid AS __legacy_order, * FROM ${quote(table)} ORDER BY rowid`).iterate()) {
          const { __legacy_order, ...row } = sourceRow;
          if (ORDERED.has(table)) row.sequence = __legacy_order;
          if (table === 'approvals' && !row.approved_content_hash) row.approved_content_hash = legacy.prepare('SELECT content_hash FROM plan_versions WHERE id=?').get(row.plan_id)?.content_hash;
          const columns = Object.keys(row);
          if (columns.some((name) => !destinationColumns.has(name))) throw new Error(`Legacy ${table} has unsupported columns; source remains intact.`);
          const returned = repository.database.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${columns.map(() => '?').join(',')}) RETURNING ${columns.map(quote).join(',')}`).get(...columns.map((key) => row[key]));
          expected.update(rowHash(row)); actual.update(rowHash(returned)); count += 1;
        }
        const expectedDigest = expected.digest('hex'); const actualDigest = actual.digest('hex');
        if (expectedDigest !== actualDigest || repository.database.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get().count !== count) throw new Error(`PostgreSQL import verification failed for ${table}.`);
        if (destinationColumns.has('sequence')) repository.database.prepare(`SELECT setval(pg_get_serial_sequence(?, 'sequence'), COALESCE(MAX(sequence),1), COUNT(*)>0) FROM ${quote(table)}`).get(table);
        report.tables.push({ table, rows: count, digest: actualDigest });
      }
      repository.database.exec('CREATE TABLE IF NOT EXISTS ege_legacy_imports (id INTEGER PRIMARY KEY, manifest_json TEXT NOT NULL)');
      repository.database.prepare('INSERT INTO ege_legacy_imports VALUES (1,?)').run(JSON.stringify(report));
    });
    legacy.exec('COMMIT');
    return await publishManifest(target, report);
  } finally { try { legacy.close(); } finally { repository?.close(); } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i]; const value = process.argv[i + 1];
    const key = { '--source': 'source', '--destination': 'destination', '--source-object-root': 'sourceObjectRoot', '--destination-object-root': 'destinationObjectRoot' }[name];
    if (!key || !value) throw new Error('Usage: storage:import-sqlite -- --source PATH --destination DIRECTORY [--source-object-root PATH] [--destination-object-root PATH]');
    options[key] = resolve(process.env.INIT_CWD || process.cwd(), value);
  }
  process.stdout.write(`${JSON.stringify(await importLegacySqlite(options), null, 2)}\n`);
}
