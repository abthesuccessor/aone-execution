import { Badge, Flex, Text } from '@radix-ui/themes';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { IconGripVertical, IconRobot } from '@tabler/icons-react';
import type { NodeRunStatus, ProposedSpecialistNode } from '../lib/types';

interface ProposedFlowNodeData {
  [key: string]: unknown;
  specialist: ProposedSpecialistNode;
  status?: NodeRunStatus;
}

export type ProposedFlowNodeType = Node<ProposedFlowNodeData, 'proposal'>;

export function ProposedFlowNode({ data, selected }: NodeProps<ProposedFlowNodeType>) {
  const node = data.specialist;
  const intentNodeIds = Array.isArray(node.traceability?.intentNodeIds) ? node.traceability.intentNodeIds : [];
  const evidenceIds = Array.isArray(node.traceability?.evidenceIds) ? node.traceability.evidenceIds : [];
  const traceCount = intentNodeIds.length + evidenceIds.length;
  const label = !data.status ? 'Agent proposal' : data.status === 'draft' ? 'Not selected' : data.status === 'completed' ? 'Complete' : data.status === 'not_run' ? 'Not run' : data.status[0].toUpperCase() + data.status.slice(1);
  const color = data.status === 'failed' ? 'red' : data.status === 'completed' ? 'green' : data.status === 'running' ? 'cyan' : data.status ? 'gray' : 'cyan';

  return (
    <article
      className={`proposed-flow-node${selected ? ' is-selected' : ''}`}
      aria-label={`${node.title}, ${label}, proposed specialist, drag to move or select for details`}
      aria-current={selected ? 'true' : undefined}
    >
      <Handle type="target" position={Position.Top} aria-label="Proposed incoming relation" />
      <Flex align="center" justify="between" gap="2">
        <Text size="1" weight="bold" className="proposal-domain">{String(node.domain || 'specialist').toUpperCase()}</Text>
        <Badge size="1" color={color} variant="soft"><IconGripVertical size={10} /> {label}</Badge>
      </Flex>
      <Text as="div" size="2" weight="bold" mt="3" className="node-title">{node.title}</Text>
      <Text as="p" size="1" mt="1" className="node-objective">{node.objective || 'No objective supplied'}</Text>
      <Flex align="center" justify="between" gap="2" mt="3">
        <Text size="1" className="proposal-agent" title={node.agentId}><IconRobot size={12} /> {shortAgent(node.agentId)}</Text>
        <Text size="1" color="gray">{traceCount} refs</Text>
      </Flex>
      <Handle type="source" position={Position.Bottom} aria-label="Proposed outgoing relation" />
    </article>
  );
}

function shortAgent(value: string): string {
  if (!value) return 'unbound';
  const segment = value.includes(':') ? value.split(':').at(-1) ?? value : value;
  return segment.length > 22 ? `${segment.slice(0, 20)}…` : segment;
}
