import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { reconcileOpenClawMcp, resetOpenClawMcpReconciliationForTests } from './openclawMcpReconciliation';

const originalMode = process.env.AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE;
let mockEpoch = 1;
let mockInstallation = 'build-one';
jest.mock('../runtimes/openclaw/installationRevision', () => ({ openClawInstallationRevision: () => mockInstallation }));
const mockRpc = jest.fn();
jest.mock('../runtimes/openclaw/gatewayClient', () => ({
  getGatewayConnectionEpoch: () => mockEpoch,
  gatewayRpcCall: (...args: unknown[]) => mockRpc(...args),
}));

describe('OpenClaw MCP reconciliation', () => {
  let root: string;
  beforeEach(async () => {
    await setupTestDb();
    await getDb().run("INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)");
    await getDb().run("INSERT INTO agents (id, tenant_id, name, session_key) VALUES (1, 1, 'One', 'agent:one:main'), (2, 1, 'Two', 'agent:two:main')");
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ahq-reconcile-'));
    fs.writeFileSync(path.join(root, 'openclaw.json'), '{}');
    process.env.AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE = 'async-every-dispatch';
    mockEpoch = 1;
    mockInstallation = 'build-one';
    mockRpc.mockReset();
    mockRpc.mockImplementation(async ({ rpcParams }) => ({ ok: true, payload: {
      ok: true, runtime: { generation: 2, pluginIds: (rpcParams.plugins ?? []).map((p: { pluginId: string }) => p.pluginId) },
    } }));
    resetOpenClawMcpReconciliationForTests();
  });
  afterEach(async () => { if(originalMode === undefined) delete process.env.AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE; else process.env.AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE = originalMode; await teardownTestDb(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

  function input(agentId = 1) {
    const bundle = path.join(root, String(agentId));
    fs.mkdirSync(path.join(bundle, '.claude-plugin'), { recursive: true });
    const bundlePath = path.join(bundle, '.mcp.json');
    if (!fs.existsSync(bundlePath)) fs.writeFileSync(bundlePath, '{"mcpServers":{}}');
    fs.writeFileSync(path.join(bundle, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: `fixture-${agentId}` }));
    return { db: getDb(), agentId, bundlePath, bundlePluginId: `fixture-${agentId}`, configPath: path.join(root, 'openclaw.json') };
  }

  it('acknowledges one generation and skips ten unchanged launches', async () => {
    const params = input();
    await reconcileOpenClawMcp(params);
    for (let i = 0; i < 10; i++) await reconcileOpenClawMcp(params);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(expect.objectContaining({ method: 'plugins.reload', retryOnDisconnect: false }));
    expect(await getDb().get('SELECT state, desired_revision, applied_revision FROM openclaw_mcp_reconciliation')).toEqual(expect.objectContaining({ state: 'applied' }));
  });

  it('batches different agents and shares same-revision waiters', async () => {
    const first = input(1); const second = input(2);
    await Promise.all([reconcileOpenClawMcp(first), reconcileOpenClawMcp(first), reconcileOpenClawMcp(second)]);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc.mock.calls[0][0].rpcParams.plugins).toEqual(expect.arrayContaining([{ pluginId: 'fixture-1' }, { pluginId: 'fixture-2' }]));
  });

  it('reapplies changed files and invalidates acknowledgements after reconnect', async () => {
    const params = input(); await reconcileOpenClawMcp(params);
    fs.writeFileSync(params.bundlePath, '{"mcpServers":{"changed":{}}}');
    await reconcileOpenClawMcp(params);
    mockEpoch = 2;
    await reconcileOpenClawMcp(params);
    expect(mockRpc).toHaveBeenCalledTimes(3);
  });

  it('does not acknowledge a file edit that happens during application', async () => {
    const params = input();
    mockRpc.mockImplementationOnce(async () => {
      fs.writeFileSync(params.bundlePath, '{"mcpServers":{"newer":{}}}');
      return { ok: true, payload: { ok: true, runtime: { generation: 2, pluginIds: ['fixture-1'] } } };
    });
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('configuration changed');
    expect((await getDb().get<{ state: string }>('SELECT state FROM openclaw_mcp_reconciliation'))?.state).toBe('failed');
    await reconcileOpenClawMcp(params);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('persists an uncertain failure without blindly replaying the mutation', async () => {
    const params = input();
    mockRpc.mockResolvedValueOnce({ ok: false, error: 'Gateway WebSocket timeout' });
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('timeout');
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('timeout');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    resetOpenClawMcpReconciliationForTests();
    mockEpoch = 2;
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('timeout');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    await reconcileOpenClawMcp({ ...params, force: true });
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });
  it('uses gateway metadata refresh only for metadata changes, including an installation upgrade', async () => {
    process.env.AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE = 'on-change';
    const params = input();
    fs.writeFileSync(params.bundlePath, '{"mcpServers":{"one":{"command":"node","args":["before"]}}}');
    await reconcileOpenClawMcp(params);
    expect(mockRpc.mock.calls.map(c => c[0].method)).toEqual(['plugins.refresh', 'plugins.reload']);
    for (let i = 0; i < 10; i++) await reconcileOpenClawMcp(params);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    fs.writeFileSync(params.bundlePath, '{"mcpServers":{"one":{"command":"node","args":["a","b"]}}}');
    await reconcileOpenClawMcp(params);
    expect(mockRpc.mock.calls.at(-1)![0].method).toBe('plugins.reload');
    expect(mockRpc).toHaveBeenCalledTimes(3);
    fs.writeFileSync(params.bundlePath, '{"mcpServers":{"one":{"args":["a","b"],"command":"node"}}}');
    await reconcileOpenClawMcp(params);
    expect(mockRpc).toHaveBeenCalledTimes(3);
    fs.writeFileSync(path.join(path.dirname(params.bundlePath), '.claude-plugin', 'plugin.json'), '{"name":"fixture-1","version":"2"}');
    await reconcileOpenClawMcp(params);
    expect(mockRpc.mock.calls.slice(-2).map(c => c[0].method)).toEqual(['plugins.refresh', 'plugins.reload']);
    mockInstallation = 'build-two';
    await reconcileOpenClawMcp(params);
    expect(mockRpc.mock.calls.slice(-2).map(c => c[0].method)).toEqual(['plugins.refresh', 'plugins.reload']);
    expect(mockRpc).toHaveBeenCalledTimes(7);
  });

  it('persists safe retry cooldowns across API restarts', async () => {
    const params = input();
    mockRpc.mockResolvedValue({ ok: false, error: 'another operation is running',
      failure: { code: 'UNAVAILABLE', retryable: true, retryAfterMs: 2000 } });
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('another operation');
    resetOpenClawMcpReconciliationForTests();
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('another operation');
    expect(mockRpc).toHaveBeenCalledTimes(1);
    await getDb().run("UPDATE openclaw_mcp_reconciliation SET retry_at = now() - interval '1 second'");
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('another operation');
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(await getDb().get('SELECT attempts,recovery_required FROM openclaw_mcp_reconciliation'))
      .toEqual({ attempts: 2, recovery_required: false });
  });

  it('does not replay a published failure even after files change or the socket reconnects', async () => {
    const params = input();
    mockRpc.mockResolvedValue({ ok: false, error: 'cleanup failed after publication',
      failure: { details: { runtime: { committed: true, generation: 7 } } } });
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('cleanup failed');
    fs.writeFileSync(params.bundlePath, '{"mcpServers":{"newer":{}}}');
    resetOpenClawMcpReconciliationForTests(); mockEpoch++;
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('cleanup failed');
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it('recovers a crash before mutation and holds a crash after mutation starts', async () => {
    const params = input();
    await reconcileOpenClawMcp(params);
    await getDb().run("UPDATE openclaw_mcp_reconciliation SET state = 'pending', operation_phase = 'prepared'");
    resetOpenClawMcpReconciliationForTests();
    await reconcileOpenClawMcp(params);
    expect(mockRpc).toHaveBeenCalledTimes(2);
    await getDb().run("UPDATE openclaw_mcp_reconciliation SET state = 'pending', operation_phase = 'reload'");
    resetOpenClawMcpReconciliationForTests();
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('interrupted after mutation began');
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });

  it('rejects acknowledgement from a changed connection', async () => {
    const params = input();
    mockRpc.mockImplementationOnce(async () => { mockEpoch++; return { ok: true, payload: {
      ok: true, runtime: { generation: 2, pluginIds: ['fixture-1'] },
    } }; });
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('connection changed');
    expect(await getDb().get('SELECT state,recovery_required,applied_revision FROM openclaw_mcp_reconciliation'))
      .toEqual({ state: 'failed', recovery_required: true, applied_revision: null });
  });

  it('handles a confirmed drain timeout as a bounded retry without pretending it applied', async () => {
    const params = input();
    mockRpc.mockResolvedValueOnce({ ok: false, error: 'admitted work did not settle within 60s',
      failure: { details: { runtime: { committed: false, generation: 2 } } } });
    await expect(reconcileOpenClawMcp(params)).rejects.toThrow('did not settle');
    expect(await getDb().get('SELECT state,recovery_required,applied_revision FROM openclaw_mcp_reconciliation'))
      .toEqual({ state: 'failed', recovery_required: false, applied_revision: null });
    expect(await getDb().value('SELECT retry_at IS NOT NULL FROM openclaw_mcp_reconciliation')).toBe(true);
  });

});
