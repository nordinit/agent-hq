import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getRunLifecycle } from './runLifecycle.ts';

describe('getRunLifecycle', () => {
  it('shows a terminal failed runtime end without lifecycle outcome as failed', () => {
    const lifecycle = getRunLifecycle({
      status: 'failed',
      created_at: '2026-06-03T01:30:00.000Z',
      runtime_ended_at: '2026-06-03T01:32:00.000Z',
      runtime_end_success: 0,
      runtime_end_error: 'exceeded retry limit, last status: 429 Too Many Requests',
    });

    assert.equal(lifecycle.displayStatus, 'failed');
    assert.equal(lifecycle.note, null);
  });

  it('keeps successful runtime ends without lifecycle handoff awaiting outcome', () => {
    const lifecycle = getRunLifecycle({
      status: 'done',
      created_at: '2026-06-03T01:30:00.000Z',
      runtime_ended_at: '2026-06-03T01:32:00.000Z',
      runtime_end_success: 1,
    });

    assert.equal(lifecycle.displayStatus, 'awaiting_outcome');
    assert.equal(lifecycle.note, 'Runtime ended, waiting for lifecycle outcome handoff.');
  });
});
