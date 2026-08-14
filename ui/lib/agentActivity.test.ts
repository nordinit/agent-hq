import assert from 'node:assert/strict';
import test from 'node:test';
import { activityLabel, isActivityStalled, isActivityVisible } from './agentActivity.ts';
import type { RunActivity, RunActivityState } from './api/types.ts';

function activity(state: RunActivityState, label = 'Working'): RunActivity {
  return {
    instance_id: 1,
    state,
    activity: 'tool_call',
    label,
    detail: null,
    last_event_at: '2026-08-12T23:00:00.000Z',
    stage: 'progress',
  };
}

test('shows the indicator only while a turn is open', () => {
  assert.equal(isActivityVisible(activity('starting')), true);
  assert.equal(isActivityVisible(activity('working')), true);
  assert.equal(isActivityVisible(activity('stalled')), true);
  assert.equal(isActivityVisible(activity('done')), false);
  assert.equal(isActivityVisible(activity('idle')), false);
});

test('hides the indicator when there is no activity at all', () => {
  assert.equal(isActivityVisible(null), false);
  assert.equal(isActivityVisible(undefined), false);
});

test('marks only a stalled run as stalled', () => {
  assert.equal(isActivityStalled(activity('stalled')), true);
  assert.equal(isActivityStalled(activity('working')), false);
  assert.equal(isActivityStalled(null), false);
});

test('appends an ellipsis to ongoing work but not to a stall', () => {
  assert.equal(activityLabel(activity('working', 'Using Bash')), 'Using Bash…');
  assert.equal(activityLabel(activity('starting', 'Starting up')), 'Starting up…');
  assert.equal(activityLabel(activity('stalled', 'No recent activity')), 'No recent activity');
  assert.equal(activityLabel(null), '');
});
