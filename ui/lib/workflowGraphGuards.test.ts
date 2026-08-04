import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deleteConsequences,
  guardCreate,
  guardMutate,
  guardProjectScope,
  type GuardContext,
} from './workflowGraphGuards.ts';

const atWorkflow: GuardContext = { workflowId: 115, projectId: 99, workflowCount: 4 };
const atType: GuardContext = { workflowId: null, projectId: 99, workflowCount: 4 };
const noProject: GuardContext = { workflowId: null, projectId: null, workflowCount: 0 };

const override = { is_override: true, enabled: true };
const inherited = { is_override: false, enabled: true };

test('refuses everything at All Projects scope', () => {
  // Rows with a null project never match at dispatch and cannot be addressed for update or
  // delete afterwards, so creating one is a trap rather than a shortcut.
  assert.equal(guardProjectScope(noProject)?.allow, false);
  assert.equal(guardCreate(noProject).allow, false);
  assert.equal(guardMutate('delete', override, noProject).allow, false);
});

test('allows creating at All Projects nowhere, and says why', () => {
  const verdict = guardCreate(noProject);
  assert.match(verdict.warning ?? '', /never match at dispatch/);
  assert.match(verdict.alternative ?? '', /Select a project/);
});

test('creating on a specific workflow needs no caveat', () => {
  assert.deepEqual(guardCreate(atWorkflow), { allow: true, warning: null, alternative: null });
});

test('creating at workflow-type scope states the blast radius', () => {
  const verdict = guardCreate(atType);
  assert.equal(verdict.allow, true);
  assert.match(verdict.warning ?? '', /all 4 workflows/);
});

test('does not say "all 1 workflows"', () => {
  const verdict = guardCreate({ workflowId: null, projectId: 99, workflowCount: 1 });
  assert.match(verdict.warning ?? '', /the 1 workflow of this type/);
});

test('REFUSES deleting an inherited row from inside one workflow', () => {
  // The row is shared. Deleting it here would silently change every workflow of the type,
  // which is the single most destructive gesture the canvas could offer.
  const verdict = guardMutate('delete', inherited, atWorkflow);
  assert.equal(verdict.allow, false);
  assert.match(verdict.warning ?? '', /shared by 4 workflows/);
  assert.match(verdict.alternative ?? '', /override for this workflow/);
});

test('REFUSES editing or disabling an inherited row from inside one workflow', () => {
  for (const action of ['update', 'disable'] as const) {
    const verdict = guardMutate(action, inherited, atWorkflow);
    assert.equal(verdict.allow, false, `${action} should be refused`);
    assert.match(verdict.alternative ?? '', /Override it for this workflow/);
  }
});

test('allows mutating the workflow\'s OWN row without caveat', () => {
  assert.deepEqual(guardMutate('delete', override, atWorkflow), { allow: true, warning: null, alternative: null });
  assert.deepEqual(guardMutate('update', override, atWorkflow), { allow: true, warning: null, alternative: null });
});

test('allows editing the shared default at type scope, but states the reach', () => {
  const verdict = guardMutate('update', inherited, atType);
  assert.equal(verdict.allow, true);
  assert.match(verdict.warning ?? '', /all 4 workflows/);
});

test('does not warn at type scope when only one workflow exists', () => {
  const context = { workflowId: null, projectId: 99, workflowCount: 1 };
  assert.deepEqual(guardMutate('update', inherited, context), { allow: true, warning: null, alternative: null });
});

test('warns that deleting a rule unassigns tasks, except running ones', () => {
  const notes = deleteConsequences('rule');
  assert.equal(notes.length, 1);
  assert.match(notes[0], /unassigned, except any with a run in flight/);
});

test('warns that a deleted starter transition may be re-seeded', () => {
  assert.match(deleteConsequences('transition')[0], /may recreate it/);
});

test('notes that a deleted requirement is tombstoned rather than re-seeded', () => {
  assert.match(deleteConsequences('requirement')[0], /tombstone/);
});
