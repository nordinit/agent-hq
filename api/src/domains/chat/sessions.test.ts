import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { type Db } from '../../db/adapter/types';
import { getResumableChatSessionId, listRuntimeChatMessages } from './sessions';

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

describe('getResumableChatSessionId', () => {
  let db: Db;

  async function seedChatTurn(
    instanceId: number,
    sessionKey: string,
    createdAt = '2026-08-14 10:00:00',
    runStage = 'chat',
  ): Promise<void> {
    await db.run(`
      INSERT INTO job_instances (id, agent_id, status, run_stage, session_key, created_at)
      VALUES (?, 1, 'done', ?, ?, ?)
    `, instanceId, runStage, sessionKey, createdAt);
  }

  beforeEach(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO agents (id, name, session_key) VALUES (1, 'Atlas', 'agent:atlas:web:direct:abc')`);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('returns the most recent turn’s session id', async () => {
    await seedChatTurn(90, 'claude-code:11111111-1111-1111-1111-111111111111', '2026-08-14 10:00:00');
    await seedChatTurn(91, 'claude-code:22222222-2222-2222-2222-222222222222', '2026-08-14 11:00:00');

    expect(await getResumableChatSessionId(db, 1, {}))
      .toBe('22222222-2222-2222-2222-222222222222');
  });

  it('excludes the turn being dispatched', async () => {
    // The runtime rewrites the new instance's session key during dispatch, so
    // without this the run would be asked to resume the session it is creating.
    await seedChatTurn(90, 'claude-code:11111111-1111-1111-1111-111111111111');
    await seedChatTurn(91, 'claude-code:22222222-2222-2222-2222-222222222222', '2026-08-14 11:00:00');

    expect(await getResumableChatSessionId(db, 1, { excludeInstanceId: 91 }))
      .toBe('11111111-1111-1111-1111-111111111111');
  });

  it('does not reach back past the start of the conversation', async () => {
    // Rotating the canonical key ("new chat") moves the anchor forward, which is
    // what makes a new conversation new to the agent and not only to the reader.
    await seedChatTurn(90, 'claude-code:11111111-1111-1111-1111-111111111111', '2026-08-10 10:00:00');

    expect(await getResumableChatSessionId(db, 1, { since: '2026-08-14 00:00:00' })).toBeNull();
    expect(await getResumableChatSessionId(db, 1, { since: '2026-08-01 00:00:00' }))
      .toBe('11111111-1111-1111-1111-111111111111');
  });

  it('ignores task runs and other runtimes', async () => {
    // A dispatched task is its own conversation, and a non-claude-code key holds
    // no resumable id.
    await seedChatTurn(90, 'claude-code:11111111-1111-1111-1111-111111111111', '2026-08-14 10:00:00', 'task');
    await seedChatTurn(91, 'run:91:durable-abc', '2026-08-14 11:00:00');

    expect(await getResumableChatSessionId(db, 1, {})).toBeNull();
  });

  it('returns null for an agent with no prior chat turn', async () => {
    expect(await getResumableChatSessionId(db, 1, {})).toBeNull();
  });
});
