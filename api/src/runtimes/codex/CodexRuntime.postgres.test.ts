import type { Db } from '../../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { CodexRuntime } from './CodexRuntime';

type CodexRuntimePersistenceHarness = {
  persistAssistantMessage(
    db: Db | null,
    instanceId: number | null,
    content: string,
  ): Promise<void>;
};

describe('Codex runtime PostgreSQL persistence', () => {
  let db: Db;

  beforeEach(async () => {
    db = await setupTestDb();
    await db.run(`
      INSERT INTO tenants (id, name, slug)
      VALUES (1, 'Codex Runtime Tests', 'codex-runtime-tests')
    `);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, role, session_key, runtime_type)
      VALUES (14, 1, 'Codex Runtime Test', 'test', 'agent:codex-runtime-test:main', 'codex')
    `);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, status)
      VALUES (4711, 1, 14, 'running')
    `);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('inherits tenant ownership when persisting the fallback assistant message', async () => {
    const runtime = new CodexRuntime() as unknown as CodexRuntimePersistenceHarness;

    await runtime.persistAssistantMessage(db, 4711, 'PostgreSQL fallback response');

    await expect(db.get<{
      tenant_id: number;
      agent_id: number;
      instance_id: number;
      role: string;
      content: string;
      event_type: string;
    }>(`
      SELECT tenant_id, agent_id, instance_id, role, content, event_type
      FROM chat_messages
      WHERE id = 'codex-asst-4711'
    `)).resolves.toEqual({
      tenant_id: 1,
      agent_id: 14,
      instance_id: 4711,
      role: 'assistant',
      content: 'PostgreSQL fallback response',
      event_type: 'text',
    });
  });
});
