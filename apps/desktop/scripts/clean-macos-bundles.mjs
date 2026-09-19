import { readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const productPrefix = 'Aone Execution';
const bundleDirectories = [
  join(desktopRoot, 'out', 'make'),
  join(desktopRoot, 'src-tauri', 'target', 'release', 'bundle', 'dmg'),
];
const removed = [];

for (const directory of bundleDirectories) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(productPrefix) || !entry.name.endsWith('.dmg')) continue;
    const path = join(directory, entry.name);
    await rm(path, { force: true });
    removed.push(path);
  }
}

process.stdout.write(removed.length > 0
  ? `Removed ${removed.length} previous desktop DMG${removed.length === 1 ? '' : 's'}.\n`
  : 'No previous desktop DMGs found.\n');
