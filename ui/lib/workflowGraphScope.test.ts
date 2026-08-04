import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  scopePresentation,
  shouldMarkIndividually,
  summarizeScope,
  type ScopeAnnotated,
} from './workflowGraphScope.ts';

const override: ScopeAnnotated = { is_override: true, effective_for_sprint: true };
const inherited: ScopeAnnotated = { is_override: false, effective_for_sprint: true };
const superseded: ScopeAnnotated = { is_override: false, effective_for_sprint: false };

test('says nothing about scope when no workflow is selected', () => {
  // At workflow-type scope every row IS the default, so badging them all is pure noise.
  assert.equal(scopePresentation(override, false), 'not-applicable');
  assert.equal(scopePresentation(inherited, false), 'not-applicable');
  assert.equal(scopePresentation(superseded, false), 'not-applicable');
});

test('distinguishes override, inherited and superseded with a workflow selected', () => {
  assert.equal(scopePresentation(override, true), 'override');
  assert.equal(scopePresentation(inherited, true), 'inherited');
  assert.equal(scopePresentation(superseded, true), 'superseded');
});

test('superseded wins over inherited, because doing nothing is the important fact', () => {
  assert.equal(scopePresentation({ is_override: false, effective_for_sprint: false }, true), 'superseded');
});

test('treats a row with no annotation as inherited rather than throwing', () => {
  // Event-derived rows and older payloads may omit the fields entirely.
  assert.equal(scopePresentation({}, true), 'inherited');
});

test('does not mark individually when every row shares one scope', () => {
  // The real Agency/#115 case: all 23 assignments are overrides, so a badge on each says
  // nothing. The summary line states it once instead.
  assert.equal(shouldMarkIndividually([override, override, override], true), false);
  assert.equal(shouldMarkIndividually([inherited, inherited], true), false);
});

test('marks individually as soon as the scopes are mixed', () => {
  assert.equal(shouldMarkIndividually([override, inherited], true), true);
  assert.equal(shouldMarkIndividually([inherited, superseded], true), true);
});

test('never marks individually without a workflow, or for a single row', () => {
  assert.equal(shouldMarkIndividually([override, inherited], false), false);
  assert.equal(shouldMarkIndividually([override], true), false);
});

test('summarises a mixed set', () => {
  const summary = summarizeScope([override, override, inherited, superseded], true);
  assert.deepEqual(
    { override: summary.override, inherited: summary.inherited, superseded: summary.superseded },
    { override: 2, inherited: 1, superseded: 1 },
  );
  assert.equal(summary.label, '2 on this workflow · 1 inherited · 1 superseded');
});

test('omits zero categories from the label', () => {
  assert.equal(summarizeScope([override, override], true).label, '2 on this workflow');
  assert.equal(summarizeScope([inherited], true).label, '1 inherited');
});

test('has no label without a workflow selected, or with no rows', () => {
  assert.equal(summarizeScope([override, inherited], false).label, null);
  assert.equal(summarizeScope([], true).label, null);
});

test('counts nothing when no workflow is selected', () => {
  const summary = summarizeScope([override, inherited, superseded], false);
  assert.deepEqual(
    { override: summary.override, inherited: summary.inherited, superseded: summary.superseded },
    { override: 0, inherited: 0, superseded: 0 },
  );
});
