import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENGINEERING_DOMAINS,
  IntentCompilerError,
  RELATIONSHIP_TYPES,
  compileIntentMap,
  materializeProviderProposal,
  validateProposedGraph,
} from '../src/intent_compiler.mjs';
import { DEFAULT_AGENT_ARCHETYPES } from '../src/agents.mjs';

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

const agentCatalog = [
  ['product-agent', 'product', 'requirements traceability', '1'],
  ['experience-agent', 'experience', 'frontend ui accessibility', '2'],
  ['application-agent', 'application', 'backend api distributed systems', '3'],
  ['data-agent', 'data', 'database retrieval ranking rrf', '4'],
  ['platform-agent', 'platform', 'deployment observability flamegraph', '5'],
  ['quality-agent', 'quality', 'independent test evaluation validation', '6'],
  ['security-agent', 'security', 'independent threat security governance', '7'],
].map(([id, domain, description, character]) => ({ id, domains: [domain], description, promptDigest: digest(character) }));

test('compiles a broad intent map into seven bounded, typed, traceable specialists', () => {
  const input = {
    intentNodes: [{
      id: 'intent-brd',
      title: 'Customer portal',
      objective: 'Build an accessible frontend and GraphQL backend with PostgreSQL, retrieval using RRF, deployment, monitoring, and flamegraph profiling.',
    }],
    evidenceSummaries: [
      { id: 'evidence-brd-sheet', summary: 'BRD acceptance flows, database schema, API contract, UI states, security constraints, tests, and Kubernetes release requirements.', sourceNodeIds: ['intent-brd'] },
    ],
    agentCatalog,
  };

  const graph = compileIntentMap(input);
  assert.deepEqual(graph.selectedDomains, ['product', 'data', 'application', 'experience', 'quality', 'security', 'platform']);
  assert.equal(graph.nodes.length, ENGINEERING_DOMAINS.length);
  assert.equal(validateProposedGraph(graph), true);
  assert.match(graph.proposalId, /^proposal:[a-f0-9]{24}$/);
  assert.match(graph.contentDigest, /^sha256:[a-f0-9]{64}$/);

  for (const node of graph.nodes) {
    assert.ok(node.agentId);
    assert.match(node.promptDigest, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(node.traceability.intentNodeIds, ['intent-brd']);
    assert.deepEqual(node.traceability.evidenceIds, ['evidence-brd-sheet']);
    assert.ok(node.acceptanceCriteria.length >= 2);
    assert.ok(node.inputs.length && node.outputs.length);
    assert.ok(node.budget.maxSteps > 0 && node.budget.timeoutMs > 0);
    assert.ok(node.stop.maxIterations > 0 && node.stop.maxNoProgressIterations > 0);
  }

  const types = new Set(graph.relationships.map((relationship) => relationship.type));
  assert.deepEqual([...RELATIONSHIP_TYPES].filter((type) => !types.has(type)), []);
  assert.notEqual(graph.nodes.find((node) => node.domain === 'quality').agentId, graph.nodes.find((node) => node.domain === 'application').agentId);
  assert.notEqual(graph.nodes.find((node) => node.domain === 'security').agentId, graph.nodes.find((node) => node.domain === 'application').agentId);
  const applicationCriteria = graph.nodes.find((node) => node.domain === 'application').acceptanceCriteria.join('\n');
  const qualityCriteria = graph.nodes.find((node) => node.domain === 'quality').acceptanceCriteria.join('\n');
  assert.match(applicationCriteria, /high-level design defines system boundaries/);
  assert.match(applicationCriteria, /low-level design defines modules, interfaces, schemas/);
  assert.match(qualityCriteria, /High-level and low-level designs are independently checked/);
});

test('right-sizes a narrow request instead of expanding every domain template', () => {
  const graph = compileIntentMap({
    intentNode: { id: 'intent-cli', objective: 'Implement a deterministic command-line algorithm in Rust.' },
    agentCatalog,
  });

  assert.deepEqual(graph.selectedDomains, ['product', 'application', 'quality', 'security']);
  assert.equal(graph.nodes.some((node) => node.domain === 'experience'), false);
  assert.equal(graph.nodes.some((node) => node.domain === 'data'), false);
  assert.equal(graph.nodes.some((node) => node.domain === 'platform'), false);
});

test('is byte-stable for the same normalized inputs and can use bounded builtin specialists', () => {
  const input = [{ id: 'intent-one', text: 'Create a small API service.' }];
  const first = compileIntentMap(input);
  const second = compileIntentMap(input);
  assert.deepEqual(second, first);
  assert.ok(first.nodes.every((node) => node.agentAssignment === 'builtin-fallback'));
});

test('accepts the versioned default agent catalog shape and binds its prompt revisions', () => {
  const graph = compileIntentMap({
    intentNode: { id: 'intent-platform', text: 'Build a browser UI, API, PostgreSQL data model, tests, secure deployment, observability, and retrieval ranking.' },
    agentCatalog: { archetypes: DEFAULT_AGENT_ARCHETYPES },
  });
  assert.ok(graph.nodes.every((node) => node.agentAssignment === 'catalog'));
  assert.ok(graph.nodes.every((node) => DEFAULT_AGENT_ARCHETYPES.some((agent) => agent.id === node.agentId)));
  assert.ok(graph.nodes.every((node) => /^sha256:[a-f0-9]{64}$/.test(node.promptDigest)));
  assert.notEqual(graph.nodes.find((node) => node.domain === 'quality').agentId, graph.nodes.find((node) => node.domain === 'security').agentId);
});

test('rejects cyclic intent dependencies and unbounded loops before proposing work', () => {
  assert.throws(
    () => compileIntentMap({
      intentNodes: [
        { id: 'a', text: 'Build service A.', dependsOn: ['b'] },
        { id: 'b', text: 'Build service B.', dependsOn: ['a'] },
      ],
      agentCatalog,
    }),
    (error) => error instanceof IntentCompilerError && error.code === 'INTENT_CYCLE',
  );

  assert.throws(
    () => compileIntentMap({
      intentNode: { id: 'loop', text: 'Iteratively improve an API.', loop: { stopWhen: 'perfect' } },
      agentCatalog,
    }),
    (error) => error instanceof IntentCompilerError && error.code === 'UNBOUNDED_LOOP',
  );
});

test('rejects a proposal whose dependency graph is later made cyclic', () => {
  const graph = compileIntentMap({ intentNode: { id: 'intent-api', text: 'Build an API.' }, agentCatalog });
  const product = graph.nodes.find((node) => node.domain === 'product');
  const application = graph.nodes.find((node) => node.domain === 'application');
  product.dependsOn = [application.id];
  assert.throws(
    () => validateProposedGraph(graph),
    (error) => error instanceof IntentCompilerError && error.code === 'PROPOSED_GRAPH_CYCLE',
  );
});

test('rejects a proposal whose planning stop policy becomes unbounded', () => {
  const graph = compileIntentMap({ intentNode: { id: 'intent-api', text: 'Build an API.' }, agentCatalog });
  graph.stop.maxPlanRevisions = Number.POSITIVE_INFINITY;
  assert.throws(
    () => validateProposedGraph(graph),
    (error) => error instanceof IntentCompilerError && error.code === 'UNBOUNDED_LOOP',
  );
});

test('materializes unrestricted configured-AI domains and semantic relationships with canonical agent bindings', () => {
  const graph = materializeProviderProposal({
    provider: 'openai-api',
    model: 'gpt-test',
    intentNodes: [{ id: 'intent-studio', title: 'Creative studio', objective: 'Build a collaborative generative media studio.' }],
    evidenceSummaries: [{ id: 'evidence-flow', summary: 'Creators need branching review and provenance.', sourceNodeIds: ['intent-studio'] }],
    agentCatalog,
    proposal: {
      summary: 'A provider-generated graph.',
      nodes: [
        {
          id: 'specialist:creative-direction',
          domain: 'creative-systems-orchestration',
          title: 'Creative direction system',
          objective: 'Turn creator intent into a branching production direction with explicit provenance.',
          agentId: 'product-agent',
          dependsOn: [],
          acceptanceCriteria: ['Every branch remains traceable to the creator intent.'],
          inputs: [{ id: 'brief', type: 'creator_brief', required: true, provenanceRequired: true }],
          outputs: [{ id: 'direction', type: 'creative_direction', required: true, provenanceRequired: true }],
          traceability: { intentNodeIds: ['intent-studio'], evidenceIds: ['evidence-flow'] },
        },
        {
          id: 'specialist:branch-editor',
          domain: 'nonlinear-media-editing',
          title: 'Branch editor',
          objective: 'Implement movable branches and review checkpoints without flattening alternatives.',
          agentId: 'experience-agent',
          dependsOn: ['specialist:creative-direction'],
          acceptanceCriteria: ['A creator can compare and retain multiple branches.'],
          inputs: [{ id: 'direction', type: 'creative_direction', required: true, provenanceRequired: true }],
          outputs: [{ id: 'branches', type: 'reviewable_branches', required: true, provenanceRequired: true }],
          traceability: { intentNodeIds: ['intent-studio'], evidenceIds: ['evidence-flow'] },
        },
      ],
      relationships: [{
        id: 'relationship:co-creates',
        type: 'CO_CREATES_WITH',
        source: 'specialist:creative-direction',
        target: 'specialist:branch-editor',
        rationale: 'Direction and editing remain linked while alternatives are explored.',
        traceability: { intentNodeIds: ['intent-studio'], evidenceIds: ['evidence-flow'] },
      }],
    },
  });

  assert.equal(graph.deterministic, false);
  assert.deepEqual(graph.selectedDomains, ['creative-systems-orchestration', 'nonlinear-media-editing']);
  assert.ok(graph.relationships.some((relationship) => relationship.type === 'CO_CREATES_WITH'));
  assert.ok(graph.relationships.some((relationship) => relationship.type === 'REQUIRES'));
  assert.equal(graph.nodes[1].promptDigest, agentCatalog.find((agent) => agent.id === 'experience-agent').promptDigest);
  assert.equal(validateProposedGraph(graph), true);
});
