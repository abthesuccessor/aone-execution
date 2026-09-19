import { fileURLToPath } from 'node:url';
import { resealSkillSnapshot } from './skill-snapshot.mjs';

if (process.env.EGE_SKILLS_CONFIRM_RESEAL !== '1') {
  process.stderr.write([
    'Resealing re-signs the skill catalog from the files currently on disk.',
    '',
    'The snapshot is a provenance record: every file is pinned by SHA-256 so a',
    'build can prove the catalog it ships is the one that was imported. Resealing',
    'breaks that chain on purpose. Use it only when the files on disk are the only',
    'surviving copy and some were damaged in transit, so `npm run skills:ingest`',
    'can no longer rebuild them from the original sources.',
    '',
    'The new manifest records what changed under a `resealed` key, so the result',
    'is never mistaken for a pristine import.',
    '',
    'If the original sources are still intact, run this instead:',
    '',
    '    npm run skills:ingest',
    '',
    'To reseal anyway:',
    '',
    '    EGE_SKILLS_CONFIRM_RESEAL=1 npm run skills:reseal',
    '',
  ].join('\n'));
  process.exit(1);
}

const targetRoot = fileURLToPath(new URL('../apps/desktop/resources/skills', import.meta.url));
const manifest = await resealSkillSnapshot(targetRoot);
const { changed, added, removed } = manifest.resealed;

process.stdout.write(`Resealed ${manifest.skills.length} skills (${manifest.files.length} files).\n`);
if (changed.length) {
  process.stdout.write(`\n${changed.length} file(s) no longer match the bytes that were imported:\n`);
  for (const file of changed) process.stdout.write(`  ${file.path}\n    now ${file.size} bytes, imported ${file.importedSize}\n`);
}
for (const path of added) process.stdout.write(`  added since import: ${path}\n`);
for (const path of removed) process.stdout.write(`  gone since import: ${path}\n`);
if (!changed.length && !added.length && !removed.length) process.stdout.write('Nothing had drifted; the manifest was already accurate.\n');
