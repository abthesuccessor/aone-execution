import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type NodeChange,
  type OnNodeDrag,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type ReactFlowInstance,
} from '@xyflow/react';
import { IconTopologyStar3 } from '@tabler/icons-react';
import type { GraphEdge, NodeRunStatus, ProposedGraph, TopicNode } from '../lib/types';
import {
  createProposalForceLayout,
  readStoredProposalPositions,
  storeProposalPositions,
  type CanvasPosition,
} from '../lib/proposal-layout';
import { ProposedFlowNode, type ProposedFlowNodeType } from './ProposedFlowNode';
import { TopicFlowNode, type TopicFlowNodeType } from './TopicFlowNode';
import { Button } from './ui/button';

interface GraphCanvasProps {
  graphId?: string;
  readOnly?: boolean;
  selectedNodeIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  onOpenNode?: (id: string) => void;
  onSelectEdge?: (id: string) => void;
  filterQuery?: string;
  collapsedGroups?: string[];
  showMinimap?: boolean;
  nodes: TopicNode[];
  edges: GraphEdge[];
  proposedGraph?: ProposedGraph;
  proposalStatuses?: Record<string, NodeRunStatus>;
  selectedNodeId?: string;
  selectedProposalNodeId?: string;
  focusNodeRequest?: { nodeId: string; sequence: number };
  onSelectNode: (nodeId?: string) => void;
  onSelectProposalNode: (nodeId?: string) => void;
  onPositionChange: (nodeId: string, position: { x: number; y: number }) => void;
  onPositionsChange?: (positions: Array<{ nodeId: string; position: CanvasPosition }>) => void;
  onConnectNodes?: (sourceNodeId: string, targetNodeId: string) => void;
}

const nodeTypes = { topic: TopicFlowNode, proposal: ProposedFlowNode };
const INTENT_NODE_INITIAL_SIZE = { width: 224, height: 124 };
const PROPOSAL_NODE_INITIAL_SIZE = { width: 232, height: 132 };

export function GraphCanvas({
  graphId,
  readOnly = false, selectedNodeIds, onSelectionChange, onOpenNode, onSelectEdge, filterQuery = '', collapsedGroups = [], showMinimap = false,
  nodes,
  edges,
  proposedGraph,
  proposalStatuses,
  selectedNodeId,
  selectedProposalNodeId,
  focusNodeRequest,
  onSelectNode,
  onSelectProposalNode,
  onPositionChange,
  onPositionsChange,
  onConnectNodes,
}: GraphCanvasProps) {
  const proposalDigest = proposedGraph?.contentDigest ?? proposedGraph?.proposalId ?? '';
  const proposalLayoutKey = useMemo(() => [
    proposalDigest,
    (proposedGraph?.nodes ?? []).map((node) => node.id).sort().join('|'),
    (proposedGraph?.relationships ?? []).map((relationship) => relationship.id).sort().join('|'),
  ].join('::'), [proposalDigest, proposedGraph]);
  const proposalLayoutCacheRef = useRef<{
    key: string;
    positions: Map<string, CanvasPosition>;
  }>({ key: '', positions: new Map() });
  if (proposalLayoutCacheRef.current.key !== proposalLayoutKey) {
    proposalLayoutCacheRef.current = {
      key: proposalLayoutKey,
      positions: createProposalForceLayout(
        nodes,
        proposedGraph?.nodes ?? [],
        proposedGraph?.relationships ?? [],
      ),
    };
  }
  const generatedProposalPositions = proposalLayoutCacheRef.current.positions;
  const storedProposalPositions = useMemo(() => readStoredProposalPositions(
    proposalDigest,
    new Set(proposedGraph?.nodes.map((node) => node.id) ?? []),
  ), [proposalDigest, proposedGraph]);
  const defaultProposalPositions = useMemo(() => new Map([
    ...generatedProposalPositions,
    ...storedProposalPositions,
  ]), [generatedProposalPositions, storedProposalPositions]);
  const [proposalPositionState, setProposalPositionState] = useState<{
    digest: string;
    positions: Map<string, CanvasPosition>;
  }>({ digest: '', positions: new Map() });
  const canonicalPositionKey = useMemo(() => JSON.stringify([graphId, nodes.map((node) => [node.id, node.position.x, node.position.y])]), [graphId, nodes]);
  const [intentDragState, setIntentDragState] = useState<{ key: string; positions: Map<string, CanvasPosition> }>({ key: canonicalPositionKey, positions: new Map() });
  const intentDragPositions = useMemo(() => intentDragState.key === canonicalPositionKey ? intentDragState.positions : new Map<string, CanvasPosition>(), [canonicalPositionKey, intentDragState]);
  const setIntentDragPositions = useCallback((update: (current: Map<string, CanvasPosition>) => Map<string, CanvasPosition>) => {
    setIntentDragState((current) => ({ key: canonicalPositionKey, positions: update(current.key === canonicalPositionKey ? current.positions : new Map()) }));
  }, [canonicalPositionKey]);
  useEffect(() => { if (readOnly) setIntentDragPositions(() => new Map()); }, [readOnly, setIntentDragPositions]);
  const [measuredNodeSizes, setMeasuredNodeSizes] = useState<Map<string, { width: number; height: number }>>(new Map());
  const flowRootRef = useRef<HTMLDivElement>(null);
  const flowInstanceRef = useRef<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const visibilityTimerRef = useRef<number | null>(null);
  const intentPositions = useMemo(() => new Map(nodes.map((node) => [
    node.id,
    intentDragPositions.get(node.id) ?? node.position,
  ])), [intentDragPositions, nodes]);
  const proposalPositions = proposalPositionState.digest === proposalDigest
    ? proposalPositionState.positions
    : defaultProposalPositions;
  const viewportContentKey = useMemo(() => graphId
    ? `${graphId}::${proposalDigest}`
    : [
      nodes.map((node) => node.id).sort().join('|'),
      proposalDigest,
      (proposedGraph?.nodes ?? []).map((node) => node.id).sort().join('|'),
    ].join('::'), [graphId, nodes, proposalDigest, proposedGraph]);

  const flowNodes = useMemo<FlowNode[]>(() => {
    const intentNodes = nodes.map((node) => ({
      id: node.id,
      type: 'topic',
      position: intentPositions.get(node.id) ?? node.position,
      initialWidth: INTENT_NODE_INITIAL_SIZE.width,
      initialHeight: INTENT_NODE_INITIAL_SIZE.height,
      measured: measuredNodeSizes.get(node.id),
      data: node,
      selected: selectedNodeIds?.includes(node.id) ?? node.id === selectedNodeId,
      hidden: Boolean(node.group && collapsedGroups.includes(node.group)) || !`${node.title} ${node.objective} ${node.group ?? ''}`.toLowerCase().includes(filterQuery.toLowerCase()),
      draggable: !readOnly,
      selectable: true,
      connectable: !readOnly && Boolean(onConnectNodes),
      focusable: true,
      ariaRole: 'button',
      ariaLabel: `Select node ${node.title}`,
      zIndex: node.id === selectedNodeId ? 30 : 20,
    } satisfies TopicFlowNodeType));
    const proposalNodes = (proposedGraph?.nodes ?? []).map((specialist) => ({
      id: proposalNodeId(specialist.id),
      type: 'proposal',
      position: proposalPositions.get(specialist.id) ?? { x: 600, y: 100 },
      initialWidth: PROPOSAL_NODE_INITIAL_SIZE.width,
      initialHeight: PROPOSAL_NODE_INITIAL_SIZE.height,
      measured: measuredNodeSizes.get(proposalNodeId(specialist.id)),
      data: { specialist, status: proposalStatuses?.[specialist.id] },
      draggable: !readOnly,
      selectable: true,
      selected: specialist.id === selectedProposalNodeId,
      connectable: false,
      focusable: true,
      ariaRole: 'button',
      ariaLabel: `Select proposed specialist ${specialist.title}`,
      zIndex: specialist.id === selectedProposalNodeId ? 25 : 10,
    } satisfies ProposedFlowNodeType));
    return [...intentNodes, ...proposalNodes];
  }, [intentPositions, measuredNodeSizes, nodes, onConnectNodes, proposalPositions, proposedGraph, proposalStatuses, selectedNodeId, selectedProposalNodeId, selectedNodeIds, readOnly, filterQuery, collapsedGroups]);

  const flowEdges = useMemo<FlowEdge[]>(() => {
    const intentEdges = edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: (edge.type ?? 'RELATED_TO').replaceAll('_', ' ').toLowerCase(),
      ariaLabel: `${edge.rationale || 'RELATED'} from ${edge.source} to ${edge.target}`,
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#77979e' },
      className: 'intent-edge',
      animated: false,
    }));
    const intentIds = new Set(nodes.map((node) => node.id));
    const specialistIds = new Set(proposedGraph?.nodes.map((node) => node.id) ?? []);
    const traceabilityEdges = (proposedGraph?.nodes ?? []).flatMap((specialist, specialistIndex) => (
      (specialist.traceability?.intentNodeIds ?? [])
        .filter((intentNodeId) => intentIds.has(intentNodeId))
        .map((intentNodeId, intentIndex) => ({
          id: `traceability::${intentNodeId}::${specialist.id}`,
          source: intentNodeId,
          target: proposalNodeId(specialist.id),
          type: 'smoothstep',
          pathOptions: { offset: 16 + ((specialistIndex + intentIndex) % 4) * 7, borderRadius: 8 },
          ariaLabel: `Source intent ${intentNodeId} proposes ${specialist.id}`,
          markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: '#6c8f97' },
          className: 'traceability-edge',
          selectable: false,
          focusable: false,
          zIndex: 0,
        }))
    ));
    const proposalEdges = (proposedGraph?.relationships ?? [])
      .filter((relationship) => specialistIds.has(relationship.source) && specialistIds.has(relationship.target))
      .map((relationship, index) => ({
        id: `proposal::${relationship.id}`,
        source: proposalNodeId(relationship.source),
        target: proposalNodeId(relationship.target),
        type: 'smoothstep',
        pathOptions: { offset: 22 + (index % 4) * 8, borderRadius: 8 },
        label: String(relationship.type || 'RELATED').replaceAll('_', ' '),
        ariaLabel: `${relationship.type} from ${relationship.source} to ${relationship.target}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#4d9da2' },
        className: 'proposed-edge',
        selectable: false,
      }));
    return [...traceabilityEdges, ...intentEdges, ...proposalEdges];
  }, [edges, nodes, proposedGraph]);

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    const selectionChanges = changes.filter((change) => change.type === 'select' && !isProposalNodeId(change.id));
    if (selectionChanges.length && onSelectionChange) {
      const next = new Set(selectedNodeIds ?? (selectedNodeId ? [selectedNodeId] : []));
      for (const change of selectionChanges) if (change.type === 'select') { if (change.selected) next.add(change.id); else next.delete(change.id); }
      onSelectionChange([...next]);
    }
    const dimensionChanges = changes.filter((change) => (
      change.type === 'dimensions'
      && change.dimensions
      && Number.isFinite(change.dimensions.width)
      && Number.isFinite(change.dimensions.height)
      && change.dimensions.width > 0
      && change.dimensions.height > 0
    ));
    if (dimensionChanges.length > 0) {
      setMeasuredNodeSizes((current) => {
        const sizes = new Map(current);
        let changed = false;
        for (const change of dimensionChanges) {
          if (change.type !== 'dimensions' || !change.dimensions) continue;
          const previous = sizes.get(change.id);
          if (previous?.width === change.dimensions.width && previous.height === change.dimensions.height) continue;
          sizes.set(change.id, change.dimensions);
          changed = true;
        }
        return changed ? sizes : current;
      });
    }
    const proposalChanges = changes.filter((change) => (
      change.type === 'position' && change.position && isProposalNodeId(change.id)
    ));
    if (proposalChanges.length > 0) {
      setProposalPositionState((current) => {
        const positions = new Map(current.digest === proposalDigest ? current.positions : proposalPositions);
        for (const change of proposalChanges) {
          if (change.type === 'position' && change.position) positions.set(fromProposalNodeId(change.id), change.position);
        }
        return { digest: proposalDigest, positions };
      });
    }
    const intentChanges = changes.filter((change) => (
      change.type === 'position' && change.position && !isProposalNodeId(change.id)
    ));
    if (intentChanges.length > 0) {
      setIntentDragPositions((current) => {
        const positions = new Map(current);
        for (const change of intentChanges) {
          if (change.type === 'position' && change.position) positions.set(change.id, change.position);
        }
        return positions;
      });
    }
  }, [proposalDigest, proposalPositions, onSelectionChange, selectedNodeIds, selectedNodeId, setIntentDragPositions]);

  useEffect(() => {
    const activeNodeIds = new Set([
      ...nodes.map((node) => node.id),
      ...(proposedGraph?.nodes ?? []).map((node) => proposalNodeId(node.id)),
    ]);
    setMeasuredNodeSizes((current) => {
      if ([...current.keys()].every((id) => activeNodeIds.has(id))) return current;
      return new Map([...current].filter(([id]) => activeNodeIds.has(id)));
    });
  }, [nodes, proposedGraph]);

  const keepDraggedNodeVisible = useCallback((draggedNode: FlowNode) => {
    if (visibilityTimerRef.current !== null) window.clearTimeout(visibilityTimerRef.current);
    visibilityTimerRef.current = window.setTimeout(() => {
      visibilityTimerRef.current = null;
      const root = flowRootRef.current;
      const instance = flowInstanceRef.current;
      if (!root || !instance) return;
      const nodeElement = [...root.querySelectorAll<HTMLElement>('.react-flow__node')]
        .find((element) => element.dataset.id === draggedNode.id);
      if (nodeElement && hasUsableNodeIntersection(root.getBoundingClientRect(), nodeElement.getBoundingClientRect())) {
        return;
      }
      const currentNode = instance.getNode(draggedNode.id) ?? draggedNode;
      const position = finiteCanvasPosition(currentNode.position);
      const width = currentNode.measured?.width ?? currentNode.width ?? 240;
      const height = currentNode.measured?.height ?? currentNode.height ?? 120;
      void instance.setCenter(
        position.x + width / 2,
        position.y + height / 2,
        { zoom: Math.max(instance.getZoom(), 0.55), duration: 120 },
      );
    }, 0);
  }, []);

  useEffect(() => () => {
    if (visibilityTimerRef.current !== null) window.clearTimeout(visibilityTimerRef.current);
  }, []);

  const handleNodeDragStop: OnNodeDrag = useCallback((_, node, draggedNodes) => {
    if (readOnly) return;
    if (isProposalNodeId(node.id)) {
      const position = finiteCanvasPosition(node.position);
      const nextPositions = new Map(proposalPositions);
      nextPositions.set(fromProposalNodeId(node.id), position);
      setProposalPositionState({ digest: proposalDigest, positions: nextPositions });
      storeProposalPositions(proposalDigest, nextPositions);
      keepDraggedNodeVisible({ ...node, position });
      return;
    }
    const position = finiteCanvasPosition(node.position);
    const moved = [...new Map([node, ...(draggedNodes ?? [])].filter((item) => !isProposalNodeId(item.id)).map((item) => [item.id, item])).values()]
      .map((item) => ({ nodeId: item.id, position: finiteCanvasPosition(item.position) }))
      .filter((item) => { const current = nodes.find((candidate) => candidate.id === item.nodeId); return current && (current.position.x !== item.position.x || current.position.y !== item.position.y); });
    if (moved.length && onPositionsChange) onPositionsChange(moved);
    else for (const item of moved) onPositionChange(item.nodeId, item.position);
    // The parent owns committed positions. React batches its update with this cleanup,
    // so accepted moves stay in place and future Undo/server edits remain visible.
    setIntentDragPositions((current) => { const next = new Map(current); for (const item of [node, ...(draggedNodes ?? [])]) next.delete(item.id); return next; });
    keepDraggedNodeVisible({ ...node, position });
  }, [keepDraggedNodeVisible, nodes, onPositionChange, onPositionsChange, proposalDigest, proposalPositions, readOnly, setIntentDragPositions]);

  const handleConnect = useCallback((connection: Connection) => {
    const { source, target } = connection;
    if (readOnly || !source || !target || source === target || isProposalNodeId(source) || isProposalNodeId(target)) return;
    onConnectNodes?.(source, target);
  }, [onConnectNodes, readOnly]);

  const selectNode = useCallback((node: FlowNode) => {
    if (node.type === 'topic') {
      onSelectProposalNode(undefined);
      onSelectNode(node.id);
    } else if (node.type === 'proposal') {
      onSelectNode(undefined);
      onSelectProposalNode(fromProposalNodeId(node.id));
    }
  }, [onSelectNode, onSelectProposalNode]);

  const autoArrangeProposals = useCallback(() => {
    const positions = createProposalForceLayout(
      nodes,
      proposedGraph?.nodes ?? [],
      proposedGraph?.relationships ?? [],
    );
    setProposalPositionState({ digest: proposalDigest, positions });
    storeProposalPositions(proposalDigest, positions);
  }, [nodes, proposalDigest, proposedGraph]);

  if (nodes.length === 0) {
    return (
      <div className="canvas-empty" role="status">
        <IconEmpty />
        <strong>This workspace is empty</strong>
        <span>Use + in Node Library to add the first context node.</span>
      </div>
    );
  }

  return (
    <div ref={flowRootRef} className="graph-flow-shell">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onInit={(instance) => { flowInstanceRef.current = instance; }}
        onNodesChange={handleNodesChange}
        onConnect={handleConnect}
        isValidConnection={(connection) => Boolean(
          !readOnly && onConnectNodes
          && connection.source
          && connection.target
          && connection.source !== connection.target
          && !isProposalNodeId(connection.source)
          && !isProposalNodeId(connection.target)
        )}
        onNodeDragStop={handleNodeDragStop}
        onNodeClick={(event, node) => {
          event.stopPropagation();
          if (!event.shiftKey && !event.metaKey && !event.ctrlKey) selectNode(node);
        }}
        onNodeDoubleClick={(_, node) => { if (!isProposalNodeId(node.id)) onOpenNode?.(node.id); }}
        onEdgeClick={(_, edge) => { if (!edge.id.startsWith('proposal::') && !edge.id.startsWith('traceability::')) onSelectEdge?.(edge.id); }}
        onNodeDragStart={(event, node) => {
          if (!event.shiftKey && !event.metaKey && !event.ctrlKey && !selectedNodeIds?.includes(node.id)) selectNode(node);
        }}
        selectNodesOnDrag={false}
        nodesDraggable={!readOnly}
        multiSelectionKeyCode={['Meta', 'Control', 'Shift']}
        nodeDragThreshold={0}
        autoPanOnNodeDrag={false}
        elevateNodesOnSelect
        fitView
        fitViewOptions={{ padding: 0.14, minZoom: 0.16, maxZoom: 1 }}
        minZoom={0.12}
        maxZoom={1.8}
        nodesConnectable={!readOnly && Boolean(onConnectNodes)}
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
        aria-label="Engineering topic graph"
      >
        <GraphViewportSync containerRef={flowRootRef} contentKey={viewportContentKey} focusNodeRequest={focusNodeRequest} />
        <Background color="#38383d" gap={22} size={1} variant={BackgroundVariant.Dots} />
        {showMinimap && <MiniMap pannable zoomable nodeColor={(node) => node.type === 'proposal' ? '#44727a' : '#24b6a7'} maskColor="rgba(30, 30, 30, 0.76)" />}
        <Controls showInteractive={false} />
        {proposedGraph?.nodes.length ? (
          <Panel position="top-left" className="proposal-layout-controls">
            <Button type="button" variant="secondary" size="sm" onClick={autoArrangeProposals} title="Re-run force layout for proposal nodes">
              <IconTopologyStar3 size={15} aria-hidden="true" /> Arrange proposals
            </Button>
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
}

function GraphViewportSync({
  containerRef,
  contentKey,
  focusNodeRequest,
}: {
  containerRef: { current: HTMLDivElement | null };
  contentKey: string;
  focusNodeRequest?: { nodeId: string; sequence: number };
}) {
  const nodesInitialized = useNodesInitialized();
  const { fitView, getNode, setCenter } = useReactFlow();
  const lastFittedKey = useRef('');
  const lastFocusSequence = useRef(0);

  useEffect(() => {
    if (!nodesInitialized || !contentKey || lastFittedKey.current === contentKey) return undefined;
    let timeout: number;
    let observer: ResizeObserver | undefined;
    const container = containerRef.current;
    const finish = () => { window.clearTimeout(timeout); observer?.disconnect(); container?.removeEventListener('pointerdown', userTookControl); container?.removeEventListener('wheel', userTookControl); };
    const userTookControl = () => { lastFittedKey.current = contentKey; finish(); };
    const scheduleFit = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(() => {
        void fitView({ padding: 0.16, minZoom: 0.16, maxZoom: 1, duration: 0 });
        lastFittedKey.current = contentKey;
        finish();
      }, 80);
    };
    if (container && typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(scheduleFit); observer.observe(container); }
    container?.addEventListener('pointerdown', userTookControl, { once: true });
    container?.addEventListener('wheel', userTookControl, { once: true });
    scheduleFit();
    return finish;
  }, [containerRef, contentKey, fitView, nodesInitialized]);

  useEffect(() => {
    if (!nodesInitialized || !focusNodeRequest || focusNodeRequest.sequence === lastFocusSequence.current) {
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      const node = getNode(focusNodeRequest.nodeId);
      if (!node) return;
      const width = node.measured?.width ?? node.width ?? 240;
      const height = node.measured?.height ?? node.height ?? 120;
      void setCenter(
        node.position.x + width / 2,
        node.position.y + height / 2,
        { zoom: 0.9, duration: 160 },
      );
      lastFocusSequence.current = focusNodeRequest.sequence;
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [focusNodeRequest, getNode, nodesInitialized, setCenter]);

  return null;
}

function finiteCanvasPosition(position: CanvasPosition): CanvasPosition {
  return {
    x: Number.isFinite(position.x) ? position.x : 100,
    y: Number.isFinite(position.y) ? position.y : 100,
  };
}

function hasUsableNodeIntersection(container: DOMRect, node: DOMRect): boolean {
  const width = Math.max(0, Math.min(container.right, node.right) - Math.max(container.left, node.left));
  const height = Math.max(0, Math.min(container.bottom, node.bottom) - Math.max(container.top, node.top));
  return width >= Math.min(node.width, 48) && height >= Math.min(node.height, 36);
}

function proposalNodeId(value: string): string {
  return `proposal::${value}`;
}

function isProposalNodeId(value: string): boolean {
  return value.startsWith('proposal::');
}

function fromProposalNodeId(value: string): string {
  return value.slice('proposal::'.length);
}

function IconEmpty() {
  return <div className="empty-graph-mark" aria-hidden="true"><span /><span /><span /></div>;
}
