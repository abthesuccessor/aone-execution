import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { SkillCatalog, defaultSkillRoot, parseSkillMetadata } from '../src/skills.mjs';

test('skill frontmatter uses YAML block-scalar semantics instead of exposing syntax markers', () => {
  const folded = parseSkillMetadata(`---
name: api-engineering
description: >-
  Designs typed HTTP and GraphQL contracts.
  Verifies compatibility and failure behavior.
---
# API engineering
`, 'api-engineering/SKILL.md');

  assert.equal(folded.valid, true);
  assert.equal(
    folded.description,
    'Designs typed HTTP and GraphQL contracts. Verifies compatibility and failure behavior.',
  );
  assert.notEqual(folded.description, '>-');
});

test('malformed or non-string skill metadata fails closed', () => {
  const malformed = parseSkillMetadata(`---
name: [not, a, string]
description: 42
---
`, 'api-engineering/SKILL.md');

  assert.equal(malformed.valid, false);
  assert.ok(malformed.validationErrors.some((error) => error.includes('name') && error.includes('string')));
  assert.ok(malformed.validationErrors.some((error) => error.includes('description') && error.includes('string')));
});

test('catalog routes relevant skills automatically without a user selection', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-auto-skills-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fixtures = [
    ['frontend-quality', 'Accessible React frontend interface, responsive layout, keyboard, and browser testing guidance.'],
    ['gke-security', 'Hardens GKE Kubernetes workloads with network policy and workload identity controls.'],
    ['find-skills', 'Discovers and installs capability packages only when explicitly requested.'],
  ];
  for (const [name, description] of fixtures) {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
  }

  const catalog = new SkillCatalog({ root });
  await catalog.scan();
  assert.deepEqual(
    catalog.selectRelevantMetadata('Frontend engineer implementing an accessible React browser interface and responsive keyboard behavior.')
      .map((skill) => skill.name),
    ['frontend-quality'],
  );
  assert.deepEqual(
    catalog.selectRelevantMetadata('Secure a GKE Kubernetes workload with workload identity and network policy.')
      .map((skill) => skill.name),
    ['gke-security'],
  );
  assert.equal(catalog.routingManifest().mode, 'agent-managed');
  assert.equal(catalog.routingManifest().catalogCount, fixtures.length);
  assert.match(catalog.routingManifest().catalogDigest, /^sha256:[a-f0-9]{64}$/);
});

test('planning can reuse a scanned catalog while an explicit scan refreshes changed packages', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-cached-skills-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const firstDirectory = join(root, 'first-skill');
  await mkdir(firstDirectory, { recursive: true });
  await writeFile(join(firstDirectory, 'SKILL.md'), '---\nname: first-skill\ndescription: First reusable skill.\n---\n');

  const catalog = new SkillCatalog({ root });
  assert.equal((await catalog.ensureScanned()).length, 1);

  const secondDirectory = join(root, 'second-skill');
  await mkdir(secondDirectory, { recursive: true });
  await writeFile(join(secondDirectory, 'SKILL.md'), '---\nname: second-skill\ndescription: Second refreshable skill.\n---\n');

  assert.equal((await catalog.ensureScanned()).length, 1);
  assert.equal((await catalog.scan()).length, 2);
});

test('the default skill catalog uses fixed project resources while explicit roots remain supported', () => {
  const expected = fileURLToPath(new URL('../../desktop/resources/skills', import.meta.url));
  assert.equal(defaultSkillRoot, expected);
  assert.equal(new SkillCatalog().root, expected);
  assert.equal(new SkillCatalog({ root: '/tmp/explicit-ege-skills' }).root, '/tmp/explicit-ege-skills');
});

test('source namespaces preserve legacy skill IDs and distinguish duplicate names across copies and edits', async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'ege-source-skills-'));
  context.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const root = join(temporaryRoot, 'original');
  const paths = ['same-skill', 'codex/same-skill'];
  for (const path of paths) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(join(root, path, 'SKILL.md'), '---\nname: same-skill\ndescription: Shared skill instructions.\n---\nOriginal instructions.\n');
  }
  const catalog = new SkillCatalog({ root });
  const items = await catalog.scan();
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.name), ['same-skill', 'same-skill']);
  assert.equal(new Set(items.map((item) => item.id)).size, 2);
  const legacy = items.find((item) => item.relativePath === 'same-skill/SKILL.md');
  assert.equal(legacy.id, `skill_${createHash('sha256').update('same-skill/SKILL.md').digest('hex').slice(0, 16)}`);
  await cp(root, join(temporaryRoot, 'relocated'), { recursive: true });
  assert.deepEqual((await new SkillCatalog({ root: join(temporaryRoot, 'relocated') }).scan()).map((item) => item.id), items.map((item) => item.id));
  await writeFile(join(root, 'same-skill/SKILL.md'), '---\nname: same-skill\ndescription: Revised instructions.\n---\nChanged body.\n');
  const revised = (await catalog.scan()).find((item) => item.id === legacy.id);
  assert.notEqual(revised.contentDigest, legacy.contentDigest);
  assert.equal(catalog.validateSelection(items.map((item) => item.id)).valid, true);
});

test('source provenance requires matching skill and whole-package hashes and is not retained for edited overrides', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-provenance-skills-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'codex/source-skill');
  await mkdir(directory, { recursive: true });
  const content = '---\nname: source-skill\ndescription: Provenance fixture.\n---\nRead reference.md.\n';
  await writeFile(join(directory, 'SKILL.md'), content);
  await writeFile(join(directory, 'reference.md'), 'Original reference.\n');
  const catalog = new SkillCatalog({ root });
  const [original] = await catalog.scan();
  const origins = [{ source: 'codex', path: 'source-skill/SKILL.md' }];
  const entry = { path: original.relativePath, sha256: original.contentDigest, packageDigest: original.packageDigest, files: original.packageFiles, origins };
  const saveManifest = (entries) => writeFile(join(root, '.catalog-manifest.json'), JSON.stringify({ version: 2, skills: entries }));
  await saveManifest([entry]);
  assert.deepEqual((await catalog.scan())[0].sourceProvenance, origins);
  assert.deepEqual(catalog.resolveMetadata([original.id])[0].sourceProvenance, origins);
  assert.equal((await catalog.scan())[0].sourceRoot, 'agent-skill-catalog');

  for (const invalid of [
    { ...entry, path: 'other/source-skill/SKILL.md' },
    { ...entry, sha256: '0'.repeat(64) },
    { ...entry, packageDigest: '0'.repeat(64) },
    { ...entry, origins: [{ source: 'codex', path: '../source-skill/SKILL.md' }] },
  ]) {
    await saveManifest([invalid]);
    assert.equal((await catalog.scan())[0].sourceProvenance, undefined);
  }
  await saveManifest([entry, entry]);
  assert.equal((await catalog.scan())[0].sourceProvenance, undefined);
  await saveManifest([entry]);
  await writeFile(join(directory, 'reference.md'), 'Changed reference.\n');
  assert.equal((await catalog.scan())[0].sourceProvenance, undefined);
  await writeFile(join(directory, 'reference.md'), 'Original reference.\n');
  catalog.setRepository({ listCatalogRevisions: () => [{ id: original.id, version: 1, digest: 'override', data: {
    name: original.name, description: original.description, content: `${content}\nUser revision.`, basePackageDigest: original.packageDigest, basePackageFiles: original.packageFiles,
  } }] });
  const [overridden] = await catalog.scan();
  assert.equal(overridden.valid, true);
  assert.equal(overridden.sourceProvenance, undefined);
});

test('linked provenance manifests are ignored and namespaced Google skills retain product-specific routing', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-namespaced-skills-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'codex/google-skills/cloud/api-security');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '---\nname: api-security\ndescription: Secures HTTP API contracts and authentication for Google cloud.\n---\nInstructions.\n');
  const catalog = new SkillCatalog({ root });
  const [item] = await catalog.scan();
  await writeFile(join(root, 'linked-manifest.json'), JSON.stringify({ version: 2, skills: [{ path: item.relativePath, sha256: item.contentDigest, packageDigest: item.packageDigest, origins: [{ source: 'codex', path: 'google-skills/cloud/api-security/SKILL.md' }] }] }));
  await symlink(join(root, 'linked-manifest.json'), join(root, '.catalog-manifest.json'));
  assert.equal((await catalog.scan())[0].sourceProvenance, undefined);
  assert.deepEqual(catalog.selectRelevantMetadata('Secure HTTP API authentication contracts.'), []);
  assert.deepEqual(catalog.selectRelevantMetadata('Secure Google cloud HTTP API authentication contracts.').map((skill) => skill.id), [item.id]);
});

test('whole packages accept 2048 regular files but reject the next file without relaxing byte limits', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-package-file-bound-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'reference-library');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'SKILL.md'), '---\nname: reference-library\ndescription: Many small reference files.\n---\nInstructions.\n');
  for (let offset = 0; offset < 2047; offset += 32) {
    await Promise.all(Array.from({ length: Math.min(32, 2047 - offset) }, (_, index) => writeFile(join(directory, `reference-${offset + index}.md`), '')));
  }
  const catalog = new SkillCatalog({ root });
  const [accepted] = await catalog.scan();
  assert.equal(accepted.valid, true);
  assert.equal(accepted.packageFiles.length, 2048);
  await writeFile(join(directory, 'one-too-many.md'), '');
  const [rejected] = await catalog.scan();
  assert.equal(rejected.valid, false);
  assert.ok(rejected.validationErrors.some((error) => error.includes('2048 regular files')));
  await rm(join(directory, 'one-too-many.md'));
  await writeFile(join(directory, 'reference-0.md'), Buffer.alloc(16 * 1024 * 1024));
  const [oversized] = await catalog.scan();
  assert.equal(oversized.valid, false);
  assert.ok(oversized.validationErrors.some((error) => error.includes('16777216 bytes')));
});
