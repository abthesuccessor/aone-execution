import { createHash } from 'node:crypto';

export const RELATIONSHIP_TYPES = Object.freeze([
  'SUPPORTED_BY',
  'REQUIRES',
  'PRODUCES',
  'CONSUMES_CONTRACT',
  'IMPLEMENTS',
  'VERIFIES',
  'GOVERNS',
  'DEPLOYS',
  'OBSERVES',
]);

export const ENGINEERING_DOMAINS = Object.freeze([
  'product',
  'experience',
  'application',
  'data',
  'platform',
  'quality',
  'security',
]);

const COMPILE_ORDER = Object.freeze([
  'product',
  'data',
  'application',
  'experience',
  'quality',
  'security',
  'platform',
]);

const IMPLEMENTATION_DOMAINS = Object.freeze(['data', 'application', 'experience', 'platform']);

const CATALOG_DOMAIN_ALIASES = Object.freeze({
  product: ['product'],
  'product-requirements': ['product'],
  experience: ['experience'],
  'client-experience': ['experience'],
  application: ['application'],
  'integration-services': ['application'],
  'architecture-computation': ['application', 'data'],
  data: ['data'],
  'data-intelligence': ['data'],
  platform: ['platform'],
  'platform-delivery': ['platform'],
  quality: ['quality'],
  security: ['security'],
  'assurance-security': ['quality', 'security'],
});

const DOMAIN_DEFINITIONS = Object.freeze({
  product: {
    title: 'Requirements and traceability',
    objective: 'Turn supplied intent and evidence into bounded, testable requirements and explicit decisions.',
    outputType: 'requirements_contract',
    keywords: ['brd', 'business', 'requirement', 'acceptance', 'feature', 'product', 'workflow', 'user story', 'intent', 'flow'],
    agentKeywords: ['product', 'business analyst', 'requirements', 'traceability', 'architecture'],
    acceptanceCriteria: [
      'Every supplied intent is mapped to a requirement, constraint, assumption, or unresolved decision.',
      'Success measures and approval boundaries are explicit and testable.',
    ],
  },
  experience: {
    title: 'Experience and client engineering',
    objective: 'Define and implement usable, accessible client experiences against explicit contracts.',
    outputType: 'experience_artifact',
    keywords: ['frontend', 'front end', 'ui', 'ux', 'browser', 'web app', 'mobile', 'accessibility', 'react', 'vue', 'angular'],
    agentKeywords: ['frontend', 'ui', 'ux', 'accessibility', 'browser', 'mobile'],
    acceptanceCriteria: [
      'Primary interactions, state transitions, and accessibility requirements have executable checks.',
      'Client behavior consumes versioned interfaces without inventing backend behavior.',
    ],
  },
  application: {
    title: 'Application and service engineering',
    objective: 'Implement domain behavior, service boundaries, APIs, and integrations with explicit failure semantics.',
    outputType: 'application_artifact',
    keywords: ['api', 'graphql', 'rest', 'backend', 'service', 'microservice', 'domain logic', 'software', 'code', 'implement', 'application', 'algorithm', 'dsa', 'python', 'java', 'rust', 'golang', 'c#', 'c++', 'typescript'],
    agentKeywords: ['backend', 'api', 'application', 'distributed systems', 'programming', 'algorithm', 'integration'],
    acceptanceCriteria: [
      'A reviewable high-level design defines system boundaries, components, data and control flows, trust and failure domains, and material tradeoffs.',
      'A reviewable low-level design defines modules, interfaces, schemas, state transitions, algorithms, concurrency, error semantics, and test seams at implementation depth.',
      'Domain behavior and public contracts are covered by deterministic tests.',
      'Failure, retry, idempotency, and compatibility behavior is explicit where applicable.',
    ],
  },
  data: {
    title: 'Data, storage, and retrieval engineering',
    objective: 'Design canonical data, durable artifacts, retrieval, ranking, and recovery boundaries.',
    outputType: 'data_contract',
    keywords: ['database', 'data', 'sql', 'postgres', 'mysql', 'minio', 'object storage', 'storage', 'schema', 'migration', 'vector', 'embedding', 'retrieval', 'rrf', 'rerank', 'ranking', 'search'],
    agentKeywords: ['data', 'database', 'storage', 'retrieval', 'ranking', 'search', 'sql'],
    acceptanceCriteria: [
      'Canonical ownership, schemas, migrations, retention, and recovery behavior are defined.',
      'Retrieval or ranking changes include relevance, provenance, and authorization evaluation.',
    ],
  },
  platform: {
    title: 'Platform, delivery, and observability',
    objective: 'Build, deploy, observe, profile, and recover the system through reproducible environments.',
    outputType: 'delivery_observability_artifact',
    keywords: ['deploy', 'deployment', 'infrastructure', 'platform', 'kubernetes', 'docker', 'cloud', 'ci/cd', 'pipeline', 'release', 'observability', 'monitoring', 'telemetry', 'flamegraph', 'profiling', 'performance', 'sre'],
    agentKeywords: ['platform', 'devops', 'sre', 'deployment', 'observability', 'performance', 'infrastructure'],
    acceptanceCriteria: [
      'Build, deployment, rollback, and recovery procedures are reproducible.',
      'Service health, critical paths, resource use, and failure signals are observable.',
    ],
  },
  quality: {
    title: 'Independent verification and evaluation',
    objective: 'Independently verify requirements, contracts, behavior, performance, and evidence quality.',
    outputType: 'verification_report',
    keywords: ['test', 'testing', 'qa', 'quality', 'validate', 'verify', 'evaluation', 'evaluate', 'benchmark', 'playwright', 'junit', 'pytest', 'coverage', 'scoring'],
    agentKeywords: ['test', 'quality', 'verification', 'evaluation', 'critic', 'reviewer', 'qa'],
    acceptanceCriteria: [
      'High-level and low-level designs are independently checked for requirement traceability, internal consistency, and implementation drift.',
      'Independent checks cover functional, contract, integration, regression, and relevant non-functional risks.',
      'Every result records the command or method, evidence, expected result, actual result, and confidence boundary.',
    ],
  },
  security: {
    title: 'Independent security and governance',
    objective: 'Threat-model and independently gate code, AI, data, dependencies, secrets, and delivery risks.',
    outputType: 'security_governance_report',
    keywords: ['security', 'secure', 'threat', 'vulnerability', 'auth', 'authorization', 'secret', 'privacy', 'compliance', 'injection', 'supply chain', 'governance', 'guardrail', 'ai safety'],
    agentKeywords: ['security', 'threat', 'governance', 'privacy', 'compliance', 'secure coding'],
    acceptanceCriteria: [
      'Threats, trust boundaries, dependency risks, secret handling, and abuse cases have evidence-backed dispositions.',
      'Security gates are independent from implementation and fail closed for unresolved high-risk findings.',
    ],
  },
});

const DEFAULT_GRAPH_BUDGET = Object.freeze({
  maxNodes: 7,
  maxRelationships: 96,
  maxTotalSteps: 84,
  maxTotalTokens: 196_000,
  maxCostMicrounits: 2_000_000,
  timeoutMs: 3_600_000,
});

const DEFAULT_NODE_BUDGET = Object.freeze({
  maxSteps: 12,
  maxInputTokens: 20_000,
  maxOutputTokens: 8_000,
  maxCostMicrounits: 250_000,
  timeoutMs: 900_000,
});

const DEFAULT_STOP = Object.freeze({
  maxIterations: 4,
  maxNoProgressIterations: 1,
  conditions: Object.freeze([
    'acceptance_criteria_met',
    'budget_exhausted',
    'no_progress',
    'policy_denied',
    'human_stop',
  ]),
});

const AI_GRAPH_BUDGET = Object.freeze({
  maxNodes: 48,
  maxRelationships: 256,
  maxTotalSteps: 576,
  maxTotalTokens: 512_000,
  maxCostMicrounits: 5_000_000,
  timeoutMs: 3_600_000,
});

const RELATIONSHIP_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;

export class IntentCompilerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'IntentCompilerError';
    this.code = code;
    this.details = details;
  }
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort(compareText).map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textFrom(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return [
    value.title,
    value.name,
    value.kind,
    value.domain,
    value.category,
    value.objective,
    value.summary,
    value.description,
    value.context,
    value.text,
    value.content,
    value.requirements,
    value.techStack,
    value.technology,
  ].flatMap(asArray).filter((item) => typeof item === 'string').join(' ').trim();
}

function requiredId(value, fallback, label) {
  const id = String(value ?? fallback).trim();
  if (!id) throw new IntentCompilerError('INVALID_ID', `${label} requires a non-empty id.`);
  return id;
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort(compareText);
}

function normalizeDigest(value, label) {
  const digest = String(value || '').toLowerCase();
  if (/^sha256:[a-f0-9]{64}$/.test(digest)) return digest;
  if (/^[a-f0-9]{64}$/.test(digest)) return `sha256:${digest}`;
  throw new IntentCompilerError('INVALID_PROMPT_DIGEST', `${label} must be a SHA-256 digest.`);
}

function assertUniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) throw new IntentCompilerError('DUPLICATE_ID', `${label} id ${item.id} is duplicated.`);
    seen.add(item.id);
  }
}

function assertBoundedLoop(value, label) {
  if (!value || typeof value !== 'object') return;
  const loop = value.loop ?? value.iterationPolicy;
  const loopRequested = loop || value.maxIterations !== undefined || value.repeatUntil !== undefined;
  if (!loopRequested) return;
  const maxIterations = loop?.maxIterations ?? value.maxIterations;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new IntentCompilerError('UNBOUNDED_LOOP', `${label} declares a loop without a finite positive maxIterations.`);
  }
}

function normalizeIntents(rawIntents) {
  const intents = asArray(rawIntents).map((value, index) => {
    const raw = typeof value === 'string' ? { text: value } : value;
    if (!raw || typeof raw !== 'object') {
      throw new IntentCompilerError('INVALID_INTENT', `Intent ${index + 1} must be text or an object.`);
    }
    assertBoundedLoop(raw, `Intent ${raw.id ?? index + 1}`);
    const text = textFrom(raw);
    if (!text) throw new IntentCompilerError('INVALID_INTENT', `Intent ${raw.id ?? index + 1} has no usable content.`);
    return {
      id: requiredId(raw.id ?? raw.nodeId ?? raw.sourceId, `intent-${index + 1}`, 'Intent'),
      text,
      dependsOn: uniqueSorted(asArray(raw.dependsOn ?? raw.dependencies).map(String)),
      raw,
    };
  }).sort((left, right) => compareText(left.id, right.id));
  if (!intents.length) throw new IntentCompilerError('INTENT_REQUIRED', 'At least one user intent node is required.');
  assertUniqueIds(intents, 'Intent');
  return intents;
}

function normalizeEvidence(rawEvidence) {
  const evidence = asArray(rawEvidence).map((value, index) => {
    const raw = typeof value === 'string' ? { summary: value } : value;
    if (!raw || typeof raw !== 'object') {
      throw new IntentCompilerError('INVALID_EVIDENCE', `Evidence ${index + 1} must be text or an object.`);
    }
    const text = textFrom(raw);
    if (!text) throw new IntentCompilerError('INVALID_EVIDENCE', `Evidence ${raw.id ?? index + 1} has no usable summary.`);
    return {
      id: requiredId(raw.id ?? raw.evidenceId ?? raw.sourceId, `evidence-${index + 1}`, 'Evidence'),
      text,
      sourceNodeIds: uniqueSorted(asArray(raw.sourceNodeIds ?? raw.intentNodeIds ?? raw.nodeIds).map(String)),
      raw,
    };
  }).sort((left, right) => compareText(left.id, right.id));
  assertUniqueIds(evidence, 'Evidence');
  return evidence;
}

function normalizeAgents(rawAgents) {
  const agents = asArray(rawAgents).map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new IntentCompilerError('INVALID_AGENT', `Agent ${index + 1} must be an object.`);
    }
    const id = requiredId(raw.id ?? raw.agentId ?? raw.name, undefined, 'Agent');
    const promptValue = typeof raw.prompt === 'string'
      ? raw.prompt
      : raw.systemPrompt ?? raw.promptTemplate ?? raw.prompt?.content ?? raw.prompt?.text;
    const suppliedDigest = raw.promptDigest ?? raw.defaultPromptDigest ?? raw.prompt?.digest;
    if (!suppliedDigest && !promptValue) {
      throw new IntentCompilerError('AGENT_PROMPT_REQUIRED', `Agent ${id} requires a prompt or promptDigest.`);
    }
    return {
      id,
      promptDigest: suppliedDigest ? normalizeDigest(suppliedDigest, `Agent ${id} promptDigest`) : sha256(promptValue),
      searchText: [
        id,
        raw.name,
        raw.role,
        raw.description,
        ...asArray(raw.domains),
        ...asArray(raw.specialties),
        ...asArray(raw.capabilities),
        ...asArray(raw.skills),
        ...asArray(raw.tags),
      ].filter(Boolean).join(' ').toLowerCase(),
      explicitDomains: uniqueSorted(asArray(raw.domains ?? raw.domain ?? raw.domainId)
        .flatMap((item) => CATALOG_DOMAIN_ALIASES[String(item).toLowerCase()] ?? [])),
    };
  }).sort((left, right) => compareText(left.id, right.id));
  assertUniqueIds(agents, 'Agent');
  return agents;
}

function keywordMatch(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text);
}

function scoreDomain(text, domain, agent = false) {
  const definition = DOMAIN_DEFINITIONS[domain];
  const keywords = agent ? definition.agentKeywords : definition.keywords;
  return keywords.reduce((score, keyword) => score + (keywordMatch(text, keyword) ? 1 : 0), 0);
}

function validateIntentDependencies(intents, relationships = []) {
  const ids = new Set(intents.map((item) => item.id));
  const dependencies = new Map(intents.map((item) => [item.id, new Set(item.dependsOn)]));
  for (const relation of asArray(relationships)) {
    if (!relation || typeof relation !== 'object') continue;
    const type = String(relation.type ?? relation.kind ?? 'REQUIRES').toUpperCase();
    if (!['REQUIRES', 'DEPENDS_ON', 'CONTROL'].includes(type)) continue;
    const source = String(relation.source ?? relation.from ?? '').trim();
    const target = String(relation.target ?? relation.to ?? '').trim();
    if (source && target && ids.has(target)) dependencies.get(target).add(source);
  }
  for (const [target, sources] of dependencies) {
    for (const source of sources) {
      if (!ids.has(source)) throw new IntentCompilerError('UNKNOWN_DEPENDENCY', `Intent ${target} depends on unknown intent ${source}.`);
      if (source === target) throw new IntentCompilerError('INTENT_CYCLE', `Intent ${target} depends on itself.`);
    }
  }
  assertAcyclic([...ids], dependencies, 'INTENT_CYCLE', 'The intent map contains a dependency cycle.');
}

function assertAcyclic(ids, dependencies, code, message) {
  const indegree = new Map(ids.map((id) => [id, dependencies.get(id)?.size ?? 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const [target, sources] of dependencies) {
    for (const source of sources) outgoing.get(source)?.push(target);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0).sort(compareText);
  let visited = 0;
  while (ready.length) {
    const current = ready.shift();
    visited += 1;
    for (const target of outgoing.get(current).sort(compareText)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) ready.push(target);
    }
    ready.sort(compareText);
  }
  if (visited !== ids.length) throw new IntentCompilerError(code, message);
}

function normalizeBudget(raw = {}) {
  const budget = { ...DEFAULT_GRAPH_BUDGET };
  for (const key of Object.keys(DEFAULT_GRAPH_BUDGET)) {
    if (raw[key] === undefined) continue;
    if (!Number.isSafeInteger(raw[key]) || raw[key] < 0 || (key !== 'maxCostMicrounits' && raw[key] === 0)) {
      throw new IntentCompilerError('INVALID_BUDGET', `${key} must be a finite positive integer.`);
    }
    budget[key] = raw[key];
  }
  budget.maxNodes = Math.min(budget.maxNodes, ENGINEERING_DOMAINS.length);
  return budget;
}

function selectDomains(intents, evidence) {
  const sources = [...intents, ...evidence];
  const selected = new Set(['product']);
  for (const domain of ENGINEERING_DOMAINS) {
    if (domain !== 'product' && sources.some((source) => scoreDomain(source.text, domain) > 0)) selected.add(domain);
  }
  const allText = sources.map((source) => source.text).join(' ');
  if (![...IMPLEMENTATION_DOMAINS].some((domain) => selected.has(domain))
      && ['build', 'create', 'develop', 'engineering', 'system'].some((keyword) => keywordMatch(allText, keyword))) {
    selected.add('application');
  }
  if (IMPLEMENTATION_DOMAINS.some((domain) => selected.has(domain))) {
    selected.add('quality');
    selected.add('security');
  }
  return COMPILE_ORDER.filter((domain) => selected.has(domain));
}

function sourceTrace(domain, intents, evidence) {
  const matchedIntents = intents.filter((item) => domain === 'product' || scoreDomain(item.text, domain) > 0);
  const intentNodeIds = uniqueSorted((matchedIntents.length ? matchedIntents : intents).map((item) => item.id));
  const matchedEvidence = evidence.filter((item) => domain === 'product'
    || scoreDomain(item.text, domain) > 0
    || item.sourceNodeIds.some((id) => intentNodeIds.includes(id)));
  return {
    intentNodeIds,
    evidenceIds: uniqueSorted(matchedEvidence.map((item) => item.id)),
  };
}

function agentScore(agent, domain) {
  return (agent.explicitDomains.includes(domain) ? 100 : 0) + scoreDomain(agent.searchText, domain, true);
}

function assignAgent(domain, agents, unavailable = new Set(), forceIndependent = false) {
  const ranked = agents
    .map((agent) => ({ agent, score: agentScore(agent, domain) }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || compareText(left.agent.id, right.agent.id));
  const selected = ranked.find((item) => !unavailable.has(item.agent.id))?.agent
    ?? (!forceIndependent ? ranked[0]?.agent : undefined);
  if (selected) return { agentId: selected.id, promptDigest: selected.promptDigest, assignment: 'catalog' };
  const agentId = `builtin:${domain}-specialist`;
  return {
    agentId,
    promptDigest: sha256(`Bounded ${domain} specialist. Follow supplied evidence, emit typed artifacts, and stop at declared limits.`),
    assignment: 'builtin-fallback',
  };
}

function dependenciesFor(domain, selectedDomains) {
  const has = (candidate) => selectedDomains.includes(candidate);
  if (domain === 'product') return [];
  if (domain === 'data') return has('product') ? ['specialist:product'] : [];
  if (domain === 'application') return [has('product') && 'specialist:product', has('data') && 'specialist:data'].filter(Boolean);
  if (domain === 'experience') return [
    has('product') && 'specialist:product',
    has('application') ? 'specialist:application' : has('data') && 'specialist:data',
  ].filter(Boolean);
  if (domain === 'quality' || domain === 'security') {
    const implementation = ['data', 'application', 'experience'].filter(has).map((item) => `specialist:${item}`);
    return implementation.length ? implementation : ['specialist:product'];
  }
  if (domain === 'platform') {
    return uniqueSorted([
      ...['data', 'application', 'experience'].filter(has).map((item) => `specialist:${item}`),
      has('quality') && 'specialist:quality',
      has('security') && 'specialist:security',
      has('product') && 'specialist:product',
    ].filter(Boolean));
  }
  return [];
}

function makeNode(domain, traceability, agent, selectedDomains) {
  const definition = DOMAIN_DEFINITIONS[domain];
  const id = `specialist:${domain}`;
  const dependsOn = dependenciesFor(domain, selectedDomains);
  return {
    id,
    type: 'SPECIALIST_AGENT',
    domain,
    title: definition.title,
    objective: definition.objective,
    agentId: agent.agentId,
    promptDigest: agent.promptDigest,
    agentAssignment: agent.assignment,
    traceability,
    inputs: [{
      id: `${id}:input:context`,
      type: domain === 'product' ? 'intent_evidence_bundle' : 'upstream_contract_bundle',
      required: true,
      sourceIntentNodeIds: traceability.intentNodeIds,
      sourceEvidenceIds: traceability.evidenceIds,
    }],
    outputs: [{
      id: `artifact:${domain}`,
      type: definition.outputType,
      required: true,
      provenanceRequired: true,
    }],
    dependsOn,
    acceptanceCriteria: [...definition.acceptanceCriteria],
    budget: { ...DEFAULT_NODE_BUDGET },
    stop: { ...DEFAULT_STOP, conditions: [...DEFAULT_STOP.conditions] },
  };
}

function relation(type, from, to, rationale, traceability) {
  return {
    id: `relationship:${type.toLowerCase()}:${from}:${to}`,
    type,
    from,
    to,
    rationale,
    traceability: {
      intentNodeIds: [...traceability.intentNodeIds],
      evidenceIds: [...traceability.evidenceIds],
    },
  };
}

function buildRelationships(nodes) {
  const relationships = [];
  const byDomain = new Map(nodes.map((node) => [node.domain, node]));
  for (const node of nodes) {
    relationships.push(relation(
      'SUPPORTED_BY',
      `sources:${node.id}`,
      node.id,
      'The proposal is grounded in the bound intent and evidence references.',
      node.traceability,
    ));
    relationships.push(relation(
      'PRODUCES',
      node.id,
      node.outputs[0].id,
      `The specialist emits a typed ${node.outputs[0].type} artifact.`,
      node.traceability,
    ));
    for (const dependency of node.dependsOn) {
      relationships.push(relation(
        'REQUIRES',
        dependency,
        node.id,
        'The downstream specialist requires the admitted upstream artifact.',
        node.traceability,
      ));
    }
  }

  const product = byDomain.get('product');
  for (const domain of ['data', 'application', 'experience']) {
    const node = byDomain.get(domain);
    if (node && product) relationships.push(relation('IMPLEMENTS', node.id, product.id, 'The specialist implements the approved requirements contract.', node.traceability));
  }
  if (byDomain.has('data') && byDomain.has('application')) {
    const application = byDomain.get('application');
    relationships.push(relation('CONSUMES_CONTRACT', 'specialist:data', application.id, 'Application work consumes the canonical data contract.', application.traceability));
  }
  if (byDomain.has('application') && byDomain.has('experience')) {
    const experience = byDomain.get('experience');
    relationships.push(relation('CONSUMES_CONTRACT', 'specialist:application', experience.id, 'Client work consumes the versioned application contract.', experience.traceability));
  }

  const governedTargets = ['data', 'application', 'experience', 'platform'].filter((domain) => byDomain.has(domain));
  const quality = byDomain.get('quality');
  if (quality) {
    for (const domain of governedTargets) {
      relationships.push(relation('VERIFIES', quality.id, byDomain.get(domain).id, 'Independent verification evaluates this engineering artifact.', quality.traceability));
    }
  }
  const security = byDomain.get('security');
  if (security) {
    for (const domain of governedTargets) {
      relationships.push(relation('GOVERNS', security.id, byDomain.get(domain).id, 'Independent security review gates unresolved material risk.', security.traceability));
    }
  }
  const platform = byDomain.get('platform');
  if (platform) {
    for (const domain of ['data', 'application', 'experience'].filter((candidate) => byDomain.has(candidate))) {
      const target = byDomain.get(domain);
      relationships.push(relation('DEPLOYS', platform.id, target.id, 'The platform specialist supplies reproducible delivery and rollback.', platform.traceability));
      relationships.push(relation('OBSERVES', platform.id, target.id, 'The platform specialist instruments runtime behavior and failure signals.', platform.traceability));
    }
  }

  const unique = new Map();
  for (const item of relationships) unique.set(`${item.type}:${item.from}:${item.to}`, item);
  return [...unique.values()].sort((left, right) => compareText(left.id, right.id));
}

function unpackInput(input, positionalEvidence, positionalAgents) {
  if (Array.isArray(input) || typeof input === 'string') {
    return { intents: input, evidence: positionalEvidence, agents: positionalAgents, relationships: [], budget: {} };
  }
  if (!input || typeof input !== 'object') return { intents: [], evidence: [], agents: [], relationships: [], budget: {} };
  const hasEnvelope = input.intentMap !== undefined
    || input.intentNodes !== undefined
    || input.intentNode !== undefined
    || input.evidenceSummaries !== undefined
    || input.agentCatalog !== undefined;
  if (!hasEnvelope) return { intents: input, evidence: positionalEvidence, agents: positionalAgents, relationships: [], budget: {} };
  const intentMap = input.intentMap;
  const catalog = input.agentCatalog ?? input.agents ?? positionalAgents;
  const evidence = input.evidenceSummaries ?? input.evidence ?? positionalEvidence;
  return {
    intents: input.intentNodes ?? input.intentNode ?? intentMap?.nodes ?? intentMap,
    evidence: evidence?.items ?? evidence?.summaries ?? evidence,
    agents: catalog?.agents ?? catalog?.items ?? catalog?.archetypes ?? catalog,
    relationships: intentMap?.relationships ?? intentMap?.edges ?? input.intentRelationships ?? [],
    budget: input.budget ?? input.budgets ?? {},
  };
}

export function compileIntentMap(input, positionalEvidence = [], positionalAgents = []) {
  const unpacked = unpackInput(input, positionalEvidence, positionalAgents);
  const intents = normalizeIntents(unpacked.intents);
  const evidence = normalizeEvidence(unpacked.evidence);
  const agents = normalizeAgents(unpacked.agents);
  validateIntentDependencies(intents, unpacked.relationships);
  const budget = normalizeBudget(unpacked.budget);
  const domains = selectDomains(intents, evidence);
  if (domains.length > budget.maxNodes) {
    throw new IntentCompilerError('NODE_BUDGET_EXCEEDED', `The right-sized proposal needs ${domains.length} nodes but maxNodes is ${budget.maxNodes}.`, { domains });
  }

  const usedAgents = new Set();
  const nodes = domains.map((domain) => {
    const independent = domain === 'quality' || domain === 'security';
    const agent = assignAgent(domain, agents, usedAgents, independent);
    usedAgents.add(agent.agentId);
    return makeNode(domain, sourceTrace(domain, intents, evidence), agent, domains);
  });
  const relationships = buildRelationships(nodes);
  if (relationships.length > budget.maxRelationships) {
    throw new IntentCompilerError('RELATIONSHIP_BUDGET_EXCEEDED', `The proposal needs ${relationships.length} relationships but maxRelationships is ${budget.maxRelationships}.`);
  }

  const source = {
    intentNodeIds: intents.map((item) => item.id),
    evidenceIds: evidence.map((item) => item.id),
  };
  const proposalCore = {
    schemaVersion: 'intent-proposed-graph/v1',
    type: 'PROPOSED_GRAPH',
    status: 'PROPOSED',
    deterministic: true,
    compilerVersion: 'intent-map-compiler/1.0.0',
    domainModel: [...ENGINEERING_DOMAINS],
    selectedDomains: [...domains],
    source,
    nodes,
    relationships,
    budget,
    stop: {
      maxPlanRevisions: 3,
      maxNoProgressRevisions: 1,
      conditions: ['approved', 'rejected', 'budget_exhausted', 'no_progress', 'human_stop'],
    },
  };
  const proposalId = `proposal:${sha256(canonicalJson(proposalCore)).slice(7, 31)}`;
  const proposedGraph = {
    ...proposalCore,
    proposalId,
    contentDigest: sha256(canonicalJson({ ...proposalCore, proposalId })),
  };
  validateProposedGraph(proposedGraph);
  return proposedGraph;
}

function boundedProviderText(value, label, maximum) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maximum || normalized.includes('\0')) {
    throw new IntentCompilerError('INVALID_AI_PROPOSAL', `${label} must contain 1 to ${maximum} characters.`);
  }
  return normalized;
}

function providerTraceability(value, intentIds, evidenceIds, label, fallback) {
  const raw = value && typeof value === 'object' ? value : {};
  const intentNodeIds = uniqueSorted(asArray(raw.intentNodeIds ?? fallback?.intentNodeIds).map(String));
  const linkedEvidenceIds = uniqueSorted(asArray(raw.evidenceIds ?? fallback?.evidenceIds).map(String));
  if (!intentNodeIds.length || intentNodeIds.some((id) => !intentIds.has(id))) {
    throw new IntentCompilerError('MISSING_TRACEABILITY', `${label} must cite one or more supplied intent node ids.`);
  }
  if (linkedEvidenceIds.some((id) => !evidenceIds.has(id))) {
    throw new IntentCompilerError('MISSING_TRACEABILITY', `${label} cites evidence that was not supplied to the planner.`);
  }
  return { intentNodeIds, evidenceIds: linkedEvidenceIds };
}

function providerPorts(value, nodeId, direction) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new IntentCompilerError('MISSING_PORTS', `Node ${nodeId} requires 1 to 20 typed ${direction} ports.`);
  }
  const ports = value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new IntentCompilerError('MISSING_PORTS', `Node ${nodeId} has an invalid ${direction} port.`);
    }
    return {
      id: boundedProviderText(raw.id, `Node ${nodeId} ${direction} port ${index + 1} id`, 200),
      type: boundedProviderText(raw.type, `Node ${nodeId} ${direction} port ${index + 1} type`, 200),
      required: raw.required !== false,
      provenanceRequired: raw.provenanceRequired !== false,
    };
  });
  if (new Set(ports.map((port) => port.id)).size !== ports.length) {
    throw new IntentCompilerError('DUPLICATE_ID', `Node ${nodeId} has duplicate ${direction} port ids.`);
  }
  return ports;
}

function normalizedRelationshipType(value, label) {
  const type = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!RELATIONSHIP_TYPE_PATTERN.test(type)) {
    throw new IntentCompilerError('INVALID_RELATIONSHIP', `${label} requires an uppercase semantic relationship type.`);
  }
  return type;
}

/**
 * Converts a schema-bound model proposal into the canonical immutable graph.
 * The model controls semantic decomposition; the server binds configured agents,
 * prompt revisions, finite budgets, stop rules, and content digests.
 */
export function materializeProviderProposal({
  proposal,
  intentNodes,
  evidenceSummaries = [],
  agentCatalog = [],
  provider = 'configured-ai',
  model = null,
}) {
  if (!proposal || typeof proposal !== 'object' || !Array.isArray(proposal.nodes) || !proposal.nodes.length) {
    throw new IntentCompilerError('INVALID_AI_PROPOSAL', 'The configured AI provider returned no proposal nodes.');
  }
  if (proposal.nodes.length > AI_GRAPH_BUDGET.maxNodes) {
    throw new IntentCompilerError('NODE_BUDGET_EXCEEDED', `The AI proposal exceeds the ${AI_GRAPH_BUDGET.maxNodes}-node safety limit.`);
  }

  const intents = normalizeIntents(intentNodes);
  const evidence = normalizeEvidence(evidenceSummaries);
  const rawAgents = agentCatalog?.agents ?? agentCatalog?.items ?? agentCatalog?.archetypes ?? agentCatalog;
  const agents = normalizeAgents(rawAgents);
  if (!agents.length) {
    throw new IntentCompilerError('AGENT_REQUIRED', 'AI proposal generation requires at least one configured active agent.');
  }
  const intentIds = new Set(intents.map((item) => item.id));
  const evidenceIds = new Set(evidence.map((item) => item.id));
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  const nodes = proposal.nodes.map((raw, index) => {
    if (!raw || typeof raw !== 'object') {
      throw new IntentCompilerError('INVALID_AI_PROPOSAL', `AI proposal node ${index + 1} is invalid.`);
    }
    const id = boundedProviderText(raw.id, `AI proposal node ${index + 1} id`, 200);
    const agentId = boundedProviderText(raw.agentId, `Node ${id} agentId`, 200);
    const agent = agentsById.get(agentId);
    if (!agent) {
      throw new IntentCompilerError('INVALID_AGENT_BINDING', `Node ${id} selected unknown or inactive agent ${agentId}.`);
    }
    const dependsOn = uniqueSorted(asArray(raw.dependsOn).map((dependency) => boundedProviderText(dependency, `Node ${id} dependency`, 200)));
    const acceptanceCriteria = asArray(raw.acceptanceCriteria)
      .map((criterion, criterionIndex) => boundedProviderText(criterion, `Node ${id} acceptance criterion ${criterionIndex + 1}`, 2_000));
    if (!acceptanceCriteria.length || acceptanceCriteria.length > 20) {
      throw new IntentCompilerError('MISSING_ACCEPTANCE_CRITERIA', `Node ${id} requires 1 to 20 acceptance criteria.`);
    }
    const traceability = providerTraceability(raw.traceability, intentIds, evidenceIds, `Node ${id}`);
    return {
      id,
      type: 'SPECIALIST_AGENT',
      domain: boundedProviderText(raw.domain, `Node ${id} domain`, 120),
      title: boundedProviderText(raw.title, `Node ${id} title`, 500),
      objective: boundedProviderText(raw.objective, `Node ${id} objective`, 8_000),
      agentId,
      promptDigest: agent.promptDigest,
      agentAssignment: 'provider-selected',
      traceability,
      inputs: providerPorts(raw.inputs, id, 'input'),
      outputs: providerPorts(raw.outputs, id, 'output'),
      dependsOn,
      acceptanceCriteria,
      budget: { ...DEFAULT_NODE_BUDGET },
      stop: { ...DEFAULT_STOP, conditions: [...DEFAULT_STOP.conditions] },
    };
  });
  assertUniqueIds(nodes, 'AI proposal node');
  const nodeIds = new Set(nodes.map((node) => node.id));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodeIds.has(dependency)) {
        throw new IntentCompilerError('UNKNOWN_DEPENDENCY', `Node ${node.id} depends on unknown node ${dependency}.`);
      }
      if (dependency === node.id) {
        throw new IntentCompilerError('PROPOSED_GRAPH_CYCLE', `Node ${node.id} depends on itself.`);
      }
    }
  }

  const relationships = [];
  const relationshipIds = new Set();
  const relationshipKeys = new Set();
  for (const [index, raw] of asArray(proposal.relationships).entries()) {
    if (!raw || typeof raw !== 'object') {
      throw new IntentCompilerError('INVALID_RELATIONSHIP', `AI relationship ${index + 1} is invalid.`);
    }
    const source = boundedProviderText(raw.source ?? raw.from, `AI relationship ${index + 1} source`, 200);
    const target = boundedProviderText(raw.target ?? raw.to, `AI relationship ${index + 1} target`, 200);
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) {
      throw new IntentCompilerError('INVALID_RELATIONSHIP', `AI relationship ${index + 1} must connect two different proposal nodes.`);
    }
    const type = normalizedRelationshipType(raw.type, `AI relationship ${index + 1}`);
    const key = `${type}:${source}:${target}`;
    if (relationshipKeys.has(key)) continue;
    const id = boundedProviderText(raw.id ?? `relationship:${index + 1}`, `AI relationship ${index + 1} id`, 200);
    if (relationshipIds.has(id)) {
      throw new IntentCompilerError('DUPLICATE_RELATIONSHIP', `AI relationship id ${id} is duplicated.`);
    }
    const fallbackTrace = {
      intentNodeIds: uniqueSorted([
        ...nodeById.get(source).traceability.intentNodeIds,
        ...nodeById.get(target).traceability.intentNodeIds,
      ]),
      evidenceIds: uniqueSorted([
        ...nodeById.get(source).traceability.evidenceIds,
        ...nodeById.get(target).traceability.evidenceIds,
      ]),
    };
    relationships.push({
      id,
      type,
      from: source,
      to: target,
      rationale: boundedProviderText(raw.rationale ?? raw.reason, `AI relationship ${id} rationale`, 2_000),
      traceability: providerTraceability(raw.traceability, intentIds, evidenceIds, `Relationship ${id}`, fallbackTrace),
    });
    relationshipIds.add(id);
    relationshipKeys.add(key);
    if (type === 'REQUIRES' && !nodeById.get(target).dependsOn.includes(source)) {
      nodeById.get(target).dependsOn.push(source);
      nodeById.get(target).dependsOn.sort(compareText);
    }
  }

  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      const key = `REQUIRES:${dependency}:${node.id}`;
      if (relationshipKeys.has(key)) continue;
      const id = `relationship:requires:${dependency}:${node.id}`;
      if (id.length > 200 || relationshipIds.has(id)) {
        throw new IntentCompilerError('INVALID_RELATIONSHIP', `The dependency relationship for ${node.id} cannot be represented safely.`);
      }
      relationships.push({
        id,
        type: 'REQUIRES',
        from: dependency,
        to: node.id,
        rationale: 'The downstream proposal node requires completion of the upstream node.',
        traceability: {
          intentNodeIds: [...node.traceability.intentNodeIds],
          evidenceIds: [...node.traceability.evidenceIds],
        },
      });
      relationshipIds.add(id);
      relationshipKeys.add(key);
    }
  }
  if (relationships.length > AI_GRAPH_BUDGET.maxRelationships) {
    throw new IntentCompilerError('RELATIONSHIP_BUDGET_EXCEEDED', `The AI proposal exceeds the ${AI_GRAPH_BUDGET.maxRelationships}-relationship safety limit.`);
  }

  const source = {
    intentNodeIds: intents.map((item) => item.id),
    evidenceIds: evidence.map((item) => item.id),
  };
  const selectedDomains = uniqueSorted(nodes.map((node) => node.domain));
  const proposalCore = {
    schemaVersion: 'intent-proposed-graph/v2',
    type: 'PROPOSED_GRAPH',
    status: 'PROPOSED',
    deterministic: false,
    compilerVersion: 'configured-ai-proposal/2.0.0',
    generator: { provider, model },
    domainModel: [...selectedDomains],
    selectedDomains,
    source,
    nodes,
    relationships,
    budget: { ...AI_GRAPH_BUDGET },
    stop: {
      maxPlanRevisions: 6,
      maxNoProgressRevisions: 2,
      conditions: ['approved', 'rejected', 'budget_exhausted', 'no_progress', 'human_stop'],
    },
  };
  const proposalId = `proposal:${sha256(canonicalJson(proposalCore)).slice(7, 31)}`;
  const proposedGraph = {
    ...proposalCore,
    proposalId,
    contentDigest: sha256(canonicalJson({ ...proposalCore, proposalId })),
  };
  validateProposedGraph(proposedGraph);
  return proposedGraph;
}

// User configuration wins over inferred configuration, but conflicting source
// intents must be split instead of silently choosing one user's instruction.
export function bindIntentConfiguration(graph, intentNodes = [], agentCatalog = []) {
  const agents = new Map(normalizeAgents(agentCatalog).map((agent) => [agent.id, agent]));
  const definitions = new Map(agentCatalog.map((agent) => [agent.id, agent]));
  const intents = new Map(intentNodes.map((node) => [node.id, node]));
  const nodes = graph.nodes.map((node) => {
    const sources = (node.traceability?.intentNodeIds ?? []).map((id) => intents.get(id)).filter(Boolean);
    const override = {};
    for (const field of ['agentId', 'providerId', 'model', 'skills', 'inputs', 'outputs', 'acceptanceCriteria', 'budgets', 'group', 'review']) {
      const values = sources.map((source) => source[field]).filter((value) => (
        value != null && value !== '' && (Array.isArray(value) ? value.length > 0 : typeof value === 'object' ? Object.keys(value).length > 0 : true)
      ));
      const uniqueValues = [...new Map(values.map((value) => [canonicalJson(value), value])).values()];
      if (uniqueValues.length > 1) throw new IntentCompilerError('NODE_CONFIGURATION_CONFLICT', `Node ${node.id} combines conflicting ${field} settings. Split the source intents into separate proposal nodes.`);
      if (uniqueValues.length) override[field] = uniqueValues[0];
    }
    const agent = agents.get(override.agentId ?? node.agentId);
    const defaults = definitions.get(override.agentId ?? node.agentId) ?? {};
    if (override.agentId && !agent) throw new IntentCompilerError('INVALID_AGENT_BINDING', `Node ${node.id} selects unknown or inactive agent ${override.agentId}.`);
    const configuredPorts = (values, kind) => values.map((description, index) => ({ id: `${node.id}:${kind}:${index + 1}`, type: 'text', description }));
    return {
      ...node,
      ...(override.group ? { group: override.group } : {}),
      ...(override.agentId ? { agentId: override.agentId, promptDigest: agent.promptDigest, agentAssignment: 'user-configured' } : {}),
      ...(override.providerId || defaults.providerId ? { providerId: override.providerId || defaults.providerId } : {}),
      ...(override.model || defaults.model ? { model: override.model || defaults.model } : {}),
      ...(override.skills || defaults.skillIds?.length ? { configuredSkillIds: override.skills || defaults.skillIds } : {}),
      ...(override.inputs ? { inputs: configuredPorts(override.inputs, 'input') } : {}),
      ...(override.outputs ? { outputs: configuredPorts(override.outputs, 'output') } : {}),
      ...(override.acceptanceCriteria ? { acceptanceCriteria: override.acceptanceCriteria } : {}),
      ...(override.budgets ? { budgets: override.budgets, budget: { ...node.budget, ...(override.budgets.timeoutMs ? { timeoutMs: override.budgets.timeoutMs } : {}) } } : {}),
      ...(override.review ? { review: override.review } : {}),
      ...(sources.some((source) => source.breakpoint === true) ? { breakpoint: true } : {}),
    };
  });
  const { contentDigest: _digest, proposalId: _id, ...core } = graph;
  const updatedCore = { ...core, nodes };
  const proposalId = `proposal:${sha256(canonicalJson(updatedCore)).slice(7, 31)}`;
  const updated = { ...updatedCore, proposalId, contentDigest: sha256(canonicalJson({ ...updatedCore, proposalId })) };
  validateProposedGraph(updated);
  return updated;
}

export function validateProposedGraph(graph) {
  if (!graph || typeof graph !== 'object' || !Array.isArray(graph.nodes) || !graph.nodes.length) {
    throw new IntentCompilerError('INVALID_PROPOSED_GRAPH', 'A proposed graph requires at least one node.');
  }
  const requiredPositiveBudgetFields = ['maxNodes', 'maxRelationships', 'maxTotalSteps', 'maxTotalTokens', 'timeoutMs'];
  if (!graph.budget
    || requiredPositiveBudgetFields.some((field) => !Number.isSafeInteger(graph.budget[field]) || graph.budget[field] < 1)
    || !Number.isSafeInteger(graph.budget.maxCostMicrounits) || graph.budget.maxCostMicrounits < 0
    || graph.nodes.length > graph.budget.maxNodes) {
    throw new IntentCompilerError('NODE_BUDGET_EXCEEDED', 'The proposed graph exceeds its node budget.');
  }
  if (!graph.stop || !Number.isSafeInteger(graph.stop.maxPlanRevisions) || graph.stop.maxPlanRevisions < 1
    || !Number.isSafeInteger(graph.stop.maxNoProgressRevisions) || graph.stop.maxNoProgressRevisions < 1
    || !Array.isArray(graph.stop.conditions) || !graph.stop.conditions.length) {
    throw new IntentCompilerError('UNBOUNDED_LOOP', 'The proposed graph requires finite planning stop conditions.');
  }
  const ids = graph.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) throw new IntentCompilerError('DUPLICATE_NODE', 'Proposed node ids must be unique.');
  const idSet = new Set(ids);
  const dependencies = new Map();
  for (const node of graph.nodes) {
    if (typeof node.domain !== 'string' || !node.domain.trim() || node.domain.length > 120) {
      throw new IntentCompilerError('INVALID_DOMAIN', `Node ${node.id} requires a bounded semantic domain.`);
    }
    if (typeof node.agentId !== 'string' || !node.agentId || !/^sha256:[a-f0-9]{64}$/.test(node.promptDigest || '')) {
      throw new IntentCompilerError('INVALID_AGENT_BINDING', `Node ${node.id} requires an agentId and SHA-256 promptDigest.`);
    }
    if (!node.traceability?.intentNodeIds?.length || !Array.isArray(node.traceability.evidenceIds)) {
      throw new IntentCompilerError('MISSING_TRACEABILITY', `Node ${node.id} must trace to source intent and evidence ids.`);
    }
    if (!Array.isArray(node.inputs) || !node.inputs.length || !Array.isArray(node.outputs) || !node.outputs.length) {
      throw new IntentCompilerError('MISSING_PORTS', `Node ${node.id} requires typed inputs and outputs.`);
    }
    if (!Array.isArray(node.acceptanceCriteria) || !node.acceptanceCriteria.length) {
      throw new IntentCompilerError('MISSING_ACCEPTANCE_CRITERIA', `Node ${node.id} requires acceptance criteria.`);
    }
    if (!node.budget || Object.values(node.budget).some((value) => !Number.isSafeInteger(value) || value < 0)) {
      throw new IntentCompilerError('INVALID_BUDGET', `Node ${node.id} has an invalid budget.`);
    }
    if (!node.stop || !Number.isSafeInteger(node.stop.maxIterations) || node.stop.maxIterations < 1
      || !Number.isSafeInteger(node.stop.maxNoProgressIterations) || node.stop.maxNoProgressIterations < 1
      || !Array.isArray(node.stop.conditions) || !node.stop.conditions.length) {
      throw new IntentCompilerError('UNBOUNDED_LOOP', `Node ${node.id} requires finite stop conditions.`);
    }
    const nodeDependencies = new Set(node.dependsOn || []);
    for (const dependency of nodeDependencies) {
      if (!idSet.has(dependency)) throw new IntentCompilerError('UNKNOWN_DEPENDENCY', `Node ${node.id} depends on unknown node ${dependency}.`);
      if (dependency === node.id) throw new IntentCompilerError('PROPOSED_GRAPH_CYCLE', `Node ${node.id} depends on itself.`);
    }
    dependencies.set(node.id, nodeDependencies);
  }
  assertAcyclic(ids, dependencies, 'PROPOSED_GRAPH_CYCLE', 'The proposed graph contains a dependency cycle.');

  const relationshipKeys = new Set();
  for (const item of graph.relationships || []) {
    if (!RELATIONSHIP_TYPE_PATTERN.test(item.type || '')) {
      throw new IntentCompilerError('INVALID_RELATIONSHIP', `Relationship ${item.id} has an invalid semantic type ${item.type}.`);
    }
    const key = `${item.type}:${item.from}:${item.to}`;
    if (relationshipKeys.has(key)) throw new IntentCompilerError('DUPLICATE_RELATIONSHIP', `Relationship ${key} is duplicated.`);
    relationshipKeys.add(key);
    if (!item.traceability?.intentNodeIds?.length || !Array.isArray(item.traceability.evidenceIds)) {
      throw new IntentCompilerError('MISSING_TRACEABILITY', `Relationship ${item.id} lacks source traceability.`);
    }
    if (item.type === 'REQUIRES' && (!idSet.has(item.from) || !idSet.has(item.to)
      || !dependencies.get(item.to)?.has(item.from))) {
      throw new IntentCompilerError('INCONSISTENT_DEPENDENCY', `Relationship ${item.id} does not match node dependencies.`);
    }
  }
  if ((graph.relationships?.length ?? 0) > graph.budget.maxRelationships) {
    throw new IntentCompilerError('RELATIONSHIP_BUDGET_EXCEEDED', 'The proposed graph exceeds its relationship budget.');
  }
  return true;
}
