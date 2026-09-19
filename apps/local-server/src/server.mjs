import { createHash } from 'node:crypto';
import { constants, realpathSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { LocalRepository } from './database.mjs';
import {
  DEFAULT_EVIDENCE_LIMITS,
  EVIDENCE_PARSER_REVISION,
  EvidenceError,
  EvidenceService,
  retrieveEvidence,
} from './evidence.mjs';
import { compileIntentMap, IntentCompilerError } from './intent_compiler.mjs';
import { LocalObjectStore } from './object_store.mjs';
import {
  buildCodexExecutionArguments,
  buildCodexExecutionPrompt,
  boundedWorkspaceManifest,
  captureWorkspaceFileManifest,
  digestExecutionInput,
  runCodexWorkspaceStep,
} from './execution_adapters.mjs';
import { captureWorkspaceBaseline, createPlanContent } from './planners.mjs';
import {
  DEFAULT_AGENT_ARCHETYPES,
  DEFAULT_AGENT_POLICIES,
  DEFAULT_AGENT_PROMPTS,
  ENGINEERING_DOMAINS,
  createContentDigest,
  createPromptRevision,
  revisePrompt,
} from './agents.mjs';
import { DEFAULT_PROVIDER_PROFILES, detectProviders, inspectCliProvider, localAgentProviderStatus } from './providers.mjs';
import {
  ProviderConnectionError,
  ProviderConnectionManager,
  normalizeOllamaBaseUrl,
} from './provider_connections.mjs';
import { SkillCatalog } from './skills.mjs';
import {
  LIVE_WEB_RESEARCH_CAPABILITY,
  createResearchPolicy,
  validateResearchPolicy,
} from './research_policy.mjs';
import { workspaceBinding } from './trace_data.mjs';
import { createCatalogRoutes } from './catalog_routes.mjs';
import { createChatRoutes } from './chat_routes.mjs';
import { createTerminalRoutes } from './terminal_routes.mjs';
import { createEngineeringEnvironment, normalizeEngineeringOptions } from './engineering_environment.mjs';
import { createEngineeringProposalRoutes } from './engineering_proposals.mjs';
import { createHarnessMemory } from './harness_memory.mjs';
import { createHarnessMemoryRoutes } from './harness_memory_routes.mjs';
import { nodeMemoryDigest } from './harness_memory_provenance.mjs';
import { ENGINEERING_PLAN_STAGES, runEngineeringPlanningStages } from './engineering_planning.mjs';
import { createEngineeringSettingsRoutes } from './engineering_settings.mjs';
import { normalizeNodeReview, pinNodeReview, assertNodeReviewPins, runNodeReviews } from './node_review.mjs';
import { assertLegacyImportComplete } from './legacy_storage.mjs';
import { compressionGuidance } from './token_policy.mjs';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = DEFAULT_EVIDENCE_LIMITS.maxSourceBytes;
const MAX_EVIDENCE_EXCERPTS = 32;
const MAX_EXCERPT_CHARS = 2_000;
const CLI_INVENTORY_TTL_MS = 30_000;
const STATIC_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
].join('; ');
const API_CONTENT_SECURITY_POLICY = "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'";
const STATIC_MEDIA_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.htm', 'text/html; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
]);

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function securityHeaders(contentSecurityPolicy = API_CONTENT_SECURITY_POLICY) {
  return {
    'Content-Security-Policy': contentSecurityPolicy,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), serial=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function isPathInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

function decodedRequestPathSegments(requestTarget) {
  const rawPath = String(requestTarget || '').split('?', 1)[0];
  if (!rawPath.startsWith('/')) {
    throw new HttpError(400, 'INVALID_REQUEST_PATH', 'Request path must be origin-form.');
  }
  const segments = [];
  for (const rawSegment of rawPath.split('/')) {
    if (!rawSegment) continue;
    let segment;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      throw new HttpError(400, 'INVALID_REQUEST_PATH', 'Request path contains invalid percent encoding.');
    }
    if (segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('\0')) {
      throw new HttpError(403, 'PATH_TRAVERSAL_REJECTED', 'Request path may not traverse outside the application root.');
    }
    segments.push(segment);
  }
  return segments;
}

function configureStaticRoot(staticRoot, staticDir) {
  if (staticRoot && staticDir && resolve(staticRoot) !== resolve(staticDir)) {
    throw new Error('staticRoot and staticDir cannot identify different directories.');
  }
  const suppliedRoot = staticRoot || staticDir;
  if (!suppliedRoot) return null;
  let canonicalRoot;
  let canonicalIndex;
  try {
    canonicalRoot = realpathSync(suppliedRoot);
    if (!statSync(canonicalRoot).isDirectory()) throw new Error('not a directory');
    canonicalIndex = realpathSync(resolve(canonicalRoot, 'index.html'));
    if (!isPathInside(canonicalRoot, canonicalIndex) || !statSync(canonicalIndex).isFile()) {
      throw new Error('index.html is not a contained regular file');
    }
  } catch (error) {
    throw new Error(`The desktop static root must contain a readable index.html: ${error.message}`);
  }
  return { root: canonicalRoot, index: canonicalIndex };
}

async function readContainedStaticFile(staticAssets, candidate) {
  let canonicalPath;
  try {
    canonicalPath = realpathSync(candidate);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw error;
  }
  if (!isPathInside(staticAssets.root, canonicalPath)) {
    throw new HttpError(403, 'STATIC_PATH_OUTSIDE_ROOT', 'Static assets must remain inside the configured application root.');
  }
  let handle;
  try {
    handle = await open(canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) return null;
    return { bytes: await handle.readFile(), path: canonicalPath };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    if (error.code === 'ELOOP') {
      throw new HttpError(403, 'STATIC_SYMLINK_REJECTED', 'Static assets may not resolve through a symbolic link.');
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function serveStaticAsset(request, response, staticAssets, pathSegments) {
  const requestedPath = pathSegments.length ? resolve(staticAssets.root, ...pathSegments) : staticAssets.index;
  if (!isPathInside(staticAssets.root, requestedPath)) {
    throw new HttpError(403, 'PATH_TRAVERSAL_REJECTED', 'Static assets must remain inside the configured application root.');
  }
  let file = await readContainedStaticFile(staticAssets, requestedPath);
  const lastSegment = pathSegments.at(-1) || '';
  const assetLikeRequest = pathSegments[0] === 'assets' || Boolean(extname(lastSegment));
  const isSpaFallback = !file && !assetLikeRequest;
  if (isSpaFallback) file = await readContainedStaticFile(staticAssets, staticAssets.index);
  if (!file) throw new HttpError(404, 'STATIC_ASSET_NOT_FOUND', 'Static asset was not found.');

  const isHtml = extname(file.path).toLowerCase() === '.html';
  const headers = {
    ...securityHeaders(STATIC_CONTENT_SECURITY_POLICY),
    'Content-Type': STATIC_MEDIA_TYPES.get(extname(file.path).toLowerCase()) || 'application/octet-stream',
    'Content-Length': file.bytes.length,
    'Cache-Control': isHtml || isSpaFallback ? 'no-store' : 'public, max-age=31536000, immutable',
  };
  response.writeHead(200, headers);
  response.end(request.method === 'HEAD' ? undefined : file.bytes);
}

function now() {
  return new Date().toISOString();
}

function json(response, status, body, headers = {}) {
  const content = body === undefined ? '' : JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(content),
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(content);
}

function empty(response, status, headers = {}) {
  response.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  response.end();
}

function binary(response, status, bytes, { mediaType, filename, ...headers } = {}) {
  const safeFilename = String(filename || 'source.bin').replace(/[\r\n"\\]/g, '_');
  response.writeHead(status, {
    'Content-Type': mediaType || 'application/octet-stream',
    'Content-Length': bytes.length,
    'Content-Disposition': `attachment; filename="${safeFilename}"; filename*=UTF-8''${encodeURIComponent(safeFilename)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'sandbox',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(bytes);
}

function hostNameFromHeader(hostHeader) {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'BODY_TOO_LARGE', 'Request body exceeds 2 MiB.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
}

async function readBytes(request, maximum = MAX_SOURCE_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new HttpError(413, 'SOURCE_TOO_LARGE', `Source exceeds ${Math.floor(maximum / 1024 / 1024)} MiB.`);
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(422, 'EMPTY_SOURCE', 'Uploaded source bytes cannot be empty.');
  return Buffer.concat(chunks);
}

function requiredString(value, field, maxLength = 500) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(422, 'VALIDATION_ERROR', `${field} must be a non-empty string.`, { field });
  }
  if (value.length > maxLength) {
    throw new HttpError(422, 'VALIDATION_ERROR', `${field} is longer than ${maxLength} characters.`, { field });
  }
  return value.trim();
}

function optionalString(value, field, maxLength = 20_000) {
  if (value == null) return value;
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new HttpError(422, 'VALIDATION_ERROR', `${field} must be a string no longer than ${maxLength} characters.`, { field });
  }
  return value;
}

function requiredBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new HttpError(422, 'VALIDATION_ERROR', `${field} must be a boolean.`, { field });
  }
  return value;
}

function requiredHash(value, field) {
  const hash = requiredString(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new HttpError(422, 'VALIDATION_ERROR', `${field} must be a lowercase SHA-256 hex digest.`, { field });
  }
  return hash;
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compactText(value, maxLength = MAX_EXCERPT_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function encodeTraceCursor(trace) {
  if (!trace) return null;
  return Buffer.from(JSON.stringify({ startedAt: trace.startedAt, id: trace.id })).toString('base64url');
}

function decodeTraceCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof cursor.startedAt !== 'string' || !Number.isFinite(Date.parse(cursor.startedAt))
      || typeof cursor.id !== 'string' || !/^[a-f0-9]{32}$/.test(cursor.id)) throw new Error('invalid');
    return cursor;
  } catch {
    throw new HttpError(422, 'INVALID_TRACE_CURSOR', 'before must be an opaque trace cursor returned by this API.');
  }
}

function normalizedFilename(value) {
  const filename = requiredString(value, 'filename', 500).replace(/\\/g, '/').split('/').at(-1);
  if (!filename || filename === '.' || filename === '..') {
    throw new HttpError(422, 'VALIDATION_ERROR', 'filename must identify a file.', { field: 'filename' });
  }
  return filename;
}

function filenameFromRequest(request, requestUrl) {
  const explicit = requestUrl.searchParams.get('filename') || request.headers['x-ege-filename'];
  if (explicit) return normalizedFilename(explicit);
  const disposition = String(request.headers['content-disposition'] || '');
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return normalizedFilename(decodeURIComponent(encoded));
    } catch {
      throw new HttpError(422, 'VALIDATION_ERROR', 'Content-Disposition filename is not valid UTF-8.', { field: 'filename' });
    }
  }
  const basic = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  if (basic) return normalizedFilename(basic);
  throw new HttpError(422, 'VALIDATION_ERROR', 'Supply filename as a query parameter, X-EGE-Filename, or Content-Disposition.', { field: 'filename' });
}

function mediaTypeFromRequest(request) {
  const mediaType = String(request.headers['content-type'] || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
  return mediaType && mediaType.length <= 200 ? mediaType : 'application/octet-stream';
}

function tokenize(value) {
  return String(value || '').toLowerCase().match(/[\p{L}\p{N}_+#.-]+/gu) ?? [];
}

function buildEvidenceContext(repository, graphId) {
  const sources = repository.listSources(graphId).sort((left, right) => left.id.localeCompare(right.id));
  const chunks = repository.listGraphSourceChunks(graphId);
  const chunksBySource = new Map();
  for (const chunk of chunks) {
    if (!chunksBySource.has(chunk.sourceId)) chunksBySource.set(chunk.sourceId, []);
    chunksBySource.get(chunk.sourceId).push(chunk);
  }
  const sourcePins = sources.map((source) => ({
    id: source.id,
    nodeId: source.nodeId,
    filename: source.filename,
    mediaType: source.mediaType,
    byteSize: source.byteSize,
    sha256: source.sha256,
    objectKey: source.objectKey,
    parserId: source.parserId,
    parserVersion: source.parserVersion,
    parseStatus: source.parseStatus,
    chunkDigests: (chunksBySource.get(source.id) ?? []).map((chunk) => chunk.contentSha256),
  }));
  const excerpts = [];
  for (const source of sources) {
    for (const chunk of (chunksBySource.get(source.id) ?? []).slice(0, 2)) {
      if (excerpts.length >= MAX_EVIDENCE_EXCERPTS) break;
      excerpts.push({
        sourceId: source.id,
        chunkId: chunk.id,
        nodeId: source.nodeId,
        filename: source.filename,
        location: chunk.location,
        contentSha256: chunk.contentSha256,
        text: compactText(chunk.text),
      });
    }
  }
  const manifestCore = { sources: sourcePins, excerpts };
  return {
    evidenceSummaries: sources.map((source) => ({
      id: source.id,
      sourceNodeIds: source.nodeId ? [source.nodeId] : [],
      summary: compactText([
        source.filename,
        source.mediaType,
        ...(chunksBySource.get(source.id) ?? []).slice(0, 3).map((chunk) => chunk.text),
        source.metadata?.summary,
      ].filter(Boolean).join('\n'), 8_000),
    })),
    evidenceManifest: { ...manifestCore, digest: createContentDigest(manifestCore) },
  };
}

function retrieveGraphEvidence(repository, graphId, query, limit) {
  const chunks = repository.listGraphSourceChunks(graphId).map((chunk) => ({
    id: chunk.id,
    documentId: chunk.sourceId,
    text: chunk.text,
    citations: chunk.location?.citations ?? [{
      documentId: chunk.sourceId,
      objectId: `sha256:${chunk.sourceSha256}`,
      digest: chunk.sourceSha256,
      sourceName: chunk.filename,
      mediaType: chunk.mediaType,
      parserRevision: EVIDENCE_PARSER_REVISION,
      locator: chunk.location,
    }],
  }));
  const result = retrieveEvidence({ query, chunks, topK: limit });
  const manifestCore = {
    algorithm: result.fusion.method,
    version: result.fusion.version,
    k: result.fusion.k,
    rankers: result.fusion.rankers,
    queryDigest: sha256Hex(query),
    resultChunkIds: result.results.map((item) => item.chunkId),
  };
  return { ...result, manifest: { ...manifestCore, digest: createContentDigest(manifestCore) } };
}

function containsSecretLikeKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsSecretLikeKey);
  return Object.entries(value).some(([key, child]) => (
    /(?:api[-_]?key|secret|password|credential|token)/i.test(key) || containsSecretLikeKey(child)
  ));
}

function validatedProviderBaseUrl(providerId, value) {
  if (value == null || value === '') return null;
  const input = requiredString(value, 'baseUrl', 2_048);
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new HttpError(422, 'VALIDATION_ERROR', 'baseUrl must be an absolute URL.', { field: 'baseUrl' });
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'baseUrl cannot contain credentials, query parameters, or fragments.', { field: 'baseUrl' });
  }
  if (providerId === 'ollama') {
    try {
      return normalizeOllamaBaseUrl(input);
    } catch (error) {
      if (error instanceof ProviderConnectionError) throw new HttpError(error.status, error.code, error.message, error.details);
      throw error;
    }
  } else if (providerId === 'openai-api' && `${url.origin}${url.pathname.replace(/\/$/, '')}` !== 'https://api.openai.com/v1') {
    throw new HttpError(422, 'VALIDATION_ERROR', 'OpenAI baseUrl is fixed to https://api.openai.com/v1.', { field: 'baseUrl' });
  } else if (providerId === 'anthropic-api' && `${url.origin}${url.pathname.replace(/\/$/, '')}` !== 'https://api.anthropic.com/v1') {
    throw new HttpError(422, 'VALIDATION_ERROR', 'Anthropic baseUrl is fixed to https://api.anthropic.com/v1.', { field: 'baseUrl' });
  }
  return input.replace(/\/$/, '');
}

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

// Ordered so the most capable runtime is reported first. Codex CLI is last
// because it is the only one that can write to a workspace, and a user reading
// the result should see the chat/planning providers settle before the executor.
const AUTODETECT_CANDIDATES = Object.freeze([
  { providerId: 'openai-api', kind: 'hosted', envName: 'OPENAI_API_KEY' },
  { providerId: 'anthropic-api', kind: 'hosted', envName: 'ANTHROPIC_API_KEY' },
  { providerId: 'ollama', kind: 'local' },
  { providerId: 'codex-cli', kind: 'cli' },
]);

function canonicalSecretEnvName(providerId) {
  if (providerId === 'openai-api') return 'OPENAI_API_KEY';
  if (providerId === 'anthropic-api') return 'ANTHROPIC_API_KEY';
  return null;
}

function asProviderConnectionHttpError(error) {
  if (error instanceof ProviderConnectionError) {
    return new HttpError(error.status, error.code, error.message, error.details);
  }
  return error;
}

function asAdmissionError(error) {
  const codes = new Set(['PLAN_HASH_MISMATCH', 'PLAN_APPROVAL_MISMATCH', 'PLAN_DRAFT_STALE', 'EXECUTION_CHANGED']);
  if (codes.has(error.code)) return new HttpError(409, error.code, error.message);
  return error;
}

function asObjectStoreHttpError(error) {
  if (error.code === 'OBJECT_TOO_LARGE') return new HttpError(413, error.code, error.message, error.details);
  if (error.code === 'OBJECT_NOT_FOUND') return new HttpError(404, error.code, error.message);
  if (error.code === 'OBJECT_INVALID_CONTENT' || error.code === 'OBJECT_INVALID_REFERENCE') {
    return new HttpError(422, error.code, error.message, error.details);
  }
  if (error.code === 'OBJECT_INTEGRITY_ERROR') return new HttpError(409, error.code, error.message, error.details);
  return error;
}

function validateDraft(body) {
  const reviewConfig = (...args) => { try { return normalizeNodeReview(...args); } catch (error) { throw new HttpError(error.status || 422, error.code, error.message); } };
  if (!Array.isArray(body.nodes) || !Array.isArray(body.edges ?? [])) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'Draft nodes and edges must be arrays.');
  }
  const ids = new Set();
  const stringList = (value, field, limit = 100) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > limit) throw new HttpError(422, 'VALIDATION_ERROR', `${field} must be an array of at most ${limit} strings.`);
    return [...new Set(value.map((item) => requiredString(item, `${field}[]`, 2_000)))];
  };
  const nodes = body.nodes.map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HttpError(422, 'VALIDATION_ERROR', `nodes[${index}] must be an object.`);
    }
    const id = requiredString(input.id, `nodes[${index}].id`, 200);
    if (ids.has(id)) throw new HttpError(422, 'VALIDATION_ERROR', `Duplicate node id “${id}”.`);
    ids.add(id);
    let position;
    if (input.position != null) {
      if (!Number.isFinite(input.position.x) || !Number.isFinite(input.position.y)) {
        throw new HttpError(422, 'VALIDATION_ERROR', `nodes[${index}].position requires finite x and y numbers.`);
      }
      position = { x: input.position.x, y: input.position.y };
    }
    const budgets = {};
    if (input.budgets !== undefined) {
      if (!input.budgets || typeof input.budgets !== 'object' || Array.isArray(input.budgets)) throw new HttpError(422, 'VALIDATION_ERROR', 'Node budgets must be an object.');
      for (const [key, maximum] of [['timeoutMs', 3_600_000], ['maxAttempts', 10]]) {
        if (input.budgets[key] === undefined) continue;
        const value = input.budgets[key];
        if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new HttpError(422, 'VALIDATION_ERROR', `${key} must be an integer from 1 to ${maximum}.`);
        budgets[key] = value;
      }
    }
    if (input.breakpoint !== undefined && typeof input.breakpoint !== 'boolean') throw new HttpError(422, 'VALIDATION_ERROR', 'breakpoint must be a boolean.');
    let proposalSource;
    if (input.proposalSource !== undefined) {
      if (!input.proposalSource || typeof input.proposalSource !== 'object' || Array.isArray(input.proposalSource)) throw new HttpError(422, 'VALIDATION_ERROR', 'proposalSource must be an object.');
      proposalSource = {
        planId: requiredString(input.proposalSource.planId, 'proposalSource.planId', 200),
        planHash: requiredHash(input.proposalSource.planHash, 'proposalSource.planHash'),
        proposalNodeId: requiredString(input.proposalSource.proposalNodeId, 'proposalSource.proposalNodeId', 200),
        sourceIntentNodeIds: stringList(input.proposalSource.sourceIntentNodeIds, 'proposalSource.sourceIntentNodeIds'),
        sourceEvidenceIds: stringList(input.proposalSource.sourceEvidenceIds, 'proposalSource.sourceEvidenceIds'),
      };
    }
    return {
      id,
      title: requiredString(input.title, `nodes[${index}].title`, 500),
      kind: optionalString(input.kind ?? 'engineering', `nodes[${index}].kind`, 100) || 'engineering',
      description: optionalString(input.description ?? '', `nodes[${index}].description`, 8_000) || '',
      context: optionalString(input.context ?? '', `nodes[${index}].context`, 100_000) || '',
      ...(input.group != null && input.group !== '' ? { group: requiredString(input.group, 'group', 200) } : {}),
      ...(input.agentId != null && input.agentId !== '' ? { agentId: requiredString(input.agentId, 'agentId', 200) } : {}),
      ...(input.providerId != null && input.providerId !== '' ? { providerId: requiredString(input.providerId, 'providerId', 100) } : {}),
      ...(input.model != null && input.model !== '' ? { model: requiredString(input.model, 'model', 300) } : {}),
      skills: stringList(input.skills, 'skills'),
      inputs: stringList(input.inputs, 'inputs'),
      outputs: stringList(input.outputs, 'outputs'),
      acceptanceCriteria: stringList(input.acceptanceCriteria, 'acceptanceCriteria', 20),
      budgets,
      breakpoint: input.breakpoint ?? false,
      ...(input.review === undefined ? {} : { review: reviewConfig(input.review, id) }),
      ...(position ? { position } : {}),
      ...(proposalSource ? { proposalSource } : {}),
    };
  });

  for (const node of nodes) if (node.review) reviewConfig(node.review, node.id, ids);
  const edgeIds = new Set();
  const edges = (body.edges ?? []).map((input, index) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new HttpError(422, 'VALIDATION_ERROR', `edges[${index}] must be an object.`);
    }
    const source = requiredString(input.source, `edges[${index}].source`, 200);
    const target = requiredString(input.target, `edges[${index}].target`, 200);
    if (!ids.has(source) || !ids.has(target)) {
      throw new HttpError(422, 'VALIDATION_ERROR', `edges[${index}] references an unknown node.`);
    }
    if (source === target) throw new HttpError(422, 'VALIDATION_ERROR', 'Self-referencing edges are not supported in this local harness.');
    const id = optionalString(input.id, `edges[${index}].id`, 200) || `edge:${source}:${target}`;
    if (edgeIds.has(id)) throw new HttpError(422, 'VALIDATION_ERROR', `Duplicate edge id “${id}”.`);
    edgeIds.add(id);
    const type = optionalString(input.type ?? 'REQUIRES', `edges[${index}].type`, 100).toUpperCase();
    if (!/^[A-Z][A-Z0-9_]*$/.test(type)) throw new HttpError(422, 'VALIDATION_ERROR', 'Relationship type must use uppercase words separated by underscores.');
    return { id, source, target, type, label: optionalString(input.label ?? type, `edges[${index}].label`, 500) || type,
      ...(input.rationale ? { rationale: requiredString(input.rationale, 'rationale', 8_000) } : {}) };
  });

  return { nodes, edges, context: optionalString(body.context ?? '', 'context', 200_000) || '' };
}

function safeArtifactName(title, nodeId) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);
  const idSlug = nodeId.replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32);
  return `${slug || idSlug || 'node'}-${idSlug || 'artifact'}.md`;
}

function artifactContent(step, execution, node) {
  const dependencies = step.dependsOn.length ? step.dependsOn.map((dependency) => `- ${dependency}`).join('\n') : '- None';
  return [
    `# ${step.title}`,
    '',
    '> Generated by the deterministic local simulation provider. This artifact proves the harness flow; it is not production implementation output.',
    '',
    `- Execution: ${execution.id}`,
    `- Plan: ${execution.planId}`,
    `- Node: ${step.nodeId}`,
    `- Completed: ${now()}`,
    '',
    '## Objective',
    '',
    step.objective,
    '',
    '## User context',
    '',
    node?.context || node?.description || 'No additional node context supplied.',
    '',
    '## Dependencies',
    '',
    dependencies,
    '',
    '## Checkpoint',
    '',
    'The node reached its durable completion checkpoint. A pause request takes effect before the next node starts.',
    '',
  ].join('\n');
}

function reusableCheckpoints(previousPlan, nextPlan, completedNodeIds) {
  const previousSteps = new Map(previousPlan.plan.steps.map((step) => [step.nodeId, step]));
  const nextSteps = new Map(nextPlan.plan.steps.map((step) => [step.nodeId, step]));
  const invalidated = new Set();
  for (const [nodeId, step] of nextSteps) {
    if (!previousSteps.has(nodeId) || previousSteps.get(nodeId).inputDigest !== step.inputDigest) {
      invalidated.add(nodeId);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of nextSteps.values()) {
      if (!invalidated.has(step.nodeId) && step.dependsOn.some((dependency) => invalidated.has(dependency))) {
        invalidated.add(step.nodeId);
        changed = true;
      }
    }
  }
  return completedNodeIds.filter((nodeId) => nextSteps.has(nodeId) && !invalidated.has(nodeId));
}

export function executionDependencyContext(repository, execution, plan, step) {
  if (execution.planId !== plan.id || execution.graphId !== plan.graphId && plan.graphId != null) throw new HttpError(409, 'DEPENDENCY_EVIDENCE_MISSING', 'Dependency context must use the execution’s pinned plan and graph.');
  const steps = new Map(plan.plan.steps.map((item) => [item.nodeId, item]));
  const required = new Set();
  const visit = (nodeId) => {
    if (required.has(nodeId)) return;
    const dependency = steps.get(nodeId);
    if (!dependency || !execution.completedNodeIds.includes(nodeId)) throw new HttpError(409, 'DEPENDENCY_EVIDENCE_MISSING', `Required node ${nodeId} has no completed checkpoint.`);
    required.add(nodeId);
    for (const parent of dependency.dependsOn ?? []) visit(parent);
  };
  for (const nodeId of step.dependsOn ?? []) visit(nodeId);
  const eventCache = new Map();
  const eventsFor = (id) => {
    if (eventCache.has(id)) return eventCache.get(id);
    const events = [];
    let cursor = 0;
    while (true) {
      const page = repository.listEvents(id, cursor, 2_000);
      events.push(...page);
      if (events.length > 100_000) throw new HttpError(409, 'DEPENDENCY_CONTEXT_LIMIT', 'Dependency history exceeds the bounded evidence scan.');
      if (page.length < 2_000) break;
      cursor = page.at(-1).sequence;
    }
    eventCache.set(id, events);
    return events;
  };
  let remainingChars = 192_000;
  const capture = (artifact, limit) => {
    const content = artifact.content.slice(0, Math.min(limit, remainingChars));
    remainingChars -= content.length;
    return {
      artifactId: artifact.id, name: artifact.name, mediaType: artifact.mediaType,
      sha256: createHash('sha256').update(artifact.content).digest('hex'),
      content, originalChars: artifact.content.length, truncated: content.length !== artifact.content.length,
    };
  };
  const dependencies = [];
  for (const dependency of plan.plan.steps.filter((item) => required.has(item.nodeId))) {
    let source = execution;
    let sourcePlan = plan;
    const visited = new Set();
    let found = false;
    while (source && !visited.has(source.id)) {
      visited.add(source.id);
      if (source.graphId !== execution.graphId || !source.completedNodeIds.includes(dependency.nodeId)) break;
      const sourceStep = sourcePlan.plan.steps.find((item) => item.nodeId === dependency.nodeId);
      if (!sourceStep || sourceStep.inputDigest !== dependency.inputDigest || sourceStep.promptDigest !== dependency.promptDigest) break;
      const events = eventsFor(source.id);
      const completedIndex = events.findLastIndex((event) => event.type === 'node.completed' && event.payload.nodeId === dependency.nodeId && event.payload.stepId === sourceStep.id);
      if (completedIndex >= 0) {
        const completed = events[completedIndex];
        const verified = events.slice(0, completedIndex).findLast((event) => event.type === 'verification.receipt' && event.payload.nodeId === dependency.nodeId);
        const receiptArtifact = verified && repository.getArtifact(verified.payload.artifactId);
        let receipt;
        try { receipt = JSON.parse(receiptArtifact?.content); } catch { break; }
        if (!receiptArtifact || receiptArtifact.executionId !== source.id || receiptArtifact.nodeId !== dependency.nodeId
          || !['PASS', 'SIMULATED_PASS'].includes(verified.payload.result) || receipt.result !== verified.payload.result
          || receipt.nodeId !== dependency.nodeId || receipt.planId !== sourcePlan.id) break;
        const outputIds = completed.payload.artifactIds ?? [completed.payload.artifactId];
        const outputArtifacts = outputIds.map((id) => repository.getArtifact(id));
        if (outputArtifacts.some((artifact) => !artifact || artifact.executionId !== source.id || artifact.nodeId !== dependency.nodeId)) break;
        dependencies.push({
          nodeId: dependency.nodeId, title: dependency.title, stepInputDigest: dependency.inputDigest,
          sourceExecutionId: source.id, sourcePlanId: sourcePlan.id, sourcePlanHash: sourcePlan.contentHash,
          lineageStatus: source.id === execution.id ? 'CURRENT' : 'REUSED_CHECKPOINT',
          completionEventId: completed.id, verificationEventId: verified.id,
          verificationMode: receipt.verificationMode, result: receipt.result,
          workspaceVerification: {
            changedFilesMatch: receipt.changedFilesMatch ?? null,
            workspaceBeforeDigest: receipt.workspaceBeforeDigest ?? null,
            workspaceAfterDigest: receipt.workspaceAfterDigest ?? null,
            manifestEvidenceAvailable: Boolean(receipt.workspaceEvidence),
          },
          receipt: capture(receiptArtifact, 32_000),
          artifacts: outputArtifacts.slice(0, 16).map((artifact) => capture(artifact, 8_000)),
          omittedArtifactCount: Math.max(0, outputArtifacts.length - 16),
        });
        found = true;
        break;
      }
      const checkpoint = source.resumedFromCheckpoint;
      const parent = source.parentExecutionId && repository.getExecution(source.parentExecutionId);
      const parentPlan = parent && repository.getPlan(parent.planId);
      if (!parent || !parentPlan || checkpoint?.predecessorExecutionId !== parent.id || checkpoint?.predecessorPlanId !== parent.planId
        || checkpoint?.newPlanId !== source.planId || !checkpoint?.reusedNodeIds?.includes(dependency.nodeId)
        || parent.graphId !== execution.graphId || parent.rootExecutionId !== execution.rootExecutionId
        || parent.workspaceBindingDigest !== execution.workspaceBindingDigest
        || !reusableCheckpoints(parentPlan, sourcePlan, parent.completedNodeIds).includes(dependency.nodeId)) break;
      source = parent;
      sourcePlan = parentPlan;
    }
    if (!found) throw new HttpError(409, 'DEPENDENCY_EVIDENCE_MISSING', `Required node ${dependency.nodeId} has no accepted receipt in the verified execution lineage.`);
  }
  return { dependencies, contentTruncated: dependencies.some((item) => item.receipt.truncated || item.omittedArtifactCount || item.artifacts.some((artifact) => artifact.truncated)) };
}

export function createLocalServer({
  host = '127.0.0.1',
  port = 4317,
  webPort = Number(process.env.EGE_WEB_PORT || 5173),
  databasePath = resolve('.ege/postgres'),
  objectRoot,
  staticRoot,
  staticDir,
  maxSourceBytes = MAX_SOURCE_BYTES,
  skillsRoot,
  workspaceRoot = process.env.EGE_WORKSPACE_ROOT || process.cwd(),
  stepDelayMs = Number(process.env.EGE_SIMULATION_STEP_MS || 250),
  environment = process.env,
  fetchImpl = globalThis.fetch,
  codexWorkspaceExecutor = runCodexWorkspaceStep,
  providerInventoryClock = Date.now,
  engineeringEnvironmentInspector,
  nodeReviewStream,
  nodeReviewTimeoutMs,
  allowedBrowserOrigins = [],
  allowNonLoopbackBind = false,
} = {}) {
  // This engine has no authentication: anything that can open a TCP connection
  // to it can drive it. Binding to loopback is what keeps that honest on a
  // normal machine, so it is the default and the guard stays on.
  //
  // A container is the one case where loopback is wrong: a published port
  // reaches the container's network interface, never its loopback, so a
  // loopback-bound engine is simply unreachable. There the container's network
  // namespace is the isolation boundary instead. That is a deliberate
  // deployment decision, so it must be stated explicitly rather than inferred,
  // and the operator still has to publish to the host's loopback
  // (-p 127.0.0.1:4317:4317) to avoid handing the engine to the LAN.
  if (host !== '127.0.0.1' && host !== 'localhost' && !allowNonLoopbackBind) {
    throw new Error(`The no-login local server may bind only to 127.0.0.1 or localhost. To bind ${host} inside a container, set EGE_ALLOW_NON_LOOPBACK_BIND=1 and publish the port to the host's loopback only (docker run -p 127.0.0.1:4317:4317).`);
  }

  const staticAssets = configureStaticRoot(staticRoot, staticDir);

  const canonicalWorkspaceRoot = realpathSync(workspaceRoot);
  if (!statSync(canonicalWorkspaceRoot).isDirectory()) {
    throw new Error('EGE_WORKSPACE_ROOT must resolve to a directory.');
  }

  const browserOrigins = new Set([
    `http://127.0.0.1:${webPort}`,
    `http://localhost:${webPort}`,
    ...allowedBrowserOrigins,
  ]);

  function canonicalizeWorkspacePath(candidate) {
    if (candidate == null || candidate === '') return null;
    const requested = isAbsolute(candidate) ? candidate : resolve(canonicalWorkspaceRoot, candidate);
    let canonical;
    try {
      canonical = realpathSync(requested);
    } catch {
      throw new HttpError(422, 'WORKSPACE_NOT_FOUND', 'workspacePath must resolve to an existing directory.');
    }
    if (!statSync(canonical).isDirectory()) {
      throw new HttpError(422, 'WORKSPACE_NOT_DIRECTORY', 'workspacePath must resolve to a directory.');
    }
    const relation = relative(canonicalWorkspaceRoot, canonical);
    if (relation.startsWith('..') || isAbsolute(relation)) {
      throw new HttpError(403, 'WORKSPACE_OUTSIDE_ROOT', 'workspacePath must remain inside EGE_WORKSPACE_ROOT.');
    }
    return canonical;
  }

  assertLegacyImportComplete(databasePath);
  const repository = new LocalRepository(databasePath);
  const resolvedObjectRoot = resolve(objectRoot
    || process.env.EGE_OBJECT_ROOT
    || (databasePath === ':memory:' ? resolve('.ege/object-store') : resolve(dirname(databasePath), 'object-store')));
  let objectStore;
  let evidenceService;
  function objects() {
    objectStore ??= new LocalObjectStore({ root: resolvedObjectRoot, maxObjectBytes: maxSourceBytes });
    return objectStore;
  }
  function evidence() {
    evidenceService ??= new EvidenceService({ objectStore: objects(), limits: { maxSourceBytes } });
    return evidenceService;
  }
  const promptByAgent = new Map(DEFAULT_AGENT_PROMPTS.map((prompt) => [prompt.agentId, prompt]));
  const policyByAgent = new Map(DEFAULT_AGENT_POLICIES.map((policy) => [policy.agentId, policy]));
  repository.syncAgentCatalog(DEFAULT_AGENT_ARCHETYPES.map((agent) => {
    const prompt = promptByAgent.get(agent.id);
    const policy = policyByAgent.get(agent.id);
    return {
      id: agent.id,
      slug: agent.id,
      name: agent.name,
      domain: agent.domainId,
      description: agent.description,
      capabilities: policy.allowedCapabilities,
      toolPolicy: policy,
      prompt: prompt.text,
      promptDigest: prompt.contentDigest,
      outputSchema: {},
    };
  }));
  repository.syncProviderProfiles(DEFAULT_PROVIDER_PROFILES);
  const skills = new SkillCatalog(skillsRoot ? { root: skillsRoot } : undefined);
  void skills.ensureScanned().catch(() => {});
  const cliInventory = new Map();
  function cachedCliInspection(providerId, inspectionEnvironment = environment, { force = false } = {}) {
    const fingerprint = JSON.stringify(['PATH', 'HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'].map((key) => inspectionEnvironment[key] ?? null));
    const cached = cliInventory.get(providerId);
    const age = cached ? providerInventoryClock() - cached.checkedAt : Infinity;
    if (!force && cached?.fingerprint === fingerprint && age >= 0 && age < CLI_INVENTORY_TTL_MS) return cached.inspection;
    const inspection = inspectCliProvider(providerId, inspectionEnvironment);
    cliInventory.set(providerId, { inspection, fingerprint, checkedAt: providerInventoryClock() });
    return inspection;
  }
  const providerConnections = new ProviderConnectionManager({ environment, fetchImpl, inspectCli: cachedCliInspection });
  const settingsRoutes = createEngineeringSettingsRoutes({ repository, readJson, json, HttpError });
  const engineeringSettings = settingsRoutes.settingsStore;
  const assertEnabledSkills = (ids) => {
    const disabled = new Set(engineeringSettings.get().skills.disabledIds);
    const blocked = [...new Set(ids)].filter((id) => disabled.has(id));
    if (blocked.length) throw new HttpError(409, 'SKILL_GLOBALLY_DISABLED', `Re-enable these skills in Engineering settings or remove their node/agent selection: ${blocked.join(', ')}`);
  };
  const readSkillContents = skills.readSelectedContents.bind(skills);
  skills.readSelectedContents = (ids = [], options) => { assertEnabledSkills(ids); return readSkillContents(ids, options); };
  const enabledCatalogMetadata = skills.catalogMetadata.bind(skills);
  skills.catalogMetadata = () => {
    const disabled = new Set(engineeringSettings.get().skills.disabledIds);
    return enabledCatalogMetadata().filter((item) => !disabled.has(item.id));
  };
  const memory = createHarnessMemory({ repository, environment, fetchImpl, engineeringSettings });
  const routeDependencies = { repository, skills, currentProviders, providerConnections, environment, fetchImpl, readJson, json, HttpError, validateDraft, memory, engineeringSettings };
  const catalogRoutes = createCatalogRoutes(routeDependencies);
  const chatRoutes = createChatRoutes(routeDependencies);
  const terminalRoutes = createTerminalRoutes(routeDependencies);
  const engineeringProposalRoutes = createEngineeringProposalRoutes(routeDependencies);
  const engineeringEnvironment = engineeringEnvironmentInspector ?? createEngineeringEnvironment({ environment });
  const memoryRoutes = createHarnessMemoryRoutes(routeDependencies);
  const clients = new Map();
  const traceClients = new Map();
  const planningTraces = new Map();
  const runnerPromises = new Map();
  const runnerControllers = new Map();
  let closed = false;
  let closePromise = null;

  function canonicalWorkspaceBinding(candidate) {
    const canonicalPath = canonicalizeWorkspacePath(candidate);
    if (!canonicalPath) return null;
    return workspaceBinding(canonicalPath, statSync(canonicalPath));
  }

  async function connectAndPersist(providerId, input, existing) {
    const result = await providerConnections.connect(input, existing);
    const next = {
      ...existing,
      enabled: true,
      model: result.connection.selectedModel ?? existing.model,
      baseUrl: result.connection.baseUrl ?? existing.baseUrl,
      secretEnvName: canonicalSecretEnvName(providerId) ?? existing.secretEnvName,
      options: existing.options,
    };
    const changed = existing.enabled !== next.enabled || existing.model !== next.model
      || existing.baseUrl !== next.baseUrl || existing.secretEnvName !== next.secretEnvName;
    const profile = changed ? repository.upsertProviderProfile(next) : existing;
    return {
      ...result,
      connection: providerConnections.connection(providerId, profile),
      provider: currentProviders().find((item) => item.id === providerId),
    };
  }

  // One action that connects whatever this machine already provides: hosted keys
  // exported into the engine's environment, a loopback Ollama daemon, and a
  // logged-in CLI. Each provider is attempted independently and a failure is
  // reported against that provider only -- a missing key must never stop an
  // installed CLI from being connected. Nothing is guessed: every result names
  // the evidence it acted on, so "skipped" is actionable rather than mysterious.
  async function autodetectProviders(body) {
    const ollamaBaseUrl = typeof body?.ollamaBaseUrl === 'string' && body.ollamaBaseUrl.trim()
      ? body.ollamaBaseUrl.trim()
      : DEFAULT_OLLAMA_BASE_URL;
    const results = [];
    for (const candidate of AUTODETECT_CANDIDATES) {
      const { providerId, kind, envName } = candidate;
      const existing = repository.getProviderProfile(providerId);
      if (!existing) {
        results.push({ providerId, kind, status: 'unavailable', detail: 'No provider profile is registered for this engine.' });
        continue;
      }
      try {
        if (kind === 'hosted') {
          const apiKey = environment[envName];
          if (!apiKey || !apiKey.trim()) {
            results.push({ providerId, kind, status: 'skipped', detail: `${envName} is not set in this engine's environment.` });
            continue;
          }
          const discovered = await providerConnections.discover({ kind, providerId, apiKey: apiKey.trim() }, existing);
          const model = discovered.models.some((item) => item.id === existing.model)
            ? existing.model
            : discovered.models[0]?.id;
          if (!model) {
            results.push({ providerId, kind, status: 'failed', detail: 'The credential verified but the provider listed no selectable model.' });
            continue;
          }
          const connected = await connectAndPersist(providerId, { kind, providerId, model }, existing);
          results.push({ providerId, kind, status: 'connected', model, detail: `Verified ${envName} and selected ${model}.` });
          continue;
        }
        if (kind === 'local') {
          const discovered = await providerConnections.discover({ kind, providerId, baseUrl: ollamaBaseUrl }, existing);
          const model = discovered.models.some((item) => item.id === existing.model)
            ? existing.model
            : discovered.models[0]?.id;
          if (!model) {
            results.push({ providerId, kind, status: 'failed', detail: `${ollamaBaseUrl} answered but has no installed model. Run: ollama pull <model>` });
            continue;
          }
          await connectAndPersist(providerId, { kind, providerId, baseUrl: ollamaBaseUrl, model }, existing);
          results.push({ providerId, kind, status: 'connected', model, detail: `${ollamaBaseUrl} is serving ${model}.` });
          continue;
        }
        await providerConnections.discover({ kind, providerId }, existing);
        await connectAndPersist(providerId, { kind, providerId }, existing);
        results.push({ providerId, kind, status: 'connected', model: null, detail: `${providerId} is installed and logged in.` });
      } catch (error) {
        const code = error instanceof ProviderConnectionError ? error.code : null;
        results.push({
          providerId,
          kind,
          status: code === 'CLI_NOT_INSTALLED' || code === 'CLI_AUTH_REQUIRED' ? 'skipped' : 'failed',
          ...(code ? { code } : {}),
          detail: error.message,
        });
      }
    }
    return { results, connected: results.filter((item) => item.status === 'connected').length };
  }

  function currentProviders({ forceCli = false } = {}) {
    // Recompute mutable profiles and connection decoration on every request.
    // Only expensive CLI authentication/help probes have a bounded cache.
    return detectProviders(environment, repository.listProviderProfiles(), {
      inspectCli: (id, env) => cachedCliInspection(id, env, { force: forceCli }),
    }).map((provider) => {
      const checked = cliInventory.get(provider.id);
      return providerConnections.decorate({
        ...provider,
        ...(checked ? { readinessCheckedAt: new Date(checked.checkedAt).toISOString(), readinessExpiresAt: new Date(checked.checkedAt + CLI_INVENTORY_TTL_MS).toISOString() } : {}),
      });
    });
  }

  function planningProviderStatus(providerId) {
    const profile = repository.getProviderProfile(providerId);
    if (!profile) return null;
    if (providerId === 'local-agents') return localAgentProviderStatus(profile);
    if (providerId === 'simulation') {
      const available = profile.enabled !== false;
      return {
        id: providerId,
        label: profile.label || 'Local simulation',
        kind: 'local',
        detected: true,
        available,
        configured: available,
        ready: available,
        capabilities: available ? ['plan', 'execute', 'pause', 'replan', 'resume', 'artifacts'] : [],
        profile,
        detail: 'Deterministic built-in provider; it never calls an external model.',
      };
    }
    const connection = providerConnections.connection(providerId, profile);
    if (profile.enabled !== true || connection?.status !== 'CONNECTED' || connection.verified !== true) return null;
    return {
      id: providerId,
      label: profile.label || providerId,
      kind: profile.kind,
      detected: true,
      available: true,
      configured: true,
      ready: true,
      connectionVerified: true,
      capabilities: connection.capabilities ?? [],
      profile,
      connection,
      detail: 'Verified provider connection available for AI planning.',
    };
  }

  function compilerAgentCatalog() {
    return repository.listAgents()
      .filter((agent) => agent.status === 'ACTIVE' && agent.currentPrompt)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description,
        domainId: agent.domain,
        capabilities: agent.capabilities,
        providerId: agent.providerId,
        model: agent.model,
        skillIds: agent.skillIds,
        defaultPromptDigest: agent.currentPrompt.digest,
      }));
  }

  function providerProfilePin(profile, providerId = profile?.id) {
    if (!profile) return null;
    return {
      id: profile.id,
      label: profile.label,
      kind: profile.kind,
      model: profile.model,
      baseUrl: profile.baseUrl,
      enabled: profile.enabled,
      secretEnvName: profile.secretEnvName,
      options: profile.options,
      connectionRevision: profile.kind === 'cli' ? null : providerConnections.connectionRevision(providerId),
      updatedAt: profile.updatedAt,
    };
  }

  function plannerProviderPin(profile, providerId = profile?.id) {
    return {
      id: providerId,
      model: profile?.model ?? null,
      baseUrl: profile?.baseUrl ?? null,
      secretEnvName: profile?.secretEnvName ?? null,
      connectionRevision: profile?.kind === 'cli' ? null : providerConnections.connectionRevision(providerId),
      updatedAt: profile?.updatedAt ?? null,
    };
  }

  function samePlannerProviderPin(left, right) {
    if (!left || !right) return left === right;
    const cliPin = left.id?.endsWith('-cli') || right.id?.endsWith('-cli');
    const comparable = (pin) => cliPin ? { ...pin, connectionRevision: null } : pin;
    return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
  }

  function assertExecutionSettings(plan) {
    const pinned = plan.plan.contextManifest?.engineeringSettings;
    if (pinned && pinned.revision !== engineeringSettings.get().revision) throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'Engineering settings changed. Create and approve a new plan.', { reason: 'ENGINEERING_SETTINGS_CHANGED' });
    assertEnabledSkills((plan.plan.steps ?? []).flatMap((step) => (step.skills ?? []).map((skill) => skill.id)));
  }

  function assertReviewCurrent(plan, step) {
    assertExecutionSettings(plan);
    assertNodeReviewPins(step.reviewPin, { draft: repository.getLatestDraft(plan.graphId), getAgent: (id) => repository.getAgent(id), getProviderPin: (id) => providerProfilePin(repository.getProviderProfile(id), id) });
  }

  function selectedAgentPins(proposedGraph) {
    const agents = new Map(repository.listAgents().map((agent) => [agent.id, agent]));
    return [...new Map(proposedGraph.nodes.map((node) => [node.agentId, node])).values()]
      .map((node) => {
        const agent = agents.get(node.agentId);
        return {
          id: node.agentId,
          promptDigest: node.promptDigest,
          promptVersion: agent?.currentPrompt?.version ?? null,
          policyDigest: agent?.toolPolicy?.contentDigest ?? null,
          configDigest: agent?.configDigest ?? null,
          assignment: node.agentAssignment,
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  function executionProvider(plan, selectedNodeIds = null) {
    const available = currentProviders();
    const steps = plan.plan.steps.filter((step) => !selectedNodeIds || selectedNodeIds.includes(step.nodeId));
    const ids = [...new Set(steps.map((step) => step.providerId || plan.provider))];
    const providers = ids.map((id) => {
      const provider = available.find((item) => item.id === id);
      if (!provider?.available || !provider.capabilities?.includes('execute')) throw new HttpError(422, 'EXECUTION_PROVIDER_UNAVAILABLE', `${provider?.label || id} cannot execute workspace nodes. Configure an available execution provider for these nodes.`);
      return provider;
    });
    return providers.find((provider) => provider.id === 'codex-cli') ?? providers[0];
  }

  function selectedExecutionNodes(plan, requestedIds) {
    if (requestedIds === undefined || requestedIds === null) return null;
    if (!Array.isArray(requestedIds) || !requestedIds.length || requestedIds.length > 256) throw new HttpError(422, 'VALIDATION_ERROR', 'nodeIds must be a non-empty array of at most 256 node IDs.');
    const steps = new Map(plan.plan.steps.map((step) => [step.nodeId, step]));
    const selected = new Set();
    const visit = (id) => {
      if (selected.has(id)) return;
      const step = steps.get(id);
      if (!step) throw new HttpError(422, 'NODE_NOT_IN_PLAN', `Node ${id} is not in the approved plan.`);
      selected.add(id);
      for (const dependency of step.dependsOn) visit(dependency);
    };
    for (const value of requestedIds) {
      const id = requiredString(value, 'nodeIds[]', 200);
      const matches = steps.has(id) ? [id] : [...steps.values()].filter((step) => step.sourceIntentNodeIds?.includes(id)).map((step) => step.nodeId);
      if (!matches.length) throw new HttpError(422, 'NODE_NOT_IN_PLAN', `Node ${id} is not in the approved plan.`);
      matches.forEach(visit);
    }
    return [...steps.keys()].filter((id) => selected.has(id));
  }

  async function executeConfiguredNode(input) {
    const attempts = input.step.budgets?.maxAttempts ?? 1;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await codexWorkspaceExecutor(input);
      } catch (error) {
        if (input.signal?.aborted || attempt === attempts) throw error;
        // Retrying after partial edits can duplicate work. Only retry an adapter
        // failure when the admitted workspace checkpoint is still unchanged.
        await assertExecutionWorkspaceCheckpoint(repository.getExecution(input.executionId));
        emit(input.executionId, 'node.retry', { nodeId: input.step.nodeId, attempt: attempt + 1, maxAttempts: attempts, code: error.code || 'EXECUTOR_FAILED' });
      }
    }
  }

  function requiredExecutionWorkspace(graph) {
    if (!graph?.workspacePath) {
      throw new HttpError(
        422,
        'EXECUTION_WORKSPACE_REQUIRED',
        'Codex execution requires an explicitly selected workspace folder for this graph.',
      );
    }
    return canonicalizeWorkspacePath(graph.workspacePath);
  }

  function requiredPinnedExecutionWorkspace(execution) {
    if (!execution?.workspacePath || !execution.workspaceBindingDigest) {
      throw new HttpError(409, 'EXECUTION_WORKSPACE_BINDING_MISSING', 'The admitted execution has no immutable local-project binding.');
    }
    const current = canonicalWorkspaceBinding(execution.workspacePath);
    if (!current || current.digest !== execution.workspaceBindingDigest) {
      throw new HttpError(409, 'EXECUTION_WORKSPACE_BINDING_CHANGED', 'The admitted local-project folder identity changed. Execution stopped closed.');
    }
    return current.canonicalPath;
  }

  async function assertExecutionWorkspaceCheckpoint(execution) {
    const workspacePath = requiredPinnedExecutionWorkspace(execution);
    const current = await captureWorkspaceBaseline(workspacePath, environment);
    if (!execution.workspaceBaseline || JSON.stringify(current) !== JSON.stringify(execution.workspaceBaseline)) {
      const error = new Error('The local project changed outside the admitted execution checkpoint. Replan before continuing.');
      error.code = 'EXECUTION_WORKSPACE_DRIFT';
      error.currentBaseline = current;
      throw error;
    }
    return { workspacePath, baseline: current };
  }

  function pinnedAgentForStep(step, plan) {
    const agent = repository.getAgent(step.agentId);
    const binding = plan?.plan?.contextManifest?.selectedAgents?.find((item) => item.id === step.agentId);
    if (agent && (agent.status !== 'ACTIVE' || (binding && ((binding.policyDigest ?? null) !== (agent.toolPolicy?.contentDigest ?? null) || (binding.configDigest ?? null) !== (agent.configDigest ?? null))))) throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The assigned agent configuration changed before this node started. Replan before continuing.', { reason: 'AGENT_CONFIGURATION_CHANGED', agentId: step.agentId });
    if (!agent) {
      return {
        id: step.agentId,
        name: step.agentId,
        currentPrompt: {
          prompt: 'Work critically, preserve evidence provenance, satisfy the approved acceptance criteria, and report only command-backed results.',
          digest: String(step.promptDigest || '').replace(/^sha256:/, ''),
        },
      };
    }
    const expectedDigest = String(step.promptDigest || '').replace(/^sha256:/, '');
    const prompt = repository.listAgentPrompts(agent.id).find((revision) => revision.digest === expectedDigest);
    if (!prompt) {
      throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The pinned agent prompt revision is unavailable for execution.', {
        reason: 'AGENT_PROMPT_MISSING', agentId: agent.id, expectedDigest,
      });
    }
    return { ...agent, currentPrompt: prompt };
  }

  function executionEvidence(plan, step, draft) {
    const intentIds = new Set(step.sourceIntentNodeIds ?? step.traceability?.intentNodeIds ?? []);
    const evidenceIds = new Set(step.sourceEvidenceIds ?? step.traceability?.evidenceIds ?? []);
    const intents = (draft?.nodes ?? [])
      .filter((node) => intentIds.has(node.id))
      .map((node) => ({
        sourceId: `intent:${node.id}`,
        filename: `Intent node: ${node.title}`,
        text: [node.description, node.context].filter(Boolean).join('\n') || node.title,
      }));
    const excerpts = (plan.plan.contextManifest?.evidenceManifest?.excerpts ?? [])
      .filter((item) => evidenceIds.has(item.sourceId));
    return [...intents, ...excerpts];
  }

  function realExecutionSummary(step, result) {
    const changed = result.actualChangedFiles.length
      ? result.actualChangedFiles.map((path) => `- ${path}`).join('\n')
      : '- No lasting workspace file changes';
    const verification = result.actualVerification.length
      ? result.actualVerification.map((check) => `- ${check.status} (${check.exitCode}): ${check.command}`).join('\n')
      : '- No command receipt';
    const risks = result.receipt.risks.length ? result.receipt.risks.map((risk) => `- ${risk}`).join('\n') : '- None reported';
    return [
      `# ${step.title}`,
      '',
      `Codex CLI result: ${result.accepted ? 'accepted' : 'not accepted'}`,
      '',
      result.receipt.summary,
      '',
      '## Changed files',
      '',
      changed,
      '',
      '## Actual command receipts',
      '',
      verification,
      '',
      '## Risks',
      '',
      risks,
      '',
    ].join('\n');
  }

  function publish(event) {
    const executionId = event.executionId;
    for (const client of clients.get(executionId) ?? []) {
      if (event.sequence > client.lastSequence) {
        client.response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        client.lastSequence = event.sequence;
      }
    }
    return event;
  }

  function publishTraceEvent(event) {
    if (!event) return null;
    const trace = repository.getTrace(event.traceId);
    if (!trace) return event;
    for (const client of traceClients.get(trace.graphId) ?? []) {
      if (event.sequence > client.lastSequence) {
        client.response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        client.lastSequence = event.sequence;
      }
    }
    return event;
  }

  function observe(operation) {
    try {
      const result = operation();
      if (result?.traceEvent) publishTraceEvent(result.traceEvent);
      if (result?.executionEvent) publish(result.executionEvent);
      return result;
    } catch (error) {
      // Diagnostic capture is deliberately non-authoritative. Execution and approval truth must continue.
      process.stderr.write(`[ege telemetry degraded] ${error.message}\n`);
      return null;
    }
  }

  function createTraceObserver(traceId, rootSpanId, executionId = null) {
    const spans = new Map([['root', rootSpanId]]);
    return {
      startSpan(key, spec) {
        if (spans.has(key)) return spans.get(key);
        const result = observe(() => repository.startTraceSpan({
          traceId,
          parentSpanId: spec.parentSpanId ?? spans.get(spec.parentKey || 'root') ?? rootSpanId,
          executionId,
          ...spec,
        }));
        if (result?.span) spans.set(key, result.span.id);
        return result?.span?.id ?? null;
      },
      event(key, name, attributes) {
        const spanId = spans.get(key);
        return spanId ? observe(() => repository.appendTraceSpanEvent(spanId, name, attributes)) : null;
      },
      endSpan(key, result = {}) {
        const spanId = spans.get(key);
        if (!spanId) return null;
        const ended = observe(() => repository.endTraceSpan(spanId, result));
        spans.delete(key);
        return ended?.span ?? null;
      },
      spanId(key) { return spans.get(key) ?? null; },
    };
  }

  function beginTrace({ graphId, executionId = null, planId = null, kind, name, provider, model, attributes, input }) {
    const created = observe(() => repository.createTrace({
      graphId, executionId, planId, kind, name, provider, model, attributes,
    }));
    if (!created?.trace) return null;
    const root = observe(() => repository.startTraceSpan({
      traceId: created.trace.id,
      executionId,
      planId,
      name: kind === 'PLAN' ? 'ege.plan' : 'ege.execute',
      category: 'GRAPH',
      spanKind: 'INTERNAL',
      attributes: { operation: kind.toLowerCase(), displayName: name },
      input,
      root: true,
    }));
    if (!root?.span) {
      observe(() => repository.endTrace(created.trace.id, { status: 'ERROR', attributes: { telemetryDegraded: true } }));
      return null;
    }
    return {
      traceId: created.trace.id,
      rootSpanId: root.span.id,
      observer: createTraceObserver(created.trace.id, root.span.id, executionId),
    };
  }

  function finishTrace(context, status, output = null, attributes = {}) {
    if (!context) return;
    context.observer.endSpan('root', { status, output, attributes });
    observe(() => repository.endTrace(context.traceId, { status, attributes }));
  }

  function closePersistedTrace(trace, status, output = null, attributes = {}) {
    if (!trace || trace.endedAt) return;
    const root = repository.getTraceSpan(trace.rootSpanId);
    if (root && !root.endedAt) observe(() => repository.endTraceSpan(root.id, { status, output, attributes }));
    observe(() => repository.endTrace(trace.id, { status, attributes }));
  }

  function emit(executionId, type, payload = {}) {
    return publish(repository.appendEvent(executionId, type, payload));
  }

  function scheduleExecution(executionId) {
    if (closed || runnerPromises.has(executionId)) return;
    const controller = new AbortController();
    runnerControllers.set(executionId, controller);
    const promise = runExecution(executionId, controller.signal)
      .catch((error) => {
        if (closed || repository.getExecution(executionId)?.status === 'CANCELLED') return;
        const transition = repository.failExecution(executionId, error.message || 'Execution failed.');
        for (const event of transition.events) publish(event);
        const trace = repository.getTraceByExecution(executionId);
        if (trace && !trace.endedAt) {
          const root = repository.getTraceSpan(trace.rootSpanId);
          if (root && !root.endedAt) observe(() => repository.endTraceSpan(root.id, {
            status: 'ERROR', output: { code: error.code, message: error.message },
          }));
          observe(() => repository.endTrace(trace.id, { status: 'ERROR', attributes: { errorCode: error.code ?? 'EXECUTION_FAILED' } }));
        }
      })
      .finally(() => {
        runnerPromises.delete(executionId);
        runnerControllers.delete(executionId);
      });
    runnerPromises.set(executionId, promise);
  }

  async function runExecution(executionId, signal) {
    while (!closed) {
      let execution = repository.getExecution(executionId);
      if (!execution) return;
      if (execution.status === 'PAUSE_REQUESTED' || execution.pauseRequested) {
        const transition = repository.pauseAtCheckpoint(executionId);
        for (const event of transition.events) publish(event);
        const trace = repository.getTraceByExecution(executionId);
        if (trace && !trace.endedAt) {
          const checkpoint = observe(() => repository.startTraceSpan({
            traceId: trace.id, parentSpanId: trace.rootSpanId, executionId,
            name: 'Pause at durable checkpoint', category: 'CHECKPOINT', spanKind: 'INTERNAL',
            input: { completedNodeIds: transition.execution.completedNodeIds },
          }));
          if (checkpoint?.span) observe(() => repository.endTraceSpan(checkpoint.span.id, {
            status: 'OK', output: { status: 'PAUSED', completedNodeIds: transition.execution.completedNodeIds },
          }));
        }
        return;
      }
      if (execution.status !== 'RUNNING') return;

      const plan = repository.getPlan(execution.planId);
      const persistedExecutionTrace = repository.getTraceByExecution(executionId);
      let executionTrace = persistedExecutionTrace?.endedAt ? null : persistedExecutionTrace;
      if (!persistedExecutionTrace) {
        const graph = repository.getGraph(execution.graphId);
        const recoveredTrace = beginTrace({
          graphId: execution.graphId, executionId, planId: plan.id, kind: 'EXECUTION',
          name: `Execute ${graph?.name || execution.graphId} plan v${plan.version}`,
          provider: plan.provider, model: plan.plan.contextManifest?.plannerProvider?.model ?? null,
          attributes: { recoveredTrace: true }, input: { executionId, planId: plan.id },
        });
        if (recoveredTrace) observe(() => repository.linkTrace({ traceId: recoveredTrace.traceId, executionId, planId: plan.id }));
        executionTrace = repository.getTraceByExecution(executionId);
      }
      const incompleteSteps = plan.plan.steps.filter((step) => (!execution.selectedNodeIds || execution.selectedNodeIds.includes(step.nodeId)) && !execution.completedNodeIds.includes(step.nodeId));
      if (!incompleteSteps.length) {
        const transition = repository.completeExecution(executionId, { completedNodeIds: execution.completedNodeIds });
        for (const event of transition.events) publish(event);
        if (executionTrace && !executionTrace.endedAt) {
          const root = repository.getTraceSpan(executionTrace.rootSpanId);
          if (root && !root.endedAt) observe(() => repository.endTraceSpan(root.id, {
            status: 'OK', output: { completedNodeIds: execution.completedNodeIds },
          }));
          observe(() => repository.endTrace(executionTrace.id, { status: 'OK' }));
        }
        return;
      }
      const nextStep = incompleteSteps.find((step) => step.dependsOn.every((dependency) => execution.completedNodeIds.includes(dependency)));
      if (!nextStep) throw new Error('No dependency-ready node exists; the persisted plan is inconsistent.');
      if (nextStep.breakpoint && !execution.passedBreakpointNodeIds.includes(nextStep.nodeId)) {
        const events = repository.transaction(() => {
          repository.updateExecution(executionId, { passedBreakpointNodeIds: [...execution.passedBreakpointNodeIds, nextStep.nodeId] });
          const requested = repository.requestPause(executionId);
          return [...requested.events, repository.appendEvent(executionId, 'execution.breakpoint_reached', { nodeId: nextStep.nodeId, takesEffect: 'before-node-start' })];
        });
        for (const event of events) publish(event);
        continue;
      }
      const stepProvider = nextStep.providerId || plan.provider;
      assertExecutionSettings(plan);
      assertReviewCurrent(plan, nextStep);

      const executionGraph = stepProvider === 'codex-cli' ? repository.getGraph(execution.graphId) : null;
      let executionWorkspace = null;
      if (stepProvider === 'codex-cli') {
        try {
          ({ workspacePath: executionWorkspace } = await assertExecutionWorkspaceCheckpoint(execution));
        } catch (error) {
          const transition = repository.failExecution(executionId, error.message);
          for (const event of transition.events) publish(event);
          if (executionTrace && !executionTrace.endedAt) {
            const checkpoint = observe(() => repository.startTraceSpan({
              traceId: executionTrace.id, parentSpanId: executionTrace.rootSpanId, executionId,
              name: 'Verify local-project checkpoint', category: 'CHECKPOINT', spanKind: 'INTERNAL',
              input: { expectedBindingDigest: execution.workspaceBindingDigest, expectedBaseline: execution.workspaceBaseline },
            }));
            if (checkpoint?.span) observe(() => repository.endTraceSpan(checkpoint.span.id, {
              status: 'ERROR', output: { code: error.code, message: error.message, currentBaseline: error.currentBaseline },
            }));
            const root = repository.getTraceSpan(executionTrace.rootSpanId);
            if (root && !root.endedAt) observe(() => repository.endTraceSpan(root.id, {
              status: 'ERROR', output: { code: error.code, message: error.message },
            }));
            observe(() => repository.endTrace(executionTrace.id, { status: 'ERROR', attributes: { errorCode: error.code } }));
          }
          return;
        }
      }

      const started = repository.startNode({
        executionId,
        nodeId: nextStep.nodeId,
        stepId: nextStep.id,
        title: nextStep.title,
      });
      for (const event of started.events) publish(event);
      const nodeSpan = executionTrace ? observe(() => repository.startTraceSpan({
        traceId: executionTrace.id,
        parentSpanId: executionTrace.rootSpanId,
        executionId,
        planId: plan.id,
        nodeId: nextStep.nodeId,
        stepId: nextStep.id,
        agentId: nextStep.agentId,
        name: 'ege.node',
        category: 'NODE',
        spanKind: 'INTERNAL',
        attributes: {
          displayName: nextStep.title,
          sourceIntentNodeIds: nextStep.sourceIntentNodeIds ?? nextStep.traceability?.intentNodeIds ?? [],
        },
        input: {
          objective: nextStep.objective,
          dependencies: nextStep.dependsOn,
          acceptanceCriteria: nextStep.acceptanceCriteria,
          skills: nextStep.skills,
          inputDigest: nextStep.inputDigest,
        },
      }))?.span : null;
      execution = repository.getExecution(executionId);
      const draft = repository.getDraft(execution.graphId, plan.baseDraftRevision);
      if (stepProvider === 'simulation') {
        if (nextStep.reviewPin?.required) {
          const receiptDocument = { verificationMode: 'SIMULATED', result: 'FAILED', nodeId: nextStep.nodeId, planId: plan.id, code: 'NODE_REVIEW_EVIDENCE_MISSING', message: 'Simulated results cannot satisfy a required recorded-evidence review.' };
          const failed = repository.failNode({ executionId, step: nextStep, receiptArtifact: { name: `${nextStep.nodeId}.review.json`, mediaType: 'application/json', content: JSON.stringify(receiptDocument) }, receiptDocument, message: receiptDocument.message });
          for (const event of failed.events) publish(event);
          closePersistedTrace(repository.getTraceByExecution(executionId), 'ERROR', receiptDocument);
          return;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, stepDelayMs));
        if (closed || repository.getExecution(executionId)?.status === 'CANCELLED') return;
        const intentNodeId = nextStep.sourceIntentNodeIds?.[0];
        const node = draft?.nodes.find((candidate) => candidate.id === intentNodeId);
        const receiptDocument = {
          verificationMode: 'SIMULATED',
          result: 'SIMULATED_PASS',
          nodeId: nextStep.nodeId,
          planId: execution.planId,
          checkedAt: now(),
          checks: nextStep.acceptanceCriteria.map((criterion) => ({
            criterion,
            result: 'SIMULATED_PASS',
            evidence: 'The local simulation provider generated a deterministic receipt; no production tests or external validation ran.',
          })),
        };
        const verifierSpan = executionTrace ? observe(() => repository.startTraceSpan({
          traceId: executionTrace.id, parentSpanId: nodeSpan?.id ?? executionTrace.rootSpanId,
          executionId, planId: plan.id, nodeId: nextStep.nodeId, stepId: nextStep.id,
          name: 'Simulated verification receipt', category: 'VERIFIER', spanKind: 'INTERNAL',
          attributes: { simulated: true }, input: { acceptanceCriteria: nextStep.acceptanceCriteria },
        }))?.span : null;
        const completed = repository.completeNode({
          executionId,
          step: nextStep,
          artifact: {
            name: safeArtifactName(nextStep.title, nextStep.nodeId),
            mediaType: 'text/markdown',
            content: artifactContent(nextStep, execution, node),
          },
          receiptArtifact: {
            name: `${safeArtifactName(nextStep.title, nextStep.nodeId).replace(/\.md$/, '')}.verification.json`,
            mediaType: 'application/json',
            content: JSON.stringify(receiptDocument, null, 2),
          },
          receiptDocument,
        });
        for (const event of completed.events) publish(event);
        if (verifierSpan) observe(() => repository.endTraceSpan(verifierSpan.id, {
          status: 'OK', output: receiptDocument,
        }));
        for (const artifact of completed.artifacts) {
          const artifactSpan = executionTrace ? observe(() => repository.startTraceSpan({
            traceId: executionTrace.id, parentSpanId: nodeSpan?.id ?? executionTrace.rootSpanId,
            executionId, planId: plan.id, nodeId: nextStep.nodeId, stepId: nextStep.id,
            name: 'ege.artifact.persist', category: 'ARTIFACT', spanKind: 'INTERNAL',
            attributes: { displayName: `Persist artifact ${artifact.name}`, artifactName: artifact.name },
            input: { artifactId: artifact.id, name: artifact.name, mediaType: artifact.mediaType },
          }))?.span : null;
          if (artifactSpan) observe(() => repository.endTraceSpan(artifactSpan.id, {
            status: 'OK', output: { artifactId: artifact.id },
          }));
        }
        if (nodeSpan) observe(() => repository.endTraceSpan(nodeSpan.id, {
          status: 'OK', output: { verificationMode: 'SIMULATED', artifactIds: completed.artifacts.map((item) => item.id) },
        }));
        continue;
      }

      if (stepProvider !== 'codex-cli') {
        throw new Error(`Provider ${stepProvider} can plan but has no workspace execution adapter.`);
      }

      const graph = executionGraph;
      const receiptName = `${safeArtifactName(nextStep.title, nextStep.nodeId).replace(/\.md$/, '')}.verification.json`;
      let skillSpan = null;
      let agentSpan = null;
      let modelSpan = null;
      let activeCommandSpan = null;
      try {
        skillSpan = executionTrace ? observe(() => repository.startTraceSpan({
          traceId: executionTrace.id, parentSpanId: nodeSpan?.id ?? executionTrace.rootSpanId,
          executionId, planId: plan.id, nodeId: nextStep.nodeId, stepId: nextStep.id,
          name: 'Load pinned skill packages', category: 'TOOL', spanKind: 'INTERNAL',
          input: { bindings: nextStep.skills ?? [] },
        }))?.span : null;
        await skills.scan();
        const skillIds = (nextStep.skills ?? []).map((binding) => binding.id);
        const selectedSkills = await skills.readSelectedContents(skillIds);
        for (const binding of nextStep.skills ?? []) {
          const selected = selectedSkills.find((skill) => skill.id === binding.id);
          if (!selected || selected.contentDigest !== binding.digest || selected.packageDigest !== binding.packageDigest) {
            const error = new Error(`Pinned skill ${binding.id} changed before node execution.`);
            error.code = 'SKILL_CHANGED';
            throw error;
          }
        }
        if (skillSpan) observe(() => repository.endTraceSpan(skillSpan.id, {
          status: 'OK', output: { selectedSkills: selectedSkills.map((skill) => ({
            id: skill.id, contentDigest: skill.contentDigest, packageDigest: skill.packageDigest,
          })) },
        }));
        const selectedAgent = pinnedAgentForStep(nextStep, plan);
        const selectedEvidence = executionEvidence(plan, nextStep, draft);
        const dependencyContext = executionDependencyContext(repository, execution, plan, nextStep);
        const currentManifest = await captureWorkspaceFileManifest(executionWorkspace, environment);
        await assertExecutionWorkspaceCheckpoint(execution);
        const executionContext = {
          schemaVersion: 1, executionId, planId: plan.id, planHash: plan.contentHash, nodeId: nextStep.nodeId,
          currentWorkspace: {
            bindingDigest: execution.workspaceBindingDigest,
            checkpoint: execution.workspaceBaseline,
            manifest: boundedWorkspaceManifest(currentManifest),
          },
          ...dependencyContext,
        };
        if (Buffer.byteLength(JSON.stringify(executionContext)) > 512 * 1024) throw new HttpError(409, 'DEPENDENCY_CONTEXT_LIMIT', 'Required execution evidence exceeds the bounded context limit. Split this node into smaller steps.');
        const executionContextDigest = digestExecutionInput(executionContext);
        const researchPolicy = plan.plan.contextManifest?.researchPolicy;
        const model = nextStep.model || plan.plan.contextManifest?.nodeProviderProfiles?.find((profile) => profile.id === stepProvider)?.model || plan.plan.contextManifest?.plannerProvider?.model || undefined;
        const executionPrompt = buildCodexExecutionPrompt({
          graph, plan, step: nextStep, agent: selectedAgent,
          skills: selectedSkills, evidence: selectedEvidence, researchPolicy, executionContext,
        });
        agentSpan = executionTrace ? observe(() => repository.startTraceSpan({
          traceId: executionTrace.id, parentSpanId: nodeSpan?.id ?? executionTrace.rootSpanId,
          executionId, planId: plan.id, nodeId: nextStep.nodeId, stepId: nextStep.id,
          agentId: nextStep.agentId, name: 'ege.agent',
          category: 'AGENT', spanKind: 'INTERNAL',
          attributes: {
            promptDigest: selectedAgent.currentPrompt?.digest ?? null,
            authority: selectedAgent.toolPolicy?.authority ?? 'proposal-or-bounded-execution',
            toolPolicyEnforcement: 'prompt-guidance',
            displayName: selectedAgent.name || nextStep.agentId,
          },
          input: { assignment: nextStep.agentAssignment, selectedSkillIds: skillIds, evidenceCount: selectedEvidence.length,
            executionContextDigest, dependencyNodeIds: executionContext.dependencies.map((item) => item.nodeId) },
        }))?.span : null;
        modelSpan = executionTrace ? observe(() => repository.startTraceSpan({
          traceId: executionTrace.id, parentSpanId: agentSpan?.id ?? nodeSpan?.id ?? executionTrace.rootSpanId,
          executionId, planId: plan.id, nodeId: nextStep.nodeId, stepId: nextStep.id,
          agentId: nextStep.agentId, name: 'ege.model.invoke',
          category: 'MODEL', spanKind: 'CLIENT',
          attributes: { provider: 'codex-cli', model: model ?? null, hiddenReasoningCaptured: false, displayName: 'Codex CLI workspace execution', executionContextDigest },
          input: {
            command: 'codex',
            arguments: buildCodexExecutionArguments({
              workspacePath: executionWorkspace,
              schemaPath: '[EPHEMERAL_RECEIPT_SCHEMA]', outputPath: '[EPHEMERAL_RECEIPT]',
              model, researchPolicy,
            }),
            executionContext,
            executionContextDigest,
            prompt: executionPrompt,
          },
        }))?.span : null;
        if (signal.aborted || closed || repository.getExecution(executionId)?.status === 'CANCELLED') return;
        assertReviewCurrent(plan, nextStep);
        const result = await executeConfiguredNode({
          executionId,
          workspacePath: executionWorkspace,
          graph,
          plan,
          step: nextStep,
          agent: selectedAgent,
          skills: selectedSkills,
          evidence: selectedEvidence,
          executionContext,
          executionContextDigest,
          model,
          researchPolicy,
          prompt: executionPrompt,
          environment,
          signal,
          timeoutMs: nextStep.budgets?.timeoutMs || nextStep.budget?.timeoutMs,
          onProgress: (progress) => {
            if (repository.getExecution(executionId)?.status === 'CANCELLED') return;
            emit(executionId, 'node.progress', {
              nodeId: nextStep.nodeId,
              stepId: nextStep.id,
              progressType: progress.type,
              message: progress.message,
              ...(progress.exitCode === undefined ? {} : { exitCode: progress.exitCode }),
            });
            if (!executionTrace || !modelSpan) return;
            if (progress.type === 'command.started') {
              activeCommandSpan = observe(() => repository.startTraceSpan({
                traceId: executionTrace.id, parentSpanId: modelSpan.id, executionId, planId: plan.id,
                nodeId: nextStep.nodeId, stepId: nextStep.id, agentId: nextStep.agentId,
                name: 'ege.command',
                category: 'COMMAND', spanKind: 'INTERNAL',
                attributes: { displayName: progress.command?.command || progress.message || 'Command' },
                input: progress.command ?? { message: progress.message },
              }))?.span ?? null;
            } else if (progress.type === 'command.completed') {
              if (activeCommandSpan) observe(() => repository.endTraceSpan(activeCommandSpan.id, {
                status: progress.exitCode === 0 ? 'OK' : 'ERROR', output: progress.command ?? progress,
              }));
              activeCommandSpan = null;
            } else {
              observe(() => repository.appendTraceSpanEvent(modelSpan.id, progress.type, {
                message: progress.message, exitCode: progress.exitCode,
              }));
            }
          },
        });
        if (repository.getExecution(executionId)?.status === 'CANCELLED') return;
        if (activeCommandSpan) observe(() => repository.endTraceSpan(activeCommandSpan.id, {
          status: 'CANCELLED', output: { reason: 'Command completion was not observed.' },
        }));
        activeCommandSpan = null;
        if (modelSpan) observe(() => repository.endTraceSpan(modelSpan.id, {
          status: 'OK',
          output: {
            provider: result.provider, model: result.model, inputDigest: result.inputDigest,
            eventCount: result.eventCount, accepted: result.accepted,
          },
        }));
        const reviewWorkspaceManifest = nextStep.reviewPin?.required && result.accepted ? await captureWorkspaceFileManifest(executionWorkspace, environment) : null;
        const reviewResult = await runNodeReviews({ pin: nextStep.reviewPin, step: nextStep, result, signal,
          compressionMode: plan.plan.contextManifest?.engineeringSettings?.harness?.compression ?? 'lite',
          ...(nodeReviewStream ? { streamImpl: nodeReviewStream } : {}), ...(nodeReviewTimeoutMs ? { timeoutMs: nodeReviewTimeoutMs } : {}),
          assertCurrent: async () => {
            assertReviewCurrent(plan, nextStep);
            if (reviewWorkspaceManifest && (await captureWorkspaceFileManifest(executionWorkspace, environment)).digest !== reviewWorkspaceManifest.digest) throw Object.assign(new Error('Workspace changed while its recorded evidence was being reviewed.'), { code: 'NODE_REVIEW_WORKSPACE_CHANGED' });
          },
          providerOptions: (reviewer) => {
            const profile = repository.getProviderProfile(reviewer.provider.id);
            const connection = providerConnections.connection(reviewer.provider.id, profile);
            if (!profile?.enabled || connection?.status !== 'CONNECTED' || !connection.verified) throw Object.assign(new Error('Connect the configured review provider before continuing.'), { code: 'NODE_REVIEW_PROVIDER_UNAVAILABLE' });
            return { providerId: reviewer.provider.id, profile: { ...profile, model: reviewer.model }, secret: providerConnections.runtimeSecret(reviewer.provider.id), environment, fetchImpl };
          },
          onEvent: ({ type, ...payload }) => { if (repository.getExecution(executionId)?.status !== 'CANCELLED') emit(executionId, type, { nodeId: nextStep.nodeId, stepId: nextStep.id, ...payload }); },
        });
        if (signal.aborted || closed || repository.getExecution(executionId)?.status === 'CANCELLED') return;
        const nodeAccepted = result.accepted && reviewResult.passed;
        const receiptDocument = {
          verificationMode: 'CODEX_CLI',
          result: nodeAccepted ? 'PASS' : 'FAILED',
          executionResult: result.accepted ? 'PASS' : 'FAILED',
          ...(reviewResult.required ? { review: reviewResult } : {}),
          nodeId: nextStep.nodeId,
          planId: execution.planId,
          checkedAt: now(),
          provider: result.provider,
          model: result.model,
          researchPolicy: result.researchPolicy,
          inputDigest: result.inputDigest,
          executionContextDigest,
          changedFiles: result.actualChangedFiles,
          reportedChangedFiles: result.receipt.changedFiles,
          changedFilesMatch: result.changedFilesMatch,
          workspaceBeforeDigest: result.workspaceBeforeDigest,
          workspaceAfterDigest: result.workspaceAfterDigest,
          workspaceEvidence: result.workspaceEvidence ?? null,
          acceptance: result.receipt.acceptance,
          actualVerification: result.actualVerification,
          verificationMatches: result.verificationMatches,
          skippedArtifacts: result.workspaceArtifacts.skipped,
          risks: result.receipt.risks,
        };
        const verifierSpan = executionTrace ? observe(() => repository.startTraceSpan({
          traceId: executionTrace.id, parentSpanId: agentSpan?.id ?? nodeSpan?.id ?? executionTrace.rootSpanId,
          executionId, planId: plan.id, nodeId: nextStep.nodeId, stepId: nextStep.id,
          agentId: nextStep.agentId, name: 'Validate execution receipt',
          category: 'VERIFIER', spanKind: 'INTERNAL',
          input: {
            acceptanceCriteria: nextStep.acceptanceCriteria,
            actualVerification: result.actualVerification,
            changedFiles: result.actualChangedFiles,
          },
        }))?.span : null;
        if (!nodeAccepted) {
          const failed = repository.failNode({
            executionId,
            step: nextStep,
            receiptArtifact: { name: receiptName, mediaType: 'application/json', content: JSON.stringify(receiptDocument, null, 2) },
            receiptDocument,
            message: result.accepted && !reviewResult.passed ? 'Required cross-node review is blocked or unsupported. Dependent tasks were not admitted; inspect the review receipt and create a revised plan.' : result.changedFilesMatch
              ? 'Codex did not satisfy every acceptance criterion with passing command receipts.'
              : 'Codex reported changed files that do not match the workspace manifest.',
          });
          for (const event of failed.events) publish(event);
          if (verifierSpan) observe(() => repository.endTraceSpan(verifierSpan.id, {
            status: 'ERROR', output: receiptDocument,
          }));
          if (agentSpan) observe(() => repository.endTraceSpan(agentSpan.id, {
            status: 'ERROR', output: { result: 'FAILED', receipt: receiptDocument },
          }));
          if (nodeSpan) observe(() => repository.endTraceSpan(nodeSpan.id, {
            status: 'ERROR', output: { result: 'FAILED', receiptArtifactId: failed.artifacts[0]?.id },
          }));
          if (executionTrace && !executionTrace.endedAt) {
            const root = repository.getTraceSpan(executionTrace.rootSpanId);
            if (root && !root.endedAt) observe(() => repository.endTraceSpan(root.id, {
              status: 'ERROR', output: { failedNodeId: nextStep.nodeId, result: 'FAILED' },
            }));
            observe(() => repository.endTrace(executionTrace.id, { status: 'ERROR', attributes: { failedNodeId: nextStep.nodeId } }));
          }
          return;
        }
        const advancedWorkspaceBaseline = await captureWorkspaceBaseline(executionWorkspace, environment);
        const completed = repository.completeNode({
          executionId,
          step: nextStep,
          artifacts: [
            {
              name: safeArtifactName(nextStep.title, nextStep.nodeId),
              mediaType: 'text/markdown',
              content: realExecutionSummary(nextStep, result),
            },
            ...result.workspaceArtifacts.artifacts,
          ],
          receiptArtifact: { name: receiptName, mediaType: 'application/json', content: JSON.stringify(receiptDocument, null, 2) },
          receiptDocument,
          workspaceBaseline: advancedWorkspaceBaseline,
        });
        for (const event of completed.events) publish(event);
        if (verifierSpan) observe(() => repository.endTraceSpan(verifierSpan.id, {
          status: 'OK', output: receiptDocument,
        }));
        for (const artifact of completed.artifacts) {
          const artifactSpan = executionTrace ? observe(() => repository.startTraceSpan({
            traceId: executionTrace.id, parentSpanId: nodeSpan?.id ?? executionTrace.rootSpanId,
            executionId, planId: plan.id, nodeId: nextStep.nodeId, stepId: nextStep.id,
            agentId: nextStep.agentId, name: 'ege.artifact.persist',
            category: 'ARTIFACT', spanKind: 'INTERNAL',
            attributes: { displayName: `Persist artifact ${artifact.name}`, artifactName: artifact.name },
            input: { artifactId: artifact.id, name: artifact.name, mediaType: artifact.mediaType },
          }))?.span : null;
          if (artifactSpan) observe(() => repository.endTraceSpan(artifactSpan.id, {
            status: 'OK', output: { artifactId: artifact.id },
          }));
        }
        if (agentSpan) observe(() => repository.endTraceSpan(agentSpan.id, {
          status: 'OK', output: { result: 'PASS', receipt: receiptDocument },
        }));
        if (nodeSpan) observe(() => repository.endTraceSpan(nodeSpan.id, {
          status: 'OK', output: {
            result: 'PASS', artifactIds: completed.artifacts.map((item) => item.id),
            nextWorkspaceBaseline: advancedWorkspaceBaseline,
          },
        }));
      } catch (error) {
        if (repository.getExecution(executionId)?.status === 'CANCELLED') return;
        const receiptDocument = {
          verificationMode: 'CODEX_CLI',
          result: 'ADAPTER_FAILED',
          nodeId: nextStep.nodeId,
          planId: execution.planId,
          checkedAt: now(),
          code: error.code || 'EXECUTOR_FAILED',
          message: error.message || 'Codex workspace execution failed.',
        };
        const failed = repository.failNode({
          executionId,
          step: nextStep,
          receiptArtifact: { name: receiptName, mediaType: 'application/json', content: JSON.stringify(receiptDocument, null, 2) },
          receiptDocument,
          message: receiptDocument.message,
        });
        for (const event of failed.events) publish(event);
        if (activeCommandSpan) observe(() => repository.endTraceSpan(activeCommandSpan.id, {
          status: 'CANCELLED', output: { reason: receiptDocument.message },
        }));
        if (skillSpan && !repository.getTraceSpan(skillSpan.id)?.endedAt) observe(() => repository.endTraceSpan(skillSpan.id, {
          status: 'ERROR', output: { code: receiptDocument.code, message: receiptDocument.message },
        }));
        if (modelSpan && !repository.getTraceSpan(modelSpan.id)?.endedAt) observe(() => repository.endTraceSpan(modelSpan.id, {
          status: 'ERROR', output: { code: receiptDocument.code, message: receiptDocument.message },
        }));
        if (agentSpan && !repository.getTraceSpan(agentSpan.id)?.endedAt) observe(() => repository.endTraceSpan(agentSpan.id, {
          status: 'ERROR', output: { code: receiptDocument.code, message: receiptDocument.message },
        }));
        if (nodeSpan) observe(() => repository.endTraceSpan(nodeSpan.id, {
          status: 'ERROR', output: { code: receiptDocument.code, message: receiptDocument.message },
        }));
        if (executionTrace && !executionTrace.endedAt) {
          const root = repository.getTraceSpan(executionTrace.rootSpanId);
          if (root && !root.endedAt) observe(() => repository.endTraceSpan(root.id, {
            status: 'ERROR', output: { failedNodeId: nextStep.nodeId, code: receiptDocument.code },
          }));
          observe(() => repository.endTrace(executionTrace.id, { status: 'ERROR', attributes: {
            failedNodeId: nextStep.nodeId, errorCode: receiptDocument.code,
          } }));
        }
        return;
      }
    }
  }

  async function buildPlanInput(graphId, {
    provider, instructions = '', parentPlanId, draft: draftOverride, research = {}, engineeringProfile, conventions = '',
  } = {}) {
    let engineeringOptions;
    try { engineeringOptions = normalizeEngineeringOptions({ engineeringProfile: engineeringProfile ?? 'mvp', conventions }); }
    catch (error) { throw new HttpError(422, error.code || 'VALIDATION_ERROR', error.message); }
    const graph = repository.getGraph(graphId);
    if (!graph) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
    const draft = draftOverride || repository.getLatestDraft(graphId);
    if (!draft.nodes.length) throw new HttpError(422, 'EMPTY_GRAPH', 'Add at least one node before planning.');
    if (typeof provider !== 'string' || !provider.trim()) {
      throw new HttpError(422, 'PLANNING_PROVIDER_REQUIRED', 'Select an available agent runtime.');
    }
    const selectedProvider = planningProviderStatus(provider)
      ?? currentProviders().find((item) => item.id === provider);
    if (!selectedProvider) throw new HttpError(422, 'UNKNOWN_PROVIDER', `Unknown provider “${provider}”.`);
    if (!selectedProvider.available) throw new HttpError(422, 'PROVIDER_UNAVAILABLE', selectedProvider.detail);
    const usesLocalCompiler = provider === 'local-agents';
    if (provider !== 'simulation' && provider !== 'local-agents' && !graph.workspacePath) {
      throw new HttpError(
        422,
        'PLANNING_WORKSPACE_REQUIRED',
        'The selected agent runtime requires an explicitly selected local project folder for this workspace.',
      );
    }
    const binding = graph.workspacePath ? canonicalWorkspaceBinding(graph.workspacePath) : null;
    let researchPolicy;
    try {
      researchPolicy = createResearchPolicy(research, provider);
    } catch (error) {
      throw new HttpError(422, error.code || 'INVALID_RESEARCH_POLICY', error.message);
    }
    if (researchPolicy.enabled && !(selectedProvider.capabilities ?? []).includes(LIVE_WEB_RESEARCH_CAPABILITY)) {
      throw new HttpError(
        422,
        'RESEARCH_CAPABILITY_UNAVAILABLE',
        'This Codex CLI installation does not expose the verified live web-search capability.',
      );
    }
    const traceContext = beginTrace({
      graphId,
      kind: 'PLAN',
      name: `Plan ${graph.name}`,
      provider,
      model: selectedProvider.profile?.model ?? null,
      attributes: {
        draftRevision: draft.revision,
        localAgentPlanner: usesLocalCompiler,
        configuredRuntime: provider !== 'simulation' ? provider : null,
      },
      input: {
        graph: { id: graph.id, name: graph.name, description: graph.description },
        draftRevision: draft.revision,
        instructions,
        researchPolicy,
        workspaceBinding: binding,
      },
    });
    try {
      let previousPlan, evidenceSummaries, evidenceManifest, engineering, engineeringDigest, agentCatalog;
      let proposedGraph, profilePin, plannerPin, generated, finalInput, settingsPin;
      await runEngineeringPlanningStages({
        capture_context: async () => {
          settingsPin = engineeringSettings.get();
          assertEnabledSkills(draft.nodes.flatMap((node) => [...(node.skills ?? []), ...(repository.getAgent(node.agentId)?.skillIds ?? [])]));
          await skills.ensureScanned();
          previousPlan = parentPlanId ? repository.getPlan(parentPlanId) : repository.latestPlan(graphId);
          if (parentPlanId && !previousPlan) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Parent plan was not found.');
          if (parentPlanId && previousPlan.graphId !== graphId) {
            throw new HttpError(409, 'PLAN_GRAPH_MISMATCH', 'Parent plan belongs to another workspace.');
          }
          ({ evidenceSummaries, evidenceManifest } = buildEvidenceContext(repository, graphId));
          const environmentSnapshot = engineeringProfile && graph.workspacePath
            ? await engineeringEnvironment.inspect(graph.workspacePath) : null;
          const recalled = await memory.recall({ graphId, nodeIds: [], query: [graph.name, instructions, ...draft.nodes.map((node) => `${node.title} ${node.description || ''}`)].join('\n').slice(0, 8_000), maxChars: 6_000 });
          const retainedMemory = recalled.items.filter((item) => (item.provenance?.nodes ?? []).every((pin) => {
            const candidate = draft.nodes.find((node) => node.id === pin.id);
            return candidate && nodeMemoryDigest(candidate) === pin.sha256;
          }));
          const excludedMemory = recalled.items.length - retainedMemory.length;
          engineering = {
            profile: engineeringOptions.engineeringProfile, conventions: engineeringOptions.conventions,
            environment: environmentSnapshot,
            acceptedContext: { source: 'current-graph-draft', revision: draft.revision, detail: 'Applied graph changes are included in the draft; unapplied chat suggestions are not accepted decisions.' },
            memory: { digest: createContentDigest(retainedMemory.map((item) => [item.id, item.digest])),
              context: retainedMemory.map((item) => JSON.stringify({ id: item.id, kind: item.kind, content: item.content, validation: item.validation.state, digest: item.digest })).join('\n'),
              records: retainedMemory.map((item) => ({ id: item.id, digest: item.digest })),
              includedCount: retainedMemory.length, omittedCount: recalled.omittedCount + excludedMemory, truncated: recalled.truncated || excludedMemory > 0, boundary: recalled.boundary },
          };
          engineeringDigest = createContentDigest({ profile: engineering.profile, conventions: engineering.conventions, memory: engineering.memory.records,
            tools: environmentSnapshot?.tools.map((tool) => ({ id: tool.id, available: tool.available, version: tool.version })) ?? null });
          agentCatalog = compilerAgentCatalog();
        },
        propose_plan: async () => {
          if (provider === 'simulation' || usesLocalCompiler) {
            traceContext?.observer.startSpan('intent-compiler', {
              name: usesLocalCompiler ? 'Compile context-aware local agent graph' : 'Compile deterministic simulation graph',
              category: 'PLANNER', spanKind: 'INTERNAL',
              input: { draft, evidenceSummaries, agentCount: agentCatalog.length },
            });
            proposedGraph = compileIntentMap({
              intentMap: {
                nodes: draft.nodes,
                relationships: draft.edges.map((edge) => ({
                  id: edge.id,
                  type: edge.type ?? 'REQUIRES',
                  from: edge.source,
                  to: edge.target,
                })),
              },
              evidenceSummaries,
              agentCatalog,
            });
            traceContext?.observer.endSpan('intent-compiler', { status: 'OK', output: proposedGraph });
          }
          profilePin = providerProfilePin(selectedProvider.profile, provider);
          plannerPin = plannerProviderPin(selectedProvider.profile, provider);
          generated = await createPlanContent({
            provider,
            graph,
            draft,
            previousPlan,
            skillCatalog: skills,
            instructions: [instructions, compressionGuidance(settingsPin.harness.compression)].filter(Boolean).join('\n\n'),
            engineeringContext: engineering,
            proposedGraph,
            evidenceManifest,
            evidenceSummaries,
            agentCatalog,
            providerProfile: profilePin,
            environment,
            runtimeSecret: providerConnections.runtimeSecret(provider),
            fetchImpl,
            researchPolicy,
            traceObserver: traceContext?.observer,
          });
        },
        validate_plan: async () => {
          if (engineeringSettings.get().revision !== settingsPin.revision) throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'Engineering settings changed during planning. Plan again.');
          proposedGraph = generated.proposedGraph;
          const agentPins = selectedAgentPins(proposedGraph);
          const pinnedAgents = new Map(agentPins.map((agent) => [agent.id, agent]));
          const nodeProviderProfiles = [...new Set(generated.plan.steps.map((step) => step.providerId).filter(Boolean))].map((id) => {
            const profile = repository.getProviderProfile(id);
            if (!profile) throw new HttpError(422, 'UNKNOWN_PROVIDER', `Node execution provider ${id} is unknown.`);
            return providerProfilePin(profile, id);
          });
          const plan = {
            ...generated.plan,
            proposedGraph,
            steps: generated.plan.steps.map((step) => {
              assertEnabledSkills([...(step.skills ?? []).map((skill) => skill.id), ...(repository.getAgent(step.agentId)?.skillIds ?? [])]);
              const reviewPin = pinNodeReview({ step, draft, steps: generated.plan.steps, agents: repository.listAgents(), defaultProviderId: provider,
                getProviderPin: (id) => {
                  const profile = repository.getProviderProfile(id);
                  const connection = providerConnections.connection(id, profile);
                  if (connection?.status !== 'CONNECTED' || !connection.verified) throw new HttpError(422, 'NODE_REVIEW_PROVIDER_UNAVAILABLE', 'Connect the configured API/Ollama review provider before planning.');
                  return providerProfilePin(profile, id);
                } });
              for (const reviewer of reviewPin?.reviewers ?? []) assertEnabledSkills(repository.getAgent(reviewer.agentId)?.skillIds ?? []);
              const evidenceIds = new Set(step.traceability?.evidenceIds ?? []);
              const sourcePins = evidenceManifest.sources.filter((source) => evidenceIds.has(source.id));
              return {
                ...step,
                ...(reviewPin ? { reviewPin } : {}),
                inputDigest: createContentDigest({
                  plannerInputDigest: step.inputDigest ?? null,
                  agent: pinnedAgents.get(step.agentId) ?? null,
                  sources: sourcePins,
                  providerProfile: profilePin,
                  nodeProviderProfile: nodeProviderProfiles.find((profile) => profile.id === step.providerId) ?? null,
                  researchPolicy,
                  engineeringDigest,
                  reviewPin,
                  engineeringSettingsRevision: settingsPin.revision,
                }),
              };
            }),
            contextManifest: {
              ...(generated.plan.contextManifest ?? {}),
              evidenceManifest,
              selectedAgents: agentPins,
              providerProfile: profilePin,
              nodeProviderProfiles,
              plannerProvider: plannerPin,
              researchPolicy,
              engineering,
              engineeringSettings: settingsPin,
              planningOrchestration: { engine: 'langgraph', version: 'engineering-request-plan/1', stages: [...ENGINEERING_PLAN_STAGES], modelCallPolicy: usesLocalCompiler || provider === 'simulation' ? 'deterministic-no-model' : 'one-configured-planner-request', persistence: 'atomic-plan-awaiting-review', restartResume: false },
              workspaceBinding: binding,
              proposalGenerator: {
                kind: usesLocalCompiler
                  ? 'local-agent-parser'
                  : provider === 'simulation' ? 'deterministic-simulation' : 'configured-ai-provider',
                provider,
                model: profilePin?.model ?? null,
                proposalId: proposedGraph.proposalId,
                contentDigest: proposedGraph.contentDigest,
                selectedDomains: proposedGraph.selectedDomains,
              },
            },
          };
          const evidenceChanged = previousPlan
            && previousPlan.plan.contextManifest?.evidenceManifest?.digest !== evidenceManifest.digest;
          const providerChanged = previousPlan
            && !samePlannerProviderPin(previousPlan.plan.contextManifest?.plannerProvider ?? null, plannerPin);
          const researchChanged = previousPlan
            && JSON.stringify(previousPlan.plan.contextManifest?.researchPolicy ?? null) !== JSON.stringify(researchPolicy);
          const diff = evidenceChanged || providerChanged || researchChanged
            ? {
                ...generated.diff,
                changedNodeIds: [...new Set([...(generated.diff.changedNodeIds ?? []), ...plan.steps.map((step) => step.nodeId)])],
                summary: `${generated.diff.summary} Planning evidence, provider, or research policy context changed.`,
              }
            : generated.diff;
          const result = {
            graphId,
            baseDraftRevision: draft.revision,
            parentPlanId: previousPlan?.id ?? null,
            provider,
            instructions,
            ...generated,
            plan,
            diff,
            contentHash: createContentDigest({ draftRevision: draft.revision, plan }),
            traceId: traceContext?.traceId ?? null,
          };
          if (traceContext) planningTraces.set(traceContext.traceId, {
            context: traceContext,
            output: {
            summary: plan.summary,
            proposedNodeCount: plan.steps.length,
            proposedEdgeCount: plan.proposedEdges.length,
            contentHash: result.contentHash,
            },
          });
          finalInput = result;        },
      }, traceContext?.observer);
      return finalInput;
    } catch (error) {
      if (provider === 'simulation' || usesLocalCompiler) {
        traceContext?.observer.endSpan('intent-compiler', {
          status: 'ERROR', output: { code: error.code, message: error.message },
        });
      }
      finishTrace(traceContext, 'ERROR', { code: error.code, message: error.message });
      if (error instanceof HttpError) throw error;
      if (error.code?.startsWith('NODE_REVIEW_')) throw new HttpError(error.status || 422, error.code, error.message);
      if (error instanceof IntentCompilerError) {
        throw new HttpError(422, error.code, error.message, error.details);
      }
      if (error.code === 'PROVIDER_NOT_ENABLED') {
        throw new HttpError(422, error.code, error.message);
      }
      if (error.code === 'SKILL_TOO_LARGE') throw new HttpError(422, error.code, error.message);
      if (error.code === 'SKILL_CHANGED') throw new HttpError(409, 'PLAN_CONTEXT_STALE', error.message, { reason: 'SKILL_CHANGED' });
      throw new HttpError(502, 'PLANNER_FAILED', error.message || 'Planner failed.');
    }
  }

  async function createPlan(graphId, options = {}) {
    const input = await buildPlanInput(graphId, options);
    return persistPlannedInput(input, () => repository.createPlan(input));
  }

  function persistPlannedInput(planInput, persist) {
    const pending = planInput.traceId ? planningTraces.get(planInput.traceId) : null;
    pending?.context.observer.startSpan('persist-plan', {
      name: 'Persist immutable plan version', category: 'CHECKPOINT', spanKind: 'INTERNAL',
      input: { graphId: planInput.graphId, baseDraftRevision: planInput.baseDraftRevision, contentHash: planInput.contentHash },
    });
    try {
      const result = persist();
      const plan = result?.plan ?? result;
      if (pending && plan?.id) observe(() => repository.linkTrace({ traceId: pending.context.traceId, planId: plan.id }));
      pending?.context.observer.endSpan('persist-plan', {
        status: 'OK', output: { planId: plan?.id, version: plan?.version, status: plan?.status },
      });
      if (pending) finishTrace(pending.context, 'OK', { ...pending.output, planId: plan?.id, version: plan?.version });
      return result;
    } catch (error) {
      pending?.context.observer.endSpan('persist-plan', {
        status: 'ERROR', output: { code: error.code, message: error.message },
      });
      if (pending) finishTrace(pending.context, 'ERROR', { code: error.code, message: error.message });
      throw error;
    } finally {
      if (planInput.traceId) planningTraces.delete(planInput.traceId);
    }
  }

  async function ensurePlanContextFresh(plan) {
    assertExecutionSettings(plan);
    for (const step of plan.plan.steps ?? []) {
      try { assertReviewCurrent(plan, step); } catch (error) { throw new HttpError(409, error.code || 'PLAN_CONTEXT_STALE', error.message); }
    }
    for (const pin of plan.plan.contextManifest?.engineering?.memory?.records ?? []) {
      let current;
      try { current = memory.get(plan.graphId, pin.id); } catch { /* Missing or cross-graph record is stale. */ }
      if (!current?.current || current.digest !== pin.digest) throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'A user-reviewed memory record used by this plan changed. Replan before continuing.', { reason: 'MEMORY_CHANGED', memoryId: pin.id });
    }
    for (const pin of plan.plan.contextManifest?.nodeProviderProfiles ?? []) {
      const current = providerProfilePin(repository.getProviderProfile(pin.id), pin.id);
      if (JSON.stringify(current) !== JSON.stringify(pin)) throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'A configured node provider changed. Replan before execution.', { reason: 'NODE_PROVIDER_CHANGED', providerId: pin.id });
    }
    await skills.scan();
    const pinned = plan.plan.contextManifest?.selectedSkills ?? [];
    for (const binding of pinned) {
      const current = skills.resolveMetadata([binding.id])[0];
      if (!current || !current.valid || current.enabled === false || current.archived || current.contentDigest !== binding.digest || current.packageDigest !== binding.packageDigest) {
        throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The automatically routed agent capability catalog changed after this plan was created. Replan before approval or execution.', {
          reason: 'AGENT_CAPABILITY_CATALOG_CHANGED',
          capabilityId: binding.id,
        });
      }
    }
    const pinnedEvidence = plan.plan.contextManifest?.evidenceManifest;
    if (pinnedEvidence) {
      const currentEvidence = buildEvidenceContext(repository, plan.graphId).evidenceManifest;
      if (currentEvidence.digest !== pinnedEvidence.digest) {
        throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'Graph source evidence changed after this plan was created. Replan before approval or execution.', {
          reason: 'SOURCE_CHANGED',
          expectedDigest: pinnedEvidence.digest,
          currentDigest: currentEvidence.digest,
        });
      }
    }
    const pinnedProvider = plan.plan.contextManifest?.plannerProvider;
    if (pinnedProvider) {
      const currentProfile = repository.getProviderProfile(pinnedProvider.id);
      const currentPin = currentProfile ? plannerProviderPin(currentProfile, pinnedProvider.id) : null;
      if (!currentProfile || !samePlannerProviderPin(currentPin, pinnedProvider)) {
        throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The planner provider profile changed after this plan was created. Replan before approval or execution.', {
          reason: 'PROVIDER_CHANGED',
          providerId: pinnedProvider.id,
        });
      }
    }
    let researchPolicy;
    try {
      researchPolicy = validateResearchPolicy(plan.plan.contextManifest?.researchPolicy, plan.provider);
    } catch (error) {
      throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The pinned research policy is invalid. Replan before approval or execution.', {
        reason: error.code || 'INVALID_RESEARCH_POLICY',
      });
    }
    if (researchPolicy.enabled) {
      const currentProvider = currentProviders({ forceCli: true }).find((item) => item.id === researchPolicy.provider);
      if (!currentProvider?.available || !(currentProvider.capabilities ?? []).includes(LIVE_WEB_RESEARCH_CAPABILITY)) {
        throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The pinned live web-research capability is no longer available. Replan before approval or execution.', {
          reason: 'RESEARCH_CAPABILITY_CHANGED',
          providerId: researchPolicy.provider,
        });
      }
    }
    const pinnedWorkspace = plan.plan.contextManifest?.workspaceBaseline;
    const pinnedBinding = plan.plan.contextManifest?.workspaceBinding ?? null;
    if (plan.provider !== 'simulation' && plan.provider !== 'local-agents' && !pinnedBinding) {
      throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The live plan has no immutable workspace binding. Create a new plan.', {
        reason: 'WORKSPACE_BINDING_MISSING',
      });
    }
    if (pinnedBinding) {
      const graph = repository.getGraph(plan.graphId);
      let currentBinding;
      try {
        currentBinding = canonicalWorkspaceBinding(graph?.workspacePath);
      } catch (error) {
        throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The workspace binding can no longer be verified. Replan before approval or execution.', {
          reason: 'WORKSPACE_BINDING_UNVERIFIED',
        });
      }
      if (!currentBinding || currentBinding.digest !== pinnedBinding.digest
        || currentBinding.canonicalPath !== pinnedBinding.canonicalPath) {
        throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The selected local project changed after this plan was created. Replan before approval or execution.', {
          reason: 'WORKSPACE_BINDING_CHANGED',
        });
      }
    }
    if (pinnedWorkspace && !['unbound', 'local-context'].includes(pinnedWorkspace.kind)) {
      let currentWorkspace;
      try {
        currentWorkspace = await captureWorkspaceBaseline(pinnedBinding.canonicalPath, environment);
      } catch (error) {
        throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The workspace baseline can no longer be verified. Replan before approval or execution.', {
          reason: 'WORKSPACE_BASELINE_UNVERIFIED',
          baselineError: error.code ?? 'WORKSPACE_BASELINE_FAILED',
        });
      }
      if (JSON.stringify(currentWorkspace) !== JSON.stringify(pinnedWorkspace)) {
        throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'The workspace changed after this plan was created. Replan before approval or execution.', {
          reason: 'WORKSPACE_CHANGED',
        });
      }
    }
    for (const binding of plan.plan.contextManifest?.selectedAgents ?? []) {
      if (binding.assignment === 'builtin-fallback') continue;
      const current = repository.getAgent(binding.id);
      const currentDigest = current?.currentPrompt?.digest ? `sha256:${current.currentPrompt.digest}` : null;
      if (!current || current.status !== 'ACTIVE' || currentDigest !== binding.promptDigest
        || (binding.configDigest ?? null) !== (current.configDigest ?? null)
        || (binding.policyDigest ?? null) !== (current.toolPolicy?.contentDigest ?? null)) {
        throw new HttpError(409, 'PLAN_CONTEXT_STALE', 'A selected agent prompt or policy changed after this plan was created. Replan before approval or execution.', {
          reason: 'AGENT_PROMPT_CHANGED',
          agentId: binding.id,
        });
      }
    }
    const latestDraft = repository.getLatestDraft(plan.graphId);
    if (!latestDraft || latestDraft.revision !== plan.baseDraftRevision) {
      throw new HttpError(409, 'PLAN_DRAFT_STALE', 'The graph draft changed after this plan was created. Generate and approve a new plan.', {
        planDraftRevision: plan.baseDraftRevision,
        latestDraftRevision: latestDraft?.revision ?? null,
      });
    }
  }

  function corsHeaders(request) {
    const origin = request.headers.origin;
    if (!origin) return {};
    const sameOrigin = request.headers.host ? `http://${request.headers.host}` : '';
    if (!browserOrigins.has(origin) && origin !== sameOrigin) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      Vary: 'Origin',
    };
  }

  function enforceBrowserBoundary(request) {
    const hostname = hostNameFromHeader(request.headers.host);
    if (!hostname || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
      throw new HttpError(403, 'HOST_REJECTED', 'Only loopback Host headers are accepted.');
    }
    const origin = request.headers.origin;
    if (origin) {
      const sameOrigin = `http://${request.headers.host}`;
      const allowed = new Set([...browserOrigins, sameOrigin]);
      if (!allowed.has(origin)) {
        throw new HttpError(403, 'ORIGIN_REJECTED', 'Browser Origin is not allowed.');
      }
    }
    if (MUTATING_METHODS.has(request.method)) {
      if (!origin) throw new HttpError(403, 'ORIGIN_REQUIRED', 'Mutating browser requests require an allowed Origin.');
    }
  }

  async function route(request, response) {
    enforceBrowserBoundary(request);
    const pathSegments = decodedRequestPathSegments(request.url);
    const requestUrl = new URL(request.url, `http://${request.headers.host}`);
    const path = requestUrl.pathname;
    const method = request.method;
    const cors = corsHeaders(request);

    if (method === 'OPTIONS') {
      return empty(response, 204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Content-Disposition, X-EGE-Filename, X-EGE-Node-Id, Last-Event-ID',
        'Access-Control-Max-Age': '600',
      });
    }

    if (method === 'GET' && path === '/api/health') {
      try {
        repository.database.prepare('SELECT 1 AS ready').get();
        const { engine, mode, version, vector } = repository.storageInfo ?? {};
        return json(response, 200, { status: 'ok', bind: host, storage: 'postgresql', auth: 'none', database: { engine, mode, version, vector } }, cors);
      } catch {
        return json(response, 503, { status: 'unavailable', storage: 'postgresql', error: { code: 'DATABASE_UNAVAILABLE', message: 'The local PostgreSQL store is unavailable.' } }, cors);
      }
    }
    if (method === 'GET' && path === '/api/session') {
      return json(response, 200, { auth: 'none', sessionToken: null }, cors);
    }
    if (await settingsRoutes.handle({ request, response, path, method, cors })) return;
    if (await catalogRoutes.handle({ request, response, path, method, cors })) return;
    if (await chatRoutes.handle({ request, response, path, method, cors })) return;
    if (await terminalRoutes.handle({ request, response, path, method, cors })) return;
    if (await engineeringProposalRoutes.handle({ request, response, path, method, cors })) return;
    if (await memoryRoutes.handle({ request, response, path, method, cors })) return;
    const environmentMatch = path.match(/^\/api\/graphs\/([^/]+)\/environment$/);
    if (environmentMatch && method === 'GET') {
      const graph = repository.getGraph(decodeURIComponent(environmentMatch[1]));
      if (!graph) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
      try {
        const inspected = await engineeringEnvironment.inspect(graph.workspacePath, { refresh: requestUrl.searchParams.get('refresh') === '1' });
        const executor = currentProviders().find((provider) => provider.id === 'codex-cli');
        const executionEnabled = Boolean(executor?.capabilities?.includes('execute'));
        return json(response, 200, { environment: { ...inspected, execution: { providerId: 'codex-cli', ready: executionEnabled,
          detail: executionEnabled ? 'The Codex CLI workspace-write adapter is enabled. Execution still requires a current approved plan, its bound workspace, and the tools required by each node; environment checks do not prove a build or test will pass.' : executor?.detail || 'Codex workspace execution is not configured.',
          setupOptions: executionEnabled ? [] : ['Install and authenticate Codex CLI, enable its provider profile, and start this server with EGE_ENABLE_WORKSPACE_WRITE=1. A current approved plan and bound workspace are still required.'] } } }, cors);
      } catch (error) { throw new HttpError(error.status || 422, error.code || 'ENVIRONMENT_INSPECTION_FAILED', error.message); }
    }

    if (method === 'GET' && path === '/api/skills') {
      return json(response, 200, await skills.list(), cors);
    }
    if (method === 'GET' && path === '/api/providers') {
      return json(response, 200, { items: currentProviders({ forceCli: requestUrl.searchParams.get('refresh') === '1' }) }, cors);
    }
    if (method === 'POST' && path === '/api/provider-connections/discover') {
      const body = await readJson(request);
      const providerId = requiredString(body.providerId, 'providerId', 100);
      const profile = repository.getProviderProfile(providerId);
      if (!profile) throw new HttpError(404, 'PROVIDER_NOT_FOUND', 'Provider profile was not found.');
      try {
        const result = await providerConnections.discover(body, profile);
        return json(response, 200, result, cors);
      } catch (error) {
        throw asProviderConnectionHttpError(error);
      }
    }
    if (method === 'POST' && path === '/api/provider-connections/connect') {
      const body = await readJson(request);
      const providerId = requiredString(body.providerId, 'providerId', 100);
      const existing = repository.getProviderProfile(providerId);
      if (!existing) throw new HttpError(404, 'PROVIDER_NOT_FOUND', 'Provider profile was not found.');
      try {
        return json(response, 200, await connectAndPersist(providerId, body, existing), cors);
      } catch (error) {
        throw asProviderConnectionHttpError(error);
      }
    }
    if (method === 'POST' && path === '/api/provider-connections/autodetect') {
      return json(response, 200, await autodetectProviders(await readJson(request).catch(() => ({}))), cors);
    }
    const providerModelsMatch = path.match(/^\/api\/provider-connections\/([^/]+)\/models$/);
    if (providerModelsMatch && method === 'GET') {
      const providerId = decodeURIComponent(providerModelsMatch[1]);
      const profile = repository.getProviderProfile(providerId);
      if (!profile) throw new HttpError(404, 'PROVIDER_NOT_FOUND', 'Provider profile was not found.');
      try {
        return json(response, 200, await providerConnections.listModels(providerId, profile), cors);
      } catch (error) {
        throw asProviderConnectionHttpError(error);
      }
    }
    const providerConnectionMatch = path.match(/^\/api\/provider-connections\/([^/]+)$/);
    if (providerConnectionMatch && method === 'DELETE') {
      const providerId = decodeURIComponent(providerConnectionMatch[1]);
      const existing = repository.getProviderProfile(providerId);
      if (!existing) throw new HttpError(404, 'PROVIDER_NOT_FOUND', 'Provider profile was not found.');
      try {
        const result = providerConnections.disconnect(providerId, existing);
        const profile = existing.enabled
          ? repository.upsertProviderProfile({ ...existing, enabled: false, options: existing.options })
          : existing;
        return json(response, 200, {
          ...result,
          connection: providerConnections.connection(providerId, profile),
          provider: currentProviders().find((item) => item.id === providerId),
        }, cors);
      } catch (error) {
        throw asProviderConnectionHttpError(error);
      }
    }
    if (method === 'GET' && path === '/api/agents') {
      return json(response, 200, { domains: ENGINEERING_DOMAINS, items: repository.listAgents() }, cors);
    }
    if (method === 'POST' && path === '/api/agents') {
      const body = await readJson(request);
      const slug = requiredString(body.slug, 'slug', 64).toLowerCase();
      if (!/^[a-z][a-z0-9-]{2,63}$/.test(slug)) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'slug must be a lowercase kebab-case identifier.', { field: 'slug' });
      }
      const domain = requiredString(body.domain, 'domain', 100);
      if (!ENGINEERING_DOMAINS.some((item) => item.id === domain)) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'domain must reference one of the seven engineering domains.', { field: 'domain' });
      }
      const promptRevision = createPromptRevision({ agentId: slug, text: requiredString(body.prompt, 'prompt', 20_000) });
      const capabilities = Array.isArray(body.capabilities) ? [...new Set(body.capabilities.map((value) => requiredString(value, 'capabilities[]', 120)))] : [];
      const allowedToolClasses = Array.isArray(body.allowedToolClasses)
        ? [...new Set(body.allowedToolClasses.map((value) => requiredString(value, 'allowedToolClasses[]', 120)))]
        : [];
      const policyCore = {
        id: `${slug}-policy`, agentId: slug, version: 1,
        authority: 'proposal-or-bounded-execution',
        allowedCapabilities: capabilities,
        allowedToolClasses,
        deniedCapabilities: ['approval.self-grant', 'policy.modify', 'receipt.fabricate', 'secret.read-raw', 'workspace.write-unscoped'],
      };
      try {
        const agent = repository.createAgent({
          id: slug,
          slug,
          name: requiredString(body.name, 'name', 200),
          domain,
          description: requiredString(body.description, 'description', 2_000),
          capabilities,
          toolPolicy: { ...policyCore, contentDigest: createContentDigest(policyCore) },
          prompt: promptRevision.text,
          promptDigest: promptRevision.contentDigest,
        });
        return json(response, 201, { agent }, cors);
      } catch (error) {
        if (String(error.message).includes('UNIQUE constraint failed')) {
          throw new HttpError(409, 'AGENT_EXISTS', 'An agent with this slug already exists.');
        }
        throw error;
      }
    }
    let match = path.match(/^\/api\/agents\/([^/]+)$/);
    if (match && method === 'GET') {
      const agent = repository.getAgent(decodeURIComponent(match[1]));
      if (!agent) throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent was not found.');
      return json(response, 200, { agent, promptRevisions: repository.listAgentPrompts(agent.id) }, cors);
    }
    match = path.match(/^\/api\/agents\/([^/]+)\/prompts$/);
    if (match && method === 'POST') {
      const agentId = decodeURIComponent(match[1]);
      const agent = repository.getAgent(agentId);
      if (!agent) throw new HttpError(404, 'AGENT_NOT_FOUND', 'Agent was not found.');
      const body = await readJson(request);
      const current = agent.currentPrompt;
      const expectedDigest = requiredHash(body.expectedDigest, 'expectedDigest');
      let revision;
      try {
        revision = revisePrompt({
          agentId,
          version: current.version,
          parentDigest: current.parentDigest,
          text: current.prompt,
          contentDigest: current.digest,
        }, requiredString(body.prompt, 'prompt', 20_000));
      } catch (error) {
        if (error.code === 'INVALID_AGENT_PROMPT') {
          throw new HttpError(422, error.code, error.message, { errors: error.errors });
        }
        throw error;
      }
      try {
        const prompt = repository.createAgentPromptRevision(agentId, {
          prompt: revision.text,
          outputSchema: current.outputSchema,
          digest: revision.contentDigest,
          expectedCurrentDigest: expectedDigest,
        });
        return json(response, 201, { agent: repository.getAgent(agentId), prompt }, cors);
      } catch (error) {
        if (error.code === 'PROMPT_CHANGED') throw new HttpError(409, error.code, error.message);
        throw error;
      }
    }

    match = path.match(/^\/api\/provider-profiles\/([^/]+)$/);
    if (match && method === 'PUT') {
      const providerId = decodeURIComponent(match[1]);
      const existing = repository.getProviderProfile(providerId);
      if (!existing) throw new HttpError(404, 'PROVIDER_NOT_FOUND', 'Provider profile was not found.');
      const body = await readJson(request);
      const { secretEnvName: declaredSecretEnvName, ...nonSecretSettings } = body;
      if (containsSecretLikeKey(nonSecretSettings)) {
        throw new HttpError(422, 'SECRET_VALUE_REJECTED', 'Provider settings accept secret environment-variable names, never secret values.');
      }
      const secretEnvName = body.secretEnvName === undefined
        ? existing.secretEnvName
        : optionalString(declaredSecretEnvName, 'secretEnvName', 120);
      if (secretEnvName && !/^[A-Z][A-Z0-9_]{1,119}$/.test(secretEnvName)) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'secretEnvName must be an uppercase environment-variable name.', { field: 'secretEnvName' });
      }
      const canonicalSecretName = canonicalSecretEnvName(providerId);
      if (canonicalSecretName && secretEnvName !== canonicalSecretName) {
        throw new HttpError(422, 'VALIDATION_ERROR', `${providerId} may reference only ${canonicalSecretName}.`, { field: 'secretEnvName' });
      }
      if (!canonicalSecretName && secretEnvName) {
        throw new HttpError(422, 'VALIDATION_ERROR', `${providerId} does not accept a secret environment-variable reference.`, { field: 'secretEnvName' });
      }
      const model = body.model === undefined ? existing.model : optionalString(body.model, 'model', 200);
      const baseUrl = body.baseUrl === undefined ? existing.baseUrl : validatedProviderBaseUrl(providerId, body.baseUrl);
      const enabled = body.enabled === undefined ? existing.enabled : requiredBoolean(body.enabled, 'enabled');
      const nextProfile = {
        ...existing,
        model: model || null,
        baseUrl,
        enabled,
        secretEnvName: secretEnvName || null,
        options: existing.options,
      };
      const changed = existing.model !== nextProfile.model || existing.baseUrl !== nextProfile.baseUrl
        || existing.enabled !== nextProfile.enabled || existing.secretEnvName !== nextProfile.secretEnvName;
      const profile = changed ? repository.upsertProviderProfile(nextProfile) : existing;
      if (providerConnections.connection(providerId, profile)
        && (profile.enabled !== true || profile.model !== existing.model || profile.baseUrl !== existing.baseUrl)) {
        try {
          providerConnections.disconnect(providerId, profile);
        } catch (error) {
          if (!(error instanceof ProviderConnectionError) || error.code !== 'PROVIDER_NOT_SUPPORTED') throw error;
        }
      }
      return json(response, 200, {
        profile,
        provider: currentProviders().find((item) => item.id === providerId),
      }, cors);
    }
    if (method === 'GET' && path === '/api/graphs') {
      return json(response, 200, { items: repository.listGraphs() }, cors);
    }
    if (method === 'POST' && path === '/api/graphs') {
      const body = await readJson(request);
      const graph = repository.createGraph({
        name: requiredString(body.name, 'name', 500),
        description: optionalString(body.description ?? '', 'description', 8_000) || '',
        workspacePath: canonicalizeWorkspacePath(optionalString(body.workspacePath, 'workspacePath', 4_096)),
      });
      return json(response, 201, { graph }, cors);
    }

    match = path.match(/^\/api\/graphs\/([^/]+)$/);
    if (match) {
      const graphId = decodeURIComponent(match[1]);
      const graph = repository.getGraph(graphId);
      if (!graph) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
      if (method === 'GET') {
        return json(response, 200, {
          graph,
          draft: repository.getLatestDraft(graphId),
          plans: repository.listPlans(graphId),
          executions: repository.listExecutions(graphId),
        }, cors);
      }
      if (method === 'PATCH') {
        const body = await readJson(request);
        const name = body.name === undefined ? undefined : requiredString(body.name, 'name', 500);
        const description = optionalString(body.description, 'description', 8_000);
        const workspacePath = body.workspacePath === undefined
          ? undefined
          : canonicalizeWorkspacePath(optionalString(body.workspacePath, 'workspacePath', 4_096));
        const workspaceChanged = workspacePath !== undefined && workspacePath !== graph.workspacePath;
        if (workspaceChanged) {
          const active = repository.listExecutions(graphId)
            .some((execution) => ['QUEUED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED'].includes(execution.status));
          if (active) {
            throw new HttpError(
              409,
              'WORKSPACE_REBIND_BLOCKED',
              'Finish or supersede the admitted execution before changing the local project folder.',
            );
          }
          return json(response, 200, repository.rebindGraphWorkspace(graphId, { name, description, workspacePath }), cors);
        }
        return json(response, 200, {
          graph: repository.updateGraph(graphId, { name, description, workspacePath }),
          draft: repository.getLatestDraft(graphId),
          stalePlanIds: [],
          workspaceChanged: false,
        }, cors);
      }
      if (method === 'DELETE') {
        const active = repository.listExecutions(graphId).some((execution) => ['RUNNING', 'PAUSE_REQUESTED'].includes(execution.status));
        if (active) throw new HttpError(409, 'GRAPH_ACTIVE', 'Pause or finish active executions before deleting the graph.');
        repository.deleteGraph(graphId);
        for (const client of traceClients.get(graphId) ?? []) client.response.end();
        traceClients.delete(graphId);
        return empty(response, 204, cors);
      }
    }

    match = path.match(/^\/api\/graphs\/([^/]+)\/draft$/);
    if (match && method === 'PUT') {
      const graphId = decodeURIComponent(match[1]);
      if (!repository.getGraph(graphId)) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
      const draft = repository.saveDraft(graphId, validateDraft(await readJson(request)));
      return json(response, 200, { draft }, cors);
    }

    match = path.match(/^\/api\/graphs\/([^/]+)\/traces$/);
    if (match && method === 'GET') {
      const graphId = decodeURIComponent(match[1]);
      if (!repository.getGraph(graphId)) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
      const requestedLimit = Number(requestUrl.searchParams.get('limit') || 50);
      const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 50, 200));
      const before = decodeTraceCursor(requestUrl.searchParams.get('before'));
      const rows = repository.listGraphTraces(graphId, { before, limit: limit + 1 });
      const items = rows.slice(0, limit);
      return json(response, 200, {
        items,
        page: {
          limit,
          hasMore: rows.length > limit,
          nextBefore: rows.length > limit ? encodeTraceCursor(items.at(-1)) : null,
        },
      }, cors);
    }

    match = path.match(/^\/api\/graphs\/([^/]+)\/traces\/events$/);
    if (match && method === 'GET') {
      const graphId = decodeURIComponent(match[1]);
      if (!repository.getGraph(graphId)) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
      const queryCursor = Number(requestUrl.searchParams.get('after') || 0);
      const headerCursor = Number(request.headers['last-event-id'] || 0);
      const after = Math.max(Number.isFinite(queryCursor) ? queryCursor : 0, Number.isFinite(headerCursor) ? headerCursor : 0);
      response.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write(': connected\n\n');
      const client = { response, lastSequence: after };
      if (!traceClients.has(graphId)) traceClients.set(graphId, new Set());
      traceClients.get(graphId).add(client);
      let replayCursor = after;
      while (true) {
        const page = repository.listGraphTraceEvents(graphId, replayCursor, 2_000);
        for (const event of page) {
          if (event.sequence <= client.lastSequence) continue;
          response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          client.lastSequence = event.sequence;
          replayCursor = event.sequence;
        }
        if (page.length < 2_000) break;
      }
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      request.on('close', () => {
        clearInterval(heartbeat);
        traceClients.get(graphId)?.delete(client);
        if (!traceClients.get(graphId)?.size) traceClients.delete(graphId);
      });
      return;
    }

    match = path.match(/^\/api\/graphs\/([^/]+)\/sources$/);
    if (match && (method === 'GET' || method === 'POST')) {
      const graphId = decodeURIComponent(match[1]);
      const graph = repository.getGraph(graphId);
      if (!graph) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
      if (method === 'GET') {
        const nodeId = requestUrl.searchParams.has('nodeId') ? requestUrl.searchParams.get('nodeId') : undefined;
        return json(response, 200, { items: repository.listSources(graphId, nodeId) }, cors);
      }

      const nodeId = requestUrl.searchParams.get('nodeId') || request.headers['x-ege-node-id'] || null;
      if (nodeId) {
        const draft = repository.getLatestDraft(graphId);
        if (!draft?.nodes.some((node) => node.id === nodeId)) {
          throw new HttpError(422, 'SOURCE_NODE_NOT_FOUND', 'The source nodeId must reference a node in the latest draft.', { nodeId });
        }
      }
      const filename = filenameFromRequest(request, requestUrl);
      const mediaType = mediaTypeFromRequest(request);
      const bytes = await readBytes(request, maxSourceBytes);
      let document;
      try {
        document = await evidence().ingest({ bytes, sourceName: filename, mediaType });
      } catch (error) {
        if (error instanceof EvidenceError) {
          const status = error.code === 'EVIDENCE_SOURCE_TOO_LARGE' ? 413 : 422;
          throw new HttpError(status, error.code, error.message, error.details);
        }
        throw asObjectStoreHttpError(error);
      }
      const source = repository.createSource({
        graphId,
        nodeId,
        filename,
        mediaType,
        byteSize: document.source.object.size,
        sha256: document.source.object.digest,
        objectKey: document.source.object.key,
        parserId: document.parser.id,
        parserVersion: document.parser.revision,
        parseStatus: document.parseStatus.toUpperCase(),
        metadata: {
          evidenceDocumentId: document.id,
          format: document.format,
          ...document.metadata,
          errors: document.errors,
          manifestObject: document.manifestObject,
        },
        chunks: document.chunks.map((chunk) => ({
          ordinal: chunk.ordinal,
          text: chunk.text,
          location: { citations: chunk.citations, characterCount: chunk.characterCount },
          contentSha256: chunk.contentDigest,
          tokenCount: tokenize(chunk.text).length,
        })),
      });
      return json(response, 201, {
        source,
        object: {
          id: document.source.object.id,
          digest: document.source.object.digest,
          size: document.source.object.size,
          deduplicated: document.storage.sourceDeduplicated,
        },
        manifestObject: document.manifestObject,
        chunkCount: document.chunks.length,
        parseStatus: document.parseStatus,
        errors: document.errors,
      }, cors);
    }

    match = path.match(/^\/api\/graphs\/([^/]+)\/retrieve$/);
    if (match && method === 'POST') {
      const graphId = decodeURIComponent(match[1]);
      if (!repository.getGraph(graphId)) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
      const body = await readJson(request);
      const query = requiredString(body.query, 'query', 5_000);
      const limit = body.limit ?? 8;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'limit must be an integer between 1 and 50.', { field: 'limit' });
      }
      return json(response, 200, retrieveGraphEvidence(repository, graphId, query, limit), cors);
    }

    match = path.match(/^\/api\/sources\/([^/]+)\/content$/);
    if (match && method === 'GET') {
      const source = repository.getSource(decodeURIComponent(match[1]));
      if (!source) throw new HttpError(404, 'SOURCE_NOT_FOUND', 'Source was not found.');
      let bytes;
      try {
        bytes = await objects().get(source.sha256, { maxBytes: maxSourceBytes });
      } catch (error) {
        throw asObjectStoreHttpError(error);
      }
      return binary(response, 200, bytes, { mediaType: source.mediaType, filename: source.filename, ...cors });
    }

    match = path.match(/^\/api\/sources\/([^/]+)$/);
    if (match && (method === 'GET' || method === 'DELETE')) {
      const sourceId = decodeURIComponent(match[1]);
      const source = repository.getSource(sourceId);
      if (!source) throw new HttpError(404, 'SOURCE_NOT_FOUND', 'Source was not found.');
      if (method === 'GET') {
        return json(response, 200, { source, chunks: repository.listSourceChunks(sourceId) }, cors);
      }
      repository.deleteSource(sourceId);
      return empty(response, 204, { ...cors, 'X-EGE-Object-Retained': 'content-addressed' });
    }

    match = path.match(/^\/api\/graphs\/([^/]+)\/plans$/);
    if (match && method === 'POST') {
      const body = await readJson(request);
      const plan = await createPlan(decodeURIComponent(match[1]), {
        provider: body.provider,
        instructions: optionalString(body.instructions ?? '', 'instructions', 100_000) || '',
        engineeringProfile: body.engineeringProfile,
        conventions: body.conventions ?? '',
        parentPlanId: optionalString(body.parentPlanId, 'parentPlanId', 256) || undefined,
        research: body.research ?? {},
      });
      return json(response, 201, { plan }, cors);
    }

    match = path.match(/^\/api\/plans\/([^/]+)$/);
    if (match && method === 'GET') {
      const plan = repository.getPlan(decodeURIComponent(match[1]));
      if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Plan was not found.');
      return json(response, 200, { plan, approval: repository.getApprovalForPlan(plan.id) }, cors);
    }

    match = path.match(/^\/api\/plans\/([^/]+)\/approve$/);
    if (match && method === 'POST') {
      const planId = decodeURIComponent(match[1]);
      const plan = repository.getPlan(planId);
      if (!plan) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Plan was not found.');
      if (plan.status === 'SUPERSEDED') throw new HttpError(409, 'PLAN_SUPERSEDED', 'A superseded plan cannot be approved.');
      const body = await readJson(request);
      const expectedContentHash = requiredHash(body.expectedContentHash, 'expectedContentHash');
      await ensurePlanContextFresh(plan);
      if (body.semanticFeedback) {
        throw new HttpError(422, 'REPLAN_REQUIRED', 'Semantic approval feedback must be applied through a new plan version before approval.');
      }
      const rationale = optionalString(body.rationale ?? body.context ?? '', 'rationale', 100_000) || '';
      let result;
      try {
        result = repository.approvePlan(planId, expectedContentHash, rationale);
      } catch (error) {
        throw asAdmissionError(error);
      }
      for (const execution of repository.findExecutionsByPendingPlan(planId)) {
        emit(execution.id, 'plan.approved', { planId, approvalId: result.approval.id, readyToContinue: true });
      }
      return json(response, 200, result, cors);
    }

    match = path.match(/^\/api\/graphs\/([^/]+)\/(?:executions|execute)$/);
    if (match && method === 'POST') {
      const graphId = decodeURIComponent(match[1]);
      const graph = repository.getGraph(graphId);
      if (!graph) throw new HttpError(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
      const body = await readJson(request);
      const plan = repository.getPlan(requiredString(body.planId, 'planId', 200));
      if (!plan || plan.graphId !== graphId) throw new HttpError(404, 'PLAN_NOT_FOUND', 'Approved plan was not found for this graph.');
      if (plan.status !== 'APPROVED') throw new HttpError(409, 'PLAN_NOT_APPROVED', 'Approve the immutable plan before execution.');
      const requestedExecutionProvider = body.provider ?? plan.provider;
      if (requestedExecutionProvider !== plan.provider) {
        throw new HttpError(409, 'EXECUTION_PROVIDER_MISMATCH', 'Execution must use the provider bound into the approved plan.');
      }
      const selectedNodeIds = selectedExecutionNodes(plan, body.nodeIds);
      terminalRoutes.assertGraphIdle(graphId);
      const selectedExecutionProvider = executionProvider(plan, selectedNodeIds);
      const executionWorkspace = selectedExecutionProvider.id === 'codex-cli'
        ? requiredExecutionWorkspace(graph)
        : null;
      const expectedPlanHash = requiredHash(body.expectedPlanHash, 'expectedPlanHash');
      await ensurePlanContextFresh(plan);
      const executionWorkspaceBaseline = executionWorkspace
        ? await captureWorkspaceBaseline(executionWorkspace, environment)
        : undefined;
      let admission;
      try {
        terminalRoutes.assertGraphIdle(graphId);
        admission = repository.createApprovedExecution({
          graphId,
          planId: plan.id,
          expectedContentHash: expectedPlanHash,
          selectedNodeIds,
          startEventPayload: {
            graphId,
            planId: plan.id,
            planVersion: plan.version,
            plannerProvider: plan.provider,
            executionProvider: selectedExecutionProvider.id,
            selectedNodeIds,
          },
          workspaceBaseline: executionWorkspaceBaseline,
        });
      } catch (error) {
        throw asAdmissionError(error);
      }
      let execution = admission.execution;
      for (const event of admission.events) publish(event);
      const executionTrace = beginTrace({
        graphId,
        executionId: execution.id,
        planId: plan.id,
        kind: 'EXECUTION',
        name: `Execute ${graph.name} plan v${plan.version}`,
        provider: selectedExecutionProvider.id,
        model: plan.plan.contextManifest?.plannerProvider?.model ?? null,
        attributes: { planVersion: plan.version, plannerProvider: plan.provider },
        input: {
          graphId,
          executionId: execution.id,
          planId: plan.id,
          planHash: plan.contentHash,
          workspacePath: execution.workspacePath,
          workspaceBindingDigest: execution.workspaceBindingDigest,
          stepCount: execution.selectedNodeIds?.length ?? plan.plan.steps.length,
          selectedNodeIds: execution.selectedNodeIds,
        },
      });
      if (executionTrace) observe(() => repository.linkTrace({ traceId: executionTrace.traceId, executionId: execution.id, planId: plan.id }));
      execution = repository.getExecution(execution.id);
      scheduleExecution(execution.id);
      return json(response, 202, { execution }, cors);
    }

    match = path.match(/^\/api\/executions\/([^/]+)$/);
    if (match && method === 'GET') {
      const execution = repository.getExecution(decodeURIComponent(match[1]));
      if (!execution) throw new HttpError(404, 'EXECUTION_NOT_FOUND', 'Execution was not found.');
      const after = Math.max(0, Number(requestUrl.searchParams.get('after') || 0));
      const requestedLimit = Number(requestUrl.searchParams.get('limit') || 500);
      const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 500, 2_000));
      const eventRows = repository.listEvents(execution.id, after, limit + 1);
      const events = eventRows.slice(0, limit);
      return json(response, 200, {
        execution,
        plan: repository.getPlan(execution.planId),
        trace: repository.getTraceByExecution(execution.id),
        events,
        eventPage: {
          after,
          nextAfter: events.at(-1)?.sequence ?? after,
          hasMore: eventRows.length > limit,
          limit,
        },
        artifacts: repository.listLineageArtifacts(execution.id),
      }, cors);
    }

    match = path.match(/^\/api\/executions\/([^/]+)\/trace$/);
    if (match && method === 'GET') {
      const executionId = decodeURIComponent(match[1]);
      if (!repository.getExecution(executionId)) throw new HttpError(404, 'EXECUTION_NOT_FOUND', 'Execution was not found.');
      const trace = repository.getTraceByExecution(executionId);
      if (!trace) throw new HttpError(404, 'TRACE_NOT_FOUND', 'Execution trace was not found.');
      const after = Math.max(0, Number(requestUrl.searchParams.get('after') || 0));
      const requestedLimit = Number(requestUrl.searchParams.get('limit') || 500);
      const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 500, 2_000));
      const rows = repository.listTraceEvents(trace.id, after, limit + 1);
      const events = rows.slice(0, limit);
      return json(response, 200, {
        trace,
        spans: repository.listTraceSpans(trace.id),
        events,
        eventPage: { after, nextAfter: events.at(-1)?.sequence ?? after, hasMore: rows.length > limit, limit },
      }, cors);
    }

    match = path.match(/^\/api\/traces\/([^/]+)$/);
    if (match && method === 'GET') {
      const traceId = decodeURIComponent(match[1]);
      const trace = repository.getTrace(traceId);
      if (!trace) throw new HttpError(404, 'TRACE_NOT_FOUND', 'Trace was not found.');
      const after = Math.max(0, Number(requestUrl.searchParams.get('after') || 0));
      const requestedLimit = Number(requestUrl.searchParams.get('limit') || 500);
      const limit = Math.max(1, Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 500, 2_000));
      const rows = repository.listTraceEvents(trace.id, after, limit + 1);
      const events = rows.slice(0, limit);
      return json(response, 200, {
        trace,
        spans: repository.listTraceSpans(trace.id),
        events,
        eventPage: { after, nextAfter: events.at(-1)?.sequence ?? after, hasMore: rows.length > limit, limit },
      }, cors);
    }

    match = path.match(/^\/api\/executions\/([^/]+)\/cancel$/);
    if (match && method === 'POST') {
      const executionId = decodeURIComponent(match[1]);
      const current = repository.getExecution(executionId);
      if (!current) throw new HttpError(404, 'EXECUTION_NOT_FOUND', 'Execution was not found.');
      if (!['RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'CANCELLED'].includes(current.status)) throw new HttpError(409, 'EXECUTION_NOT_ACTIVE', 'Only an active execution can be cancelled.');
      const transition = repository.cancelExecution(executionId);
      runnerControllers.get(executionId)?.abort();
      for (const event of transition.events) publish(event);
      const trace = repository.getTraceByExecution(executionId);
      if (trace) {
        for (const span of repository.listTraceSpans(trace.id)) {
          if (!span.endedAt) observe(() => repository.endTraceSpan(span.id, { status: 'CANCELLED', output: { reason: 'Cancelled by user; partial workspace changes may remain.' } }));
        }
        closePersistedTrace(trace, 'CANCELLED', { completedNodeIds: current.completedNodeIds });
      }
      return json(response, 202, { execution: transition.execution, interruptionRequested: Boolean(runnerControllers.has(executionId)) }, cors);
    }

    match = path.match(/^\/api\/executions\/([^/]+)\/pause$/);
    if (match && method === 'POST') {
      const executionId = decodeURIComponent(match[1]);
      let execution = repository.getExecution(executionId);
      if (!execution) throw new HttpError(404, 'EXECUTION_NOT_FOUND', 'Execution was not found.');
      if (!['RUNNING', 'PAUSE_REQUESTED'].includes(execution.status)) {
        throw new HttpError(409, 'EXECUTION_NOT_RUNNING', 'Only a running execution can be paused.');
      }
      const transition = repository.requestPause(executionId);
      execution = transition.execution;
      for (const event of transition.events) publish(event);
      return json(response, 202, { execution }, cors);
    }

    match = path.match(/^\/api\/executions\/([^/]+)\/replan$/);
    if (match && method === 'POST') {
      const executionId = decodeURIComponent(match[1]);
      let execution = repository.getExecution(executionId);
      if (!execution) throw new HttpError(404, 'EXECUTION_NOT_FOUND', 'Execution was not found.');
      if (execution.status !== 'PAUSED') throw new HttpError(409, 'EXECUTION_NOT_PAUSED', 'Wait for a durable PAUSED checkpoint before replanning.');
      const body = await readJson(request);
      const previousPendingPlanId = execution.pendingPlanId;
      const currentDraft = repository.getLatestDraft(execution.graphId);
      const newDraft = body.draft ? validateDraft(body.draft) : null;
      const candidateDraft = newDraft
        ? { ...newDraft, graphId: execution.graphId, revision: currentDraft.revision + 1, createdAt: null }
        : currentDraft;
      const planInput = await buildPlanInput(execution.graphId, {
        provider: body.provider,
        instructions: optionalString(body.instructions ?? '', 'instructions', 100_000) || '',
        engineeringProfile: body.engineeringProfile,
        conventions: body.conventions ?? '',
        research: body.research ?? {},
        parentPlanId: execution.pendingPlanId || execution.planId,
        draft: candidateDraft,
      });
      let plan;
      try {
        const committed = persistPlannedInput(planInput, () => repository.commitReplan({
          executionId,
          expectedPendingPlanId: previousPendingPlanId,
          expectedDraftRevision: currentDraft.revision,
          draft: newDraft,
          planInput,
        }));
        execution = committed.execution;
        plan = committed.plan;
      } catch (error) {
        if (['EXECUTION_CHANGED', 'DRAFT_CHANGED'].includes(error.code)) throw new HttpError(409, error.code, error.message);
        throw error;
      }
      emit(executionId, 'plan.replanned', {
        planId: plan.id, version: plan.version, status: plan.status, diff: plan.diff,
      });
      return json(response, 201, { execution, plan }, cors);
    }

    match = path.match(/^\/api\/executions\/([^/]+)\/resume$/);
    if (match && method === 'POST') {
      const executionId = decodeURIComponent(match[1]);
      let predecessor = repository.getExecution(executionId);
      if (!predecessor) throw new HttpError(404, 'EXECUTION_NOT_FOUND', 'Execution was not found.');
      if (predecessor.status !== 'PAUSED') throw new HttpError(409, 'EXECUTION_NOT_PAUSED', 'Only a paused execution can continue.');
      terminalRoutes.assertGraphIdle(predecessor.graphId);
      const body = await readJson(request);
      const mode = body.mode ?? (predecessor.pendingPlanId ? 'APPROVED_REPLAN' : 'PINNED_PLAN');
      if (!['PINNED_PLAN', 'APPROVED_REPLAN'].includes(mode)) {
        throw new HttpError(422, 'VALIDATION_ERROR', 'resume mode must be PINNED_PLAN or APPROVED_REPLAN.');
      }

      if (mode === 'PINNED_PLAN' || !predecessor.pendingPlanId) {
        executionProvider(repository.getPlan(predecessor.planId), predecessor.selectedNodeIds);
        const transition = repository.resumePinnedExecution(executionId);
        const execution = transition.execution;
        for (const event of transition.events) publish(event);
        scheduleExecution(executionId);
        return json(response, 202, { execution, predecessor: null }, cors);
      }

      const nextPlan = repository.getPlan(predecessor.pendingPlanId);
      if (nextPlan.status !== 'APPROVED') {
        throw new HttpError(409, 'PLAN_NOT_APPROVED', 'Approve the new immutable plan before continuing.');
      }
      const successorSelection = selectedExecutionNodes(nextPlan, body.nodeIds ?? predecessor.selectedNodeIds);
      const successorProvider = executionProvider(nextPlan, successorSelection);
      await ensurePlanContextFresh(nextPlan);
      const previousPlan = repository.getPlan(predecessor.planId);
      const reusableNodeIds = reusableCheckpoints(previousPlan, nextPlan, predecessor.completedNodeIds);
      const resumedFromCheckpoint = {
        predecessorExecutionId: predecessor.id,
        predecessorPlanId: predecessor.planId,
        newPlanId: nextPlan.id,
        predecessorCompletedNodeIds: predecessor.completedNodeIds,
        reusedNodeIds: reusableNodeIds,
      };
      let transition;
      try {
        terminalRoutes.assertGraphIdle(predecessor.graphId);
        transition = repository.supersedeWithSuccessor({
        predecessorId: predecessor.id,
        graphId: predecessor.graphId,
        planId: nextPlan.id,
        rootExecutionId: predecessor.rootExecutionId,
        resumedFromCheckpoint,
        completedNodeIds: reusableNodeIds,
        selectedNodeIds: successorSelection,
        predecessorEvent: {
          type: 'execution.superseded',
          payload: { planId: nextPlan.id },
        },
        successorEvents: [
          {
            type: 'execution.started',
            payload: {
              graphId: predecessor.graphId,
              planId: nextPlan.id,
              planVersion: nextPlan.version,
              plannerProvider: nextPlan.provider,
              executionProvider: successorProvider.id,
              selectedNodeIds: successorSelection,
            },
          },
          { type: 'execution.resumed_from_checkpoint', payload: resumedFromCheckpoint },
        ],
        });
      } catch (error) {
        throw asAdmissionError(error);
      }
      const successor = transition.successor;
      predecessor = transition.predecessor;
      for (const event of transition.events) publish(event);
      const predecessorTrace = repository.getTraceByExecution(predecessor.id);
      if (predecessorTrace && !predecessorTrace.endedAt) {
        const root = repository.getTraceSpan(predecessorTrace.rootSpanId);
        if (root && !root.endedAt) observe(() => repository.endTraceSpan(root.id, {
          status: 'CANCELLED', output: { successorExecutionId: successor.id, reason: 'SUPERSEDED_BY_APPROVED_REPLAN' },
        }));
        observe(() => repository.endTrace(predecessorTrace.id, {
          status: 'CANCELLED', attributes: { successorExecutionId: successor.id },
        }));
      }
      const successorTrace = beginTrace({
        graphId: predecessor.graphId,
        executionId: successor.id,
        planId: nextPlan.id,
        kind: 'EXECUTION',
        name: `Continue plan v${nextPlan.version}`,
        provider: successorProvider.id,
        model: nextPlan.plan.contextManifest?.plannerProvider?.model ?? null,
        attributes: { resumedFromExecutionId: predecessor.id, reusedNodeIds: reusableNodeIds },
        input: { planId: nextPlan.id, workspacePath: successor.workspacePath, resumedFromCheckpoint },
      });
      if (successorTrace) observe(() => repository.linkTrace({
        traceId: successorTrace.traceId, executionId: successor.id, planId: nextPlan.id,
      }));
      scheduleExecution(successor.id);
      return json(response, 202, { execution: successor, predecessor }, cors);
    }

    match = path.match(/^\/api\/executions\/([^/]+)\/events$/);
    if (match && method === 'GET') {
      const executionId = decodeURIComponent(match[1]);
      if (!repository.getExecution(executionId)) throw new HttpError(404, 'EXECUTION_NOT_FOUND', 'Execution was not found.');
      const queryCursor = Number(requestUrl.searchParams.get('after') || 0);
      const headerCursor = Number(request.headers['last-event-id'] || 0);
      const after = Math.max(Number.isFinite(queryCursor) ? queryCursor : 0, Number.isFinite(headerCursor) ? headerCursor : 0);
      response.writeHead(200, {
        ...cors,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      response.write(': connected\n\n');
      const client = { response, lastSequence: after };
      if (!clients.has(executionId)) clients.set(executionId, new Set());
      clients.get(executionId).add(client);
      let replayCursor = after;
      while (true) {
        const page = repository.listEvents(executionId, replayCursor, 2_000);
        for (const event of page) {
          response.write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          client.lastSequence = event.sequence;
          replayCursor = event.sequence;
        }
        if (page.length < 2_000) break;
      }
      const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
      request.on('close', () => {
        clearInterval(heartbeat);
        clients.get(executionId)?.delete(client);
        if (!clients.get(executionId)?.size) clients.delete(executionId);
      });
      return;
    }

    match = path.match(/^\/api\/executions\/([^/]+)\/artifacts$/);
    if (match && method === 'GET') {
      const executionId = decodeURIComponent(match[1]);
      if (!repository.getExecution(executionId)) throw new HttpError(404, 'EXECUTION_NOT_FOUND', 'Execution was not found.');
      const includeLineage = requestUrl.searchParams.get('includeLineage') !== 'false';
      const history = requestUrl.searchParams.get('history') === 'true';
      const items = history
        ? repository.listLineageArtifactHistory(executionId)
        : includeLineage
          ? repository.listLineageArtifacts(executionId)
          : repository.listArtifacts(executionId);
      return json(response, 200, { items }, cors);
    }

    match = path.match(/^\/api\/artifacts\/([^/]+)$/);
    if (match && method === 'GET') {
      const artifact = repository.getArtifact(decodeURIComponent(match[1]));
      if (!artifact) throw new HttpError(404, 'ARTIFACT_NOT_FOUND', 'Artifact was not found.');
      return json(response, 200, { artifact }, cors);
    }

    if (staticAssets && ['GET', 'HEAD'].includes(method) && path !== '/api' && !path.startsWith('/api/')) {
      return serveStaticAsset(request, response, staticAssets, pathSegments);
    }

    throw new HttpError(404, 'ROUTE_NOT_FOUND', 'Route was not found.');
  }

  const server = createServer((request, response) => {
    for (const [name, value] of Object.entries(securityHeaders())) response.setHeader(name, value);
    route(request, response).catch((error) => {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const code = error instanceof HttpError ? error.code : 'INTERNAL_ERROR';
      json(response, status, {
        error: {
          code,
          message: status === 500 ? 'Internal server error.' : error.message,
          ...(error.details ? { details: error.details } : {}),
        },
      }, corsHeaders(request));
    });
  });

  return {
    repository,
    async start() {
      if (closed) throw new Error('A closed local server cannot be restarted.');
      if (server.listening) return server.address();
      await new Promise((resolveStart, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolveStart();
        });
      });
      for (const trace of repository.listRunningTraces()) {
        if (trace.kind === 'PLAN') {
          closePersistedTrace(trace, 'ERROR', {
            code: 'PROCESS_INTERRUPTED', message: 'Planning was interrupted before a durable terminal trace checkpoint.',
          }, { processInterrupted: true, telemetryIncomplete: true });
          continue;
        }
        const execution = trace.executionId ? repository.getExecution(trace.executionId) : null;
        if (!execution || ['FAILED', 'SUPERSEDED', 'COMPLETED', 'CANCELLED'].includes(execution.status)) {
          const status = execution?.status === 'COMPLETED' ? 'OK'
            : ['SUPERSEDED', 'CANCELLED'].includes(execution?.status) ? 'CANCELLED' : 'ERROR';
          closePersistedTrace(trace, status, {
            code: 'PROCESS_INTERRUPTED', executionStatus: execution?.status ?? 'MISSING',
          }, { processInterrupted: true, telemetryIncomplete: true });
        }
      }
      for (const execution of repository.listRecoverableExecutions()) {
        const plan = repository.getPlan(execution.planId);
        if (plan?.provider !== 'simulation' && execution.currentNodeId) {
          const transition = repository.failExecution(
            execution.id,
            'Workspace execution was interrupted before a durable receipt. Inspect the workspace, then create and approve a new plan.',
          );
          for (const event of transition.events) publish(event);
          closePersistedTrace(repository.getTraceByExecution(execution.id), 'ERROR', {
            code: 'PROCESS_INTERRUPTED', message: 'A live workspace node was interrupted before a durable receipt.',
          }, { processInterrupted: true, failedNodeId: execution.currentNodeId });
          continue;
        }
        emit(execution.id, 'execution.recovered', {
          status: execution.status,
          checkpoint: execution.completedNodeIds,
          message: 'Recovered persisted execution after local-server restart.',
        });
        scheduleExecution(execution.id);
      }
      return server.address();
    },
    async close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        for (const controller of runnerControllers.values()) controller.abort();
        for (const clientSet of clients.values()) {
          for (const client of clientSet) client.response.end();
        }
        clients.clear();
        for (const clientSet of traceClients.values()) {
          for (const client of clientSet) client.response.end();
        }
        traceClients.clear();
        await chatRoutes.close?.();
        await terminalRoutes.close();
        if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
        await Promise.allSettled([...runnerPromises.values()]);
        providerConnections.close();
        memory.close();
        repository.close();
      })();
      return closePromise;
    },
    get address() {
      const address = server.address();
      return typeof address === 'object' && address ? `http://${host}:${address.port}` : null;
    },
  };
}
