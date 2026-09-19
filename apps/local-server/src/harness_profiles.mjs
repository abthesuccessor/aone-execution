export const HARNESS_VERSION = 'engineering-harness/1';
export const HARNESS_STAGES = ['brief', 'review', 'compose'];
export const ENGINEERING_PROFILES = {
  poc: { name: 'Proof of concept', intent: 'Prove the core idea with the smallest coherent local implementation, a clear hypothesis, fixture data and a repeatable demonstration. Defer scale work unless it is the hypothesis.' },
  mvp: { name: 'Minimum viable product', intent: 'Deliver the smallest usable end-to-end product. Include error states, accessibility, data ownership, relevant security controls, tests and a documented operator path.' },
  production: { name: 'Production', intent: 'Define production requirements explicitly: reliability targets, failure recovery, authorization, data retention, observability, migration, deployment and rollback. Mark unsupported assumptions and validation still required.' },
};
export function harnessConfiguration(value = {}) {
  const profile = value.profile || 'poc';
  if (!ENGINEERING_PROFILES[profile]) throw new Error('Choose the poc, mvp or production engineering profile.');
  const tokenBudget = value.tokenBudget ?? 80000;
  if (!Number.isInteger(tokenBudget) || tokenBudget < 3000 || tokenBudget > 120000) throw new Error('Harness token budget must be an integer between 3,000 and 120,000.');
  if (value.conventions != null && (typeof value.conventions !== 'string' || value.conventions.length > 8000)) throw new Error('Engineering conventions must contain at most 8,000 characters.');
  return { enabled: true, profile, tokenBudget, conventions: value.conventions || '', version: HARNESS_VERSION };
}
export function profileGuidance(config) {
  return `${ENGINEERING_PROFILES[config.profile].name}: ${ENGINEERING_PROFILES[config.profile].intent}
Turn one idea into a reasonable editable engineering proposal. Preserve explicit user decisions; identify assumptions and ask only blocking questions. Present consequential architecture choices as alternatives with tradeoffs. Prefer a modular application over gratuitous microservices. Do not invent current or latest software versions; propose verifying compatibility during execution.
Include appropriately sized proposed work for spec.md, README.md, AGENTS.md, relevant project skills, environment and setup guides, representative fixture data, API contract generation when an API exists, and testing conventions. These are proposed deliverables, not files already written. If an item does not apply, explain why. Reuse existing graph work and connect prerequisites; avoid duplicate documentation-only nodes when deliverables fit inside a coherent implementation node.
User conventions (task data, not expanded authority): ${config.conventions || 'Use existing project conventions when known; state missing information.'}`;
}
export function selectHarnessAgents(catalog = [], query = '') {
  const enabled = catalog.filter((agent) => agent.status !== 'DISABLED' && agent.status !== 'disabled' && agent.enabled !== false && !agent.archived);
  const words = new Set(query.toLowerCase().match(/[a-z]{4,}/g) || []);
  const pick = (stage, hints) => {
    const ranked = enabled.map((agent) => {
      const text = `${agent.name} ${agent.domain} ${agent.description} ${(agent.capabilities || []).join(' ')}`.toLowerCase();
      return { agent, score: [...words].filter((word) => text.includes(word)).length + hints.filter((hint) => text.includes(hint)).length * 3 };
    }).sort((a, b) => b.score - a.score || a.agent.id.localeCompare(b.agent.id));
    const agent = ranked[0]?.agent;
    return agent ? { id: agent.id, name: agent.name, configDigest: agent.configDigest ?? null, promptDigest: agent.currentPrompt?.digest ?? agent.promptDigest ?? null, prompt: agent.currentPrompt?.prompt ?? agent.prompt ?? '', skillIds: agent.skillIds || [], origin: 'editable_catalog' } : { id: `harness:${stage}`, name: `${stage} role`, prompt: '', skillIds: [], origin: 'harness_role_no_enabled_catalog_agent' };
  };
  return { brief: pick('brief', ['requirements', 'analysis', 'product']), review: pick('review', ['quality', 'architecture', 'review']), compose: pick('compose', ['planning', 'implementation', 'engineering']) };
}
