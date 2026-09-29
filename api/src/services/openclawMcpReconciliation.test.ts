import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { reconcileOpenClawMcp, resetOpenClawMcpReconciliationForTests } from './openclawMcpReconciliation';

let mockEpoch = 1;
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
    mockEpoch = 1;
    mockRpc.mockReset();
    mockRpc.mockImplementation(async ({ rpcParams }) => ({ ok: true, payload: {
      ok: true, runtime: { generation: 2, pluginIds: rpcParams.plugins.map((p: { pluginId: string }) => p.pluginId) },
    } }));
    resetOpenClawMcpReconciliationForTests();
  });
  afterEach(async () => { await teardownTestDb(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

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
    await reconcileOpenClawMcp(params);
    expect(mockRpc).toHaveBeenCalledTimes(2);
  });
});
