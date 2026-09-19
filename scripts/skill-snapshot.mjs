import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { SkillCatalog } from '../apps/local-server/src/skills.mjs';

const ignored = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.DS_Store', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.catalog-manifest.json']);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const contained = (root, path) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
const normalized = (path) => path.split('\\').join('/');

async function treeFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      // Honour the same exclusion set the import applies. treeFiles previously
      // skipped only the manifest, so an OS-generated file such as .DS_Store --
      // which macOS recreates whenever a folder is viewed -- appeared on disk,
      // never in the manifest, and failed verification. That broke every build
      // path through sync:skills (desktop:start, desktop:build, check).
      if (ignored.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Fixed skills must contain regular files, not links: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) { const bytes = await readFile(path); files.push({ path: normalized(relative(root, path)), sha256: hash(bytes), size: bytes.length }); }
      else throw new Error(`Unsupported skill resource: ${path}`);
    }
  }
  await visit(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export async function verifySkillSnapshot(root) {
  const manifest = JSON.parse(await readFile(join(root, '.catalog-manifest.json'), 'utf8'));
  if (manifest.version !== 2 || !Array.isArray(manifest.files) || !Array.isArray(manifest.skills)) throw new Error('Run npm run skills:ingest to create a fixed version-2 skill snapshot.');
  const files = await treeFiles(root);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files)) throw new Error('Fixed skill files differ from their manifest. Run npm run skills:ingest explicitly to refresh the snapshot.');
  const { items } = await new SkillCatalog({ root }).list();
  if (items.length !== files.filter((file) => file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md')).length) throw new Error('Some fixed SKILL.md files exceed catalog discovery limits.');
  if (!items.length || items.some((item) => !item.valid)) throw new Error(`Invalid fixed skill packages: ${items.filter((item) => !item.valid).map((item) => `${item.relativePath}: ${item.validationErrors.join('; ')}`).join('\n')}`);
  if (items.length !== manifest.skills.length || items.some((item) => !manifest.skills.some((pin) => pin.path === item.relativePath && pin.sha256 === item.contentDigest && pin.packageDigest === item.packageDigest))) throw new Error('Fixed skill package pins do not match the manifest.');
  return { manifest, items };
}

export async function ingestSkillSnapshot({ sources, targetRoot, allowShrink = false }) {
  targetRoot = resolve(targetRoot);
  const resolved = await Promise.all(sources.map(async (source) => ({ ...source, root: await realpath(source.root) })));
  if (resolved.some((source) => contained(source.root, targetRoot) || contained(targetRoot, source.root))) throw new Error('The snapshot output and source folders must not contain each other.');
  if (new Set(resolved.map((source) => source.prefix)).size !== resolved.length || resolved.some((source) => source.prefix && !/^[a-z0-9-]+$/.test(source.prefix))) throw new Error('Source prefixes must be distinct safe directory names.');
  for (const source of resolved) {
    source.allowed = [source.root];
    for (const entry of await readdir(source.root, { withFileTypes: true })) {
      if (entry.isSymbolicLink() && !ignored.has(entry.name)) {
        const target = await realpath(join(source.root, entry.name));
        if ((await stat(target)).isDirectory()) source.allowed.push(target);
      }
    }
  }
  const stage = `${targetRoot}.import-${randomUUID()}`;
  const backup = `${targetRoot}.previous-${randomUUID()}`;
  const excluded = []; const materializedLinks = []; const origins = new Map(); let totalBytes = 0; let fileCount = 0; let backedUp = false;
  await mkdir(stage, { recursive: true });
  async function copy(source, path, destination, ancestors = []) {
    const leaf = path.split('/').at(-1);
    const sourcePath = normalized(relative(source.root, path));
    if (ignored.has(leaf) || /^\.env(?:\.(?!example$|sample$|template$).*)?$/.test(leaf) || /\.(?:pyc|pyo)$/.test(leaf)) { excluded.push({ source: source.id, path: sourcePath }); return; }
    const canonical = await realpath(path);
    if (!source.allowed.some((root) => contained(root, canonical))) throw new Error(`Skill resource escapes its source mounts: ${source.id}/${sourcePath}`);
    const info = await lstat(path);
    if (info.isSymbolicLink()) materializedLinks.push({ source: source.id, path: sourcePath });
    const actual = await stat(canonical);
    if (actual.isDirectory()) {
      if (ancestors.includes(canonical) || ancestors.length > 16) throw new Error(`Cyclic or excessively nested skill resources: ${source.id}/${sourcePath}`);
      await mkdir(destination, { recursive: true });
      for (const entry of (await readdir(canonical)).sort()) await copy(source, join(path, entry), join(destination, entry), [...ancestors, canonical]);
    } else if (actual.isFile()) {
      const bytes = await readFile(canonical); totalBytes += bytes.length; fileCount += 1;
      if (totalBytes > 128 * 1024 * 1024 || fileCount > 10000) throw new Error('Skill snapshot exceeds 128 MiB or 10,000 files after exclusions.');
      await writeFile(destination, bytes, { flag: 'wx' });
      if (leaf === 'SKILL.md') origins.set(normalized(relative(stage, destination)), { source: source.id, path: sourcePath });
      await chmod(destination, actual.mode & 0o111 ? 0o755 : 0o644);
    } else throw new Error(`Unsupported source resource: ${source.id}/${sourcePath}`);
  }
  try {
    for (const source of resolved) await copy(source, source.root, join(stage, source.prefix));
    const { items } = await new SkillCatalog({ root: stage }).list();
    if (items.length !== origins.size) throw new Error('Some imported SKILL.md files exceed catalog discovery limits; no snapshot was published.');
    if (!items.length || items.some((item) => !item.valid)) throw new Error(`Imported skills need correction: ${items.filter((item) => !item.valid).map((item) => `${item.relativePath}: ${item.validationErrors.join('; ')}`).join('\n')}`);
    const skills = items.map((item) => {
      const origin = origins.get(item.relativePath);
      if (!origin) throw new Error(`No source provenance for ${item.relativePath}.`);
      return { path: item.relativePath, sha256: item.contentDigest, packageDigest: item.packageDigest, files: item.packageFiles, origins: [origin] };
    }).sort((a, b) => a.path.localeCompare(b.path));
    const manifest = { version: 2, generatedAt: new Date().toISOString(), sources: sources.map((source) => ({ id: source.id, path: source.displayPath || source.root, skillCount: skills.filter((item) => item.origins.some((origin) => origin.source === source.id)).length })), skills, files: await treeFiles(stage), excluded, materializedLinks };
    await writeFile(join(stage, '.catalog-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await verifySkillSnapshot(stage);
    // Publishing is destructive: the previous snapshot is renamed aside and then
    // deleted. An emptied or half-populated source directory therefore silently
    // replaces a large working catalog with a tiny one. Refuse an unexplained
    // collapse and make the operator opt in, naming the exact counts.
    if (!allowShrink) {
      const previous = await readFile(join(targetRoot, '.catalog-manifest.json'), 'utf8').then((text) => JSON.parse(text).skills?.length ?? 0).catch(() => 0);
      if (previous && skills.length < Math.min(previous, Math.ceil(previous / 2))) throw new Error(`Refusing to shrink the skill catalog from ${previous} packages to ${skills.length}. The existing snapshot was kept.\n\nThis usually means a source directory is empty or was moved. Sources read:\n${resolved.map((source) => `  ${source.displayPath || source.root}`).join('\n')}\n\nIf the reduction is intended, re-run with EGE_SKILLS_ALLOW_SHRINK=1.`);
    }
    try { if ((await lstat(targetRoot)).isSymbolicLink()) throw new Error('The snapshot target must not be a symlink.'); await rename(targetRoot, backup); backedUp = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(stage, targetRoot); } catch (error) { if (backedUp) await rename(backup, targetRoot); backedUp = false; throw error; }
    if (backedUp) await rm(backup, { recursive: true, force: true });
    return manifest;
  } finally { await rm(stage, { recursive: true, force: true }); }
}
