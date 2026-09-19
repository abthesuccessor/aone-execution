import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Flex, Heading, Text, TextArea } from '@radix-ui/themes';
import { IconArrowRight, IconFileText, IconRobot, IconRoute, IconTargetArrow } from '@tabler/icons-react';
import type { PlanVersion, ProposedSpecialistNode, SourceRecord, TopicNode } from '../lib/types';

export const PROPOSAL_REFINEMENT_LIMIT = 4_000;

interface ProposalInspectorProps {
  node: ProposedSpecialistNode;
  plan: PlanVersion;
  nextPlanVersion: number;
  sourceIntents: TopicNode[];
  evidenceSources: SourceRecord[];
  proposalNodes: ProposedSpecialistNode[];
  readOnly?: boolean;
  planning?: boolean;
  onRefine: (request: string) => Promise<boolean>;
}

export function ProposalInspector({
  node,
  plan,
  nextPlanVersion,
  sourceIntents,
  evidenceSources,
  proposalNodes,
  readOnly,
  planning,
  onRefine,
}: ProposalInspectorProps) {
  const [refinement, setRefinement] = useState('');
  const intentNodeIds = Array.isArray(node.traceability?.intentNodeIds) ? node.traceability.intentNodeIds : [];
  const evidenceIds = Array.isArray(node.traceability?.evidenceIds) ? node.traceability.evidenceIds : [];
  const acceptanceCriteria = Array.isArray(node.acceptanceCriteria) ? node.acceptanceCriteria : [];
  const dependencies = Array.isArray(node.dependsOn) ? node.dependsOn : [];
  const proposalById = useMemo(
    () => new Map(proposalNodes.map((candidate) => [candidate.id, candidate])),
    [proposalNodes],
  );
  const sourceById = useMemo(
    () => new Map(evidenceSources.map((source) => [source.id, source])),
    [evidenceSources],
  );
  const missingIntentCount = Math.max(0, intentNodeIds.length - sourceIntents.length);
  const canRefine = !readOnly && !planning && sourceIntents.length > 0 && refinement.trim().length > 0;

  useEffect(() => {
    setRefinement('');
  }, [node.id, plan.id]);

  const submitRefinement = async () => {
    const request = refinement.trim();
    if (!request || !canRefine) return;
    if (await onRefine(request)) setRefinement('');
  };

  return (
    <aside className="node-inspector proposal-inspector" aria-label={`Proposal inspector for ${node.title}`}>
      <div className="panel-heading inspector-heading">
        <Text size="1" weight="bold">PROPOSAL CONTEXT</Text>
        <Badge color="cyan" variant="soft">Plan v{plan.version} immutable</Badge>
      </div>
      <div className="proposal-inspector-scroll">
        <div className="proposal-inspector-content">
          <section className="proposal-primary" aria-labelledby="proposal-objective-heading">
            <Flex align="center" justify="between" gap="2">
              <Text id="proposal-objective-heading" size="1" weight="bold" className="proposal-domain">
                {String(node.domain || 'specialist').toUpperCase()}
              </Text>
              <Text size="1" color="gray">{node.id}</Text>
            </Flex>
            <Heading as="h2" size="3" weight="bold">{node.title}</Heading>
            <Text as="p" size="2">{node.objective || 'No specialist objective was generated.'}</Text>
            <Flex align="center" gap="2" className="proposal-agent-row">
              <IconRobot size={14} aria-hidden="true" />
              <div>
                <Text as="span" size="1" color="gray">Assigned agent</Text>
                <Text as="span" size="1" weight="medium">{node.agentAssignment || node.agentId || 'Unassigned'}</Text>
              </div>
            </Flex>
          </section>

          <InspectorSection title="Source intents" count={intentNodeIds.length}>
            {sourceIntents.map((intent) => (
              <article className="proposal-reference" key={intent.id}>
                <Flex align="center" gap="2">
                  <IconTargetArrow size={13} aria-hidden="true" />
                  <Text size="1" weight="medium">{intent.title}</Text>
                </Flex>
                <Text as="p" size="1" color="gray">{intent.objective || 'No desired outcome supplied.'}</Text>
                {intent.context && <Text as="p" size="1" className="proposal-current-context">{intent.context}</Text>}
              </article>
            ))}
            {missingIntentCount > 0 && (
              <Text as="p" size="1" color="amber">{missingIntentCount} linked intent {missingIntentCount === 1 ? 'is' : 'are'} not present in the current draft.</Text>
            )}
          </InspectorSection>

          <InspectorSection title="Evidence" count={evidenceIds.length}>
            {evidenceIds.length === 0 ? (
              <Text as="p" size="1" color="gray">No evidence is bound to this proposal.</Text>
            ) : evidenceIds.map((evidenceId) => {
              const source = sourceById.get(evidenceId);
              return (
                <article className="proposal-reference" key={evidenceId}>
                  <Flex align="center" gap="2">
                    <IconFileText size={13} aria-hidden="true" />
                    <Text size="1" weight="medium">{source?.filename ?? evidenceId}</Text>
                  </Flex>
                  <Text as="p" size="1" color="gray">
                    {source ? `${source.parseStatus.toLowerCase()}, ${source.chunkCount} ${source.chunkCount === 1 ? 'chunk' : 'chunks'}` : 'Evidence metadata is not available in the current source list.'}
                  </Text>
                </article>
              );
            })}
          </InspectorSection>

          <InspectorSection title="Acceptance" count={acceptanceCriteria.length}>
            {acceptanceCriteria.length === 0 ? (
              <Text as="p" size="1" color="gray">No acceptance criteria were generated.</Text>
            ) : (
              <ol className="proposal-detail-list">
                {acceptanceCriteria.map((criterion, index) => <li key={`${index}:${criterion}`}>{criterion}</li>)}
              </ol>
            )}
          </InspectorSection>

          <InspectorSection title="Dependencies" count={dependencies.length}>
            {dependencies.length === 0 ? (
              <Text as="p" size="1" color="gray">This specialist has no proposal dependencies.</Text>
            ) : (
              <div className="proposal-dependencies">
                {dependencies.map((dependencyId) => (
                  <Flex key={dependencyId} align="center" gap="2">
                    <IconRoute size={13} aria-hidden="true" />
                    <Text size="1">{proposalById.get(dependencyId)?.title ?? dependencyId}</Text>
                  </Flex>
                ))}
              </div>
            )}
          </InspectorSection>

          <InspectorSection title="Execution bounds">
            <div className="proposal-bounds">
              <DefinitionRecord label="Budget" value={node.budget} />
              <DefinitionRecord label="Stop condition" value={node.stop} />
            </div>
          </InspectorSection>

          <section className="proposal-refinement" aria-labelledby="proposal-refinement-heading">
            <Flex justify="between" align="baseline" gap="2">
              <Text id="proposal-refinement-heading" size="1" weight="bold">Refinement request</Text>
              <Text size="1" color={refinement.length >= PROPOSAL_REFINEMENT_LIMIT ? 'amber' : 'gray'}>
                {refinement.length}/{PROPOSAL_REFINEMENT_LIMIT}
              </Text>
            </Flex>
            <Text as="p" size="1" color="gray">
              This request is appended to {sourceIntents.length} linked draft {sourceIntents.length === 1 ? 'intent' : 'intents'}. Plan v{plan.version} stays unchanged.
            </Text>
            <TextArea
              value={refinement}
              onChange={(event) => setRefinement(event.target.value)}
              maxLength={PROPOSAL_REFINEMENT_LIMIT}
              rows={6}
              resize="vertical"
              disabled={readOnly || planning || sourceIntents.length === 0}
              aria-label={`Refinement request for ${node.title}`}
              placeholder="Add constraints, decisions, quality targets, edge cases, or evidence the next plan must address."
            />
            {sourceIntents.length === 0 && (
              <Text as="p" size="1" color="red">This proposal has no linked draft intent and cannot be refined safely.</Text>
            )}
            {readOnly && (
              <Text as="p" size="1" color="amber">Pause the active execution at a checkpoint before refining this proposal.</Text>
            )}
            <Button color="cyan" disabled={!canRefine} onClick={() => void submitRefinement()}>
              <IconArrowRight size={15} aria-hidden="true" />
              {planning ? 'Creating next plan' : `Save refinement and create Plan v${nextPlanVersion}`}
            </Button>
          </section>
        </div>
      </div>
    </aside>
  );
}

function InspectorSection({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  const headingId = `proposal-${title.toLowerCase().replaceAll(' ', '-')}`;
  return (
    <section className="proposal-inspector-section" aria-labelledby={headingId}>
      <Flex align="center" justify="between" gap="2">
        <Text id={headingId} size="1" weight="bold">{title}</Text>
        {count !== undefined && <Badge variant="outline" color="gray">{count}</Badge>}
      </Flex>
      {children}
    </section>
  );
}

function DefinitionRecord({ label, value }: { label: string; value?: Record<string, unknown> | Record<string, number> }) {
  const entries = Object.entries(value ?? {});
  return (
    <div>
      <Text size="1" color="gray">{label}</Text>
      {entries.length === 0 ? (
        <Text as="p" size="1">Not specified</Text>
      ) : (
        <dl>
          {entries.map(([key, item]) => (
            <div key={key}>
              <dt>{readableKey(key)}</dt>
              <dd>{formatBoundValue(item)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function readableKey(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').toLowerCase();
}

function formatBoundValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
