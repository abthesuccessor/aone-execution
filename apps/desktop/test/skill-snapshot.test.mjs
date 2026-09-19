import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import test from 'node:test';
import { ingestSkillSnapshot, verifySkillSnapshot } from '../../../scripts/skill-snapshot.mjs';
import { SkillCatalog } from '../../local-server/src/skills.mjs';

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ege-skill-snapshot-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const agents = join(root, 'agents'), codex = join(root, 'codex'), targetRoot = join(root, 'fixed');
  await Promise.all([mkdir(agents), mkdir(codex)]);
  return { root, agents, codex, targetRoot, sources: [
    { id: 'agents', root: agents, prefix: '', displayPath: '~/.agents/skills' },
    { id: 'codex', root: codex, prefix: 'codex', displayPath: '~/.codex/skills' },
  ] };
}

async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function skill(root, relative, text = 'Use the local resources to complete this task.') {
  await put(join(root, relative, 'SKILL.md'), `---\nname: ${basename(relative)}\ndescription: Bounded fixture skill.\n---\n\n${text}\n`);
}

async function regularTree(root) {
  const paths = [];
  for (const name of await readdir(root)) {
    const path = join(root, name), info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `${path} must be a copied resource`);
    if (info.isDirectory()) paths.push(...(await regularTree(path)).map(child => `${name}/${child}`));
    else paths.push(name);
  }
  return paths.sort();
}

test('ingestion materializes mounted catalogs and linked references as independent real files', async (context) => {
  const fixtureData = await fixture(context);
  const { root, agents, targetRoot } = fixtureData;
  const mounted = join(root, 'external-catalog');
  await skill(mounted, 'cloud/cloud-guide', 'Read [reference](references/guide.md) and run scripts/check.sh.');
  await put(join(mounted, 'shared/guide.md'), 'Pinned guidance.\n');
  await symlink('../../shared', join(mounted, 'cloud/cloud-guide/references'));
  await put(join(mounted, 'cloud/cloud-guide/scripts/check.sh'), '#!/bin/sh\nexit 0\n');
  await chmod(join(mounted, 'cloud/cloud-guide/scripts/check.sh'), 0o755);
  await symlink(mounted, join(agents, 'google-skills'));

  const manifest = await ingestSkillSnapshot(fixtureData);
  const copied = join(targetRoot, 'google-skills/cloud/cloud-guide');
  assert.equal(await readFile(join(copied, 'references/guide.md'), 'utf8'), 'Pinned guidance.\n');
  assert.equal((await stat(join(copied, 'scripts/check.sh'))).mode & 0o777, 0o755);
  assert.deepEqual(manifest.materializedLinks, [
    { source: 'agents', path: 'google-skills' },
    { source: 'agents', path: 'google-skills/cloud/cloud-guide/references' },
  ]);
  assert((await regularTree(targetRoot)).includes('google-skills/cloud/cloud-guide/references/guide.md'));
  await rm(mounted, { recursive: true });
  const verified = await verifySkillSnapshot(targetRoot);
  assert.equal(verified.items.length, 1);
  assert(verified.items[0].packageFiles.some(file => file.path === 'references/guide.md'));
});

test('ingestion excludes private environments and caches while preserving distributable templates', async (context) => {
  const fixtureData = await fixture(context);
  await skill(fixtureData.agents, 'safe-skill');
  const packageRoot = join(fixtureData.agents, 'safe-skill');
  for (const path of ['.venv/bin/python', 'venv/activate', 'node_modules/dependency/index.js', '.git/config', '__pycache__/cached.pyc', '.cache/index', '.env', '.env.local', '.env.production', 'script.pyc', 'script.pyo']) await put(join(packageRoot, path), 'private or generated fixture');
  for (const path of ['.env.example', '.env.sample', '.env.template', 'scripts/run.py']) await put(join(packageRoot, path), 'safe template fixture');
  const manifest = await ingestSkillSnapshot(fixtureData);
  assert.deepEqual((await regularTree(join(fixtureData.targetRoot, 'safe-skill'))), ['.env.example', '.env.sample', '.env.template', 'SKILL.md', 'scripts/run.py'].sort());
  for (const path of ['safe-skill/.venv', 'safe-skill/.env', 'safe-skill/.env.production', 'safe-skill/script.pyc']) assert(manifest.excluded.some(entry => entry.source === 'agents' && entry.path === path), path);
  assert(manifest.files.every(file => !file.path.includes('.venv') && !file.path.endsWith('/.env')));
});

test('duplicate skill names retain stable agents IDs and distinct Codex paths with exact origins', async (context) => {
  const fixtureData = await fixture(context);
  await skill(fixtureData.agents, 'nested/same-skill', 'Agents version.');
  await skill(fixtureData.codex, 'nested/same-skill', 'Codex version.');
  const original = (await new SkillCatalog({ root: fixtureData.agents }).list()).items[0];
  const manifest = await ingestSkillSnapshot(fixtureData);
  const { items } = await verifySkillSnapshot(fixtureData.targetRoot);
  const agents = items.find(item => item.relativePath === 'nested/same-skill/SKILL.md');
  const codex = items.find(item => item.relativePath === 'codex/nested/same-skill/SKILL.md');
  assert.equal(agents.id, original.id);
  assert.notEqual(agents.id, codex.id);
  assert.deepEqual(agents.sourceProvenance, [{ source: 'agents', path: 'nested/same-skill/SKILL.md' }]);
  assert.deepEqual(codex.sourceProvenance, [{ source: 'codex', path: 'nested/same-skill/SKILL.md' }]);
  assert.deepEqual(manifest.sources, [
    { id: 'agents', path: '~/.agents/skills', skillCount: 1 },
    { id: 'codex', path: '~/.codex/skills', skillCount: 1 },
  ]);
});

test('fixed verification never reads changed or missing source homes and rejects copied resource drift', async (context) => {
  const fixtureData = await fixture(context);
  await skill(fixtureData.agents, 'stable-skill');
  await put(join(fixtureData.agents, 'stable-skill/references/pinned.md'), 'Original reference.');
  const manifest = await ingestSkillSnapshot(fixtureData);
  await put(join(fixtureData.agents, 'stable-skill/references/pinned.md'), 'Home source changed.');
  await rename(fixtureData.agents, `${fixtureData.agents}-unavailable`);
  await rm(fixtureData.codex, { recursive: true });
  const current = await verifySkillSnapshot(fixtureData.targetRoot);
  assert.deepEqual(current.manifest, manifest);
  assert.equal(await readFile(join(fixtureData.targetRoot, 'stable-skill/references/pinned.md'), 'utf8'), 'Original reference.');
  await put(join(fixtureData.targetRoot, 'stable-skill/references/pinned.md'), 'Tampered snapshot.');
  await assert.rejects(verifySkillSnapshot(fixtureData.targetRoot), /Fixed skill files differ from their manifest/);
});

test('invalid refreshed skill leaves the previous snapshot byte-for-byte intact and removes staging', async (context) => {
  const fixtureData = await fixture(context);
  await skill(fixtureData.agents, 'stable-skill');
  await ingestSkillSnapshot(fixtureData);
  const manifestBefore = await readFile(join(fixtureData.targetRoot, '.catalog-manifest.json'));
  const skillBefore = await readFile(join(fixtureData.targetRoot, 'stable-skill/SKILL.md'));
  await put(join(fixtureData.agents, 'stable-skill/SKILL.md'), 'Invalid changed skill without metadata.');
  await assert.rejects(ingestSkillSnapshot(fixtureData), /Imported skills need correction/);
  assert.deepEqual(await readFile(join(fixtureData.targetRoot, '.catalog-manifest.json')), manifestBefore);
  assert.deepEqual(await readFile(join(fixtureData.targetRoot, 'stable-skill/SKILL.md')), skillBefore);
  await verifySkillSnapshot(fixtureData.targetRoot);
  assert(!(await readdir(fixtureData.root)).some(name => name.startsWith('fixed.import-') || name.startsWith('fixed.previous-')));
});

test('nested links escaping declared mounts cannot replace an existing snapshot', async (context) => {
  const fixtureData = await fixture(context);
  await skill(fixtureData.agents, 'stable-skill');
  const before = await ingestSkillSnapshot(fixtureData);
  await put(join(fixtureData.root, 'outside/private.txt'), 'Do not import this resource.');
  await symlink(join(fixtureData.root, 'outside/private.txt'), join(fixtureData.agents, 'stable-skill/leaked.txt'));
  await assert.rejects(ingestSkillSnapshot(fixtureData), /escapes its source mounts/);
  assert.deepEqual((await verifySkillSnapshot(fixtureData.targetRoot)).manifest, before);
});

test('disjoint agents folders in the Codex namespace retain their exact source provenance', async (context) => {
  const fixtureData = await fixture(context);
  await skill(fixtureData.agents, 'codex/agents-only');
  await skill(fixtureData.codex, 'codex-only');
  const manifest = await ingestSkillSnapshot(fixtureData);
  assert.deepEqual(manifest.skills.map(item => ({ path: item.path, origins: item.origins })), [
    { path: 'codex/agents-only/SKILL.md', origins: [{ source: 'agents', path: 'codex/agents-only/SKILL.md' }] },
    { path: 'codex/codex-only/SKILL.md', origins: [{ source: 'codex', path: 'codex-only/SKILL.md' }] },
  ]);
  const { items } = await verifySkillSnapshot(fixtureData.targetRoot);
  assert.deepEqual(items.find(item => item.name === 'agents-only').sourceProvenance, [{ source: 'agents', path: 'codex/agents-only/SKILL.md' }]);
  assert.deepEqual(manifest.sources.map(source => source.skillCount), [1, 1]);
});

test('exact Codex path collisions fail without replacing the existing snapshot', async (context) => {
  const fixtureData = await fixture(context);
  await skill(fixtureData.agents, 'stable-skill');
  const before = await ingestSkillSnapshot(fixtureData);
  await skill(fixtureData.agents, 'codex/same-skill', 'Agents original.');
  await skill(fixtureData.codex, 'same-skill', 'Conflicting Codex version.');
  await assert.rejects(ingestSkillSnapshot(fixtureData), { code: 'EEXIST' });
  assert.deepEqual((await verifySkillSnapshot(fixtureData.targetRoot)).manifest, before);
});

test('catalog nesting limits cannot silently omit copied skill packages', async (context) => {
  const fixtureData = await fixture(context);
  await skill(fixtureData.agents, 'stable-skill');
  const before = await ingestSkillSnapshot(fixtureData);
  await skill(fixtureData.agents, `${Array.from({ length: 12 }, (_, index) => `level-${index}`).join('/')}/hidden-skill`);
  await assert.rejects(ingestSkillSnapshot(fixtureData), /(?:depth|nesting|omitted|discover|catalog|limit|unrecognized)/i);
  assert.deepEqual((await verifySkillSnapshot(fixtureData.targetRoot)).manifest, before);
});
