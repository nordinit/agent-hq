import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { closeInstance } from './instanceClose';
import { abortChatRunBySessionKey } from '../../runtimes/OpenClawRuntime';
import { abortInstanceExecutionTransport } from './stopInstanceExecution';
import { type Db } from '../../db/adapter/types';

jest.mock('../../runtimes/OpenClawRuntime', () => ({
  abortChatRunBySessionKey: jest.fn(() => ({ ok: true, status: 'aborted' })),
}));

jest.mock('../../services/browserPool', () => ({
  destroyAgentContext: jest.fn(() => Promise.resolve()),
}));

// Transport selection stays real — sending a runtime session key to the gateway
// is the exact failure this guards, and the gateway reports success for it.
jest.mock('./stopInstanceExecution', () => {
  const actual = jest.requireActual('./stopInstanceExecution');
  return {
    ...actual,
    abortInstanceExecutionTransport: jest.fn(async () => ({
      transport: 'runtime' as const,
      runtimeType: 'claude-code',
      sessionKey: 'run:700',
      result: { attempted: true, ok: true, status: 'succeeded' as const },
    })),
  };
});

const TENANT_ID = 9101;
const gatewayAbortMock = abortChatRunBySessionKey as jest.MockedFunction<typeof abortChatRunBySessionKey>;
const runtimeAbortMock = abortInstanceExecutionTransport as jest.MockedFunction<typeof abortInstanceExecutionTransport>;

let db: Db;

async function seedInstance(runtimeType: string): Promise<void> {
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, 'Abort Transport', 'abort-transport', 1)`, TENANT_ID);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', ?), ('active_tenant_id', ?)`, String(TENANT_ID), String(TENANT_ID));
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, job_title, runtime_type, session_key, workspace_path)
    VALUES (91, ?, 'Atlas', 'Chief of Staff', ?, 'agent:atlas:main', '')
  `, TENANT_ID, runtimeType);
  await db.run(`
    INSERT INTO job_instances (id, tenant_id, agent_id, status, created_at, session_key)
    VALUES (700, ?, 91, 'running', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), 'run:700')
  `, TENANT_ID);
}

/** setImmediate-scheduled aborts are fire-and-forget; let them run. */
async function flushDeferredWork(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

beforeEach(async () => {
  db = await setupTestDb();
  gatewayAbortMock.mockClear();
  runtimeAbortMock.mockClear();
});

afterEach(async () => {
  await teardownTestDb();
});

describe('closeInstance abort transport', () => {
  it('stops a runtime-backed run through its runtime, not the gateway', async () => {
    await seedInstance('claude-code');

    await closeInstance({ db, instanceId: 700, outcome: 'completed', status: 'done' });
    await flushDeferredWork();

    expect(runtimeAbortMock).toHaveBeenCalledTimes(1);
    expect(runtimeAbortMock.mock.calls[0][2]).toMatchObject({ instanceId: 700, tenantId: TENANT_ID });
    expect(gatewayAbortMock).not.toHaveBeenCalled();
  });

  it('still stops an OpenClaw run through the gateway', async () => {
    await seedInstance('openclaw');

    await closeInstance({ db, instanceId: 700, outcome: 'completed', status: 'done' });
    await flushDeferredWork();

    expect(gatewayAbortMock).toHaveBeenCalledTimes(1);
    expect(gatewayAbortMock.mock.calls[0][0]).toBe('run:700');
    expect(runtimeAbortMock).not.toHaveBeenCalled();
  });

  // agents.runtime_type is NOT NULL defaulting to 'openclaw', so a blank value
  // is the only way a row can carry no real runtime.
  it('treats a blank runtime as OpenClaw', async () => {
    await seedInstance('');

    await closeInstance({ db, instanceId: 700, outcome: 'completed', status: 'done' });
    await flushDeferredWork();

    expect(gatewayAbortMock).toHaveBeenCalledTimes(1);
    expect(runtimeAbortMock).not.toHaveBeenCalled();
  });
});
