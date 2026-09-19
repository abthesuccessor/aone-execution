import { Badge, Flex, Text } from '@radix-ui/themes';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import {
  IconCheck,
  IconCircleDashed,
  IconPlayerPause,
  IconX,
} from '@tabler/icons-react';
import type { TopicNode } from '../lib/types';

export type TopicFlowNodeType = Node<TopicNode, 'topic'>;

const STATUS_META = {
  draft: { label: 'Draft', color: 'gray', icon: IconCircleDashed },
  queued: { label: 'Queued', color: 'amber', icon: IconCircleDashed },
  running: { label: 'Running', color: 'cyan', icon: IconCircleDashed },
  completed: { label: 'Complete', color: 'green', icon: IconCheck },
  failed: { label: 'Failed', color: 'red', icon: IconX },
  paused: { label: 'Paused', color: 'amber', icon: IconPlayerPause },
  partial: { label: 'Partial', color: 'amber', icon: IconCircleDashed },
  blocked: { label: 'Blocked', color: 'amber', icon: IconPlayerPause },
  cancelled: { label: 'Cancelled', color: 'gray', icon: IconX },
  not_run: { label: 'Not run', color: 'gray', icon: IconCircleDashed },
} as const;

export function TopicFlowNode({ data, selected }: NodeProps<TopicFlowNodeType>) {
  const status = STATUS_META[data.status] ?? STATUS_META.draft;
  const StatusIcon = status.icon;

  return (
    <article className={`topic-flow-node${selected ? ' is-selected' : ''}`} aria-label={`${data.title}, ${status.label}`}>
      <Handle type="target" position={Position.Left} aria-label="Incoming relation" title="Drop a node link here" />
      <Flex align="center" justify="between"><Text size="1" className="node-agent-label">{data.breakpoint ? '● ' : ''}{data.agentId ?? 'Auto agent'}</Text>
        <Badge size="1" color={status.color} variant="soft" className={`node-status is-${data.status}`}>
          <StatusIcon className={data.status === 'running' ? 'spin-icon' : ''} size={11} />
          {status.label}
        </Badge>
      </Flex>
      <Text as="div" size="2" weight="bold" mt="1" truncate className="node-title">{data.title}</Text>
      <Text as="p" size="1" mt="1" className="node-objective">{data.objective || 'No objective yet'}</Text>
      <Handle type="source" position={Position.Right} aria-label="Outgoing relation" title="Drag from here to link another node" />
    </article>
  );
}
