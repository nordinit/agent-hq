import { abortOpenClawRun } from './abort';
import { gatewayRpcCall } from './gatewayClient';

jest.mock('./gatewayClient', () => ({ gatewayRpcCall: jest.fn() }));
const rpc = jest.mocked(gatewayRpcCall);

beforeEach(() => rpc.mockReset());

describe('OpenClaw exact-run cancellation', () => {
  it('routes the Harlow short key to its agent and supplies the gateway run ID', async () => {
    rpc.mockResolvedValue({ ok: true, payload: { ok: true, aborted: true, runIds: ['gateway-run'] } });
    await expect(abortOpenClawRun('gateway-run', 'run:3474:durable', {
      agentSessionKey: 'agent:tooling-pm:main',
    })).resolves.toMatchObject({ ok: true, confirmed: true, status: 'signalled' });
    expect(rpc).toHaveBeenCalledWith(expect.objectContaining({
      method: 'chat.abort',
      rpcParams: { sessionKey: 'agent:tooling-pm:run:3474:durable', runId: 'gateway-run' },
    }));
  });

  it.each([
    { ok: true, aborted: false, runIds: [] },
    { ok: true },
    { ok: true, aborted: true, runIds: ['newer-run'] },
    { ok: false, aborted: true, runIds: ['old-run'] },
    null,
  ])('does not confuse RPC success with cancellation: %j', async payload => {
    rpc.mockResolvedValue({ ok: true, payload });
    await expect(abortOpenClawRun('old-run', 'agent:harlow:run:1')).resolves.toMatchObject({
      attempted: true, ok: false, confirmed: false,
    });
    expect(rpc.mock.calls.filter(([request]) => request.method === 'chat.abort')).toHaveLength(1);
    expect(rpc.mock.calls[0][0].rpcParams).toEqual({ sessionKey: 'agent:harlow:run:1', runId: 'old-run' });
  });

  it('accepts already gone only with an exact-run terminal snapshot', async () => {
    rpc.mockResolvedValueOnce({ ok: true, payload: { ok: true, aborted: false, runIds: [] } });
    rpc.mockResolvedValueOnce({ ok: true, payload: { runId: 'old-run', status: 'error', endedAt: 1234, stopReason: 'rpc' } });
    await expect(abortOpenClawRun('old-run', 'agent:harlow:run:1')).resolves.toMatchObject({
      confirmed: true, status: 'already_gone',
    });
    expect(rpc.mock.calls[1][0]).toMatchObject({ method: 'agent.wait', rpcParams: { runId: 'old-run', timeoutMs: 0 } });
  });

  it.each([
    { runId: 'new-run', status: 'error', endedAt: 1234 },
    { runId: 'old-run', status: 'timeout', endedAt: 1234 },
    { runId: 'old-run', status: 'ok' },
  ])('rejects inconclusive terminal evidence: %j', async terminal => {
    rpc.mockResolvedValueOnce({ ok: true, payload: { ok: true, aborted: false, runIds: [] } });
    rpc.mockResolvedValueOnce({ ok: true, payload: terminal });
    await expect(abortOpenClawRun('old-run', 'agent:harlow:run:1')).resolves.toMatchObject({ ok: false, confirmed: false });
  });

  it.each(['', 'run:1'])('refuses unknown routing without falling back to main: %s', async key => {
    await expect(abortOpenClawRun('run-id', key)).resolves.toMatchObject({ attempted: false, confirmed: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('requires an exact run ID even with a canonical session key', async () => {
    await expect(abortOpenClawRun('', 'agent:harlow:main')).resolves.toMatchObject({ attempted: false, ok: false });
    expect(rpc).not.toHaveBeenCalled();
  });

  it.each([
    ['request timed out', 'timed_out'],
    ['ETIMEDOUT', 'timed_out'],
    ['unauthorized', 'failed'],
    ['session not found', 'failed'],
  ])('reports %s without claiming already gone', async (error, status) => {
    rpc.mockResolvedValue({ ok: false, error });
    await expect(abortOpenClawRun('run-id', 'agent:harlow:run:1')).resolves.toMatchObject({
      ok: false, confirmed: false, status,
    });
  });
});
