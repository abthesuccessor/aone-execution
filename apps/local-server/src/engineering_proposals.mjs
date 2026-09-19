import { createHash } from 'node:crypto';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ACTIVE = new Set(['QUEUED', 'RUNNING', 'PAUSE_REQUESTED', 'PAUSED', 'CANCEL_REQUESTED']);

export function createEngineeringProposalRoutes({ repository, readJson, json, HttpError, validateDraft }) {
  const fail = (status, code, message) => { throw new HttpError(status, code, message); };
  async function handle({ request, response, path, method, cors }) {
    const match = path.match(/^\/api\/graphs\/([^/]+)\/plans\/([^/]+)\/adopt$/);
    if (!match || method !== 'POST') return false;
    const graphId = decodeURIComponent(match[1]);
    const planId = decodeURIComponent(match[2]);
    if (!repository.getGraph(graphId)) fail(404, 'GRAPH_NOT_FOUND', 'Graph was not found.');
    let plan = repository.getPlan(planId);
    if (!plan) fail(404, 'PLAN_NOT_FOUND', 'Plan was not found.');
    if (plan.graphId !== graphId) fail(409, 'PLAN_GRAPH_MISMATCH', 'The proposed plan belongs to another graph.');
    const body = await readJson(request);
    const currentPlan = repository.getPlan(planId);
    if (!currentPlan || currentPlan.graphId !== graphId || currentPlan.contentHash !== plan.contentHash) fail(409, 'PLAN_CHANGED', 'The proposal changed while this request was being read. Refresh before adopting it.');
    plan = currentPlan;
    if (!Array.isArray(body.nodeIds) || !body.nodeIds.length || body.nodeIds.length > 200 || body.nodeIds.some((id) => typeof id !== 'string' || !id || id.length > 200)) fail(422, 'VALIDATION_ERROR', 'Select 1 to 200 proposed node IDs.');
    const nodeIds = [...new Set(body.nodeIds)].sort();
    if (nodeIds.length !== body.nodeIds.length) fail(422, 'VALIDATION_ERROR', 'Selected proposed node IDs must be unique.');
    const expectedDraftRevision = body.expectedDraftRevision ?? plan.baseDraftRevision;
    if (!Number.isSafeInteger(expectedDraftRevision) || expectedDraftRevision < 1) fail(422, 'VALIDATION_ERROR', 'expectedDraftRevision must be a positive integer.');
    if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId))) fail(422, 'VALIDATION_ERROR', 'requestId must be an 8 to 128 character stable identifier.');
    const fingerprint = hash({ graphId, planId, nodeIds, expectedDraftRevision });
    const key = `${graphId}:${body.requestId || fingerprint}`;
    const previous = repository.getCatalogRevision('plan-adoptions', key)?.data;
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'This adoption request ID was used with different inputs.');
      json(response, 200, { ...previous.result, draft: repository.getDraft(graphId, previous.result.draftRevision), currentDraftRevision: repository.getLatestDraft(graphId).revision, idempotent: true }, cors);
      return true;
    }
    if (repository.listExecutions(graphId).some((execution) => ACTIVE.has(execution.status))) fail(409, 'EXECUTION_ACTIVE', 'Finish or cancel this graph’s execution before editing suggested nodes.');
    const latest = repository.getLatestDraft(graphId);
    if (plan.status === 'SUPERSEDED' || latest.revision !== expectedDraftRevision || latest.revision !== plan.baseDraftRevision) fail(409, 'PLAN_DRAFT_STALE', 'The graph draft or proposal changed. Request a new plan before adopting suggestions.');
    const proposal = plan.plan.proposedGraph;
    const proposedNodes = new Map((proposal?.nodes ?? []).map((node) => [node.id, node]));
    const steps = new Map((plan.plan.steps ?? []).map((step) => [step.nodeId, step]));
    if (nodeIds.some((id) => !proposedNodes.has(id) || !steps.has(id))) fail(422, 'INVALID_PROPOSED_NODE', 'Every selected ID must identify a specialist in this plan.');
    const ids = new Map(nodeIds.map((id) => [id, `adopted:${hash({ planId, nodeId: id }).slice(0, 24)}`]));
    if (latest.nodes.some((node) => [...ids.values()].includes(node.id))) fail(409, 'ADOPTION_CONFLICT', 'A suggested node already exists without this adoption receipt.');
    const startX = Math.max(0, ...latest.nodes.map((node) => node.position?.x ?? 0)) + 360;
    const sourceIds = new Set(latest.nodes.map((node) => node.id));
    const createdNodes = nodeIds.map((id, index) => {
      const node = proposedNodes.get(id);
      const step = steps.get(id);
      const sourceIntentNodeIds = node.traceability?.intentNodeIds ?? step.sourceIntentNodeIds ?? [];
      const sourceEvidenceIds = node.traceability?.evidenceIds ?? step.sourceEvidenceIds ?? [];
      if (sourceIntentNodeIds.some((sourceId) => !sourceIds.has(sourceId))) fail(409, 'PROPOSAL_SOURCE_MISSING', 'A source intention referenced by the proposal is unavailable.');
      const ports = (items) => (items ?? []).map((item) => typeof item === 'string' ? item : item.description || item.name || item.id);
      return {
        id: ids.get(id), title: node.title || step.title, kind: 'specialist', description: node.objective || step.objective,
        context: `Editable specialist adopted from plan ${planId} (${plan.contentHash}), proposed node ${id}. Preserve source traceability while refining its scope.`,
        agentId: step.agentId, ...(step.providerId ? { providerId: step.providerId } : {}), ...(step.model ? { model: step.model } : {}),
        skills: (step.skills ?? []).map((skill) => typeof skill === 'string' ? skill : skill.id),
        inputs: ports(node.inputs ?? step.inputs), outputs: ports(node.outputs ?? step.outputs),
        acceptanceCriteria: step.acceptanceCriteria ?? node.acceptanceCriteria ?? [], budgets: step.budgets ?? {}, breakpoint: step.breakpoint ?? false,
        ...(step.review ? { review: step.review } : {}),
        position: { x: startX + (index % 3) * 320, y: Math.floor(index / 3) * 180 },
        proposalSource: { planId, planHash: plan.contentHash, proposalNodeId: id, sourceIntentNodeIds, sourceEvidenceIds },
      };
    });
    const createdEdges = [];
    for (const relation of proposal.relationships ?? []) {
      const source = relation.from ?? relation.source;
      const target = relation.to ?? relation.target;
      if (!ids.has(source) || !ids.has(target)) continue;
      createdEdges.push({ id: `adopted-edge:${hash({ planId, id: relation.id }).slice(0, 24)}`, source: ids.get(source), target: ids.get(target), type: relation.type,
        label: relation.label || relation.type, rationale: relation.rationale || relation.reason || `Adopted from proposal relationship ${relation.id}.` });
    }
    for (const node of createdNodes) for (const source of node.proposalSource.sourceIntentNodeIds) createdEdges.push({
      id: `adopted-trace:${hash([node.id, source]).slice(0, 24)}`, source: node.id, target: source,
      type: 'DERIVED_FROM', label: 'Derived from intention', rationale: `Proposal provenance: plan ${planId}, node ${node.proposalSource.proposalNodeId}. This semantic link does not schedule execution.`,
    });
    const validated = validateDraft({ nodes: [...latest.nodes, ...createdNodes], edges: [...latest.edges, ...createdEdges], context: latest.context });
    const result = repository.transaction(() => {
      const admittedPlan = repository.getPlan(planId);
      if (!admittedPlan || admittedPlan.status === 'SUPERSEDED' || admittedPlan.contentHash !== plan.contentHash || admittedPlan.baseDraftRevision !== latest.revision) fail(409, 'PLAN_DRAFT_STALE', 'The proposal changed before adoption could complete.');
      if (repository.getLatestDraft(graphId).revision !== latest.revision) fail(409, 'PLAN_DRAFT_STALE', 'The draft changed during adoption.');
      if (repository.listExecutions(graphId).some((execution) => ACTIVE.has(execution.status))) fail(409, 'EXECUTION_ACTIVE', 'Execution started before adoption could complete.');
      const draft = repository.saveDraft(graphId, validated);
      // Keep immutable plan content and approvals; status marks the now-stale proposal.
      repository.database.prepare("UPDATE plan_versions SET status = 'SUPERSEDED' WHERE id = ?").run(planId);
      const stored = { sourcePlanId: planId, adoptedNodeIds: createdNodes.map((node) => node.id), adoptedProposalNodeIds: nodeIds, draftRevision: draft.revision };
      repository.saveCatalogRevision('plan-adoptions', key, { fingerprint, result: stored });
      return { ...stored, draft, currentDraftRevision: draft.revision, idempotent: false };
    });
    json(response, 201, result, cors);
    return true;
  }
  return { handle };
}
