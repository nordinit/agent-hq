import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchTaskPages } from './taskPages.ts';

test('refresh collects every capped page before replacing visible tasks, including deletions', async () => {
  const source = Array.from({ length: 625 }, (_, id) => ({ id, title: `Task ${id}` }));
  const previous = [...source, { id: 999, title: 'Deleted task' }];
  let visible = previous;
  const offsets: number[] = [];
  const snapshot = await fetchTaskPages(async (offset, limit) => {
    assert.equal(visible, previous, 'all previously visible cards stay present during fetching');
    offsets.push(offset);
    const tasks = source.slice(offset, offset + Math.min(limit, 200));
    return { tasks, total: source.length, hasMore: offset + tasks.length < source.length };
  });
  visible = snapshot.tasks;
  assert.deepEqual(offsets, [0, 200, 400, 600]);
  assert.deepEqual(visible, source);
});

test('a failed later page leaves the previous snapshot intact', async () => {
  const visible = [{ id: 700 }];
  let published = visible;
  await assert.rejects(async () => {
    const snapshot = await fetchTaskPages(async offset => {
      if (offset > 0) throw new Error('Temporary network failure');
      return { tasks: [{ id: 1 }], total: 2, hasMore: true };
    });
    published = snapshot.tasks;
  }, /Temporary network failure/);
  assert.equal(published, visible);
});

test('initial loading reports progress and advances by raw page rows even with overlaps', async () => {
  const offsets: number[] = [];
  const progress: number[][] = [];
  const pages = [
    { tasks: [{ id: 1 }, { id: 2 }], total: 4, hasMore: true },
    { tasks: [{ id: 2 }, { id: 3 }], total: 4, hasMore: true },
    { tasks: [{ id: 4 }], total: 4, hasMore: false },
  ];
  await fetchTaskPages(async (offset, limit) => {
    offsets.push(offset);
    assert.equal(limit, offset === 0 ? 50 : 200);
    return pages.shift()!;
  }, page => { progress.push(page.tasks.map(task => task.id)); });
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(progress, [[1, 2], [1, 2, 3], [1, 2, 3, 4]]);
});

test('an empty unfinished page fails instead of looping or publishing incomplete data', async () => {
  await assert.rejects(fetchTaskPages(async () => ({ tasks: [], total: 1, hasMore: true })), /Incomplete task page/);
});
