import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { createLocalServer } from '../src/index.mjs';

const origin = 'http://127.0.0.1:5173';

function fakeCodexSource({ capturePath, liveResearch }) {
  return `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'login' && args[1] === 'status') process.exit(0);
if (args[0] === '--help') {
  ${liveResearch ? "process.stdout.write('  --search\\n');" : ''}
  process.exit(0);
}
if (args.includes('--help')) process.exit(0);
(async () => {
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const extract = (marker, endMarker) => {
    const start = prompt.indexOf(marker) + marker.length;
    return JSON.parse(prompt.slice(start, prompt.indexOf(endMarker, start)));
  };
  const draft = extract('User intent draft:\\n', '\\nEvidence manifest and excerpts:\\n');
  const evidence = extract('Evidence manifest and excerpts:\\n', '\\nConfigured execution agents');
  const agents = extract('Configured execution agents (agentId is the id field):\\n', '\\nWorkspace baseline:\\n');
  const proposal = {
    summary: 'Execute the researched dynamic AI proposal.',
    nodes: [{
      id: 'ai-node:standards-api',
      domain: 'current-standards-api-design',
      title: 'Standards-aware API design',
      objective: 'Design the requested API against current cited primary standards.',
      agentId: agents[0].id,
      dependsOn: [],
      acceptanceCriteria: ['Every material standards claim cites a current primary source.'],
      inputs: [{ id: 'intent-bundle', type: 'intent_evidence_bundle', required: true, provenanceRequired: true }],
      outputs: [{ id: 'api-design', type: 'standards_aware_api_design', required: true, provenanceRequired: true }],
      traceability: {
        intentNodeIds: draft.nodes.map((node) => node.id),
        evidenceIds: evidence.sources.map((source) => source.id),
      },
    }],
    relationships: [],
  };
  fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ args, prompt }));
  const outputPath = args[args.indexOf('--output-last-message') + 1];
  fs.writeFileSync(outputPath, JSON.stringify(proposal));
})().catch((error) => { process.stderr.write(error.stack || error.message); process.exit(1); });
`;
}

test('Codex planning invokes the selected CLI with the pinned research mode and rejects vanished capability', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ege-server-research-'));
  const binaryRoot = join(root, 'bin');
  const workspaceRoot = join(root, 'workspace');
  const capturePath = join(root, 'codex-call.json');
  const codexPath = join(binaryRoot, 'codex');
  await mkdir(binaryRoot);
  await mkdir(workspaceRoot);
  await writeFile(codexPath, fakeCodexSource({ capturePath, liveResearch: true }));
  await chmod(codexPath, 0o700);

  const server = createLocalServer({
    port: 0,
    databasePath: join(root, 'local.db'),
    workspaceRoot,
    skillsRoot: join(root, 'skills'),
    environment: {
      ...process.env,
      PATH: `${binaryRoot}${delimiter}${process.env.PATH}`,
      HOME: root,
    },
  });
  await server.start();
  context.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  async function request(path, body, method = 'POST') {
    const response = await fetch(`${server.address}${path}`, {
      method,
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  }

  const graph = await request('/api/graphs', { name: 'Research-capable graph', workspacePath: workspaceRoot });
  const graphId = graph.body.graph.id;
  await request(`/api/graphs/${graphId}/draft`, {
    nodes: [{ id: 'intent', title: 'Current API design', kind: 'intent', context: 'Implement a tested API using current standards.' }],
    edges: [],
    context: 'Use current primary sources only when approved.',
  }, 'PUT');

  const planned = await request(`/api/graphs/${graphId}/plans`, {
    provider: 'codex-cli',
    research: { enabled: true },
  });
  assert.equal(planned.response.status, 201);
  const policy = planned.body.plan.plan.contextManifest.researchPolicy;
  assert.equal(policy.enabled, true);
  assert.equal(policy.provider, 'codex-cli');
  assert.equal(policy.tool, 'web_search');
  assert.equal(policy.mode, 'live');
  assert.equal(policy.citationsRequired, true);
  assert.match(policy.digest, /^[a-f0-9]{64}$/);
  assert.equal(planned.body.plan.plan.contextManifest.proposalGenerator.kind, 'configured-ai-provider');
  assert.equal(JSON.parse(await readFile(capturePath, 'utf8')).args.includes('--search'), true);

  const disabledPlan = await request(`/api/graphs/${graphId}/plans`, {
    provider: 'codex-cli',
    research: { enabled: false },
  });
  assert.equal(disabledPlan.response.status, 201);
  assert.equal(disabledPlan.body.plan.plan.contextManifest.researchPolicy.mode, 'disabled');
  assert.match(disabledPlan.body.plan.diff.summary, /research policy context changed/);
  assert.equal(
    disabledPlan.body.plan.diff.changedNodeIds.length,
    disabledPlan.body.plan.plan.steps.length,
  );
  const disabledCall = JSON.parse(await readFile(capturePath, 'utf8'));
  assert.equal(disabledCall.args.includes('--search'), false);
  assert.equal(disabledCall.args.includes('web_search="disabled"'), true);

  await writeFile(codexPath, fakeCodexSource({ capturePath, liveResearch: false }));
  await chmod(codexPath, 0o700);
  const approval = await request(`/api/plans/${planned.body.plan.id}/approve`, {
    expectedContentHash: planned.body.plan.contentHash,
    rationale: 'Capability must still be verified.',
  });
  assert.equal(approval.response.status, 409);
  assert.equal(approval.body.error.code, 'PLAN_CONTEXT_STALE');
  assert.equal(approval.body.error.details.reason, 'RESEARCH_CAPABILITY_CHANGED');
});
