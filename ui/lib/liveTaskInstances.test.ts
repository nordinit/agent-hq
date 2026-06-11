import assert from 'node:assert/strict';
import test from 'node:test';
import { hasLiveTaskInstance } from './liveTaskInstances.ts';

test('hasLiveTaskInstance accepts linked queued, dispatched, and running instances', () => {
  for (const status of ['queued', 'dispatched', 'running']) {
    assert.equal(hasLiveTaskInstance({ active_instance_id: 42, active_instance_status: status }), true);
  }
});

test('hasLiveTaskInstance rejects missing or terminal instance state', () => {
  assert.equal(hasLiveTaskInstance({ active_instance_id: null, active_instance_status: 'running' }), false);
  assert.equal(hasLiveTaskInstance({ active_instance_id: 42, active_instance_status: null }), false);
  assert.equal(hasLiveTaskInstance({ active_instance_id: 42, active_instance_status: 'done' }), false);
  assert.equal(hasLiveTaskInstance({ active_instance_id: 42, active_instance_status: 'failed' }), false);
});
