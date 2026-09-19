import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifySkillSnapshot } from '../../../scripts/skill-snapshot.mjs';

if (process.env.EGE_SKILLS_SOURCE?.trim()) throw new Error('Builds use the fixed project skill snapshot. Run npm run skills:ingest explicitly to refresh it; EGE_SKILLS_SOURCE no longer overwrites build resources.');

const targetRoot = fileURLToPath(new URL('../resources/skills', import.meta.url));

// The snapshot is deliberately not tracked in version control: it is materialized
// from the operator's own ~/.agents/skills and ~/.codex/skills, which are
// third-party packages this repository has no licence to redistribute. A fresh
// clone therefore has no snapshot, and that is an expected, recoverable state --
// not a corrupt checkout. Say so plainly instead of surfacing a bare ENOENT.
try {
  await access(join(targetRoot, '.catalog-manifest.json'));
} catch {
  throw new Error([
    'No skill catalog snapshot found.',
    '',
    `Expected: ${join(targetRoot, '.catalog-manifest.json')}`,
    '',
    'This directory is not tracked in git. It is built on your machine from skills',
    'you already have, because the packages belong to their own authors and are not',
    'redistributed here.',
    '',
    'Build it with:',
    '',
    '    npm run skills:ingest',
    '',
    'That reads ~/.agents/skills and ~/.codex/skills. If you have neither, the app',
    'still builds and runs -- create a catalog from inside the app under Skills, or',
    'point EGE_SKILLS_ROOT at a directory of your own SKILL.md packages at runtime.',
    'See docs/SKILL-CATALOG.md.',
  ].join('\n'));
}

const { manifest } = await verifySkillSnapshot(targetRoot);
process.stdout.write(`Verified ${manifest.skills.length} fixed project skills; no home-folder files were read or overwritten.\n`);
