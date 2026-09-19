import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestSkillSnapshot } from './skill-snapshot.mjs';

const targetRoot = fileURLToPath(new URL('../apps/desktop/resources/skills', import.meta.url));
const allowShrink = process.env.EGE_SKILLS_ALLOW_SHRINK === '1';
const manifest = await ingestSkillSnapshot({ targetRoot, allowShrink, sources: [
  { id: 'agents', root: join(homedir(), '.agents/skills'), prefix: '', displayPath: '~/.agents/skills' },
  { id: 'codex', root: join(homedir(), '.codex/skills'), prefix: 'codex', displayPath: '~/.codex/skills' },
] });
process.stdout.write(`Imported ${manifest.skills.length} fixed skills (${manifest.files.length} files) into ${targetRoot}\n`);
for (const source of manifest.sources) process.stdout.write(`${source.path}: ${source.skillCount} skills\n`);
process.stdout.write(`Materialized ${manifest.materializedLinks.length} links; excluded ${manifest.excluded.length} environment/cache/private-file entries.\n`);
