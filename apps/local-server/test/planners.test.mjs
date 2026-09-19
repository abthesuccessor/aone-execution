import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_AGENT_ARCHETYPES, createContentDigest } from '../src/agents.mjs';
import { compileIntentMap } from '../src/intent_compiler.mjs';
import { buildCodexPlannerArguments, captureWorkspaceBaseline, createPlanContent } from '../src/planners.mjs';
import { createResearchPolicy } from '../src/research_policy.mjs';

const skill = {
  id: 'skill-engineering',
  name: 'engineering-evidence',
  contentDigest: 'a'.repeat(64),
  packageDigest: 'b'.repeat(64),
  packageFiles: [{ path: 'SKILL.md', bytes: 256, sha256: 'c'.repeat(64) }],
  packageBytes: 256,
};

const skillCatalog = {
  selectRelevantMetadata() {
    return [skill];
  },
  resolveMetadata(ids) {
    return ids.includes(skill.id) ? [skill] : [];
  },
  async readSelectedContents(ids) {
    return ids.includes(skill.id) ? [{ ...skill, content: 'Use evidence, acceptance criteria, and receipts.' }] : [];
  },
  routingManifest() {
    return {
      mode: 'agent-managed', selectorVersion: 'test-selector-v1', maxSkillsPerNode: 4,
      catalogCount: 1, catalogDigest: `sha256:${'d'.repeat(64)}`,
    };
  },
};

async function fixture(context) {
  const workspacePath = await mkdtemp(join(tmpdir(), 'ege-planner-test-'));
  execFileSync('git', ['init', '--quiet', workspacePath]);
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  const draft = {
    revision: 3,
    context: 'Build from the supplied requirements and preserve traceability.',
    nodes: [{
      id: 'intent-api',
      title: 'Customer API',
      kind: 'custom',
      description: 'Implement a secure API with deterministic tests.',
      context: 'The API must preserve idempotency and provide failure receipts.',
    }],
    edges: [],
  };
  const evidenceManifest = {
    sources: [{ id: 'evidence-brd', nodeId: 'intent-api', filename: 'BRD.md', sha256: 'd'.repeat(64) }],
    excerpts: [{ sourceId: 'evidence-brd', chunkId: 'chunk-1', text: 'The API requires deterministic acceptance tests.' }],
  };
  evidenceManifest.digest = createContentDigest(evidenceManifest);
  const evidenceSummaries = [{
    id: 'evidence-brd',
    sourceNodeIds: ['intent-api'],
    summary: 'BRD API, security, and deterministic test requirements.',
  }];
  const proposedGraph = compileIntentMap({
    intentNodes: draft.nodes,
    evidenceSummaries,
    agentCatalog: { archetypes: DEFAULT_AGENT_ARCHETYPES },
  });
  return {
    graph: { id: 'graph-1', name: 'Customer API', description: 'Planner test', workspacePath },
    draft,
    evidenceManifest,
    evidenceSummaries,
    agentCatalog: DEFAULT_AGENT_ARCHETYPES,
    proposedGraph,
  };
}

function rawProviderPlan(proposedGraph) {
  const nodeIds = new Set(proposedGraph.nodes.map((node) => node.id));
  return {
    summary: 'Execute the configured AI provider proposal.',
    nodes: proposedGraph.nodes.map((node) => ({
      id: node.id,
      domain: node.domain,
      title: node.title,
      objective: `Deliver ${node.objective}`,
      agentId: node.agentId,
      acceptanceCriteria: [...node.acceptanceCriteria],
      dependsOn: [...node.dependsOn],
      inputs: node.inputs.map((port) => ({
        id: port.id,
        type: port.type,
        required: port.required !== false,
        provenanceRequired: port.provenanceRequired !== false,
      })),
      outputs: node.outputs.map((port) => ({
        id: port.id,
        type: port.type,
        required: port.required !== false,
        provenanceRequired: port.provenanceRequired !== false,
      })),
      traceability: node.traceability,
    })),
    relationships: proposedGraph.relationships
      .filter((relationship) => nodeIds.has(relationship.from) && nodeIds.has(relationship.to))
      .map((relationship) => ({
        id: relationship.id,
        source: relationship.from,
        target: relationship.to,
        type: relationship.type,
        rationale: relationship.rationale,
        traceability: relationship.traceability,
      })),
  };
}

function responseJson(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('simulation binds proposed specialist nodes, evidence, agents, prompts, automatic skills, relationships, and git baseline', async (context) => {
  const input = await fixture(context);
  const result = await createPlanContent({
    provider: 'simulation',
    ...input,
    previousPlan: null,
    skillCatalog,
    instructions: 'Keep the plan bounded.',
  });

  assert.equal(result.plan.steps.length, input.proposedGraph.nodes.length);
  assert.equal(result.plan.proposalId, input.proposedGraph.proposalId);
  assert.deepEqual(result.plan.proposedGraph, input.proposedGraph);
  assert.deepEqual(result.plan.relationships, input.proposedGraph.relationships);
  assert.equal(result.plan.contextManifest.workspaceBaseline.kind, 'git');
  assert.equal(result.plan.contextManifest.workspaceBaseline.head, 'UNBORN');
  assert.match(result.plan.contextManifest.workspaceBaseline.statusDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.plan.contextManifest.workspaceBaseline.trackedContentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(result.plan.contextManifest.workspaceBaseline.untrackedContentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.plan.contextManifest.evidenceManifest, input.evidenceManifest);
  assert.equal(result.plan.contextManifest.researchPolicy.enabled, false);
  assert.equal(result.plan.contextManifest.researchPolicy.mode, 'disabled');
  assert.equal(result.plan.contextManifest.skillRouting.mode, 'agent-managed');
  assert.match(result.plan.contextManifest.researchPolicy.digest, /^[a-f0-9]{64}$/);

  for (const step of result.plan.steps) {
    const proposal = input.proposedGraph.nodes.find((node) => node.id === step.nodeId);
    assert.equal(step.agentId, proposal.agentId);
    assert.equal(step.promptDigest, proposal.promptDigest);
    assert.deepEqual(step.sourceIntentNodeIds, proposal.traceability.intentNodeIds);
    assert.deepEqual(step.sourceEvidenceIds, proposal.traceability.evidenceIds);
    assert.deepEqual(step.sourceIntents, [{
      id: 'intent-api',
      title: 'Customer API',
      objective: 'Implement a secure API with deterministic tests.',
      context: 'The API must preserve idempotency and provide failure receipts.',
    }]);
    assert.deepEqual(step.skills.map((binding) => binding.id), [skill.id]);
    assert.match(step.inputDigest, /^[a-f0-9]{64}$/);
  }
  const requirementsStep = result.plan.steps.find((step) => step.nodeId === 'specialist:product');
  assert.match(requirementsStep.objective, /Source intent: Customer API: Implement a secure API with deterministic tests\./);
  assert.deepEqual(result.plan.contextManifest.selectedSkills.map((binding) => binding.id), [skill.id]);
  assert.equal(result.contentHash.length, 64);
});

test('local agents use the fast context planner without a model request or project scan', async (context) => {
  const input = await fixture(context);
  let networkCalled = false;
  const startedAt = performance.now();
  const result = await createPlanContent({
    provider: 'local-agents',
    ...input,
    graph: { ...input.graph, workspacePath: join(input.graph.workspacePath, 'missing-project') },
    previousPlan: null,
    skillCatalog,
    instructions: 'Focus on the memory architecture in this node.',
    providerProfile: {
      id: 'codex-cli', label: 'Codex CLI', kind: 'cli', enabled: true,
      model: 'gpt-5.6-terra', options: {},
    },
    fetchImpl: async () => {
      networkCalled = true;
      throw new Error('The local planner must not make a network request.');
    },
  });
  const elapsedMs = performance.now() - startedAt;

  assert.equal(networkCalled, false);
  assert.ok(elapsedMs < 1_000, `local-agent planning took ${elapsedMs.toFixed(1)}ms`);
  assert.equal(result.plan.contextManifest.workspaceBaseline.kind, 'local-context');
  assert.equal(result.plan.contextManifest.workspaceBaseline.marker, 'LOCAL_AGENT_PLANNER_NO_PROJECT_SCAN');
  assert.match(result.plan.summary, /context-specific specialist nodes locally/i);
  assert.equal(result.plan.steps.length, input.proposedGraph.nodes.length);
  assert.deepEqual(result.proposedGraph, input.proposedGraph);
});

test('Codex planner arguments pin web search disabled by default and live only after opt-in', () => {
  const base = { workspacePath: '/tmp/workspace', outputPath: '/tmp/plan.json' };
  const disabled = buildCodexPlannerArguments({
    ...base,
    researchPolicy: createResearchPolicy({}, 'codex-cli'),
  });
  assert.deepEqual(disabled.slice(0, 4), ['--strict-config', '-c', 'web_search="disabled"', 'exec']);
  assert.equal(disabled.includes('--search'), false);
  assert.ok(disabled.indexOf('--strict-config') < disabled.indexOf('exec'));

  const live = buildCodexPlannerArguments({
    ...base,
    model: 'gpt-test',
    researchPolicy: createResearchPolicy({ enabled: true }, 'codex-cli'),
  });
  assert.deepEqual(live.slice(0, 3), ['--strict-config', '--search', 'exec']);
  assert.ok(live.indexOf('--search') < live.indexOf('exec'));
  assert.deepEqual(live.slice(-3), ['--model', 'gpt-test', '-']);
});

test('workspace baseline detects content drift even when porcelain status is unchanged', async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'ege-baseline-test-'));
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', workspacePath]);

  const untrackedPath = join(workspacePath, 'untracked.txt');
  await writeFile(untrackedPath, 'alpha');
  const untrackedBefore = await captureWorkspaceBaseline(workspacePath);
  await writeFile(untrackedPath, 'bravo');
  const untrackedAfter = await captureWorkspaceBaseline(workspacePath);
  assert.equal(untrackedAfter.statusDigest, untrackedBefore.statusDigest);
  assert.notEqual(untrackedAfter.untrackedContentDigest, untrackedBefore.untrackedContentDigest);

  await writeFile(join(workspacePath, 'tracked.txt'), 'first');
  execFileSync('git', ['-C', workspacePath, 'add', 'tracked.txt']);
  execFileSync('git', [
    '-C', workspacePath, '-c', 'user.name=EGE Test', '-c', 'user.email=ege@example.invalid',
    'commit', '--quiet', '-m', 'baseline',
  ]);
  await writeFile(join(workspacePath, 'tracked.txt'), 'alpha');
  const trackedBefore = await captureWorkspaceBaseline(workspacePath);
  await writeFile(join(workspacePath, 'tracked.txt'), 'bravo');
  const trackedAfter = await captureWorkspaceBaseline(workspacePath);
  assert.equal(trackedAfter.statusDigest, trackedBefore.statusDigest);
  assert.notEqual(trackedAfter.trackedContentDigest, trackedBefore.trackedContentDigest);
});

test('workspace baseline resolves untracked paths from a repository subdirectory against the Git root', async (context) => {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'ege-subdirectory-baseline-test-'));
  context.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', repositoryRoot]);
  const workspacePath = join(repositoryRoot, 'apps', 'local-server');
  await mkdir(join(workspacePath, 'src'), { recursive: true });
  await writeFile(join(workspacePath, 'src', 'agents.mjs'), 'export const agents = [];\n');

  const baseline = await captureWorkspaceBaseline(workspacePath);
  assert.equal(baseline.kind, 'git');
  assert.equal(baseline.untrackedFileCount, 1);
  assert.match(baseline.untrackedContentDigest, /^sha256:[a-f0-9]{64}$/);
});

test('non-Git workspace baseline binds bounded file content instead of a static marker', async (context) => {
  const workspacePath = await mkdtemp(join(tmpdir(), 'ege-no-git-baseline-test-'));
  context.after(() => rm(workspacePath, { recursive: true, force: true }));
  const file = join(workspacePath, 'requirements.md');
  await writeFile(file, 'first requirement');
  const before = await captureWorkspaceBaseline(workspacePath);
  await writeFile(file, 'changed requirement');
  const after = await captureWorkspaceBaseline(workspacePath);
  assert.equal(before.kind, 'no-git');
  assert.match(before.contentDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(before.fileCount, 1);
  assert.notEqual(after.contentDigest, before.contentDigest);
});

test('OpenAI Responses adapter uses strict structured output and resolves only its canonical environment secret', async (context) => {
  const input = await fixture(context);
  const rawPlan = rawProviderPlan(input.proposedGraph);
  const calls = [];
  const secretValue = 'openai-test-secret-value';
  const result = await createPlanContent({
    provider: 'openai-api',
    engineeringContext: { profile: 'poc', conventions: 'Keep the existing stack.', environment: { tools: [{ id: 'node', available: false, version: null }] }, memory: { context: 'Confirmed: one deployable application.' } },
    ...input,
    previousPlan: null,
    skillCatalog,
    providerProfile: {
      id: 'openai-api', kind: 'api', enabled: true, model: 'gpt-test',
      baseUrl: 'https://api.openai.com/v1', secretEnvName: 'OPENAI_API_KEY', options: {},
    },
    environment: { OPENAI_API_KEY: secretValue },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return responseJson({ id: 'resp-test', status: 'completed', output_text: JSON.stringify(rawPlan) });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${secretValue}`);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.store, false);
  assert.equal(body.text.format.type, 'json_schema');
  assert.equal(body.text.format.strict, true);
  assert.match(body.instructions, /Dynamically decompose/);
  assert.match(body.instructions, /Honor explicit user node configuration and skill selections/i);
  assert.doesNotMatch(body.input, /Typed proposed graph/);
  assert.match(body.input, /Configured execution agents/);
  assert.match(body.input, /"profile":"poc"/);
  assert.match(body.input, /Keep the existing stack/);
  assert.match(body.input, /Confirmed: one deployable application/);
  assert.match(body.input, /"id":"node","available":false/);
  assert.match(body.input, /Automatically routed skill guidance/);
  assert.doesNotMatch(body.input, /Explicitly selected skills/);
  assert.equal(JSON.stringify(body).includes(secretValue), false);
  assert.equal(JSON.stringify(result.plan).includes(secretValue), false);
  assert.deepEqual(result.plan.steps[0].skills.map((binding) => binding.id), [skill.id]);
  assert.equal(result.proposedGraph.deterministic, false);
  assert.equal(result.proposedGraph.generator.provider, 'openai-api');
});

test('Anthropic Messages adapter uses output_config JSON schema and never persists its key', async (context) => {
  const input = await fixture(context);
  const rawPlan = rawProviderPlan(input.proposedGraph);
  let call;
  const secretValue = 'anthropic-test-secret-value';
  const result = await createPlanContent({
    provider: 'anthropic-api',
    ...input,
    previousPlan: null,
    skillCatalog,
    providerProfile: {
      id: 'anthropic-api', kind: 'api', enabled: true, model: 'claude-test',
      baseUrl: 'https://api.anthropic.com/v1', secretEnvName: 'ANTHROPIC_API_KEY', options: {},
    },
    environment: { ANTHROPIC_API_KEY: secretValue },
    fetchImpl: async (url, options) => {
      call = { url, options };
      return responseJson({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(rawPlan) }] });
    },
  });

  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(call.options.headers['x-api-key'], secretValue);
  assert.equal(call.options.headers['anthropic-version'], '2023-06-01');
  const body = JSON.parse(call.options.body);
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(JSON.stringify(body).includes(secretValue), false);
  assert.equal(JSON.stringify(result.plan).includes(secretValue), false);
});

test('Ollama adapter is restricted to loopback and sends a non-streaming schema-bound chat request', async (context) => {
  const input = await fixture(context);
  const rawPlan = rawProviderPlan(input.proposedGraph);
  let call;
  const result = await createPlanContent({
    provider: 'ollama',
    ...input,
    previousPlan: null,
    skillCatalog,
    providerProfile: {
      id: 'ollama', kind: 'local-api', enabled: true, model: 'qwen-test',
      baseUrl: 'http://127.0.0.1:11434', options: {},
    },
    fetchImpl: async (url, options) => {
      call = { url, options };
      return responseJson({ done: true, done_reason: 'stop', message: { content: JSON.stringify(rawPlan) } });
    },
  });

  assert.equal(call.url, 'http://127.0.0.1:11434/api/chat');
  const body = JSON.parse(call.options.body);
  assert.equal(body.stream, false);
  assert.equal(body.format.type, 'object');
  assert.equal(result.plan.steps.length, input.proposedGraph.nodes.length);

  await assert.rejects(
    createPlanContent({
      provider: 'ollama', ...input, previousPlan: null, skillCatalog,
      providerProfile: {
        id: 'ollama', kind: 'local-api', enabled: true, model: 'qwen-test',
        baseUrl: 'https://remote.example.com', options: {},
      },
      fetchImpl: async () => { throw new Error('must not be called'); },
    }),
    (error) => error.code === 'PROVIDER_CONFIG_INVALID' && /loopback/.test(error.message),
  );
});

test('missing secrets and unimplemented CLI providers fail closed without making a request', async (context) => {
  const input = await fixture(context);
  let called = false;
  await assert.rejects(
    createPlanContent({
      provider: 'openai-api', ...input, previousPlan: null, skillCatalog,
      providerProfile: {
        id: 'openai-api', kind: 'api', enabled: true, model: 'gpt-test',
        secretEnvName: 'OPENAI_API_KEY', options: {},
      },
      environment: {},
      fetchImpl: async () => { called = true; },
    }),
    (error) => error.code === 'PROVIDER_SECRET_MISSING' && !error.message.includes('OPENAI_API_KEY'),
  );
  assert.equal(called, false);

  await assert.rejects(
    createPlanContent({
      provider: 'openai-api', ...input, previousPlan: null, skillCatalog,
      providerProfile: {
        id: 'openai-api', kind: 'api', enabled: true, model: 'gpt-test',
        secretEnvName: 'AWS_SECRET_ACCESS_KEY', options: {},
      },
      environment: { AWS_SECRET_ACCESS_KEY: 'must-not-leave-process' },
      fetchImpl: async () => { called = true; },
    }),
    (error) => error.code === 'PROVIDER_CONFIG_INVALID' && !error.message.includes('AWS_SECRET_ACCESS_KEY'),
  );
  assert.equal(called, false);

  for (const provider of ['claude-cli', 'copilot-cli']) {
    await assert.rejects(
      createPlanContent({ provider, ...input, previousPlan: null, skillCatalog }),
      (error) => error.code === 'PROVIDER_NOT_ENABLED',
    );
  }
});
