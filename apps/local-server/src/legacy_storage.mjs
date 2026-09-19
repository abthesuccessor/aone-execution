import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Changing the default must never make an existing user's graphs appear lost.
// An explicit import preserves the SQLite source and creates this new PG store.
export function assertLegacyImportComplete(location) {
  if (typeof location !== 'string' || location === ':memory:' || basename(location) !== 'postgres') return;
  const legacy = join(dirname(location), 'local.db');
  if (existsSync(legacy) && statSync(legacy).isFile() && !existsSync(join(location, 'sqlite-import-manifest.json'))) {
    throw Object.assign(new Error(`Legacy SQLite data exists at ${legacy}. Close the old engine, then run npm run storage:import-sqlite -- --source "${legacy}" --destination "${location}". Import is required before opening the new PostgreSQL store; the original database is preserved.`), { code: 'LEGACY_SQLITE_IMPORT_REQUIRED' });
  }
}
