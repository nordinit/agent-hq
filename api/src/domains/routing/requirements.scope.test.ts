import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import {
  createTransitionRequirement,
  deleteTransitionRequirement,
  listTransitionRequirements,
  updateTransitionRequirement,
} from './requirements';

/**
 * A requirement request that names no scope must be refused.
 *
 * With no sprint_id, project_id or sprint_type these calls used to fall through to the legacy
 * global `transition_requirements` table — no project, no tenant, and consulted as the fallback
 * for every workflow in every project. Create silently gated all of them at once; update and
 * delete addressed a global row by an id the caller had taken from a scoped one, hitting an
 * unrelated row that happened to share it.
 *
 * Migration 15 dropped that table, so there is no longer anywhere unscoped for a request to
 * land. The guard outlives it: these tests pin the refusal, so a future refactor that
 * "helpfully" restores a fallthrough fails here instead of in production.
 */

const VALID = {
  outcome: 'completed_for_review',
  field_name: 'review_commit',
  requirement_type: 'required',
  severity: 'block',
};

beforeEach(async () => { await setupTestDb(); });
afterEach(async () => { await teardownTestDb(); });

async function expectScopeRefusal(run: () => Promise<unknown>) {
  await expect(run()).rejects.toMatchObject({ status: 400 });
  await expect(run()).rejects.toThrow(/no scope/i);
}

describe('transition requirement scope guard', () => {
  test('refuses to create a requirement with no scope at all', async () => {
    await expectScopeRefusal(() => createTransitionRequirement(getDb(), { ...VALID }));
  });

  test('the refusal names both ways to scope the write', async () => {
    // The message is the whole remedy — a bare 400 would just move the confusion.
    await expect(createTransitionRequirement(getDb(), { ...VALID }))
      .rejects.toThrow(/project_id and sprint_type.*sprint_id/s);
  });

  test('refuses to update a requirement with no scope', async () => {
    // The dangerous one: id 1 almost certainly came from a scoped row.
    await expectScopeRefusal(() => updateTransitionRequirement(getDb(), { id: 1, message: 'changed' }));
  });

  test('refuses to delete a requirement with no scope', async () => {
    await expectScopeRefusal(() => deleteTransitionRequirement(getDb(), { id: 1 }));
  });

  test('refuses to list requirements with no scope', async () => {
    // Reads were the last unscoped path: they returned the global table verbatim, so a caller
    // that forgot its scope got a plausible-looking set belonging to no workflow at all.
    await expectScopeRefusal(() => listTransitionRequirements(getDb(), {}));
  });

  test('validation still runs before the scope guard on create', async () => {
    // Scope is not a way to skip the field checks, and a caller missing both should hear about
    // the one they can see in their own payload first.
    await expect(createTransitionRequirement(getDb(), { field_name: 'review_commit' }))
      .rejects.toThrow(/outcome and field_name are required/);
  });

  test('a project and workflow type together are enough to pass the guard', async () => {
    // Proves the guard is about scope alone: this gets past it and fails later, on the scope
    // resolver, rather than being refused as unscoped.
    await expect(createTransitionRequirement(getDb(), { ...VALID, project_id: 999999, sprint_type: 'dev' }))
      .rejects.not.toThrow(/no scope/i);
  });

  test('a workflow id alone is enough to pass the guard', async () => {
    await expect(createTransitionRequirement(getDb(), { ...VALID, sprint_id: 999999 }))
      .rejects.not.toThrow(/no scope/i);
  });
});
