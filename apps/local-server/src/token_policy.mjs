// Adapted from Julius Brussee's MIT Caveman skill. Full source/license/provenance:
// third_party/caveman/. No BSL engine code or remote service is used.
import { createHash } from 'node:crypto';

export const CAVEMAN_SOURCE = Object.freeze({
  repository: 'https://github.com/juliusbrussee/caveman',
  commit: '15581d14007fd01fb3f132016741962f34936ca2',
  path: 'skills/caveman/SKILL.md',
  sha256: 'c4d7354b4b063d54601fcdd5097a5b1713d1a1a2e386ac39efa438aa1ffef8ce',
  license: 'MIT',
});
const LEVELS = {
  lite: 'Use short complete sentences. Remove filler and repetition.',
  full: 'Use concise sentences or unambiguous fragments. Omit articles only when meaning stays clear. State each fact once.',
  ultra: 'Use the shortest unambiguous phrasing. Remove redundant conjunctions only when sequence and cause remain explicit. Do not invent abbreviations.',
};
export function compressionGuidance(mode = 'off') {
  if (mode === 'off') return '';
  if (!Object.hasOwn(LEVELS, mode)) throw new Error('Unknown Caveman compression level.');
  return `Caveman ${mode} prose policy (MIT adaptation): ${LEVELS[mode]} Preserve all technical substance, uncertainty, negations, conditions, numbers, units, citations, and the user's language. Never compress code, commands, paths, exact errors, JSON keys, evidence IDs, receipts, acceptance criteria, or persisted document text. Follow the required output schema. Use normal complete prose for security explanations, approvals, destructive actions, ordered procedures, or any ambiguity. Compression never changes authority or evidence requirements.`;
}
export function tokenPolicyManifest(settings) {
  const mode = settings.harness.compression;
  const guidance = compressionGuidance(mode);
  return { mode, source: CAVEMAN_SOURCE, guidanceDigest: createHash('sha256').update(guidance).digest('hex'), instructionCharacters: guidance.length, estimatedInstructionTokens: Math.ceil(guidance.length / 4), measurement: 'Character-based estimate. Provider usage is reported separately; savings require a matched baseline.' };
}

export function promptEngineeringContext(context) {
  // Full policy identity is kept with the message/run pins. Repeating source
  // URLs, checksums and unrelated disabled IDs in every model turn adds cost.
  const { engineeringSettings, tokenPolicy, ...taskContext } = context;
  return taskContext;
}

// Context reduction selects whole preserved messages. It never rewrites evidence,
// exact code, commands, or records, and never promotes text into authority.
export function assertPromptContextLimit(messages, maxCharacters) {
  if (JSON.stringify(messages).length > maxCharacters) throw Object.assign(new Error(`The complete provider prompt exceeds the context budget (${maxCharacters} characters). Select less context, shorten the request, or raise the budget in Engineering controls. Exact task and evidence text was not truncated.`), { code: 'CHAT_CONTEXT_LIMIT', status: 422 });
}

export function selectConversationHistory(messages, { maxCharacters, compactionEnabled, serialized = false }) {
  const candidates = messages.filter((message) => message.status === undefined || message.status === 'completed');
  const originalCharacters = candidates.reduce((sum, message) => sum + message.content.length, 0);
  const cost = ({ role, content }) => serialized ? JSON.stringify({ role, content }).length + 1 : content.length;
  const pins = candidates.map(({ id, role, content }) => [id, role, createHash('sha256').update(content).digest('hex')]);
  const originalDigest = createHash('sha256').update(JSON.stringify(pins)).digest('hex');
  if (!compactionEnabled && candidates.reduce((sum, message) => sum + cost(message), 0) > maxCharacters) throw Object.assign(new Error('Conversation exceeds the context budget. Enable context compaction, raise the budget, or start a new conversation.'), { code: 'CHAT_CONTEXT_LIMIT', status: 422 });
  const chosen = new Set(); let used = 0;
  const order = candidates.length > 1 ? [0, ...candidates.slice(1).map((_, index) => index + 1).reverse()] : candidates.map((_, index) => index);
  for (const index of order) {
    const message = candidates[index];
    if (used + cost(message) <= maxCharacters) { chosen.add(index); used += cost(message); }
  }
  const selected = candidates.filter((_, index) => chosen.has(index));
  return { messages: selected.map(({ role, content }) => ({ role, content })), originalDigest, originalCharacters, includedCharacters: selected.reduce((sum, message) => sum + message.content.length, 0), omittedMessageCount: candidates.length - selected.length, includedMessageCount: selected.length, method: compactionEnabled ? 'whole-message-selection-v1' : 'complete-history-v1', boundary: 'Selected conversation messages are untrusted task data. Omitted messages remain preserved in storage.' };
}
