import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatFailureOutcomeBadgeLabel } from './taskOutcomeMeta.ts';

describe('formatFailureOutcomeBadgeLabel', () => {
  it('keeps blocked-like labels that already express blocked semantics', () => {
    assert.equal(formatFailureOutcomeBadgeLabel('Environment Blocked', true), 'Environment Blocked');
  });

  it('appends blocked for blocked-like labels that do not already express it', () => {
    assert.equal(formatFailureOutcomeBadgeLabel('Environment', true), 'Environment blocked');
  });

  it('keeps failure-like labels that already express failed semantics', () => {
    assert.equal(formatFailureOutcomeBadgeLabel('Release Failed', false), 'Release Failed');
  });

  it('appends failed for failure-like labels that do not already express it', () => {
    assert.equal(formatFailureOutcomeBadgeLabel('Release', false), 'Release failed');
  });
});
