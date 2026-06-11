import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildScheduleExpression,
  formatScheduleExpression,
  parseScheduleExpression,
  shouldClearLoadedWorkflowSelection,
  validateMinuteInterval,
} from './recurringTaskSchedule.ts';

describe('recurring task schedule helpers', () => {
  it('maps minute schedules between stored expressions and form state', () => {
    const parsed = parseScheduleExpression('every 15 minutes');
    assert.equal(parsed.schedule_kind, 'minutes');
    assert.equal(parsed.minute_interval, 15);
    assert.equal(buildScheduleExpression(parsed), 'every 15 minutes');
    assert.equal(formatScheduleExpression('every 15 minutes'), 'Every 15 minutes');
  });

  it('preserves daily, weekly, and custom schedule expressions', () => {
    assert.equal(buildScheduleExpression(parseScheduleExpression('every day 10:30')), 'every day 10:30');
    assert.equal(buildScheduleExpression(parseScheduleExpression('every monday 09:00')), 'every monday 09:00');
    assert.equal(buildScheduleExpression(parseScheduleExpression('0 9 * * 1')), '0 9 * * 1');
  });

  it('validates unsupported minute interval values', () => {
    assert.equal(validateMinuteInterval(0), 'Use at least 5 minutes.');
    assert.equal(validateMinuteInterval(-10), 'Use at least 5 minutes.');
    assert.equal(validateMinuteInterval(4), 'Use at least 5 minutes.');
    assert.equal(validateMinuteInterval(5), undefined);
    assert.equal(validateMinuteInterval(1441), 'Use 1440 minutes or less.');
  });

  it('does not clear edit selections while workflow metadata is loading', () => {
    assert.equal(shouldClearLoadedWorkflowSelection('qa', [], true), false);
    assert.equal(shouldClearLoadedWorkflowSelection('qa', ['qa', 'backend'], false), false);
    assert.equal(shouldClearLoadedWorkflowSelection('qa', ['backend'], false), true);
    assert.equal(shouldClearLoadedWorkflowSelection('', ['backend'], false), false);
  });
});
