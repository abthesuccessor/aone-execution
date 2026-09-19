import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const MAX_SKILL_BYTES = 128 * 1024;
const MAX_SKILLS = 2_000;
const MAX_DEPTH = 12;
const MAX_PACKAGE_FILES = 2_048;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '__pycache__']);
const MAX_CATALOG_MANIFEST_BYTES = 16 * 1024 * 1024;

export const defaultSkillRoot = fileURLToPath(new URL('../../desktop/resources/skills', import.meta.url));

export const AUTOMATIC_SKILL_SELECTOR_VERSION = 'lexical-relevance-v1';
export const AUTOMATIC_SKILLS_PER_NODE = 4;

const ROUTING_STOP_WORDS = new Set([
  'about', 'after', 'again', 'against', 'agent', 'agents', 'also', 'and', 'any', 'are', 'artifact',
  'artifacts', 'before', 'being', 'build', 'built', 'can', 'configured', 'context', 'could', 'create',
  'deliver', 'design', 'each', 'every', 'from', 'have', 'into', 'its', 'more', 'must', 'node', 'nodes',
  'only', 'other', 'our', 'plan', 'planning', 'provide', 'required', 'requirements', 'should', 'skill',
  'skills', 'specialist', 'supplied', 'system', 'than', 'that', 'the', 'their', 'then', 'these', 'they',
  'this', 'through', 'use', 'used', 'user', 'using', 'when', 'where', 'which', 'with', 'work', 'your',
]);

const GOOGLE_PRODUCT_TOKENS = new Set([
  'admob', 'alloydb', 'bigframes', 'bigquery', 'bigtable', 'firebase', 'gcloud', 'gemini', 'gke',
  'spanner', 'vertex',
]);

const GOOGLE_PRODUCT_PHRASES = [
  'agent platform', 'cloud logging', 'cloud monitoring', 'cloud run', 'cloud sql', 'cloud storage',
  'data manager', 'google ads', 'google analytics', 'google cloud', 'mobile ads', 'workload manager',
];

function routingTokens(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !ROUTING_STOP_WORDS.has(token));
}

function publicMetadata(item) {
  const { absolutePath: _path, skillDirectory: _directory, overrideContent: _content, ...metadata } = item;
  return metadata;
}

function routingText(value) {
  if (Array.isArray(value)) return value.map(routingText).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map(routingText).join(' ');
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function catalogScopeMatches(item, queryTokens, normalizedQuery) {
  if (!item.relativePath.split('/').includes('google-skills')) return true;
  if (queryTokens.has('google') || queryTokens.has('gcp')) return true;
  const itemTokens = new Set(routingTokens(`${item.name} ${item.description}`));
  if ([...GOOGLE_PRODUCT_TOKENS].some((token) => itemTokens.has(token) && queryTokens.has(token))) return true;
  return GOOGLE_PRODUCT_PHRASES.some((phrase) => (
    normalizedQuery.includes(phrase) && routingTokens(item.name).join(' ').includes(phrase)
  ));
}

async function readNoFollow(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readSourceProvenance(root) {
  try {
    const manifestPath = join(root, '.catalog-manifest.json');
    if ((await stat(manifestPath)).size > MAX_CATALOG_MANIFEST_BYTES) return new Map();
    const bytes = await readNoFollow(manifestPath);
    if (bytes.length > MAX_CATALOG_MANIFEST_BYTES) return new Map();
    const manifest = JSON.parse(bytes.toString('utf8'));
    if (manifest.version !== 2 || !Array.isArray(manifest.skills)) return new Map();
    const entries = new Map();
    for (const entry of manifest.skills) {
      if (!entry || typeof entry.path !== 'string') continue;
      // Ambiguous paths have no attributable origin, even when one entry matches.
      entries.set(entry.path, entries.has(entry.path) ? null : entry);
    }
    return entries;
  } catch {
    // Missing, legacy, invalid, or linked manifests do not affect skill activation.
    return new Map();
  }
}

function matchingSourceProvenance(entry, contentDigest, packageDigest) {
  if (!entry || !packageDigest || entry.sha256 !== contentDigest || entry.packageDigest !== packageDigest || !Array.isArray(entry.origins)) return undefined;
  if (!entry.origins.length || entry.origins.length > 32) return undefined;
  const origins = entry.origins.map((origin) => {
    if (!origin || !['agents', 'codex'].includes(origin.source) || typeof origin.path !== 'string'
      || origin.path.length > 2048 || origin.path.includes('\\') || origin.path.includes('\0')
      || origin.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
      || !origin.path.endsWith('/SKILL.md')) return null;
    return { source: origin.source, path: origin.path };
  });
  return origins.every(Boolean) ? origins : undefined;
}

async function buildPackageManifest(skillDirectory, canonicalRoot) {
  const files = [];
  let totalBytes = 0;

  async function visit(directory, depth) {
    if (depth > MAX_DEPTH) {
      const error = new Error(`Skill package nesting exceeds ${MAX_DEPTH} levels.`);
      error.code = 'SKILL_PACKAGE_INVALID';
      throw error;
    }
    const canonicalDirectory = await realpath(directory);
    const rootRelation = relative(canonicalRoot, canonicalDirectory);
    if (rootRelation.startsWith('..') || isAbsolute(rootRelation)) {
      const error = new Error('Skill package directory escaped the configured skills root.');
      error.code = 'SKILL_PACKAGE_INVALID';
      throw error;
    }
    const entries = await readdir(canonicalDirectory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = join(canonicalDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        const error = new Error(`Skill packages may not contain symbolic links: ${entry.name}`);
        error.code = 'SKILL_PACKAGE_INVALID';
        throw error;
      }
      if (entry.isDirectory()) {
        await visit(absolutePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      if (files.length >= MAX_PACKAGE_FILES) {
        const error = new Error(`Skill package exceeds ${MAX_PACKAGE_FILES} regular files.`);
        error.code = 'SKILL_PACKAGE_TOO_LARGE';
        throw error;
      }
      const canonicalPath = await realpath(absolutePath);
      const packageRelation = relative(skillDirectory, canonicalPath);
      const rootFileRelation = relative(canonicalRoot, canonicalPath);
      if (packageRelation.startsWith('..') || isAbsolute(packageRelation) || rootFileRelation.startsWith('..') || isAbsolute(rootFileRelation)) {
        const error = new Error('Skill package file escaped its package or configured root.');
        error.code = 'SKILL_PACKAGE_INVALID';
        throw error;
      }
      const bytes = await readNoFollow(canonicalPath);
      totalBytes += bytes.length;
      if (totalBytes > MAX_PACKAGE_BYTES) {
        const error = new Error(`Skill package exceeds ${MAX_PACKAGE_BYTES} bytes.`);
        error.code = 'SKILL_PACKAGE_TOO_LARGE';
        throw error;
      }
      files.push({
        path: packageRelation.split(sep).join('/'),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
      });
    }
  }

  await visit(skillDirectory, 0);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    files,
    totalBytes,
    packageDigest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
  };
}

export function parseSkillMetadata(content, relativePath) {
  const normalized = content.replace(/\r\n/g, '\n');
  const fallbackName = relativePath.split('/').at(-2) ?? 'unnamed-skill';
  if (!normalized.startsWith('---\n')) {
    return {
      name: fallbackName,
      description: 'Invalid skill: missing YAML frontmatter.',
      valid: false,
      validationErrors: ['SKILL.md must begin with YAML frontmatter.'],
    };
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end === -1) {
    return {
      name: fallbackName,
      description: 'Invalid skill: unterminated YAML frontmatter.',
      valid: false,
      validationErrors: ['SKILL.md frontmatter must end with ---.'],
    };
  }
  const validationErrors = [];
  let frontmatter;
  try {
    const document = parseDocument(normalized.slice(4, end), {
      maxAliasCount: 0,
      prettyErrors: false,
      uniqueKeys: true,
    });
    if (document.errors.length) {
      validationErrors.push(`Invalid YAML frontmatter: ${document.errors[0].message}`);
      frontmatter = {};
    } else {
      frontmatter = document.toJS({ maxAliasCount: 0 });
      if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
        validationErrors.push('SKILL.md frontmatter must be a YAML mapping.');
        frontmatter = {};
      }
    }
  } catch (error) {
    validationErrors.push(`Invalid YAML frontmatter: ${error.message}`);
    frontmatter = {};
  }
  const name = typeof frontmatter.name === 'string' ? frontmatter.name.trim() : undefined;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : undefined;
  if (frontmatter.name !== undefined && name === undefined) validationErrors.push('Frontmatter field “name” must be a string.');
  if (frontmatter.description !== undefined && description === undefined) validationErrors.push('Frontmatter field “description” must be a string.');
  if (!name) validationErrors.push('Frontmatter field “name” is required.');
  if (!description) validationErrors.push('Frontmatter field “description” is required.');
  if (name && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)) {
    validationErrors.push('Frontmatter name must be 1-64 lowercase letters, digits, or hyphen-separated segments.');
  }
  if (name && name !== fallbackName) {
    validationErrors.push('Frontmatter name must match the SKILL.md parent directory.');
  }
  if (description && description.length > 1_024) {
    validationErrors.push('Frontmatter description must be 1-1024 characters.');
  }
  return {
    name: (name || fallbackName).slice(0, 160),
    description: (description || 'Invalid skill metadata.').replace(/\s+/g, ' ').slice(0, 1_024),
    valid: validationErrors.length === 0,
    validationErrors,
  };
}

async function findSkillFiles(directory, boundary, logicalPrefix, depth, output, visited) {
  if (depth > MAX_DEPTH || output.length >= MAX_SKILLS) return;
  let canonicalDirectory;
  try {
    canonicalDirectory = await realpath(directory);
  } catch {
    return;
  }
  const boundaryRelation = relative(boundary, canonicalDirectory);
  if (boundaryRelation.startsWith('..') || isAbsolute(boundaryRelation) || visited.has(canonicalDirectory)) return;
  visited.add(canonicalDirectory);
  let entries;
  try {
    entries = await readdir(canonicalDirectory, { withFileTypes: true });
  } catch {
    return;
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (output.length >= MAX_SKILLS) break;
    const absolutePath = join(canonicalDirectory, entry.name);
    const logicalPath = logicalPrefix ? `${logicalPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRECTORIES.has(entry.name)) {
      await findSkillFiles(absolutePath, boundary, logicalPath, depth + 1, output, visited);
    } else if (entry.isSymbolicLink() && !IGNORED_DIRECTORIES.has(entry.name)) {
      try {
        const target = await realpath(absolutePath);
        const targetRelation = relative(boundary, target);
        if (!targetRelation.startsWith('..') && !isAbsolute(targetRelation) && (await stat(target)).isDirectory()) {
          await findSkillFiles(target, boundary, logicalPath, depth + 1, output, visited);
        }
      } catch {
        // Broken and out-of-bound catalog mounts are ignored.
      }
    } else if (entry.isFile() && entry.name === 'SKILL.md') {
      output.push({ absolutePath, relativePath: logicalPath.split(sep).join('/') });
    }
  }
}

export class SkillCatalog {
  constructor({ root = defaultSkillRoot } = {}) {
    this.root = resolve(root);
    this.canonicalRoot = null;
    this.canonicalBoundary = null;
    this.byId = new Map();
    this.items = [];
    this.lastScanAt = null;
    this.scanPromise = null;
  }

  setRepository(repository) {
    this.repository = repository;
    this.lastScanAt = null;
  }

  applyOverrides() {
    for (const revision of this.repository?.listCatalogRevisions('skills') ?? []) {
      const base = this.byId.get(revision.id);
      const data = revision.data;
      const content = data.content;
      if (typeof content !== 'string') continue;
      const relativePath = base?.relativePath ?? data.relativePath ?? `custom/${revision.id}/SKILL.md`;
      const metadata = parseSkillMetadata(content, relativePath);
      const contentDigest = createHash('sha256').update(content).digest('hex');
      const files = [...(data.basePackageFiles ?? base?.packageFiles ?? []).filter((file) => file.path !== 'SKILL.md'),
        { path: 'SKILL.md', sha256: contentDigest, size: Buffer.byteLength(content) }].sort((a, b) => a.path.localeCompare(b.path));
      const packageDigest = createHash('sha256').update(JSON.stringify(files)).digest('hex');
      this.byId.set(revision.id, {
        ...base, id: revision.id, name: data.name, description: data.description,
        relativePath, sourceRoot: base?.sourceRoot ?? 'workspace-catalog',
        contentDigest, packageFiles: files, packageDigest,
        sourceProvenance: base?.contentDigest === contentDigest && base?.packageDigest === packageDigest ? base?.sourceProvenance : undefined,
        packageBytes: files.reduce((sum, file) => sum + file.size, 0),
        basePackageDigest: data.basePackageDigest ?? null,
        valid: metadata.valid && (!data.basePackageDigest || base?.packageDigest === data.basePackageDigest),
        validationErrors: [...metadata.validationErrors, ...(data.basePackageDigest && base?.packageDigest !== data.basePackageDigest ? ['The installed package changed; its edited override requires review.'] : [])],
        enabled: data.enabled !== false, archived: data.archived === true,
        configVersion: revision.version, configDigest: revision.digest, overrideContent: content,
      });
    }
    this.items = [...this.byId.values()].map(publicMetadata);
    return this.items;
  }

  async readCatalogContent(id) {
    const skill = this.byId.get(id);
    if (!skill) return null;
    return typeof skill.overrideContent === 'string' ? skill.overrideContent : (await readNoFollow(skill.absolutePath)).toString('utf8');
  }

  async scan() {
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = this.scanUncached();
    try {
      return await this.scanPromise;
    } finally {
      this.scanPromise = null;
    }
  }

  async scanUncached() {
    const files = [];
    try {
      this.canonicalRoot = await realpath(this.root);
      this.canonicalBoundary = await realpath(resolve(this.root, '..'));
    } catch {
      this.canonicalRoot = null;
      this.byId.clear();
      this.items = [];
      this.lastScanAt = new Date().toISOString();
      return this.applyOverrides();
    }
    const provenance = await readSourceProvenance(this.canonicalRoot);
    await findSkillFiles(this.canonicalRoot, this.canonicalBoundary, '', 0, files, new Set());
    const items = [];
    this.byId.clear();

    for (const file of files) {
      try {
        const canonicalPath = await realpath(file.absolutePath);
        const relation = relative(this.canonicalBoundary, canonicalPath);
        if (relation.startsWith('..') || isAbsolute(relation)) continue;
        const bytes = await readNoFollow(canonicalPath);
        const content = bytes.toString('utf8');
        const metadata = parseSkillMetadata(content.slice(0, MAX_SKILL_BYTES), file.relativePath);
        const skillDirectory = resolve(canonicalPath, '..');
        let packageManifest;
        try {
          packageManifest = await buildPackageManifest(skillDirectory, this.canonicalBoundary);
        } catch (error) {
          packageManifest = { files: [], totalBytes: 0, packageDigest: null };
          metadata.valid = false;
          metadata.validationErrors.push(error.message);
        }
        const id = `skill_${createHash('sha256').update(file.relativePath).digest('hex').slice(0, 16)}`;
        const contentDigest = createHash('sha256').update(bytes).digest('hex');
        const sourceProvenance = matchingSourceProvenance(provenance.get(file.relativePath), contentDigest, packageManifest.packageDigest);
        const item = {
          id,
          name: metadata.name,
          description: metadata.description,
          relativePath: file.relativePath,
          sourceRoot: 'agent-skill-catalog',
          ...(sourceProvenance ? { sourceProvenance } : {}),
          contentDigest,
          packageDigest: packageManifest.packageDigest,
          packageFiles: packageManifest.files,
          packageBytes: packageManifest.totalBytes,
          valid: metadata.valid,
          validationErrors: metadata.validationErrors,
        };
        this.byId.set(id, { ...item, absolutePath: canonicalPath, skillDirectory });
        items.push(item);
      } catch {
        // An unreadable skill is omitted; the rest of the catalog remains usable.
      }
    }

    this.lastScanAt = new Date().toISOString();
    return this.applyOverrides();
  }

  async ensureScanned() {
    return this.lastScanAt ? this.items : this.scan();
  }

  async list() {
    const items = await this.scan();
    return { items, scannedAt: this.lastScanAt, truncated: items.length >= MAX_SKILLS };
  }

  resolveMetadata(ids = []) {
    return ids.map((id) => this.byId.get(id)).filter(Boolean).map(publicMetadata);
  }

  catalogMetadata() {
    return [...this.byId.values()]
      .filter((item) => item.valid && item.enabled !== false && !item.archived)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map(publicMetadata);
  }

  routingManifest() {
    const catalog = this.catalogMetadata();
    const digestInput = catalog.map((item) => ({
      id: item.id,
      contentDigest: item.contentDigest,
      packageDigest: item.packageDigest,
    }));
    return {
      mode: 'agent-managed',
      selectorVersion: AUTOMATIC_SKILL_SELECTOR_VERSION,
      maxSkillsPerNode: AUTOMATIC_SKILLS_PER_NODE,
      catalogCount: catalog.length,
      catalogDigest: `sha256:${createHash('sha256').update(JSON.stringify(digestInput)).digest('hex')}`,
    };
  }

  selectRelevantMetadata(context, { limit = AUTOMATIC_SKILLS_PER_NODE } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
      throw new TypeError('Automatic skill selection limit must be an integer from 1 to 32.');
    }
    const queryText = routingText(context);
    const queryTokens = new Set(routingTokens(queryText));
    if (queryTokens.size === 0) return [];

    const catalog = this.catalogMetadata();
    const tokenSets = catalog.map((item) => {
      const name = new Set(routingTokens(item.name));
      const description = new Set(routingTokens(item.description));
      const path = new Set(routingTokens(item.relativePath));
      return { item, name, description, path, all: new Set([...name, ...description, ...path]) };
    });
    const documentFrequency = new Map();
    for (const candidate of tokenSets) {
      for (const token of candidate.all) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    const normalizedQuery = [...queryTokens].join(' ');
    const scores = tokenSets.map((candidate) => {
      if (!catalogScopeMatches(candidate.item, queryTokens, normalizedQuery)) {
        return { item: candidate.item, score: 0, matchCount: 0 };
      }
      const matches = [...queryTokens].filter((token) => candidate.all.has(token));
      const nameMatches = matches.filter((token) => candidate.name.has(token));
      let score = 0;
      for (const token of matches) {
        const inverseFrequency = Math.log((catalog.length + 1) / ((documentFrequency.get(token) ?? 0) + 1)) + 1;
        const fieldWeight = candidate.name.has(token) ? 4 : candidate.description.has(token) ? 1.5 : 1;
        score += inverseFrequency * fieldWeight;
      }
      const normalizedName = routingTokens(candidate.item.name).join(' ');
      if (normalizedName && normalizedQuery.includes(normalizedName)) score += 20;
      const hasStrongSingleNameMatch = matches.length === 1
        && nameMatches.length === 1
        && (documentFrequency.get(nameMatches[0]) ?? catalog.length) <= Math.max(8, Math.ceil(catalog.length * 0.12));
      if (matches.length < 2 && !hasStrongSingleNameMatch) score = 0;
      return { item: candidate.item, score, matchCount: matches.length };
    });

    return scores
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score
        || right.matchCount - left.matchCount
        || left.item.name.localeCompare(right.item.name)
        || left.item.id.localeCompare(right.item.id))
      .slice(0, limit)
      .map((candidate) => candidate.item);
  }

  validateSelection(ids = []) {
    const missing = [];
    const invalid = [];
    for (const id of new Set(ids)) {
      const skill = this.byId.get(id);
      if (!skill) missing.push(id);
      else if (!skill.valid || skill.enabled === false || skill.archived) invalid.push(id);
    }
    return { valid: missing.length === 0 && invalid.length === 0, missing, invalid };
  }

  async readSelectedContents(ids = [], { perSkillLimit = MAX_SKILL_BYTES, totalLimit = 512 * 1024 } = {}) {
    const uniqueIds = [...new Set(ids)];
    const selected = [];
    let remaining = totalLimit;
    for (const id of uniqueIds) {
      if (remaining <= 0) {
        const error = new Error(`Selected skills exceed the ${totalLimit}-byte planning context limit.`);
        error.code = 'SKILL_TOO_LARGE';
        throw error;
      }
      const skill = this.byId.get(id);
      if (!skill || !skill.valid || skill.enabled === false || skill.archived) continue;
      if (typeof skill.overrideContent === 'string') {
        if (skill.basePackageDigest) {
          const currentPackage = await buildPackageManifest(skill.skillDirectory, this.canonicalBoundary);
          if (currentPackage.packageDigest !== skill.basePackageDigest) {
            const error = new Error(`Selected skill package ${id} changed during planning.`);
            error.code = 'SKILL_CHANGED';
            throw error;
          }
        }
        const size = Buffer.byteLength(skill.overrideContent);
        if (size > perSkillLimit || size > remaining) {
          const error = new Error(`Selected skill ${id} exceeds the planning context limit; partial skill activation is forbidden.`);
          error.code = 'SKILL_TOO_LARGE';
          throw error;
        }
        remaining -= size;
        selected.push({ ...publicMetadata(skill), content: skill.overrideContent });
        continue;
      }
      const packageManifest = await buildPackageManifest(skill.skillDirectory, this.canonicalBoundary);
      if (packageManifest.packageDigest !== skill.packageDigest) {
        const error = new Error(`Selected skill package ${id} changed during planning.`);
        error.code = 'SKILL_CHANGED';
        throw error;
      }
      const canonicalPath = await realpath(skill.absolutePath);
      const relation = relative(this.canonicalBoundary, canonicalPath);
      if (relation.startsWith('..') || isAbsolute(relation)) {
        const error = new Error(`Selected skill ${id} escaped the configured skills root.`);
        error.code = 'SKILL_CHANGED';
        throw error;
      }
      const bytes = await readNoFollow(canonicalPath);
      if (bytes.length > perSkillLimit || bytes.length > remaining) {
        const error = new Error(`Selected skill ${id} exceeds the planning context limit; partial skill activation is forbidden.`);
        error.code = 'SKILL_TOO_LARGE';
        throw error;
      }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== skill.contentDigest) {
        const error = new Error(`Selected skill ${id} changed during planning.`);
        error.code = 'SKILL_CHANGED';
        throw error;
      }
      const content = bytes.toString('utf8');
      remaining -= bytes.length;
      selected.push({
        id,
        name: skill.name,
        relativePath: skill.relativePath,
        contentDigest: digest,
        packageDigest: packageManifest.packageDigest,
        packageFiles: packageManifest.files,
        content,
      });
    }
    return selected;
  }
}
