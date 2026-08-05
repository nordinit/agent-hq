import type { Db } from '../../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { resolveRuntime } from '../../runtimes';
import { stopDurableLocalProcess } from '../../runtimes/durableLocalProcessControl';
import { stopInstanceExecution } from './stopInstanceExecution';

jest.mock('../../runtimes', () => ({
  resolveRuntime: jest.fn(),
}));

jest.mock('../../runtimes/durableLocalProcessControl', () => ({
  stopDurableLocalProcess: jest.fn(),
}));

jest.mock('../../runtimes/OpenClawRuntime', () => ({
  abortChatRunBySessionKey: jest.fn(),
}));

const mockedResolveRuntime = resolveRuntime as jest.MockedFunction<typeof resolveRuntime>;
const mockedStopDurableLocalProcess = stopDurableLocalProcess as jest.MockedFunction<typeof stopDurableLocalProcess>;

async function createDb(): Promise<Db> {
  const db = await setupTestDb();
  await db.exec(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES
      (1, 'Runtime One', 'runtime-one', 1),
      (2, 'Runtime Two', 'runtime-two', 0);

    INSERT INTO projects (id, tenant_id, name)
    VALUES (2, 2, 'Foreign task project');

    INSERT INTO sprints (id, tenant_id, project_id, name)
    VALUES (2, 2, 2, 'Foreign task workflow');

    INSERT INTO agents (id, tenant_id, name, role, session_key, runtime_type, runtime_config)
    VALUES
      (11, 1, 'Runtime One', 'test', 'agent:one', 'claude-code', '{}'),
      (22, 2, 'Runtime Two', 'test', 'agent:two', 'claude-code', '{}');

    INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title, status, agent_id)
    VALUES (20, 2, 2, 2, 'Foreign tenant task', 'in_progress', 22);

    INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, session_key, run_id)
    VALUES
      (100, 1, 11, 20, 'running', 'run:one', 'claude-code:100'),
      (200, 2, 22, NULL, 'running', 'run:two', 'claude-code:200');

    UPDATE tasks SET active_instance_id = 100 WHERE id = 20;
  `);
  return db;
}

async function insertRuntimeExecution(
  db: Db,
  input: { id: number; tenantId: number; instanceId: number; owner: string; fingerprint: string },
): Promise<void> {
  await db.run(`
    INSERT INTO runtime_executions (
      id, tenant_id, instance_id, boundary_json, boundary_fingerprint,
      runtime_type, driver, backend, execution_target_id, opaque_handle, state
    ) VALUES (?, ?, ?, '{}'::jsonb, ?, 'claude-code', 'claude-code',
      'local-process', 'local:test', ?::jsonb, 'running')
  `, input.id, input.tenantId, input.instanceId, input.fingerprint, JSON.stringify({ owner: input.owner }));
}

describe('stopInstanceExecution tenant boundary', () => {
  let db: Db;
  const abort = jest.fn();

  beforeEach(async () => {
    db = await createDb();
    abort.mockReset().mockResolvedValue({
      attempted: false,
      ok: false,
      confirmed: false,
      status: 'not_found',
      error: 'not registered in this API process',
    });
    mockedResolveRuntime.mockReset().mockReturnValue({ abort } as never);
    mockedStopDurableLocalProcess.mockReset().mockResolvedValue({
      attempted: true,
      ok: true,
      confirmed: true,
      status: 'already_gone',
    });
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('rejects a foreign-tenant instance before resolving or signalling its runtime', async () => {
    await insertRuntimeExecution(db, {
      id: 2,
      tenantId: 2,
      instanceId: 200,
      owner: 'two',
      fingerprint: 'fp-two',
    });

    await expect(stopInstanceExecution(db, 200, 1, 'stop')).rejects.toThrow('Instance not found');

    expect(mockedResolveRuntime).not.toHaveBeenCalled();
    expect(mockedStopDurableLocalProcess).not.toHaveBeenCalled();
    await expect(db.get(`SELECT status, task_id FROM job_instances WHERE id = 200`)).resolves.toEqual({
      status: 'running',
      task_id: null,
    });
    await expect(db.get(`SELECT state FROM runtime_executions WHERE id = 2`)).resolves.toEqual({ state: 'running' });
  });

  it('interrupts and recovers only the owned durable execution, never a foreign row or task', async () => {
    await insertRuntimeExecution(db, {
      id: 1,
      tenantId: 1,
      instanceId: 100,
      owner: 'one',
      fingerprint: 'fp-one',
    });
    await insertRuntimeExecution(db, {
      id: 2,
      tenantId: 2,
      instanceId: 200,
      owner: 'two',
      fingerprint: 'fp-two',
    });

    const result = await stopInstanceExecution(db, 100, 1, 'stop');

    expect(result).toMatchObject({
      id: 100,
      result: 'already_gone',
      runtimeUncertain: false,
      taskId: null,
    });
    expect(mockedStopDurableLocalProcess).toHaveBeenCalledTimes(1);
    expect(mockedStopDurableLocalProcess).toHaveBeenCalledWith({ owner: 'one' }, 10_000);

    await expect(db.all(`
      SELECT tenant_id, state
      FROM runtime_executions
      ORDER BY tenant_id
    `)).resolves.toEqual([
      { tenant_id: 1, state: 'interrupting' },
      { tenant_id: 2, state: 'running' },
    ]);
    await expect(db.all(`
      SELECT tenant_id, execution_id, kind
      FROM runtime_checkpoints
      ORDER BY id
    `)).resolves.toEqual([
      { tenant_id: 1, execution_id: 1, kind: 'interrupt_requested' },
    ]);
    await expect(db.get(`SELECT status, task_id FROM job_instances WHERE id = 100`)).resolves.toEqual({
      status: 'failed',
      task_id: null,
    });
    await expect(db.get(`SELECT status, active_instance_id, agent_id FROM tasks WHERE id = 20`)).resolves.toEqual({
      status: 'in_progress',
      active_instance_id: 100,
      agent_id: 22,
    });
    await expect(db.all(`SELECT DISTINCT tenant_id FROM logs`)).resolves.toEqual([{ tenant_id: 1 }]);
  });
});
