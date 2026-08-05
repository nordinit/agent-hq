import Database from 'better-sqlite3';

import { SqliteAdapter } from '../../db/adapter/SqliteAdapter';
import type { Db } from '../../db/adapter/types';
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
  const db = new SqliteAdapter(new Database(':memory:'));
  await db.exec(`
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      session_key TEXT,
      runtime_type TEXT,
      runtime_config TEXT
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      active_instance_id INTEGER,
      agent_id INTEGER,
      updated_at TEXT
    );

    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      agent_id INTEGER,
      task_id INTEGER,
      status TEXT NOT NULL,
      session_key TEXT,
      run_id TEXT,
      payload_sent TEXT,
      abort_attempted_at TEXT,
      abort_status TEXT,
      abort_error TEXT,
      completed_at TEXT,
      runtime_ended_at TEXT,
      runtime_end_success INTEGER,
      runtime_end_error TEXT,
      runtime_end_source TEXT
    );

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      instance_id INTEGER,
      agent_id INTEGER,
      job_title TEXT,
      level TEXT,
      message TEXT
    );

    CREATE TABLE runtime_executions (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      instance_id INTEGER NOT NULL,
      backend TEXT NOT NULL,
      state TEXT NOT NULL,
      opaque_handle TEXT,
      boundary_fingerprint TEXT NOT NULL,
      session_id TEXT,
      terminal_reason TEXT,
      updated_at TEXT
    );

    CREATE TABLE runtime_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      execution_id INTEGER NOT NULL,
      version INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      session_id TEXT,
      boundary_fingerprint TEXT NOT NULL,
      transcript_cursor TEXT,
      checkpoint_data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (execution_id, sequence)
    );

    INSERT INTO agents (id, tenant_id, session_key, runtime_type, runtime_config)
    VALUES
      (11, 1, 'agent:one', 'claude-code', '{}'),
      (22, 2, 'agent:two', 'claude-code', '{}');

    INSERT INTO tasks (id, tenant_id, status, active_instance_id, agent_id)
    VALUES (20, 2, 'in_progress', 100, 22);

    INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, session_key, run_id)
    VALUES
      (100, 1, 11, 20, 'running', 'run:one', 'claude-code:100'),
      (200, 2, 22, NULL, 'running', 'run:two', 'claude-code:200');
  `);
  return db;
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
    await db.close();
  });

  it('rejects a foreign-tenant instance before resolving or signalling its runtime', async () => {
    await db.run(`
      INSERT INTO runtime_executions (
        id, tenant_id, instance_id, backend, state, opaque_handle, boundary_fingerprint
      ) VALUES (2, 2, 200, 'local-process', 'running', '{"owner":"two"}', 'fp-two')
    `);

    await expect(stopInstanceExecution(db, 200, 1, 'stop')).rejects.toThrow('Instance not found');

    expect(mockedResolveRuntime).not.toHaveBeenCalled();
    expect(mockedStopDurableLocalProcess).not.toHaveBeenCalled();
    await expect(db.get(`SELECT status, task_id FROM job_instances WHERE id = 200`)).resolves.toEqual({
      status: 'running',
      task_id: null,
    });
    await expect(db.get(`SELECT state FROM runtime_executions WHERE id = 2`)).resolves.toEqual({ state: 'running' });
  });

  it('interrupts and recovers only the owned durable execution, never an equal-id foreign row or task', async () => {
    await db.exec(`
      INSERT INTO runtime_executions (
        id, tenant_id, instance_id, backend, state, opaque_handle, boundary_fingerprint
      ) VALUES
        (1, 1, 100, 'local-process', 'running', '{"owner":"one"}', 'fp-one'),
        (2, 2, 100, 'local-process', 'running', '{"owner":"two"}', 'fp-two');
    `);

    const result = await stopInstanceExecution(db, 100, 1, 'stop');

    expect(result).toMatchObject({
      id: 100,
      result: 'already_gone',
      runtimeUncertain: false,
      taskId: null,
    });
    expect(mockedStopDurableLocalProcess).toHaveBeenCalledTimes(1);
    expect(mockedStopDurableLocalProcess).toHaveBeenCalledWith('{"owner":"one"}', 10_000);

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
