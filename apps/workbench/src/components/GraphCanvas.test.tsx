import { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProposedGraph, TopicNode } from '../lib/types';
import { GraphCanvas } from './GraphCanvas';

const { fitView, setCenter } = vi.hoisted(() => ({ fitView: vi.fn(), setCenter: vi.fn() }));

vi.mock('@xyflow/react', () => ({
  ReactFlow: ({
    nodes,
    edges,
    children,
    onNodeClick,
    onPaneClick,
    onNodesChange,
    onNodeDragStart,
    onNodeDragStop,
    onInit,
    autoPanOnNodeDrag,
    nodeDragThreshold,
    nodesConnectable,
    onConnect,
    isValidConnection,
  }: {
    nodes: Array<{ id: string; type: string; selected?: boolean; selectable?: boolean; draggable?: boolean; position: { x: number; y: number } }>;
    edges: Array<{ id: string; source: string; target: string; className?: string }>;
    children?: React.ReactNode;
    onNodeClick: (event: React.MouseEvent, node: { id: string; type: string }) => void;
    onPaneClick?: () => void;
    onNodesChange: (changes: Array<Record<string, unknown>>) => void;
    onNodeDragStart?: (event: React.MouseEvent, node: { id: string; type: string; position: { x: number; y: number } }) => void;
    onNodeDragStop: (event: React.MouseEvent, node: { id: string; type: string; position: { x: number; y: number } }, nodes?: Array<{ id: string; type: string; position: { x: number; y: number } }>) => void;
    onInit?: (instance: {
      getNode: (id: string) => { id: string; position: { x: number; y: number }; measured: { width: number; height: number } };
      getZoom: () => number;
      setCenter: typeof setCenter;
    }) => void;
    autoPanOnNodeDrag?: boolean;
    nodeDragThreshold?: number;
    nodesConnectable?: boolean;
    onConnect?: (connection: { source: string; target: string; sourceHandle: null; targetHandle: null }) => void;
    isValidConnection?: (connection: { source: string; target: string; sourceHandle: null; targetHandle: null }) => boolean;
  }) => {
    const draftNodes = nodes.filter((node) => node.type === 'topic');
    onInit?.({
      getNode: (id) => ({ id, position: { x: 310, y: 20 }, measured: { width: 240, height: 120 } }),
      getZoom: () => 0.4,
      setCenter,
    });
    return (
    <div
      data-testid="react-flow"
      data-auto-pan-on-node-drag={String(autoPanOnNodeDrag)}
      data-node-drag-threshold={String(nodeDragThreshold)}
      data-nodes-connectable={String(nodesConnectable)}
    >
      {children}
      {edges.map((edge) => (
        <span
          key={edge.id}
          data-testid={`flow-edge-${edge.id}`}
          data-source={edge.source}
          data-target={edge.target}
          data-class-name={edge.className}
        >
          {edge.id}
        </span>
      ))}
      {nodes.map((node) => (
        <button
          type="button"
          key={node.id}
          aria-label={`Flow node ${node.id}`}
          aria-pressed={Boolean(node.selected)}
          data-selectable={String(node.selectable !== false)}
          data-draggable={String(node.draggable !== false)}
          data-connectable={String((node as { connectable?: boolean }).connectable !== false)}
          data-position-x={String(node.position.x)}
          data-position-y={String(node.position.y)}
          onClick={(event) => onNodeClick(event, node)}
        >
          {node.id}
        </button>
      ))}
      {nodes.map((node) => (
        <button
          type="button"
          key={`drag:${node.id}`}
          aria-label={`Drag flow node ${node.id}`}
          onClick={(event) => {
            const position = { x: node.position.x + 300, y: node.position.y };
            onNodeDragStart?.(event, { ...node, position: node.position });
            onNodesChange([{ id: node.id, type: 'position', position, dragging: true }]);
            onNodeDragStop(event, { ...node, position });
          }}
        >
          drag {node.id}
        </button>
      ))}
      {draftNodes.length > 1 && <button type="button" aria-label="Drag selected intent group" onClick={(event) => {
        const moved = draftNodes.map((node) => ({ ...node, position: { x: node.position.x + 100, y: node.position.y + 50 } }));
        onNodesChange(moved.map((node) => ({ id: node.id, type: 'position', position: node.position, dragging: true })));
        onNodeDragStop(event, moved[0], moved);
      }}>Drag group</button>}
      {draftNodes.length > 1 ? (
        <button
          type="button"
          aria-label="Connect first two draft nodes"
          onClick={() => {
            const connection = {
              source: draftNodes[0].id,
              target: draftNodes[1].id,
              sourceHandle: null,
              targetHandle: null,
            };
            if (isValidConnection?.(connection) !== false) onConnect?.(connection);
          }}
        >
          Connect
        </button>
      ) : null}
      <button type="button" onClick={() => onPaneClick?.()}>Canvas background</button>
    </div>
    );
  },
  Background: () => null,
  Controls: () => null,
  MiniMap: () => null,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Handle: () => null,
  BackgroundVariant: { Dots: 'dots' },
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
  useNodesInitialized: () => true,
  useReactFlow: () => ({
    fitView,
    setCenter,
    getNode: (id: string) => ({
      id,
      position: { x: 10, y: 20 },
      measured: { width: 240, height: 120 },
      data: {},
    }),
  }),
}));

const topic: TopicNode = {
  id: 'intent:portal',
  kind: 'custom',
  title: 'Customer portal',
  objective: 'Build the customer portal.',
  context: '',
  status: 'draft',
  position: { x: 10, y: 20 },
};

const overlappingDropTarget: TopicNode = {
  ...topic,
  id: 'intent:overlap-target',
  title: 'Overlap target',
  position: { x: 310, y: 20 },
};

const proposal: ProposedGraph = {
  proposalId: 'proposal:1',
  schemaVersion: 'intent-proposed-graph/v1',
  status: 'PROPOSED',
  compilerVersion: 'intent-map-compiler/1.0.0',
  contentDigest: `sha256:${'a'.repeat(64)}`,
  selectedDomains: ['experience'],
  nodes: [{
    id: 'specialist:experience',
    type: 'SPECIALIST_AGENT',
    domain: 'experience',
    title: 'Experience engineering',
    objective: 'Build an accessible browser experience.',
    agentId: 'experience-agent',
    promptDigest: 'sha256:prompt',
    dependsOn: [],
    acceptanceCriteria: ['Keyboard navigation passes.'],
    inputs: [],
    outputs: [],
    traceability: { intentNodeIds: [topic.id], evidenceIds: [] },
  }],
  relationships: [],
};

describe('GraphCanvas proposal selection', () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    fitView.mockClear();
    setCenter.mockClear();
    vi.useRealTimers(); vi.unstubAllGlobals();
  });

  it('explains how to add the first context node to an empty workspace', () => {
    render(
      <GraphCanvas
        nodes={[]}
        edges={[]}
        onSelectNode={vi.fn()}
        onSelectProposalNode={vi.fn()}
        onPositionChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('This workspace is empty');
    expect(screen.getByRole('status')).toHaveTextContent('Use + in Node Library to add the first context node.');
  });

  it('fits newly loaded nodes after React Flow finishes measuring them', async () => {
    const view = render(
      <GraphCanvas
        nodes={[]}
        edges={[]}
        onSelectNode={vi.fn()}
        onSelectProposalNode={vi.fn()}
        onPositionChange={vi.fn()}
      />,
    );

    view.rerender(
      <GraphCanvas
        nodes={[{ ...topic, position: { x: -207, y: 84 } }]}
        edges={[]}
        onSelectNode={vi.fn()}
        onSelectProposalNode={vi.fn()}
        onPositionChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(fitView).toHaveBeenCalledWith({
      padding: 0.16,
      minZoom: 0.16,
      maxZoom: 1,
      duration: 0,
    }));
  });

  it('renders committed drag positions, then respects Undo and external position updates', async () => {
    const user = userEvent.setup();
    function ControlledPositions() {
      const [current, setCurrent] = useState([topic]);
      return <><button type="button" onClick={() => setCurrent([topic])}>Undo position</button><button type="button" onClick={() => setCurrent([{ ...topic, position: { x: 850, y: 120 } }])}>External position</button><GraphCanvas graphId="position-graph" nodes={current} edges={[]} onSelectNode={vi.fn()} onSelectProposalNode={vi.fn()} onPositionChange={(id, position) => setCurrent((values) => values.map((node) => node.id === id ? { ...node, position } : node))} /></>;
    }
    render(<ControlledPositions />);
    const node = () => screen.getByRole('button', { name: `Flow node ${topic.id}` });
    await user.click(screen.getByRole('button', { name: `Drag flow node ${topic.id}` }));
    expect(node()).toHaveAttribute('data-position-x', '310');
    await user.click(screen.getByRole('button', { name: 'Undo position' }));
    expect(node()).toHaveAttribute('data-position-x', '10');
    await user.click(screen.getByRole('button', { name: 'External position' }));
    expect(node()).toHaveAttribute('data-position-x', '850');
    expect(node()).toHaveAttribute('data-position-y', '120');
  });

  it('waits for the initial container layout to settle and preserves viewport on later additions', () => {
    vi.useFakeTimers();
    let resize: (() => void) | undefined;
    class InitialResizeObserver {
      active = true;
      constructor(callback: ResizeObserverCallback) { resize = () => { if (this.active) callback([], this as unknown as ResizeObserver); }; }
      observe() {} unobserve() {} disconnect() { this.active = false; }
    }
    vi.stubGlobal('ResizeObserver', InitialResizeObserver);
    const props = { graphId: 'same-graph', edges: [], onSelectNode: vi.fn(), onSelectProposalNode: vi.fn(), onPositionChange: vi.fn() };
    const view = render(<GraphCanvas {...props} nodes={[]} />);
    view.rerender(<GraphCanvas {...props} nodes={[topic]} />);
    act(() => { vi.advanceTimersByTime(50); resize?.(); vi.advanceTimersByTime(70); });
    expect(fitView).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(10); });
    expect(fitView).toHaveBeenCalledTimes(1);
    view.rerender(<GraphCanvas {...props} nodes={[topic, overlappingDropTarget]} />);
    act(() => { resize?.(); vi.advanceTimersByTime(200); });
    expect(fitView).toHaveBeenCalledTimes(1);
  });

  it('commits every selected intent position in one batch when the group drag stops', async () => {
    const user = userEvent.setup(); const onPositionsChange = vi.fn(); const onPositionChange = vi.fn();
    render(<GraphCanvas graphId="group" nodes={[topic, overlappingDropTarget]} edges={[]} selectedNodeIds={[topic.id, overlappingDropTarget.id]} onSelectNode={vi.fn()} onSelectProposalNode={vi.fn()} onPositionChange={onPositionChange} onPositionsChange={onPositionsChange} />);
    await user.click(screen.getByRole('button', { name: 'Drag selected intent group' }));
    expect(onPositionsChange).toHaveBeenCalledExactlyOnceWith([{ nodeId: topic.id, position: { x: 110, y: 70 } }, { nodeId: overlappingDropTarget.id, position: { x: 410, y: 70 } }]);
    expect(onPositionChange).not.toHaveBeenCalled();
  });

  it('selects and drags proposal nodes independently from editable intent nodes', async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    const onSelectProposalNode = vi.fn();
    const { rerender } = render(
      <GraphCanvas
        nodes={[topic]}
        edges={[]}
        proposedGraph={proposal}
        selectedNodeId={topic.id}
        onSelectNode={onSelectNode}
        onSelectProposalNode={onSelectProposalNode}
        onPositionChange={vi.fn()}
      />,
    );

    const proposedOverlay = screen.getByRole('button', { name: 'Flow node proposal::specialist:experience' });
    expect(screen.getByTestId('react-flow')).toHaveAttribute('data-auto-pan-on-node-drag', 'false');
    expect(screen.getByTestId('react-flow')).toHaveAttribute('data-node-drag-threshold', '0');
    expect(proposedOverlay).toHaveAttribute('data-selectable', 'true');
    expect(proposedOverlay).toHaveAttribute('data-draggable', 'true');
    await user.click(proposedOverlay);
    expect(onSelectNode).toHaveBeenLastCalledWith(undefined);
    expect(onSelectProposalNode).toHaveBeenLastCalledWith('specialist:experience');

    rerender(
      <GraphCanvas
        nodes={[topic]}
        edges={[]}
        proposedGraph={proposal}
        selectedProposalNodeId="specialist:experience"
        onSelectNode={onSelectNode}
        onSelectProposalNode={onSelectProposalNode}
        onPositionChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Flow node proposal::specialist:experience' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Flow node intent:portal' }));
    expect(onSelectProposalNode).toHaveBeenLastCalledWith(undefined);
    expect(onSelectNode).toHaveBeenLastCalledWith(topic.id);

    const onPositionChange = vi.fn();
    rerender(
      <GraphCanvas
        nodes={[topic, overlappingDropTarget]}
        edges={[]}
        proposedGraph={proposal}
        onSelectNode={onSelectNode}
        onSelectProposalNode={onSelectProposalNode}
        onPositionChange={onPositionChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Drag flow node proposal::specialist:experience' }));
    expect(onPositionChange).not.toHaveBeenCalled();
    expect(localStorage.getItem(`ege.proposal-layout.v1:${proposal.contentDigest}`)).toContain('specialist:experience');
    await waitFor(() => expect(setCenter).toHaveBeenCalled());

    setCenter.mockClear();
    await user.click(screen.getByRole('button', { name: `Drag flow node ${topic.id}` }));
    expect(onPositionChange).toHaveBeenCalledWith(topic.id, { x: 310, y: 20 });
    await waitFor(() => expect(setCenter).toHaveBeenCalledWith(
      430,
      80,
      { zoom: 0.55, duration: 120 },
    ));
  });

  it('renders plan traceability from the original intent and enables persistent draft linking', async () => {
    const user = userEvent.setup();
    const onConnectNodes = vi.fn();
    render(
      <GraphCanvas
        nodes={[topic, overlappingDropTarget]}
        edges={[]}
        proposedGraph={proposal}
        onSelectNode={vi.fn()}
        onSelectProposalNode={vi.fn()}
        onPositionChange={vi.fn()}
        onConnectNodes={onConnectNodes}
      />,
    );

    const traceEdge = screen.getByTestId(`flow-edge-traceability::${topic.id}::specialist:experience`);
    expect(traceEdge).toHaveAttribute('data-source', topic.id);
    expect(traceEdge).toHaveAttribute('data-target', 'proposal::specialist:experience');
    expect(traceEdge).toHaveAttribute('data-class-name', 'traceability-edge');
    expect(screen.getByTestId('react-flow')).toHaveAttribute('data-nodes-connectable', 'true');
    expect(screen.getByRole('button', { name: `Flow node ${topic.id}` })).toHaveAttribute('data-connectable', 'true');
    expect(screen.getByRole('button', { name: 'Flow node proposal::specialist:experience' })).toHaveAttribute('data-connectable', 'false');

    await user.click(screen.getByRole('button', { name: 'Connect first two draft nodes' }));
    expect(onConnectNodes).toHaveBeenCalledWith(topic.id, overlappingDropTarget.id);
  });

  it('keeps proposal coordinates fixed when an intent moves or another intent is added', () => {
    const props = {
      edges: [],
      proposedGraph: proposal,
      onSelectNode: vi.fn(),
      onSelectProposalNode: vi.fn(),
      onPositionChange: vi.fn(),
      onConnectNodes: vi.fn(),
    };
    const view = render(<GraphCanvas nodes={[topic]} {...props} />);
    const proposalNode = () => screen.getByRole('button', { name: 'Flow node proposal::specialist:experience' });
    const initialPosition = {
      x: proposalNode().getAttribute('data-position-x'),
      y: proposalNode().getAttribute('data-position-y'),
    };

    view.rerender(
      <GraphCanvas
        nodes={[
          { ...topic, position: { x: 720, y: 460 } },
          { ...overlappingDropTarget, position: { x: 1_020, y: 460 } },
        ]}
        {...props}
      />,
    );

    expect(proposalNode()).toHaveAttribute('data-position-x', initialPosition.x);
    expect(proposalNode()).toHaveAttribute('data-position-y', initialPosition.y);
  });

  it('focuses a node selected from the Node Library without changing its position', async () => {
    render(
      <GraphCanvas
        nodes={[topic]}
        edges={[]}
        selectedNodeId={topic.id}
        focusNodeRequest={{ nodeId: topic.id, sequence: 1 }}
        onSelectNode={vi.fn()}
        onSelectProposalNode={vi.fn()}
        onPositionChange={vi.fn()}
      />,
    );

    await waitFor(() => expect(setCenter).toHaveBeenCalledWith(
      130,
      80,
      { zoom: 0.9, duration: 160 },
    ));
  });

  it('keeps the current node selected when the canvas background is clicked', async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    const onSelectProposalNode = vi.fn();
    render(
      <GraphCanvas
        nodes={[topic]}
        edges={[]}
        selectedNodeId={topic.id}
        onSelectNode={onSelectNode}
        onSelectProposalNode={onSelectProposalNode}
        onPositionChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Flow node intent:portal' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Canvas background' }));

    expect(onSelectNode).not.toHaveBeenCalled();
    expect(onSelectProposalNode).not.toHaveBeenCalled();
  });
});
