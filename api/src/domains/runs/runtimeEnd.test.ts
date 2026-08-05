import { applyRuntimeEndToJobInstance } from './runtimeEnd';
import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';

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

/** job_instances.agent_id is NOT NULL and references agents, so an instance needs a real owner. */
async function seedAgent(): Promise<number> {
  const inserted = await getDb().run(
    `INSERT INTO agents (name, session_key) VALUES ('Hermes', 'run:915')`,
  );
  return Number(inserted.lastInsertId);
}

describe('applyRuntimeEndToJobInstance token usage persistence', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('persists token usage from runtime end metadata without overwriting existing non-null values with null', async () => {
    const db = getDb();
    const agentId = await seedAgent();
    await db.run(`
      INSERT INTO job_instances (id, agent_id, status, session_key, token_input)
      VALUES (915, ?, 'running', 'run:915', 12)
    `, agentId);

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
