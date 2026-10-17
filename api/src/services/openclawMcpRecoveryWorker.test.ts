import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { beginMcpRecovery, escalateMcpRecoveries, resolveMcpRecovery } from '../lib/mcpRecovery';
import { attemptMcpRecovery } from './openclawMcpRecoveryWorker';
const mockSync = jest.fn();
jest.mock('../runtimes/mcpMaterialization', () => ({ syncAssignedMcpForAgent: (...args: unknown[]) => mockSync(...args) }));

describe('automatic MCP recovery worker', () => {
  beforeEach(async () => {
    await setupTestDb();
    await getDb().run("INSERT INTO tenants (id,name,slug,is_default) VALUES (1,'Test','test',1)");
    await getDb().run("INSERT INTO agents (id,tenant_id,name,session_key) VALUES (1,1,'James','agent:james:main')");
    await beginMcpRecovery(getDb(), '/gateway', 1, 'interrupted'); mockSync.mockReset();
  });
  afterEach(teardownTestDb);
  it('admits only one recovery and escalates while that recovery is still waiting', async () => {
    const db = getDb();
    let release!: () => void; let started!: () => void;
    const entered = new Promise<void>(r => { started = r; });
    mockSync.mockImplementation(async () => { started(); await new Promise<void>(r => { release = r; }); return { ok: false, error: 'offline' }; });
    const first = attemptMcpRecovery(db, '/gateway'); await entered;
    await attemptMcpRecovery(db, '/gateway');
    expect(mockSync).toHaveBeenCalledTimes(1);
    await db.run("UPDATE openclaw_mcp_recovery SET deadline_at=now()-interval '1 second'");
    await escalateMcpRecoveries(db);
    expect(await db.value('SELECT state FROM openclaw_mcp_recovery')).toBe('attention');
    release(); await first;
    await attemptMcpRecovery(db, '/gateway');
    expect(mockSync).toHaveBeenCalledTimes(1);
    expect(await db.value('SELECT count(*) FROM notification_records')).toBe(1);
  });
  it('passes the durable deadline identity and keeps the episode until reconciliation verifies it', async () => {
    mockSync.mockImplementation(async () => { await resolveMcpRecovery(getDb(), '/gateway', 1); return { ok: true }; });
    await attemptMcpRecovery(getDb(), '/gateway');
    expect(mockSync).toHaveBeenCalledWith(expect.objectContaining({ agentId: 1, forceReconciliation: true, recoveryId: expect.any(Number) }));
    expect(await getDb().value('SELECT state FROM openclaw_mcp_recovery')).toBe('resolved');
  });
});
