import { createHash } from 'node:crypto';

export const LIVE_WEB_RESEARCH_CAPABILITY = 'research-live-web';
export const RESEARCH_POLICY_VERSION = 'ege-research-policy-v1';

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export class ResearchPolicyError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'ResearchPolicyError';
    this.code = code;
  }
}

function policyCore(enabled) {
  return {
    version: RESEARCH_POLICY_VERSION,
    enabled,
    provider: enabled ? 'codex-cli' : null,
    tool: enabled ? 'web_search' : null,
    mode: enabled ? 'live' : 'disabled',
    primarySourcesPreferred: enabled,
    citationsRequired: enabled,
    independentValidationRequired: enabled,
  };
}

export function createResearchPolicy(request = {}, provider = null) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    throw new ResearchPolicyError('INVALID_RESEARCH_POLICY', 'research must be an object when supplied.');
  }
  const keys = Object.keys(request);
  if (keys.some((key) => key !== 'enabled')) {
    throw new ResearchPolicyError('INVALID_RESEARCH_POLICY', 'research accepts only the enabled boolean.');
  }
  const enabled = request.enabled ?? false;
  if (typeof enabled !== 'boolean') {
    throw new ResearchPolicyError('INVALID_RESEARCH_POLICY', 'research.enabled must be a boolean.');
  }
  if (enabled && provider !== 'codex-cli') {
    throw new ResearchPolicyError(
      'RESEARCH_PROVIDER_UNSUPPORTED',
      'Live web research is implemented only by the Codex CLI planning and execution adapters.',
    );
  }
  const core = policyCore(enabled);
  return Object.freeze({ ...core, digest: digest(core) });
}

export function validateResearchPolicy(policy, provider = null) {
  if (policy === undefined || policy === null) return createResearchPolicy({}, provider);
  if (typeof policy !== 'object' || Array.isArray(policy)) {
    throw new ResearchPolicyError('INVALID_RESEARCH_POLICY', 'Pinned research policy must be an object.');
  }
  const expected = createResearchPolicy({ enabled: policy.enabled }, provider);
  const keys = Object.keys(expected).sort();
  if (JSON.stringify(Object.keys(policy).sort()) !== JSON.stringify(keys)
    || keys.some((key) => policy[key] !== expected[key])) {
    throw new ResearchPolicyError('INVALID_RESEARCH_POLICY', 'Pinned research policy content or digest is invalid.');
  }
  return expected;
}

export function codexWebSearchArguments(policy) {
  const validated = validateResearchPolicy(policy, policy?.enabled ? 'codex-cli' : null);
  return validated.enabled
    ? ['--strict-config', '--search']
    : ['--strict-config', '-c', 'web_search="disabled"'];
}
