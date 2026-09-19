import { createHash, randomBytes } from 'node:crypto';

export const TRACE_SCHEMA_VERSION = 1;
export const MAX_TRACE_PAYLOAD_BYTES = 64 * 1024;

const SECRET_KEY = /(?:api[-_]?key|access[-_]?key|secret|password|passwd|credential|authorization|cookie|session|private[-_]?key|client[-_]?secret|refresh[-_]?token|access[-_]?token|id[-_]?token|bearer)/i;
const EXACT_SECRET_KEY = /^(?:token|auth|set-cookie)$/i;
const REDACTION_PATTERNS = Object.freeze([
  [/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]'],
  [/\bBasic\s+[A-Za-z0-9+/]+=*/gi, 'Basic [REDACTED]'],
  [/\bsk-ant-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_ANTHROPIC_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED_AWS_ACCESS_KEY]'],
  [/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED_GOOGLE_API_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"']+/gi, '[REDACTED_DATABASE_URL]'],
  [/(https?:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, '$1[REDACTED]@'],
  [/([?&](?:api_?key|token|secret|password)=)[^&#\s]+/gi, '$1[REDACTED]'],
  [/\b([A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|SECRET|PASSWORD|ACCOUNTKEY))\s*=\s*([^\s;]+)/gi, '$1=[REDACTED]'],
  [/("(?:api[-_]?key|token|secret|password|authorization)"\s*:\s*")[^"]+/gi, '$1[REDACTED]'],
]);

function redactString(value) {
  let result = String(value);
  for (const [pattern, replacement] of REDACTION_PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

function scrub(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return redactString(value);
  if (seen.has(value)) return '[CIRCULAR]';
  if (depth >= 12) return '[TRUNCATED_DEPTH]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, 500).map((item) => scrub(item, depth + 1, seen));
    if (value.length > result.length) result.push(`[TRUNCATED_${value.length - result.length}_ITEMS]`);
    return result;
  }
  const entries = Object.entries(value).slice(0, 500).map(([key, child]) => [
    key,
    (SECRET_KEY.test(key) || EXACT_SECRET_KEY.test(key)) && !(typeof child === 'number' && /(?:count|tokens)$/i.test(key))
      ? '[REDACTED_SECRET]'
      : scrub(child, depth + 1, seen),
  ]);
  if (Object.keys(value).length > entries.length) entries.push(['_truncatedKeys', Object.keys(value).length - entries.length]);
  return Object.fromEntries(entries);
}

export function captureTracePayload(value, maximumBytes = MAX_TRACE_PAYLOAD_BYTES) {
  if (value == null) return { payload: null, metadata: null };
  const originalByteCount = (() => {
    const visited = new WeakSet();
    try {
      return Buffer.byteLength(JSON.stringify(value, (_key, child) => {
        if (typeof child === 'bigint') return String(child);
        if (child && typeof child === 'object') {
          if (visited.has(child)) return '[CIRCULAR]';
          visited.add(child);
        }
        return child;
      }));
    } catch {
      return null;
    }
  })();
  const safe = scrub(value);
  const json = JSON.stringify(safe);
  const byteSize = Buffer.byteLength(json);
  if (byteSize <= maximumBytes) {
    return {
      payload: safe,
      metadata: {
        captureMode: 'REDACTED_LOCAL',
        redacted: json.includes('[REDACTED'),
        truncated: json.includes('[TRUNCATED_'),
        originalByteCount,
        storedByteCount: byteSize,
      },
    };
  }
  const preview = Buffer.from(json).subarray(0, Math.max(0, maximumBytes - 512)).toString('utf8');
  const payload = {
    _tracePayload: 'TRUNCATED',
    originalByteCount,
    sha256: createHash('sha256').update(json).digest('hex'),
    preview: redactString(preview),
  };
  return {
    payload,
    metadata: {
      captureMode: 'REDACTED_LOCAL',
      redacted: json.includes('[REDACTED'),
      truncated: true,
      originalByteCount,
      storedByteCount: Buffer.byteLength(JSON.stringify(payload)),
    },
  };
}

export function sanitizeTracePayload(value, maximumBytes = MAX_TRACE_PAYLOAD_BYTES) {
  return captureTracePayload(value, maximumBytes).payload;
}

export function createTraceId() {
  let id;
  do id = randomBytes(16).toString('hex'); while (/^0+$/.test(id));
  return id;
}

export function createSpanId() {
  let id;
  do id = randomBytes(8).toString('hex'); while (/^0+$/.test(id));
  return id;
}

export function workspaceBinding(canonicalPath, metadata) {
  const core = {
    canonicalPath,
    device: String(metadata.dev),
    inode: String(metadata.ino),
  };
  return {
    ...core,
    digest: `sha256:${createHash('sha256').update(JSON.stringify(core)).digest('hex')}`,
  };
}
