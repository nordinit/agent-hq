import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { getDb } from '../../db/client';

jest.mock('../runs', () => ({
  buildDispatchMessage: jest.fn(() => 'Sprint summary request'),
  dispatchInstance: jest.fn(async () => undefined),
}));

import { dispatchInstance } from '../runs';
import { completeSprint } from './lifecycle';

describe('completeSprint tenant ownership', () => {
  beforeEach(async () => {
    await setupTestDb();
    jest.mocked(dispatchInstance).mockClear();

    const db = getDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (2, 'Tenant Two', 'tenant-two', 1)`);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (20, 2, 'Tenant Two Project')`);
    await db.run(`
      INSERT INTO sprints (id, tenant_id, project_id, name, goal, status)
      VALUES (200, 2, 20, 'Tenant Two Sprint', 'Finish tenant-safe writes', 'active')
    `);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key, project_id, sprint_id, enabled)
      VALUES (201, 2, 'Summary Agent', 'agent:summary:main', 20, 200, 1)
    `);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('owns sprint-summary job instances with the assigned agent tenant', async () => {
    await completeSprint(200);

    const row = await getDb().get(`
      SELECT tenant_id, agent_id, status
      FROM job_instances
      WHERE agent_id = 201
    `) as { tenant_id: number; agent_id: number; status: string };

    expect(row).toEqual({ tenant_id: 2, agent_id: 201, status: 'queued' });
    expect(dispatchInstance).toHaveBeenCalledWith(expect.objectContaining({ agentId: 201 }));
  });
});
