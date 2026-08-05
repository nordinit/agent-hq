import { getDb } from './client';
import { tableColumns } from './introspection';
import { setupTestDb, teardownTestDb } from './testDb';

describe('dispatch log schema', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('creates dispatch_log on a fresh database for dispatch status and log endpoints', async () => {
    const db = getDb();
    // PRAGMA table_info does not exist on PostgreSQL; tableColumns asks whichever catalog applies.
    const columns = await tableColumns(db, 'dispatch_log');

    expect(columns).toEqual(expect.arrayContaining([
      'id',
      'task_id',
      'agent_id',
      'routing_reason',
      'candidate_count',
      'candidates_skipped',
      'dispatched_at',
    ]));

    const total = await db.get(`SELECT COUNT(*) AS n FROM dispatch_log`) as { n: number };
    expect(total.n).toBe(0);

    await db.run(`
      INSERT INTO dispatch_log (task_id, agent_id, routing_reason, candidate_count, candidates_skipped)
      VALUES (NULL, NULL, 'schema smoke', 0, '[]')
    `);

    const latest = await db.get(`
      SELECT routing_reason, candidate_count, candidates_skipped, dispatched_at
      FROM dispatch_log
      ORDER BY id DESC
      LIMIT 1
    `) as { routing_reason: string; candidate_count: number; candidates_skipped: string; dispatched_at: string };

    expect(latest).toEqual(expect.objectContaining({
      routing_reason: 'schema smoke',
      candidate_count: 0,
      candidates_skipped: '[]',
    }));
    expect(latest.dispatched_at).toEqual(expect.any(String));
  });
});
