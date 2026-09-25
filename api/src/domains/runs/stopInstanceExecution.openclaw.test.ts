import type { Db } from '../../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { stopInstanceExecution } from './stopInstanceExecution';
import { OpenClawRuntime } from '../../runtimes/openclaw/OpenClawRuntime';
import { gatewayRpcCall, gatewayWsSend } from '../../runtimes/openclaw/gatewayClient';
import { sendOpenClawTurn } from '../../runtimes/openclaw/sendTurn';

jest.mock('../../runtimes', () => ({
  resolveRuntime: () => new (jest.requireActual('../../runtimes/openclaw/OpenClawRuntime').OpenClawRuntime)(),
}));
jest.mock('../../runtimes/openclaw/gatewayClient', () => ({
  gatewayRpcCall: jest.fn(), gatewayWsSend: jest.fn(),
}));
const rpc = jest.mocked(gatewayRpcCall);
const send = jest.mocked(gatewayWsSend);
let db: Db;
const target = { runtimeType: 'openclaw', runId: 'gateway-old', sessionKey: 'agent:tooling-pm:run:700:durable' };

beforeEach(async () => {
  db = await setupTestDb();
  await db.exec(`
    INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Stop test', 'stop-test', 1);
    INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Test');
    INSERT INTO workflows (id, tenant_id, project_id, name) VALUES (1, 1, 1, 'Test');
    INSERT INTO agents (id, tenant_id, name, session_key, runtime_type)
      VALUES (91, 1, 'Harlow', 'agent:tooling-pm:main', 'openclaw');
    INSERT INTO tasks (id, tenant_id, project_id, workflow_id, title, status, agent_id)
      VALUES (1792, 1, 1, 1, 'Test stop', 'in_progress', 91);
    INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, session_key, response)
      VALUES (700, 1, 91, 1792, 'running', 'run:700:durable', '{"runId":"gateway-old"}');
    UPDATE tasks SET active_instance_id = 700 WHERE id = 1792;
  `);
  rpc.mockReset().mockImplementation(async params => ({
    ok: true, payload: { ok: true, aborted: true, runIds: [params.rpcParams?.runId] },
  }));
  send.mockReset();
});
afterEach(async () => { await teardownTestDb(); });

it('cancels legacy Harlow runs using response.runId and the agent-scoped session key', async () => {
  const result = await stopInstanceExecution(db, 700, 1, 'stop');
  expect(result).toMatchObject({ result: 'confirmed_stopped', runtimeUncertain: false });
  expect(rpc.mock.calls[0][0].rpcParams).toEqual({ runId: 'gateway-old', sessionKey: target.sessionKey });
  expect(await db.get('SELECT session_key FROM job_instances WHERE id = 700')).toEqual({ session_key: 'run:700:durable' });
});

it('fences task writes before gateway I/O and reports an unconfirmed abort honestly', async () => {
  rpc.mockImplementation(async () => {
    expect(await db.get('SELECT status, task_id, stop_requested_at FROM job_instances WHERE id = 700')).toEqual({
      status: 'failed', task_id: null, stop_requested_at: expect.any(String),
    });
    expect(await db.get('SELECT active_instance_id FROM tasks WHERE id = 1792')).toEqual({ active_instance_id: null });
    return { ok: true, payload: { ok: true, aborted: false, runIds: [] } };
  });
  const result = await stopInstanceExecution(db, 700, 1, 'stop');
  expect(result).toMatchObject({ result: 'stopped_runtime_uncertain', abortOk: false, runtimeUncertain: true });
  expect(await db.get('SELECT abort_status, runtime_ended_at FROM job_instances WHERE id = 700')).toEqual({
    abort_status: 'failed', runtime_ended_at: null,
  });
});

it('uses the persisted target after an API restart or agent routing change and makes repeated stops safe', async () => {
  await db.run('UPDATE job_instances SET runtime_abort_target = ?::jsonb WHERE id = 700', JSON.stringify(target));
  await db.run("UPDATE agents SET session_key = 'agent:renamed:main', runtime_type = 'codex' WHERE id = 91");
  await stopInstanceExecution(db, 700, 1, 'stop');
  expect(rpc.mock.calls[0][0].rpcParams).toEqual({ runId: target.runId, sessionKey: target.sessionKey });
  expect(await stopInstanceExecution(db, 700, 1, 'stop')).toMatchObject({ result: 'confirmed_stopped' });
  expect(rpc).toHaveBeenCalledTimes(1);
  // A fresh adapter has no in-memory handles; the persisted target is sufficient.
  await expect(new OpenClawRuntime().abort(target.runId, target.sessionKey)).resolves.toMatchObject({ confirmed: true });
});

it('does not stop a newer run or clear its task linkage when retrying an old stop', async () => {
  await db.exec(`
    INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, session_key, run_id)
      VALUES (701, 1, 91, 1792, 'running', 'run:701:new', 'gateway-new');
    UPDATE tasks SET active_instance_id = 701 WHERE id = 1792;
  `);
  await stopInstanceExecution(db, 700, 1, 'stop');
  expect(rpc.mock.calls[0][0].rpcParams?.runId).toBe('gateway-old');
  expect(await db.get('SELECT active_instance_id, agent_id FROM tasks WHERE id = 1792')).toEqual({ active_instance_id: 701, agent_id: 91 });
  expect(await db.get('SELECT status FROM job_instances WHERE id = 701')).toEqual({ status: 'running' });
});

it('does not claim confirmation or target main when the instance address is missing', async () => {
  await db.run('UPDATE job_instances SET session_key = NULL, response = NULL WHERE id = 700');
  expect(await stopInstanceExecution(db, 700, 1, 'stop')).toMatchObject({ runtimeUncertain: true, abortAttempted: false });
  expect(rpc).not.toHaveBeenCalled();
});

it('persists the exact target before send and cancels a turn that starts while Stop is in flight', async () => {
  let releaseSend!: (value: { ok: boolean; runId: string }) => void;
  let enteredSend!: () => void;
  const entered = new Promise<void>(resolve => { enteredSend = resolve; });
  send.mockImplementation(async params => {
    const row = await db.get<{ runtime_abort_target: unknown }>('SELECT runtime_abort_target FROM job_instances WHERE id = 700');
    expect(row?.runtime_abort_target).toEqual({ ...target, runId: params.runId });
    enteredSend();
    return new Promise(resolve => { releaseSend = resolve; });
  });
  const pending = sendOpenClawTurn({ sessionKey: target.sessionKey, message: 'Work', instance: { db, id: 700, tenantId: 1 } });
  await entered;
  rpc.mockResolvedValueOnce({ ok: true, payload: { ok: true, aborted: false, runIds: [] } });
  expect(await stopInstanceExecution(db, 700, 1, 'stop')).toMatchObject({ runtimeUncertain: true });
  const exactRunId = send.mock.calls[0][0].runId!;
  releaseSend({ ok: true, runId: exactRunId });
  expect(await pending).toMatchObject({ ok: false, error: 'Run was stopped during dispatch' });
  const abortCalls = rpc.mock.calls.filter(([request]) => request.method === 'chat.abort');
  expect(abortCalls).toHaveLength(2);
  for (const [request] of abortCalls) expect(request.rpcParams).toEqual({ runId: exactRunId, sessionKey: target.sessionKey });
  expect(await db.get('SELECT status, abort_status FROM job_instances WHERE id = 700')).toEqual({ status: 'failed', abort_status: 'succeeded' });
});

it('does not send a turn when Stop has already committed', async () => {
  await stopInstanceExecution(db, 700, 1, 'stop');
  expect(await sendOpenClawTurn({ sessionKey: target.sessionKey, message: 'Work', instance: { db, id: 700, tenantId: 1 } })).toMatchObject({ ok: false });
  expect(send).not.toHaveBeenCalled();
});
