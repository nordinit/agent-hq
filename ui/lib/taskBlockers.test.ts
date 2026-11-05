import assert from 'node:assert/strict';
import test from 'node:test';
import { blockerStillBlocks, isTaskBlocked } from './taskBlockers.ts';

test('a task is blocked only when the API says a blocker relationship still holds it', () => {
  assert.equal(isTaskBlocked({ is_blocked: true, blockers: [] }), true);
  // A cancelled blocker no longer blocks, even though its status is not done.
  assert.equal(isTaskBlocked({ is_blocked: false, blockers: [{ status: 'cancelled', blocks_dispatch: false }] }), false);
});

test('a task with no blockers is not blocked, whatever its last run reported', () => {
  assert.equal(isTaskBlocked({ blockers: [] }), false);
  assert.equal(isTaskBlocked({}), false);
});

test('falls back to blocker status when the API predates is_blocked', () => {
  assert.equal(isTaskBlocked({ blockers: [{ status: 'in_progress' }] }), true);
  assert.equal(isTaskBlocked({ blockers: [{ status: 'done' }] }), false);
  assert.equal(isTaskBlocked({ blockers: [{ status: 'cancelled', blocks_dispatch: false }, { status: 'ready', blocks_dispatch: true }] }), true);
});

test('a blocker entry uses blocks_dispatch when present', () => {
  assert.equal(blockerStillBlocks({ status: 'cancelled', blocks_dispatch: false }), false);
  assert.equal(blockerStillBlocks({ status: 'done', blocks_dispatch: true }), true);
  assert.equal(blockerStillBlocks({ status: 'blocked' }), true);
});
