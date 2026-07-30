import Database from 'better-sqlite3';
import { applyRuntimeEndToJobInstance } from './runtimeEnd';
import { type Db } from "../../db/adapter/types";
import { SqliteAdapter } from "../../db/adapter/SqliteAdapter";

jest.mock('./observability', () => ({
  recordRunCheckIn: jest.fn(),
}));

jest.mock('./lifecycleHandoff', () => ({
  taskRequiresSemanticOutcome: jest.fn(() => false),
  markTaskNeedsAttentionForMissingSemanticHandoff: jest.fn(),
}));

jest.mock('./runtimeFailureEvent', () => ({
  applyConfiguredRuntimeFailedEvent: jest.fn(),
}));

jest.mock('../../lib/taskLifecycle', () => ({
  scheduleEndedActiveInstanceLinkageCleanup: jest.fn(),
}));

async function createDb(): Promise<Db> {
  const dbRaw = new Database(':memory:');
    const db = new SqliteAdapter(dbRaw);
  await db.exec(`
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      status TEXT,
      task_id INTEGER,
      session_key TEXT,
      lifecycle_outcome_posted_at TEXT,
      task_outcome TEXT,
      started_at TEXT,
      completed_at TEXT,
      runtime_ended_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT,
      token_input INTEGER,
      token_output INTEGER,
      token_total INTEGER
    );
  `);
  return db;
}

describe('applyRuntimeEndToJobInstance token usage persistence', () => {
  let db: Db;

  afterEach(async () => {
    await db.close();
  });

  it('persists token usage from runtime end metadata without overwriting existing non-null values with null', async () => {
    db = await createDb();
    await db.run(`
      INSERT INTO job_instances (id, status, session_key, token_input)
      VALUES (915, 'running', 'run:915', 12)
    `);

    await applyRuntimeEndToJobInstance(db, {
      instanceId: 915,
      runtimeName: 'Hermes',
      event: {
        type: 'runEnded',
        source: 'hermes',
        sessionKey: 'run:915',
        success: true,
        endedAt: '2026-06-03 14:00:00.000',
        reason: 'completed',
        metadata: {
          usage: {
            output_tokens: 34,
            total_tokens: 46,
          },
        },
      },
    });

    const row = await db.get(`
      SELECT token_input, token_output, token_total, runtime_ended_at
      FROM job_instances
      WHERE id = 915
    `) as {
      token_input: number | null;
      token_output: number | null;
      token_total: number | null;
      runtime_ended_at: string | null;
    };

    expect(row).toEqual({
      token_input: 12,
      token_output: 34,
      token_total: 46,
      runtime_ended_at: '2026-06-03 14:00:00.000',
    });
  });
});
