import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { getDb } from '../../db/client';
import { OpenClawRuntime } from './OpenClawRuntime';
import type { DispatchParams } from '../types';

describe('OpenClawRuntime transcript tenant ownership', () => {
  beforeEach(async () => {
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (9, 'Runtime Tenant', 'runtime', 1)`);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key)
      VALUES (94, 9, 'Cinder Backend', 'agent:cinder-backend')
    `);
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, session_key, durable_run_id)
      VALUES (4698, 9, 94, 'run:4698:durable-4698', 'durable-4698')
    `);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('persists the dispatched user prompt with ownership derived from its instance', async () => {
    const runtime = new OpenClawRuntime();
    const persistUserPrompt = (runtime as unknown as {
      persistUserPrompt: (params: DispatchParams, promptContent?: string) => Promise<number | null>;
    }).persistUserPrompt.bind(runtime);

    const agentId = await persistUserPrompt({
      instanceId: 4698,
      message: 'Implement the tenant-safe transcript write',
      sessionKey: 'run:4698:durable-4698',
      agentSlug: 'cinder-backend',
    } as DispatchParams);

    expect(agentId).toBe(94);
    expect(await getDb().get(`
      SELECT tenant_id, agent_id, instance_id, role, content
      FROM chat_messages
      WHERE id = 'oc-user-4698'
    `)).toEqual({
      tenant_id: 9,
      agent_id: 94,
      instance_id: 4698,
      role: 'user',
      content: 'Implement the tenant-safe transcript write',
    });
  });
});
