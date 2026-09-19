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
import type { GraphEdge, TopicNode } from './types';

export interface IntentCanvasPosition {
  x: number;
  y: number;
}

interface IntentLayoutNode extends SimulationNodeDatum {
  id: string;
  anchorX: number;
  anchorY: number;
}

interface IntentLayoutLink extends SimulationLinkDatum<IntentLayoutNode> {
  source: string | IntentLayoutNode;
  target: string | IntentLayoutNode;
}

const INTENT_NODE_WIDTH = 224;
const INTENT_NODE_HEIGHT = 124;
const INTENT_HORIZONTAL_GAP = 32;
const INTENT_VERTICAL_GAP = 32;
const INTENT_GRID_X = INTENT_NODE_WIDTH + INTENT_HORIZONTAL_GAP;
const INTENT_GRID_Y = INTENT_NODE_HEIGHT + INTENT_VERTICAL_GAP;
const INTENT_COLLISION_RADIUS = 151;

export function createIntentCollisionLayout(
  nodes: TopicNode[],
  edges: GraphEdge[],
): Map<string, IntentCanvasPosition> {
  const original = new Map(nodes.map((node) => [node.id, finitePosition(node.position)]));
  if (nodes.length < 2 || !hasIntentPositionCollisions([...original.values()])) return original;

  const layoutNodes: IntentLayoutNode[] = nodes.map((node) => {
    const position = original.get(node.id)!;
    const anchorX = position.x + INTENT_NODE_WIDTH / 2;
    const anchorY = position.y + INTENT_NODE_HEIGHT / 2;
    return { id: node.id, x: anchorX, y: anchorY, anchorX, anchorY };
  });
  const nodeIds = new Set(layoutNodes.map((node) => node.id));
  const links: IntentLayoutLink[] = edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target) && edge.source !== edge.target)
    .map((edge) => ({ source: edge.source, target: edge.target }));

  const simulation = forceSimulation(layoutNodes)
    .stop()
    .alpha(1)
    .alphaDecay(0.035)
    .velocityDecay(0.42)
    .force('links', forceLink<IntentLayoutNode, IntentLayoutLink>(links)
      .id((node) => node.id)
      .distance(310)
      .strength(0.24))
    .force('charge', forceManyBody<IntentLayoutNode>().strength(-720).distanceMax(1_200))
    .force('collision', forceCollide<IntentLayoutNode>(INTENT_COLLISION_RADIUS).strength(1).iterations(5))
    .force('x', forceX<IntentLayoutNode>((node) => node.anchorX).strength(0.07))
    .force('y', forceY<IntentLayoutNode>((node) => node.anchorY).strength(0.07));

  simulation.tick(Math.min(360, 220 + nodes.length * 12));
  simulation.stop();

  const positions = new Map<string, IntentCanvasPosition>();
  for (const node of layoutNodes) {
    const preferred = {
      x: Math.round((node.x ?? node.anchorX) - INTENT_NODE_WIDTH / 2),
      y: Math.round((node.y ?? node.anchorY) - INTENT_NODE_HEIGHT / 2),
    };
    positions.set(node.id, nearestAvailableIntentPosition(preferred, [...positions.values()]));
  }
  return positions;
}

export function nearestAvailableIntentPosition(
  preferred: IntentCanvasPosition,
  occupied: IntentCanvasPosition[],
): IntentCanvasPosition {
  const origin = finitePosition(preferred);
  if (!occupied.some((position) => intentPositionsOverlap(origin, position))) return origin;

  for (let ring = 1; ring <= 48; ring += 1) {
    const offsets: Array<[number, number]> = [];
    for (let offset = -ring; offset <= ring; offset += 1) {
      offsets.push([ring, offset], [offset, ring], [-ring, offset], [offset, -ring]);
    }
    const seen = new Set<string>();
    for (const [column, row] of offsets) {
      const key = `${column}:${row}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = {
        x: origin.x + column * INTENT_GRID_X,
        y: origin.y + row * INTENT_GRID_Y,
      };
      if (!occupied.some((position) => intentPositionsOverlap(candidate, position))) return candidate;
    }
  }

  return { x: origin.x + occupied.length * INTENT_GRID_X, y: origin.y };
}

export function hasIntentPositionCollisions(positions: IntentCanvasPosition[]): boolean {
  return positions.some((position, index) => (
    positions.slice(index + 1).some((candidate) => intentPositionsOverlap(position, candidate))
  ));
}

function intentPositionsOverlap(left: IntentCanvasPosition, right: IntentCanvasPosition): boolean {
  return Math.abs(left.x - right.x) < INTENT_GRID_X
    && Math.abs(left.y - right.y) < INTENT_GRID_Y;
}

function finitePosition(position: IntentCanvasPosition): IntentCanvasPosition {
  return {
    x: Number.isFinite(position?.x) ? Math.round(position.x) : 100,
    y: Number.isFinite(position?.y) ? Math.round(position.y) : 100,
  };
}
