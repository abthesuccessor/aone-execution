import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';
import type { ProposedRelationship, ProposedSpecialistNode, TopicNode } from './types';

export interface CanvasPosition {
  x: number;
  y: number;
}

interface LayoutNode extends SimulationNodeDatum {
  id: string;
  depth: number;
}

interface LayoutLink extends SimulationLinkDatum<LayoutNode> {
  source: string | LayoutNode;
  target: string | LayoutNode;
  type: string;
}

const PROPOSAL_NODE_WIDTH = 232;
const PROPOSAL_NODE_HEIGHT = 132;
const PROPOSAL_STORAGE_PREFIX = 'ege.proposal-layout.v1:';

export function createProposalForceLayout(
  intentNodes: TopicNode[],
  proposalNodes: ProposedSpecialistNode[],
  relationships: ProposedRelationship[],
): Map<string, CanvasPosition> {
  if (proposalNodes.length === 0) return new Map();

  const intentCenterX = intentNodes.length
    ? intentNodes.reduce((total, node) => total + node.position.x + 112, 0) / intentNodes.length
    : 520;
  const proposalTop = intentNodes.length
    ? Math.max(...intentNodes.map((node) => node.position.y + 124)) + 230
    : 180;
  const depths = proposalDepths(proposalNodes);
  const radius = Math.max(260, Math.sqrt(proposalNodes.length) * 185);
  const layoutNodes: LayoutNode[] = proposalNodes.map((node, index) => {
    const angle = index * Math.PI * (3 - Math.sqrt(5));
    const ring = radius * Math.sqrt((index + 1) / proposalNodes.length);
    return {
      id: node.id,
      depth: depths.get(node.id) ?? 0,
      x: intentCenterX + Math.cos(angle) * ring,
      y: proposalTop + Math.sin(angle) * ring * 0.58 + (depths.get(node.id) ?? 0) * 92,
    };
  });
  const nodeIds = new Set(layoutNodes.map((node) => node.id));
  const links: LayoutLink[] = relationships
    .filter((relationship) => nodeIds.has(relationship.source) && nodeIds.has(relationship.target))
    .map((relationship) => ({
      source: relationship.source,
      target: relationship.target,
      type: relationship.type,
    }));

  const simulation = forceSimulation(layoutNodes)
    .stop()
    .alpha(1)
    .alphaDecay(0.035)
    .velocityDecay(0.42)
    .force('links', forceLink<LayoutNode, LayoutLink>(links)
      .id((node) => node.id)
      .distance((link) => link.type === 'REQUIRES' ? 250 : 205)
      .strength((link) => link.type === 'REQUIRES' ? 0.62 : 0.28))
    .force('charge', forceManyBody<LayoutNode>().strength(-1_050).distanceMax(1_400))
    .force('collision', forceCollide<LayoutNode>(154).strength(1).iterations(3))
    .force('x', forceX<LayoutNode>(intentCenterX).strength(0.055))
    .force('y', forceY<LayoutNode>((node) => proposalTop + node.depth * 205).strength(0.19));

  simulation.tick(Math.min(360, 180 + proposalNodes.length * 8));
  simulation.stop();

  return new Map(layoutNodes.map((node) => [node.id, {
    x: Math.round((node.x ?? intentCenterX) - PROPOSAL_NODE_WIDTH / 2),
    y: Math.round((node.y ?? proposalTop) - PROPOSAL_NODE_HEIGHT / 2),
  }]));
}

export function readStoredProposalPositions(
  proposalDigest: string,
  proposalNodeIds: Set<string>,
): Map<string, CanvasPosition> {
  if (!proposalDigest || typeof localStorage === 'undefined') return new Map();
  try {
    const value = JSON.parse(localStorage.getItem(`${PROPOSAL_STORAGE_PREFIX}${proposalDigest}`) ?? '{}') as Record<string, CanvasPosition>;
    return new Map(Object.entries(value).filter(([id, position]) => (
      proposalNodeIds.has(id)
      && Number.isFinite(position?.x)
      && Number.isFinite(position?.y)
    )));
  } catch {
    return new Map();
  }
}

export function storeProposalPositions(proposalDigest: string, positions: Map<string, CanvasPosition>): void {
  if (!proposalDigest || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      `${PROPOSAL_STORAGE_PREFIX}${proposalDigest}`,
      JSON.stringify(Object.fromEntries(positions)),
    );
  } catch {
    // A read-only or full webview storage area must not break graph interaction.
  }
}

function proposalDepths(nodes: ProposedSpecialistNode[]): Map<string, number> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const result = new Map<string, number>();
  const visit = (node: ProposedSpecialistNode, trail: Set<string>): number => {
    const known = result.get(node.id);
    if (known !== undefined) return known;
    if (trail.has(node.id)) return 0;
    const nextTrail = new Set(trail).add(node.id);
    const upstream = (node.dependsOn ?? []).map((id) => nodeById.get(id)).filter(Boolean) as ProposedSpecialistNode[];
    const depth = upstream.length === 0 ? 0 : 1 + Math.max(...upstream.map((candidate) => visit(candidate, nextTrail)));
    result.set(node.id, depth);
    return depth;
  };
  nodes.forEach((node) => visit(node, new Set()));
  return result;
}
