import Database from 'better-sqlite3';
import { spawnSync } from 'child_process';
import { backfillInstanceTokens } from './tokenBackfill';
import { type Db } from "../../db/adapter/types";

jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
  execFile: jest.fn(),
}));

const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

async function createDb(): Promise<Db> {
  const db = new Database(':memory:');
  await db.exec(`
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      status TEXT,
      created_at TEXT,
      session_key TEXT,
      token_input INTEGER,
      token_output INTEGER,
      token_total INTEGER
    );
  `);
  return db;
}

describe('backfillInstanceTokens', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb();
    mockSpawnSync.mockReset();
  });

  afterEach(() => {
    db.close();
  });

  it('persists token usage from canonical OpenClaw run sessions with durable suffixes', async () => {
    await db.run(`
      INSERT INTO job_instances (id, status, created_at, session_key)
      VALUES (99974450, 'done', datetime('now', '-5 minutes'), 'run:99974450:d6252a6b-6160-4f62-b288-4ad972449e65')
    `);

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

    expect(await backfillInstanceTokens(db)).toBe(1);

    const row = await db.get(`
      SELECT token_input, token_output, token_total
      FROM job_instances
      WHERE id = 99974450
    `) as { token_input: number | null; token_output: number | null; token_total: number | null };

    expect(row).toEqual({
      token_input: 1621,
      token_output: 115,
      token_total: 59349,
    });
  });
});
