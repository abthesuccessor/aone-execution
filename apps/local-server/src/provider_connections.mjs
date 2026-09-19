import { randomBytes } from 'node:crypto';
import { inspectCliProvider } from './providers.mjs';
import { LIVE_WEB_RESEARCH_CAPABILITY } from './research_policy.mjs';

const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODELS = 2_000;
const MAX_MODEL_ID_LENGTH = 300;
const DEFAULT_TIMEOUT_MS = 8_000;
const HOSTED_PROVIDERS = new Set(['openai-api', 'anthropic-api']);
const CLI_PROVIDERS = new Set(['codex-cli', 'claude-cli']);
const PROVIDER_KIND = Object.freeze({
  'openai-api': 'hosted',
  'anthropic-api': 'hosted',
  ollama: 'local',
  'codex-cli': 'cli',
  'claude-cli': 'cli',
});

export class ProviderConnectionError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new ProviderConnectionError(status, code, message, details);
}

function opaqueRevision() {
  return randomBytes(16).toString('hex');
}

function requireProviderKind(providerId, kind) {
  if (!Object.hasOwn(PROVIDER_KIND, providerId) || PROVIDER_KIND[providerId] !== kind) {
    fail(422, 'PROVIDER_NOT_SUPPORTED', `Provider ${providerId || '(missing)'} is not supported for ${kind} connection discovery.`);
  }
}

function requireString(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    fail(422, 'VALIDATION_ERROR', `${field} must be a non-empty string no longer than ${maximum} characters.`, { field });
  }
  return value.trim();
}

export function normalizeOllamaBaseUrl(value) {
  const input = requireString(value, 'baseUrl', 2_048);
  let url;
  try {
    url = new URL(input);
  } catch {
    fail(422, 'VALIDATION_ERROR', 'baseUrl must be an absolute URL.', { field: 'baseUrl' });
  }
  const rootPath = url.pathname === '' || url.pathname === '/';
  if (url.protocol !== 'http:' || url.username || url.password || url.search || url.hash || !rootPath
    || !['127.0.0.1', '[::1]'].includes(url.hostname)) {
    fail(422, 'VALIDATION_ERROR', 'Ollama baseUrl must be a literal HTTP loopback origin with no path, credentials, query, or fragment.', {
      field: 'baseUrl',
    });
  }
  return url.origin;
}

async function boundedJson(response, providerId) {
  if (!response || typeof response.ok !== 'boolean') {
    fail(502, 'PROVIDER_RESPONSE_INVALID', `${providerId} returned an invalid HTTP response.`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      fail(401, 'PROVIDER_AUTH_FAILED', `${providerId} rejected the supplied credential.`);
    }
    fail(502, 'PROVIDER_UNREACHABLE', `${providerId} model discovery returned HTTP ${response.status}.`);
  }
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    fail(502, 'PROVIDER_RESPONSE_INVALID', `${providerId} model discovery response exceeded the size limit.`);
  }

  const chunks = [];
  let size = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        fail(502, 'PROVIDER_RESPONSE_INVALID', `${providerId} model discovery response exceeded the size limit.`);
      }
      chunks.push(Buffer.from(value));
    }
  } else if (typeof response.text === 'function') {
    const text = await response.text();
    size = Buffer.byteLength(text);
    if (size > MAX_RESPONSE_BYTES) {
      fail(502, 'PROVIDER_RESPONSE_INVALID', `${providerId} model discovery response exceeded the size limit.`);
    }
    chunks.push(Buffer.from(text));
  } else {
    fail(502, 'PROVIDER_RESPONSE_INVALID', `${providerId} model discovery response did not contain a readable body.`);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    fail(502, 'PROVIDER_RESPONSE_INVALID', `${providerId} model discovery response was not valid JSON.`);
  }
}

async function getJson({ providerId, url, headers = {}, fetchImpl, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail(502, 'PROVIDER_UNREACHABLE', `${providerId} model discovery could not reach the configured endpoint.`);
  }
  return boundedJson(response, providerId);
}

function safeModel(value, source, recommendedIds, label = value) {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_MODEL_ID_LENGTH) return null;
  const id = value.trim();
  const safeLabel = typeof label === 'string' && label.trim() && label.length <= MAX_MODEL_ID_LENGTH
    ? label.trim()
    : id;
  return { id, label: safeLabel, source, recommended: recommendedIds.has(id) };
}

function normalizeModels(rawModels, { source, recommendedIds, idOf, labelOf = idOf }) {
  if (!Array.isArray(rawModels) || rawModels.length > MAX_MODELS) {
    fail(502, 'PROVIDER_RESPONSE_INVALID', 'Provider returned an invalid or excessive model list.');
  }
  const byId = new Map();
  for (const value of rawModels) {
    const model = safeModel(idOf(value), source, recommendedIds, labelOf(value));
    if (model) byId.set(model.id, model);
  }
  if (!byId.size) fail(502, 'PROVIDER_RESPONSE_INVALID', 'Provider returned no valid selectable models.');
  return [...byId.values()].sort((left, right) => (
    Number(right.recommended) - Number(left.recommended) || left.label.localeCompare(right.label)
  ));
}

function hostedRecommendedIds(providerId, profile) {
  const defaults = providerId === 'openai-api'
    ? ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
    : ['claude-sonnet-4-5'];
  return new Set([profile?.model, ...defaults].filter(Boolean));
}

async function discoverHosted(providerId, secret, profile, fetchImpl, timeoutMs) {
  const recommendedIds = hostedRecommendedIds(providerId, profile);
  if (providerId === 'openai-api') {
    const document = await getJson({
      providerId,
      url: OPENAI_MODELS_URL,
      headers: { Authorization: `Bearer ${secret}` },
      fetchImpl,
      timeoutMs,
    });
    return normalizeModels(document?.data, {
      source: 'provider', recommendedIds, idOf: (value) => value?.id,
    });
  }
  const document = await getJson({
    providerId,
    url: ANTHROPIC_MODELS_URL,
    headers: { 'x-api-key': secret, 'anthropic-version': '2023-06-01' },
    fetchImpl,
    timeoutMs,
  });
  return normalizeModels(document?.data, {
    source: 'provider', recommendedIds, idOf: (value) => value?.id, labelOf: (value) => value?.display_name || value?.id,
  });
}

async function discoverOllama(baseUrl, profile, fetchImpl, timeoutMs) {
  const normalized = normalizeOllamaBaseUrl(baseUrl);
  const document = await getJson({
    providerId: 'ollama',
    url: `${normalized}/api/tags`,
    fetchImpl,
    timeoutMs,
  });
  const recommendedIds = new Set([profile?.model].filter(Boolean));
  return {
    baseUrl: normalized,
    models: normalizeModels(document?.models, {
      source: 'installed', recommendedIds, idOf: (value) => value?.name || value?.model,
    }),
  };
}

function publicConnection(providerId, state, profile) {
  const kind = PROVIDER_KIND[providerId];
  if (!kind) return null;
  const connected = state?.status === 'CONNECTED';
  const status = state?.status || 'NOT_CHECKED';
  const verified = Boolean(state?.verified && ['DISCOVERED', 'CONNECTED'].includes(status));
  const secretStorage = kind === 'hosted' && state?.hasSecret ? 'SESSION_ONLY' : 'NONE';
  const selectedModel = connected ? state.model || profile?.model || null : null;
  const capabilities = connected && providerId !== 'claude-cli'
    ? [...new Set(state?.capabilities || ['plan'])]
    : [];
  const detail = state?.detail || 'Connection has not been verified in this server session.';
  return {
    kind,
    providerId,
    status,
    verified,
    secretStorage,
    hasSecret: Boolean(kind === 'hosted' && state?.hasSecret),
    revision: state?.revision || null,
    selectedModel,
    baseUrl: kind === 'local' && status !== 'DISCONNECTED' ? state?.baseUrl || profile?.baseUrl || null : null,
    capabilities,
    detail,
  };
}

function modelExists(models, model) {
  return models.some((item) => item.id === model);
}

export class ProviderConnectionManager {
  #environment;
  #fetchImpl;
  #timeoutMs;
  #inspectCli;
  #secrets = new Map();
  #states = new Map();

  constructor({ environment = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS, inspectCli = inspectCliProvider } = {}) {
    this.#environment = environment;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#inspectCli = inspectCli;
  }

  #replaceSecret(providerId, value) {
    const prior = this.#secrets.get(providerId);
    const next = Buffer.from(value, 'utf8');
    const changed = !prior || !prior.equals(next);
    if (prior) prior.fill(0);
    this.#secrets.set(providerId, next);
    return changed;
  }

  #secret(providerId) {
    const value = this.#secrets.get(providerId);
    return value ? value.toString('utf8') : null;
  }

  #setState(providerId, next, { semanticChange = false } = {}) {
    const prior = this.#states.get(providerId);
    const revision = semanticChange ? opaqueRevision() : prior?.revision || null;
    const state = { ...prior, ...next, revision };
    this.#states.set(providerId, state);
    return state;
  }

  connection(providerId, profile) {
    return publicConnection(providerId, this.#states.get(providerId), profile);
  }

  connectionRevision(providerId) {
    return this.#states.get(providerId)?.revision || null;
  }

  runtimeSecret(providerId) {
    return HOSTED_PROVIDERS.has(providerId) ? this.#secret(providerId) : null;
  }

  async discover(input, profile) {
    const kind = requireString(input?.kind, 'kind', 20);
    const providerId = requireString(input?.providerId, 'providerId', 100);
    requireProviderKind(providerId, kind);
    if (kind === 'hosted') {
      const apiKey = requireString(input.apiKey, 'apiKey', 4_096);
      const models = await discoverHosted(providerId, apiKey, profile, this.#fetchImpl, this.#timeoutMs);
      const secretChanged = this.#replaceSecret(providerId, apiKey);
      const prior = this.#states.get(providerId);
      const preserveConnected = !secretChanged && prior?.status === 'CONNECTED';
      const state = this.#setState(providerId, {
        status: preserveConnected ? 'CONNECTED' : 'DISCOVERED',
        verified: true,
        hasSecret: true,
        ...(preserveConnected ? {} : { model: null }),
        detail: preserveConnected
          ? 'Hosted credential remains verified and connected in this server session.'
          : 'Hosted credential verified and retained only in this server session; select a model to connect.',
      }, { semanticChange: secretChanged });
      return { connection: publicConnection(providerId, state, profile), models };
    }
    if (kind === 'local') {
      const discovered = await discoverOllama(input.baseUrl, profile, this.#fetchImpl, this.#timeoutMs);
      const state = this.#setState(providerId, {
        status: 'DISCOVERED', verified: true, hasSecret: false, baseUrl: discovered.baseUrl, model: null,
        detail: 'Loopback Ollama endpoint answered /api/tags; select an installed model to connect.',
      });
      return { connection: publicConnection(providerId, state, profile), models: discovered.models };
    }
    const inspection = this.#inspectCli(providerId, this.#environment, { force: true });
    if (!inspection.installed) fail(422, 'CLI_NOT_INSTALLED', `${providerId} executable was not detected in PATH.`);
    if (!inspection.authenticated) fail(422, 'CLI_AUTH_REQUIRED', `${providerId} is installed but its authentication status is not ready.`);
    const state = this.#setState(providerId, {
      status: 'DISCOVERED', verified: true, hasSecret: false, model: null,
      capabilities: providerId === 'codex-cli'
        ? ['chat', 'plan', ...(inspection.liveWebResearch ? [LIVE_WEB_RESEARCH_CAPABILITY] : [])]
        : [],
      detail: providerId === 'claude-cli'
        ? 'Claude Code CLI executable and authentication are verified; no execution adapter is implemented.'
        : 'Codex CLI executable and authentication are verified; connect it as the agent runtime.',
    });
    return { connection: publicConnection(providerId, state, profile), models: [] };
  }

  async connect(input, profile) {
    const kind = requireString(input?.kind, 'kind', 20);
    const providerId = requireString(input?.providerId, 'providerId', 100);
    requireProviderKind(providerId, kind);
    let models = [];
    let baseUrl = null;
    let model = null;
    let cliCapabilities = [];
    if (kind === 'hosted') {
      const secret = this.#secret(providerId);
      if (!secret) fail(422, 'PROVIDER_SECRET_MISSING', 'Verify an API key in this server session before connecting the hosted provider.');
      model = requireString(input.model, 'model', MAX_MODEL_ID_LENGTH);
      models = await discoverHosted(providerId, secret, profile, this.#fetchImpl, this.#timeoutMs);
      if (!modelExists(models, model)) fail(422, 'MODEL_NOT_AVAILABLE', 'The selected model is not present in the provider model list.', { field: 'model' });
    } else if (kind === 'local') {
      model = requireString(input.model, 'model', MAX_MODEL_ID_LENGTH);
      const discovered = await discoverOllama(input.baseUrl, profile, this.#fetchImpl, this.#timeoutMs);
      baseUrl = discovered.baseUrl;
      models = discovered.models;
      if (!modelExists(models, model)) fail(422, 'MODEL_NOT_AVAILABLE', 'The selected model is not installed at the configured Ollama endpoint.', { field: 'model' });
    } else {
      const inspection = this.#inspectCli(providerId, this.#environment, { force: true });
      if (!inspection.installed) fail(422, 'CLI_NOT_INSTALLED', `${providerId} executable was not detected in PATH.`);
      if (!inspection.authenticated) fail(422, 'CLI_AUTH_REQUIRED', `${providerId} is installed but its authentication status is not ready.`);
      if (providerId === 'codex-cli') {
        cliCapabilities = ['chat', 'plan', ...(inspection.liveWebResearch ? [LIVE_WEB_RESEARCH_CAPABILITY] : [])];
      }
    }

    const prior = this.#states.get(providerId);
    const semanticChange = prior?.status !== 'CONNECTED' || prior?.model !== model || prior?.baseUrl !== baseUrl;
    const state = this.#setState(providerId, {
      status: 'CONNECTED', verified: true, hasSecret: kind === 'hosted', model, baseUrl,
      capabilities: kind === 'cli' ? cliCapabilities : ['chat', 'plan'],
      detail: providerId === 'claude-cli'
        ? 'Claude Code CLI is verified, but no execution adapter is implemented.'
        : 'Agent runtime connection and model prerequisites are verified.',
    }, { semanticChange });
    return { connection: publicConnection(providerId, state, { ...profile, model, baseUrl }), models };
  }

  async listModels(providerId, profile) {
    if (HOSTED_PROVIDERS.has(providerId)) {
      const secret = this.#secret(providerId);
      if (!secret) fail(422, 'PROVIDER_SECRET_MISSING', 'No hosted credential is retained in this server session.');
      const models = await discoverHosted(providerId, secret, profile, this.#fetchImpl, this.#timeoutMs);
      return { connection: this.connection(providerId, profile), models };
    }
    if (providerId === 'ollama') {
      if (!profile?.baseUrl) fail(422, 'VALIDATION_ERROR', 'Connect an Ollama endpoint before refreshing installed models.', { field: 'baseUrl' });
      const discovered = await discoverOllama(profile.baseUrl, profile, this.#fetchImpl, this.#timeoutMs);
      return { connection: this.connection(providerId, profile), models: discovered.models };
    }
    if (CLI_PROVIDERS.has(providerId)) {
      fail(422, 'PROVIDER_MODELS_UNSUPPORTED', 'CLI providers do not expose model discovery through this dialog.');
    }
    fail(422, 'PROVIDER_NOT_SUPPORTED', `Provider ${providerId} does not support model discovery.`);
  }

  disconnect(providerId, profile) {
    if (!Object.hasOwn(PROVIDER_KIND, providerId)) fail(422, 'PROVIDER_NOT_SUPPORTED', `Provider ${providerId} cannot be disconnected here.`);
    const secret = this.#secrets.get(providerId);
    if (secret) secret.fill(0);
    this.#secrets.delete(providerId);
    const prior = this.#states.get(providerId);
    const semanticChange = prior?.status !== 'DISCONNECTED' || prior?.hasSecret || profile?.enabled === true;
    const state = this.#setState(providerId, {
      status: 'DISCONNECTED', verified: false, hasSecret: false, model: null, baseUrl: null,
      detail: 'Provider is disconnected and disabled.',
    }, { semanticChange });
    return { connection: publicConnection(providerId, state, { ...profile, enabled: false }), models: [] };
  }

  decorate(provider) {
    let state = this.#states.get(provider.id);
    if (!state && provider.kind === 'cli' && provider.available === true && provider.configured === true) {
      state = this.#setState(provider.id, {
        status: 'CONNECTED',
        verified: true,
        hasSecret: false,
        model: null,
        baseUrl: null,
        capabilities: provider.capabilities ?? [],
        detail: 'CLI executable and authentication were verified automatically for this desktop session.',
      });
    }
    let connection = this.connection(provider.id, provider.profile);
    if (!connection) return provider;
    if (provider.id === 'codex-cli' && state?.status === 'CONNECTED' && provider.available !== true) {
      const invalidated = this.#setState(provider.id, {
        status: 'DISCONNECTED', verified: false, hasSecret: false, model: null, baseUrl: null,
        detail: 'Codex CLI is no longer installed and authenticated; reconnect after restoring CLI login.',
      }, { semanticChange: true });
      connection = publicConnection(provider.id, invalidated, provider.profile);
    }
    if (state && (provider.profile?.enabled !== true || connection.status !== 'CONNECTED' || connection.verified !== true)) {
      return {
        ...provider,
        available: false,
        ready: false,
        connectionVerified: connection.verified,
        capabilities: [],
        connection,
      };
    }
    if (provider.profile?.enabled !== true || connection.status !== 'CONNECTED' || connection.verified !== true) {
      return { ...provider, connection };
    }
    if (provider.id === 'claude-cli') {
      return {
        ...provider, available: false, ready: false, connectionVerified: true, capabilities: [], connection,
        detail: 'Claude Code CLI authentication is verified, but no execution adapter is implemented.',
      };
    }
    const capabilities = provider.id === 'codex-cli'
      ? [...new Set([
          'chat', 'plan',
          ...(provider.executionEnabled ? ['execute'] : []),
          ...(provider.capabilities?.includes(LIVE_WEB_RESEARCH_CAPABILITY) ? [LIVE_WEB_RESEARCH_CAPABILITY] : []),
        ])]
      : ['chat', 'plan'];
    return {
      ...provider,
      detected: true,
      configured: true,
      available: true,
      ready: true,
      connectionVerified: true,
      capabilities,
      connection: { ...connection, capabilities },
      detail: provider.id === 'ollama'
        ? 'Loopback Ollama endpoint and installed model are verified for chat and AI planning.'
        : 'Provider connection and selected model are verified for chat and AI planning.',
    };
  }

  close() {
    for (const value of this.#secrets.values()) value.fill(0);
    this.#secrets.clear();
    this.#states.clear();
  }
}
