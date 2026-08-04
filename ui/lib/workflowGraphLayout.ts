// Layout for the workflow routing canvas.
//
// Deliberately NOT a general graph layout. Real Agent HQ data has near-unique
// stage_order per status (the dev workflow type runs 0..14 across 14 statuses), so
// treating stage_order as a layer would produce a 14-column strip one node wide.
//
// Instead this is a subway/git-graph layout: statuses form a single vertical column
// in stage_order, forward transitions arc down the right, and rework transitions arc
// up the left. That makes the pipeline read top-to-bottom and makes rework loops
// visually distinct from forward progress, which is the thing operators most need to
// see. Arcs are assigned to lanes by greedy interval allocation so they never overlap.
//
// Everything here is pure so it can be unit tested without a DOM.

export const ROW_PITCH = 78;
export const NODE_HEIGHT = 58;
export const LANE_WIDTH = 22;
export const NODE_WIDTH = 248;

export type LayoutInputNode = { id: string };

export type LayoutInputEdge = {
  transition_id: number;
  from: string;
  to: string;
  parallel_group: string;
};

export type LayoutNode = {
  id: string;
  index: number;
  /** Vertical centre of the node box. */
  y: number;
};

export type LayoutArc = {
  key: string;
  from: string;
  to: string;
  fromIndex: number;
  toIndex: number;
  fromY: number;
  toY: number;
  side: 'left' | 'right';
  /** Gutter lane, or -1 for an adjacent hop drawn straight between the two boxes. */
  lane: number;
  selfLoop: boolean;
  /**
   * A forward transition between vertically neighbouring statuses. Real pipelines are
   * mostly these, and routing them out into the gutter both wastes lanes and hides the
   * happy path off the right edge, so they are drawn as a short straight connector.
   */
  adjacent: boolean;
  /** Transition ids collapsed into this arc, so the UI can badge the count. */
  edgeIds: number[];
};

export type GraphLayout = {
  nodes: LayoutNode[];
  arcs: LayoutArc[];
  leftLanes: number;
  rightLanes: number;
  height: number;
};

function spansOverlap(a: [number, number], b: [number, number]): boolean {
  // Inclusive on purpose: two arcs that merely meet at a shared row would otherwise
  // share a lane and render as one continuous vertical line, which reads as a single
  // long arc rather than two separate transitions.
  return a[0] <= b[1] && b[0] <= a[1];
}

/** Greedy interval-graph colouring: lowest lane not taken by an overlapping arc. */
function allocateLane(span: [number, number], placed: Array<{ span: [number, number]; lane: number }>): number {
  const taken = new Set(placed.filter((entry) => spansOverlap(span, entry.span)).map((entry) => entry.lane));
  let lane = 0;
  while (taken.has(lane)) lane += 1;
  return lane;
}

export function computeGraphLayout(nodes: LayoutInputNode[], edges: LayoutInputEdge[]): GraphLayout {
  const indexOf = new Map(nodes.map((node, index) => [node.id, index]));
  const layoutNodes: LayoutNode[] = nodes.map((node, index) => ({
    id: node.id,
    index,
    y: index * ROW_PITCH + NODE_HEIGHT / 2,
  }));

  // Collapse parallel transitions between the same pair into a single arc. Real data
  // reaches 5 parallel transitions between one pair, which would be unreadable drawn
  // separately; the UI badges the count and expands on click instead.
  const grouped = new Map<string, LayoutInputEdge[]>();
  for (const edge of edges) {
    if (!indexOf.has(edge.from) || !indexOf.has(edge.to)) continue;
    grouped.set(edge.parallel_group, [...(grouped.get(edge.parallel_group) ?? []), edge]);
  }

  const candidates = [...grouped.entries()].map(([key, group]) => {
    const fromIndex = indexOf.get(group[0].from) as number;
    const toIndex = indexOf.get(group[0].to) as number;
    return {
      key,
      from: group[0].from,
      to: group[0].to,
      fromIndex,
      toIndex,
      // Forward progress arcs right; anything that moves a task back up the pipeline
      // (or loops in place) arcs left, so rework is visually separable at a glance.
      side: (toIndex > fromIndex ? 'right' : 'left') as 'left' | 'right',
      selfLoop: fromIndex === toIndex,
      adjacent: toIndex === fromIndex + 1,
      edgeIds: group.map((edge) => edge.transition_id).sort((a, b) => a - b),
    };
  });

  // Sort by span start then length so allocation is deterministic regardless of the
  // order the API returned rows in.
  candidates.sort((a, b) => {
    const aStart = Math.min(a.fromIndex, a.toIndex);
    const bStart = Math.min(b.fromIndex, b.toIndex);
    if (aStart !== bStart) return aStart - bStart;
    const aLen = Math.abs(a.toIndex - a.fromIndex);
    const bLen = Math.abs(b.toIndex - b.fromIndex);
    if (aLen !== bLen) return aLen - bLen;
    return a.key.localeCompare(b.key);
  });

  const placed: Record<'left' | 'right', Array<{ span: [number, number]; lane: number }>> = { left: [], right: [] };
  const arcs: LayoutArc[] = candidates.map((candidate) => {
    // Adjacent hops are drawn straight between the boxes, so they never occupy a
    // gutter lane and never widen the canvas.
    if (candidate.adjacent) {
      return {
        ...candidate,
        lane: -1,
        fromY: candidate.fromIndex * ROW_PITCH + NODE_HEIGHT / 2,
        toY: candidate.toIndex * ROW_PITCH + NODE_HEIGHT / 2,
      };
    }
    const span: [number, number] = [
      Math.min(candidate.fromIndex, candidate.toIndex),
      Math.max(candidate.fromIndex, candidate.toIndex),
    ];
    const lane = allocateLane(span, placed[candidate.side]);
    placed[candidate.side].push({ span, lane });
    return {
      ...candidate,
      lane,
      fromY: candidate.fromIndex * ROW_PITCH + NODE_HEIGHT / 2,
      toY: candidate.toIndex * ROW_PITCH + NODE_HEIGHT / 2,
    };
  });

  const laneCount = (side: 'left' | 'right'): number =>
    placed[side].length === 0 ? 0 : Math.max(...placed[side].map((entry) => entry.lane)) + 1;

  return {
    nodes: layoutNodes,
    arcs,
    leftLanes: laneCount('left'),
    rightLanes: laneCount('right'),
    height: nodes.length === 0 ? 0 : (nodes.length - 1) * ROW_PITCH + NODE_HEIGHT,
  };
}

/** SVG path for an arc, bulging out to its lane and back. */
export function arcPath(arc: LayoutArc, gutter: number): string {
  const anchor = gutter;

  // Adjacent hop: a short straight drop between the two stacked boxes.
  if (arc.adjacent) {
    return `M ${anchor} ${arc.fromY} L ${anchor} ${arc.toY}`;
  }

  const x = arc.side === 'right'
    ? gutter + (arc.lane + 1) * LANE_WIDTH
    : gutter - (arc.lane + 1) * LANE_WIDTH;

  if (arc.selfLoop) {
    const r = 14 + arc.lane * 6;
    const sweep = arc.side === 'right' ? 1 : 0;
    return `M ${anchor} ${arc.fromY - r / 2} A ${r} ${r} 0 1 ${sweep} ${anchor} ${arc.fromY + r / 2}`;
  }

  const curve = Math.min(22, Math.abs(arc.toY - arc.fromY) / 2);
  const dir = arc.toY > arc.fromY ? 1 : -1;
  const bend = arc.side === 'right' ? 1 : -1;
  return [
    `M ${anchor} ${arc.fromY}`,
    `Q ${anchor + bend * curve} ${arc.fromY} ${x} ${arc.fromY + dir * curve}`,
    `L ${x} ${arc.toY - dir * curve}`,
    `Q ${anchor + bend * curve} ${arc.toY} ${anchor} ${arc.toY}`,
  ].join(' ');
}
