import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeGraphLayout, NODE_HEIGHT, ROW_PITCH, type LayoutInputEdge } from './workflowGraphLayout.ts';

const nodes = (...ids: string[]) => ids.map((id) => ({ id }));

function edge(id: number, from: string, to: string): LayoutInputEdge {
  return { id: `t${id}`, from, to, parallel_group: `${from}->${to}` };
}

test('places nodes in a single column at a fixed pitch', () => {
  const layout = computeGraphLayout(nodes('a', 'b', 'c'), []);
  assert.deepEqual(layout.nodes.map((node) => node.index), [0, 1, 2]);
  assert.deepEqual(layout.nodes.map((node) => node.y), [
    NODE_HEIGHT / 2,
    ROW_PITCH + NODE_HEIGHT / 2,
    ROW_PITCH * 2 + NODE_HEIGHT / 2,
  ]);
  assert.equal(layout.height, ROW_PITCH * 2 + NODE_HEIGHT);
});

test('an empty graph has zero height rather than a negative one', () => {
  const layout = computeGraphLayout([], []);
  assert.equal(layout.height, 0);
  assert.deepEqual(layout.arcs, []);
});

test('forward transitions arc right and rework transitions arc left', () => {
  const layout = computeGraphLayout(nodes('todo', 'review', 'done'), [
    edge(1, 'todo', 'review'),
    edge(2, 'review', 'done'),
    edge(3, 'review', 'todo'),
  ]);
  const bySide = Object.fromEntries(layout.arcs.map((arc) => [arc.key, arc.side]));
  assert.equal(bySide['todo->review'], 'right');
  assert.equal(bySide['review->done'], 'right');
  assert.equal(bySide['review->todo'], 'left');
});

test('collapses parallel transitions between the same pair into one arc', () => {
  const layout = computeGraphLayout(nodes('todo', 'done'), [
    { id: 't5', from: 'todo', to: 'done', parallel_group: 'todo->done' },
    { id: 't2', from: 'todo', to: 'done', parallel_group: 'todo->done' },
    { id: 't9', from: 'todo', to: 'done', parallel_group: 'todo->done' },
  ]);
  assert.equal(layout.arcs.length, 1);
  assert.deepEqual(layout.arcs[0].edgeIds, ['t2', 't5', 't9']);
});

test('gives overlapping arcs on the same side different lanes', () => {
  const layout = computeGraphLayout(nodes('a', 'b', 'c', 'd'), [
    edge(1, 'a', 'c'),
    edge(2, 'b', 'd'),
  ]);
  const lanes = layout.arcs.map((arc) => arc.lane).sort();
  assert.deepEqual(lanes, [0, 1]);
  assert.equal(layout.rightLanes, 2);
});

test('draws adjacent forward hops straight instead of routing them through a lane', () => {
  // The happy path of a pipeline is a chain of adjacent hops. Routing those into the
  // gutter would push the forward flow off the right edge of the canvas.
  const layout = computeGraphLayout(nodes('a', 'b', 'c'), [
    edge(1, 'a', 'b'),
    edge(2, 'b', 'c'),
  ]);
  assert.deepEqual(layout.arcs.map((arc) => arc.adjacent), [true, true]);
  assert.deepEqual(layout.arcs.map((arc) => arc.lane), [-1, -1]);
  assert.equal(layout.rightLanes, 0);
});

test('a backward hop between neighbours is not treated as adjacent', () => {
  const layout = computeGraphLayout(nodes('a', 'b'), [edge(1, 'b', 'a')]);
  assert.equal(layout.arcs[0].adjacent, false);
  assert.equal(layout.arcs[0].side, 'left');
  assert.equal(layout.arcs[0].lane, 0);
});

test('reuses a lane for non-adjacent arcs whose spans do not overlap', () => {
  const layout = computeGraphLayout(nodes('a', 'b', 'c', 'd', 'e', 'f'), [
    edge(1, 'a', 'c'),
    edge(2, 'd', 'f'),
  ]);
  assert.deepEqual(layout.arcs.map((arc) => arc.lane), [0, 0]);
  assert.equal(layout.rightLanes, 1);
});

test('does not let non-adjacent arcs that merely touch at a row share a lane', () => {
  // a->c and c->e meet at c. Sharing a lane would draw them as one continuous line.
  const layout = computeGraphLayout(nodes('a', 'b', 'c', 'd', 'e'), [
    edge(1, 'a', 'c'),
    edge(2, 'c', 'e'),
  ]);
  assert.notEqual(layout.arcs[0].lane, layout.arcs[1].lane);
});

test('counts left and right lanes independently', () => {
  const layout = computeGraphLayout(nodes('a', 'b', 'c'), [
    edge(1, 'a', 'c'),
    edge(2, 'c', 'a'),
  ]);
  assert.equal(layout.leftLanes, 1);
  assert.equal(layout.rightLanes, 1);
});

test('marks a self-loop and arcs it left', () => {
  const layout = computeGraphLayout(nodes('a', 'b'), [edge(1, 'b', 'b')]);
  assert.equal(layout.arcs[0].selfLoop, true);
  assert.equal(layout.arcs[0].side, 'left');
});

test('drops edges referencing a status outside the catalog instead of throwing', () => {
  // The graph endpoint reports these as transition_to_unknown_status; layout must not
  // crash on them, because that scope still has to render.
  const layout = computeGraphLayout(nodes('a', 'b'), [
    edge(1, 'a', 'b'),
    edge(2, 'a', 'ghost'),
  ]);
  assert.equal(layout.arcs.length, 1);
  assert.equal(layout.arcs[0].key, 'a->b');
});

test('allocates lanes deterministically regardless of input order', () => {
  const forward = computeGraphLayout(nodes('a', 'b', 'c', 'd'), [
    edge(1, 'a', 'd'),
    edge(2, 'a', 'b'),
    edge(3, 'b', 'c'),
  ]);
  const reversed = computeGraphLayout(nodes('a', 'b', 'c', 'd'), [
    edge(3, 'b', 'c'),
    edge(2, 'a', 'b'),
    edge(1, 'a', 'd'),
  ]);
  assert.deepEqual(
    forward.arcs.map((arc) => [arc.key, arc.lane]),
    reversed.arcs.map((arc) => [arc.key, arc.lane]),
  );
});

test('handles the real-world worst case without exploding lane count', () => {
  // Agency / Internal Tool Development: 14 statuses, 39 distinct node pairs.
  const ids = Array.from({ length: 14 }, (_, index) => `s${index}`);
  const edges: LayoutInputEdge[] = [];
  let id = 1;
  for (let i = 0; i < 13; i += 1) {
    edges.push(edge(id++, `s${i}`, `s${i + 1}`));
    if (i % 3 === 0) edges.push(edge(id++, `s${i + 1}`, `s${i}`));
  }
  const layout = computeGraphLayout(nodes(...ids), edges);
  assert.equal(layout.arcs.length, 18);
  // The forward chain is all adjacent hops, so it consumes no right lanes at all.
  assert.equal(layout.rightLanes, 0);
  assert.ok(layout.leftLanes <= 2, `leftLanes was ${layout.leftLanes}`);
});
