import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Db } from './adapter/types';
import { installInitialConfiguration } from './migrate';
import { setupTestDb, teardownTestDb } from './testDb';

describe('PostgreSQL initial configuration install boundary', () => {
  let db: Db;
  let workspaceParent = '';
  let previousWorkspaceParent: string | undefined;

  beforeEach(async () => {
    previousWorkspaceParent = process.env.WORKSPACE_PARENT;
    workspaceParent = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-install-once-'));
    process.env.WORKSPACE_PARENT = workspaceParent;
    db = await setupTestDb();
  });

  afterEach(async () => {
    try {
      await teardownTestDb();
    } finally {
      if (previousWorkspaceParent === undefined) delete process.env.WORKSPACE_PARENT;
      else process.env.WORKSPACE_PARENT = previousWorkspaceParent;
      if (workspaceParent) fs.rmSync(workspaceParent, { recursive: true, force: true });
    }
  });

  it('installs defaults once and never recreates or overwrites operator-owned configuration', async () => {
    const firstInstall = await installInitialConfiguration(db);
    expect(firstInstall.installed).toBe(true);

    const starterTransition = await db.get<{
      id: number;
      tenant_id: number;
      sprint_id: number;
      task_type: string | null;
      from_status: string;
      outcome: string;
      to_status: string;
    }>(`
      SELECT id, tenant_id, sprint_id, task_type, from_status, outcome, to_status
      FROM sprint_task_transitions
      ORDER BY id ASC
      LIMIT 1
    `);
    expect(starterTransition).toBeDefined();

    const tenantOwnership = await db.get<{
      transition_count: number;
      transition_mismatches: number;
      requirement_count: number;
      requirement_mismatches: number;
    }>(`
      SELECT
        (SELECT COUNT(*)
         FROM sprint_task_transitions) AS transition_count,
        (SELECT COUNT(*)
         FROM sprint_task_transitions transition
         JOIN sprints sprint ON sprint.id = transition.sprint_id
         WHERE transition.tenant_id IS DISTINCT FROM sprint.tenant_id) AS transition_mismatches,
        (SELECT COUNT(*)
         FROM sprint_task_transition_requirements) AS requirement_count,
        (SELECT COUNT(*)
         FROM sprint_task_transition_requirements requirement
         JOIN sprints sprint ON sprint.id = requirement.sprint_id
         WHERE requirement.tenant_id IS DISTINCT FROM sprint.tenant_id) AS requirement_mismatches
    `);
    expect(Number(tenantOwnership?.transition_count)).toBeGreaterThan(0);
    expect(Number(tenantOwnership?.transition_mismatches)).toBe(0);
    expect(Number(tenantOwnership?.requirement_count)).toBeGreaterThan(0);
    expect(Number(tenantOwnership?.requirement_mismatches)).toBe(0);

    await db.run(`DELETE FROM sprint_task_transitions WHERE id = ?`, starterTransition!.id);
    const transitionCountAfterDelete = Number(await db.value(
      `SELECT COUNT(*) FROM sprint_task_transitions`,
    ));

    const operatorStatus = {
      label: 'Operator-owned queue',
      color: 'fuchsia',
      terminal: 0,
      is_system: 0,
      allowed_transitions: JSON.stringify(['review']),
    };
    await db.run(`
      UPDATE task_statuses
      SET label = ?, color = ?, terminal = ?, is_system = ?, allowed_transitions = ?
      WHERE name = 'todo'
    `,
    operatorStatus.label,
    operatorStatus.color,
    operatorStatus.terminal,
    operatorStatus.is_system,
    operatorStatus.allowed_transitions);

    const secondInstall = await installInitialConfiguration(db);

    expect(secondInstall).toEqual({ installed: false });
    expect(Number(await db.value(`SELECT COUNT(*) FROM sprint_task_transitions`)))
      .toBe(transitionCountAfterDelete);
    expect(await db.get(`
      SELECT id
      FROM sprint_task_transitions
      WHERE tenant_id = ?
        AND sprint_id = ?
        AND task_type IS NOT DISTINCT FROM ?
        AND from_status = ?
        AND outcome = ?
        AND to_status = ?
      LIMIT 1
    `,
    starterTransition!.tenant_id,
    starterTransition!.sprint_id,
    starterTransition!.task_type,
    starterTransition!.from_status,
    starterTransition!.outcome,
    starterTransition!.to_status))
      .toBeUndefined();
    expect(await db.get(`
      SELECT label, color, terminal, is_system, allowed_transitions
      FROM task_statuses
      WHERE name = 'todo'
    `)).toEqual(operatorStatus);
  });
});
