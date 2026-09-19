import { useMemo, useState } from 'react';
import Editor, { DiffEditor } from '@monaco-editor/react';
import { Badge, Button, Callout, Flex, ScrollArea, Text, TextArea } from '@radix-ui/themes';
import { IconCheck, IconGitCompare, IconRoute, IconSparkles } from '@tabler/icons-react';
import type { EngineeringGraph, PlanVersion } from '../lib/types';
import '../lib/monaco';

interface PlanPanelProps {
  graph?: EngineeringGraph;
  plan?: PlanVersion;
  previousPlan?: PlanVersion;
  loading?: boolean;
  approvalContext: string;
  onApprovalContextChange: (value: string) => void;
  onApprove: () => void;
  approving?: boolean;
  onReviewSuggestions?: () => void;
  canReviewSuggestions?: boolean;
}

export function PlanPanel({
  graph,
  plan,
  previousPlan,
  loading,
  approvalContext,
  onApprovalContextChange,
  onApprove,
  approving,
  onReviewSuggestions,
  canReviewSuggestions,
}: PlanPanelProps) {
  const [showRawPlan, setShowRawPlan] = useState(false);
  const intentNodes = useMemo(() => new Map(
    graph?.nodes.map((node) => [node.id, node] as const) ?? [],
  ), [graph]);
  const proposedNodes = useMemo(() => new Map(
    plan?.proposedGraph?.nodes.map((node) => [node.id, node] as const) ?? [],
  ), [plan]);
  const nodeNames = useMemo(() => new Map([
    ...[...intentNodes].map(([id, node]) => [id, node.title] as const),
    ...[...proposedNodes].map(([id, node]) => [id, node.title] as const),
  ]), [intentNodes, proposedNodes]);

  if (loading) {
    return (
      <div className="bottom-empty" role="status">
        <span className="plan-loader" />
        Compiling from your graph, evidence, and built-in agents
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="bottom-empty" role="status">
        <IconSparkles size={19} />
        <span>Save the draft, then request a plan.</span>
      </div>
    );
  }

  const isApproved = plan.status === 'approved';
  const proposalRelationships = plan.proposedGraph?.relationships ?? plan.proposedEdges.map((edge) => ({
    id: edge.id,
    type: 'PROPOSED',
    source: edge.source,
    target: edge.target,
    rationale: edge.rationale ?? '',
    traceability: { intentNodeIds: [], evidenceIds: [] },
  }));

  return (
    <div className="plan-panel">
      <ScrollArea type="auto" scrollbars="vertical" className="plan-content">
        <Flex align="center" justify="between" gap="3" className="plan-summary-row">
          <div>
            <Flex align="center" gap="2">
              <Text size="2" weight="bold">Plan v{plan.version}</Text>
              <Badge color={isApproved ? 'green' : 'amber'}>{isApproved ? 'Approved' : 'Approval required'}</Badge>
              {previousPlan && <Badge color="cyan" variant="soft">Replanned from v{previousPlan.version}</Badge>}
              <Badge color="gray" variant="outline">Runtime {plan.provider === 'local-agents' ? 'legacy plan' : plan.provider}</Badge>
              <Badge color={plan.researchPolicy?.enabled ? 'cyan' : 'gray'} variant="soft">
                Web research {plan.researchPolicy?.enabled ? 'live' : 'off'}
              </Badge>
              <Badge color="gray" variant="outline" title={plan.contentHash}>hash {plan.contentHash.slice(0, 12)}</Badge>
            </Flex>
            <Text as="p" size="1" color="gray" mt="1">{plan.summary}</Text>
          </div>
          <Button size="1" variant="soft" color="gray" onClick={() => setShowRawPlan((value) => !value)}>
            <IconGitCompare size={14} /> {showRawPlan ? 'Show work items' : previousPlan ? 'Compare versions' : 'Inspect exact plan'}
          </Button>
        </Flex>

        {onReviewSuggestions && (plan.proposedGraph?.nodes.length ?? 0) > 0 && <Flex gap="2" align="center" className="plan-adopt-row"><Button size="1" variant="soft" disabled={!canReviewSuggestions} onClick={onReviewSuggestions}>Edit suggested nodes</Button><Text size="1" color="gray">Choose the scope, turn suggestions into editable nodes, then request a fresh plan.</Text></Flex>}

        {showRawPlan && previousPlan ? (
          <div className="plan-diff-editor" aria-label={`Plan v${previousPlan.version} compared with plan v${plan.version}`}>
            <DiffEditor
              key={`${previousPlan.id}:${plan.id}`}
              original={JSON.stringify(exactPlanDocument(previousPlan), null, 2)}
              modified={JSON.stringify(exactPlanDocument(plan), null, 2)}
              originalModelPath={`ege://plans/${previousPlan.id}.json`}
              modifiedModelPath={`ege://plans/${plan.id}.json`}
              keepCurrentOriginalModel
              keepCurrentModifiedModel
              language="json"
              theme="vs-dark"
              options={{ readOnly: true, renderSideBySide: true, minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3 }}
            />
          </div>
        ) : showRawPlan ? (
          <div className="plan-diff-editor" aria-label={`Exact plan v${plan.version}`}>
            <Editor
              path={`ege://plans/${plan.id}.json`}
              value={JSON.stringify(exactPlanDocument(plan), null, 2)}
              language="json"
              theme="vs-dark"
              options={{ readOnly: true, minimap: { enabled: false }, fontSize: 12, lineNumbersMinChars: 3 }}
            />
          </div>
        ) : (
          <div className="plan-grid">
            <section aria-labelledby="work-items-heading">
              <Text id="work-items-heading" size="1" weight="bold">WORK ITEMS</Text>
              <ol className="work-items">
                {plan.workItems.map((item, index) => {
                  const proposedNode = proposedNodes.get(item.nodeId);
                  const hasPinnedSourceIntents = item.sourceIntents !== undefined;
                  const sourceIntents = item.sourceIntents ?? (proposedNode?.traceability.intentNodeIds ?? []).map((id) => ({
                    id,
                    title: intentNodes.get(id)?.title ?? id,
                    objective: intentNodes.get(id)?.objective ?? '',
                  }));
                  const evidenceCount = proposedNode?.traceability.evidenceIds.length ?? 0;
                  return (
                    <li key={item.id} className="work-item">
                      <span className="work-index">{String(index + 1).padStart(2, '0')}</span>
                      <div>
                        <Text size="2" weight="medium">{item.title}</Text>
                        {(sourceIntents.length > 0 || evidenceCount > 0) && (
                          <Flex gap="1" align="center" wrap="wrap">
                            {sourceIntents.length > 0 && (
                              <Text size="1" color="gray">
                                {hasPinnedSourceIntents
                                  ? `Source ${sourceIntents.length === 1 ? 'intent' : 'intents'}:`
                                  : `Source ${sourceIntents.length === 1 ? 'intent' : 'intents'} (current draft):`}
                              </Text>
                            )}
                            {sourceIntents.map((source) => (
                              <Badge key={source.id} size="1" variant="outline" color="gray">{source.title}</Badge>
                            ))}
                            {!hasPinnedSourceIntents && sourceIntents.length > 0 && (
                              <Badge size="1" variant="outline" color="amber">
                                Plan base draft r{plan.baseDraftRevision ?? 'unknown'}
                              </Badge>
                            )}
                            {evidenceCount > 0 && (
                              <Badge size="1" variant="soft" color="cyan">
                                {evidenceCount} evidence {evidenceCount === 1 ? 'ref' : 'refs'}
                              </Badge>
                            )}
                          </Flex>
                        )}
                        {sourceIntents.map((source) => source.objective && (
                          <Text key={`source-objective:${source.id}`} as="p" size="1" color="gray">
                            {hasPinnedSourceIntents ? 'Source objective' : 'Current draft objective'}: {source.objective}
                          </Text>
                        ))}
                        <Text as="p" size="1" color="gray">Specialist objective: {item.description}</Text>
                        {item.dependencies.length > 0 && (
                          <Text as="p" size="1" color="gray">Depends on: {item.dependencies.map((id) => nodeNames.get(id) ?? id).join(', ')}</Text>
                        )}
                        {item.acceptanceCriteria.length > 0 && (
                          <ul className="acceptance-list" aria-label={`Acceptance criteria for ${item.title}`}>
                            {item.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
                          </ul>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
            <section aria-labelledby="proposal-heading" className="proposal-review">
              <Flex align="center" gap="2" mb="2" wrap="wrap">
                <IconSparkles size={15} />
                <Text id="proposal-heading" size="1" weight="bold">SPECIALIST PROPOSAL</Text>
                <Badge color="cyan" variant="soft">Read only</Badge>
              </Flex>
              {!plan.proposedGraph ? (
                <Text size="1" color="gray">This plan has no typed specialist graph.</Text>
              ) : (
                <>
                  <Text as="p" size="1" color="gray" className="proposal-explainer">
                    Your intent nodes remain unchanged. Approval admits this generated specialist graph.
                  </Text>
                  <Flex gap="2" wrap="wrap" mb="2">
                    <Badge variant="outline" color="gray">{plan.proposedGraph.nodes.length} specialists</Badge>
                    <Badge variant="outline" color="gray">{plan.proposedGraph.relationships.length} typed relations</Badge>
                    {plan.proposedGraph.compilerVersion && <Badge variant="outline" color="gray">{plan.proposedGraph.compilerVersion}</Badge>}
                  </Flex>
                  <div className="proposal-node-list">
                    {plan.proposedGraph.nodes.map((node) => (
                      <article key={node.id}>
                        <Flex align="center" justify="between" gap="2">
                          <Text size="1" weight="medium">{node.title}</Text>
                          <Badge size="1" color="cyan" variant="soft">{node.domain}</Badge>
                        </Flex>
                        <Text as="p" size="1" color="gray">Agent: {node.agentId || 'unbound'}</Text>
                        <Text as="p" size="1" color="gray">
                          {node.inputs.length} inputs · {node.outputs.length} outputs · {node.acceptanceCriteria.length} checks
                        </Text>
                        <Text as="p" size="1" className="proposal-trace">
                          Traces to {node.traceability.intentNodeIds.length} intent and {node.traceability.evidenceIds.length} evidence refs
                        </Text>
                      </article>
                    ))}
                  </div>
                </>
              )}

              <Flex align="center" gap="2" mt="3" mb="2">
                <IconRoute size={15} />
                <Text size="1" weight="bold">PROPOSED RELATIONS</Text>
              </Flex>
              {proposalRelationships.length === 0 ? (
                <Text size="1" color="gray">No relations proposed.</Text>
              ) : (
                <div className="relation-list">
                  {proposalRelationships.map((edge) => (
                    <div key={edge.id}>
                      <Text size="1" weight="medium">{nodeNames.get(edge.source) ?? compactEndpoint(edge.source)}</Text>
                      <span aria-hidden="true">→</span>
                      <Text size="1" weight="medium">{nodeNames.get(edge.target) ?? compactEndpoint(edge.target)}</Text>
                      <Badge size="1" variant="outline" color="gray">{edge.type.replaceAll('_', ' ')}</Badge>
                      {edge.rationale && <Text as="p" size="1" color="gray">{edge.rationale}</Text>}
                    </div>
                  ))}
                </div>
              )}
              {plan.diff && (
                <Callout.Root size="1" color="cyan" mt="3">
                  <Callout.Icon><IconGitCompare size={15} /></Callout.Icon>
                  <Callout.Text>{plan.diff.summary}</Callout.Text>
                </Callout.Root>
              )}
            </section>
          </div>
        )}
      </ScrollArea>

      {!isApproved && (
        <div className="approval-bar">
          <label>
            <span>
              <Text as="div" size="1" weight="medium">Approval rationale</Text>
              <Text as="div" size="1" color="gray">Put semantic changes in planner context and create a new plan first.</Text>
            </span>
            <TextArea
              value={approvalContext}
              onChange={(event) => onApprovalContextChange(event.target.value)}
              rows={2}
              resize="vertical"
              placeholder="Why this exact plan is approved"
              aria-label="Approval rationale"
            />
          </label>
          <Button color="cyan" onClick={onApprove} disabled={approving}>
            <IconCheck size={16} /> {approving ? 'Approving' : `Approve plan v${plan.version}`}
          </Button>
        </div>
      )}
    </div>
  );
}

function compactEndpoint(value: string): string {
  const segment = value.includes(':') ? value.split(':').at(-1) ?? value : value;
  return segment.replaceAll('-', ' ');
}

function exactPlanDocument(plan: PlanVersion): unknown {
  return plan.rawDocument ?? plan;
}
