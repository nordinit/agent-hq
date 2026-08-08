import { spawnSync } from 'child_process';
import { backfillInstanceTokens } from './tokenBackfill';
import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';

jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
  execFile: jest.fn(),
}));

const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

const INSTANCE_ID = 99974450;

/**
 * job_instances.agent_id is NOT NULL and a real foreign key in both baselines, which the old
 * hand-written CREATE TABLE in this file did not have — so the instance now needs an owner.
 */
async function seedInstance(): Promise<void> {
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1')`);
  const agent = await db.run(
    `INSERT INTO agents (tenant_id, name, session_key)
     VALUES (1, 'Token Backfill Agent', 'token-backfill-agent')`,
  );
  await db.run(
    `INSERT INTO job_instances (id, tenant_id, agent_id, status, created_at, session_key)
     VALUES (?, 1, ?, 'done', to_char(now() AT TIME ZONE 'utc' - interval '5 minutes', 'YYYY-MM-DD HH24:MI:SS'), 'run:99974450:d6252a6b-6160-4f62-b288-4ad972449e65')`,
    INSTANCE_ID,
    Number(agent.lastInsertId),
  );
}

describe('backfillInstanceTokens', () => {
  beforeEach(async () => {
    await setupTestDb();
    mockSpawnSync.mockReset();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('persists token usage from canonical OpenClaw run sessions with durable suffixes', async () => {
    await seedInstance();

    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        sessions: [{
          key: 'agent:anchor-devops:run:99974450:e5d24260-cd3c-46d5-a508-68380d9c8856',
          inputTokens: 1621,
          outputTokens: 115,
          totalTokens: 59349,
          totalTokensFresh: true,
        }],
      }),
      stderr: '',
      pid: 123,
      output: [],
      signal: null,
    });

    expect(await backfillInstanceTokens(getDb())).toBe(1);

    const row = await getDb().get(`
      SELECT token_input, token_output, token_total
      FROM job_instances
      WHERE id = ?
    `, INSTANCE_ID) as { token_input: number | null; token_output: number | null; token_total: number | null };

    expect(row).toEqual({
      token_input: 1621,
      token_output: 115,
      token_total: 59349,
    });
  });

  it('ignores runs owned by a runtime OpenClaw cannot report on', async () => {
    const db = getDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1')`);
    const agent = await db.run(
      `INSERT INTO agents (tenant_id, name, session_key, runtime_type)
       VALUES (1, 'Atlas', 'atlas', 'claude-code')`,
    );
    await db.run(
      `INSERT INTO job_instances (id, tenant_id, agent_id, status, created_at, session_key)
       VALUES (?, 1, ?, 'done', to_char(now() AT TIME ZONE 'utc' - interval '5 minutes', 'YYYY-MM-DD HH24:MI:SS'), 'run:99974450:d6252a6b-6160-4f62-b288-4ad972449e65')`,
      INSTANCE_ID,
      Number(agent.lastInsertId),
    );

    // A claude-code run can never appear in OpenClaw's sessions.list, so it used
    // to stay a candidate on every tick forever. With no candidates left there
    // is nothing to fetch for, and the gateway is not called at all.
    expect(await backfillInstanceTokens(getDb())).toBe(0);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});
