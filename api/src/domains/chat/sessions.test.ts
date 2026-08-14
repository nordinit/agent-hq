import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { type Db } from '../../db/adapter/types';
import { listRuntimeChatMessages } from './sessions';

describe('listRuntimeChatMessages', () => {
  let db: Db;

  async function seedTurn(instanceId: number, createdAt: string, rows: number): Promise<void> {
    await db.run(`
      INSERT INTO job_instances (id, agent_id, status, run_stage, created_at)
      VALUES (?, 1, 'done', 'chat', ?)
    `, instanceId, createdAt);
    for (let i = 0; i < rows; i++) {
      // Two-digit sequence so id ordering matches emission order lexicographically.
      const seq = String(i).padStart(2, '0');
      const stamp = `2026-08-14 ${createdAt.slice(11, 13)}:${String(i).padStart(2, '0')}:00`;
      await db.run(`
        INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type)
        VALUES (?, 1, ?, 'agent:atlas:web:direct:abc', 'assistant', ?, ?, 'text')
      `, `cc-${instanceId}-${seq}`, instanceId, `row ${i}`, stamp);
    }
  }

  beforeEach(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO agents (id, name, session_key) VALUES (1, 'Atlas', 'agent:atlas:web:direct:abc')`);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('keeps the newest rows when the conversation outgrows the limit', async () => {
    await seedTurn(90, '2026-08-14 10:00:00', 5);
    await seedTurn(91, '2026-08-14 11:00:00', 5);

    const messages = await listRuntimeChatMessages(db, 1, { limit: 4 }) as Array<{ id: string }>;

    // The tail of the conversation, not its head — the last turn must survive.
    expect(messages.map(m => m.id)).toEqual(['cc-91-01', 'cc-91-02', 'cc-91-03', 'cc-91-04']);
  });

  it('returns the whole conversation in reading order when it fits', async () => {
    await seedTurn(90, '2026-08-14 10:00:00', 2);
    await seedTurn(91, '2026-08-14 11:00:00', 2);

    const messages = await listRuntimeChatMessages(db, 1, { limit: 500 }) as Array<{ id: string }>;

    expect(messages.map(m => m.id)).toEqual(['cc-90-00', 'cc-90-01', 'cc-91-00', 'cc-91-01']);
  });
});
