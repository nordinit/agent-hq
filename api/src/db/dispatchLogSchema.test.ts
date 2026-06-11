import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';

describe('dispatch log schema', () => {
  const originalDbPath = process.env.AGENT_HQ_DB_PATH;
  let tempDir = '';

  beforeEach(() => {
    closeDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-log-schema-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
    else process.env.AGENT_HQ_DB_PATH = originalDbPath;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  it('creates dispatch_log on a fresh database for dispatch status and log endpoints', () => {
    initSchema();

    const db = getDb();
    const columns = db.prepare(`PRAGMA table_info(dispatch_log)`).all() as Array<{ name: string }>;

    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining([
      'id',
      'task_id',
      'agent_id',
      'routing_reason',
      'candidate_count',
      'candidates_skipped',
      'dispatched_at',
    ]));

    const total = db.prepare(`SELECT COUNT(*) AS n FROM dispatch_log`).get() as { n: number };
    expect(total.n).toBe(0);

    db.prepare(`
      INSERT INTO dispatch_log (task_id, agent_id, routing_reason, candidate_count, candidates_skipped)
      VALUES (NULL, NULL, 'schema smoke', 0, '[]')
    `).run();

    const latest = db.prepare(`
      SELECT routing_reason, candidate_count, candidates_skipped, dispatched_at
      FROM dispatch_log
      ORDER BY id DESC
      LIMIT 1
    `).get() as { routing_reason: string; candidate_count: number; candidates_skipped: string; dispatched_at: string };

    expect(latest).toEqual(expect.objectContaining({
      routing_reason: 'schema smoke',
      candidate_count: 0,
      candidates_skipped: '[]',
    }));
    expect(latest.dispatched_at).toEqual(expect.any(String));
  });
});
