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
  it('keeps retrying an escalated recovery every 5, then 10 minutes, until the gateway accepts it', async () => {
    const db = getDb();
    const secondsToNextAttempt = async () => Number(await db.value('SELECT EXTRACT(EPOCH FROM next_attempt_at - now()) FROM openclaw_mcp_recovery'));
    mockSync.mockResolvedValue({ ok: false, error: 'connect ECONNREFUSED' });
    await db.run("UPDATE openclaw_mcp_recovery SET deadline_at=now()-interval '1 second'");
    await escalateMcpRecoveries(db);
    await attemptMcpRecovery(db, '/gateway');
    expect(mockSync).not.toHaveBeenCalled();
    await db.run('UPDATE openclaw_mcp_recovery SET next_attempt_at=now()');
    await attemptMcpRecovery(db, '/gateway');
    expect(mockSync).toHaveBeenCalledWith(expect.objectContaining({ agentId: 1, forceReconciliation: true, recoveryId: expect.any(Number) }));
    expect(await secondsToNextAttempt()).toBeGreaterThan(4 * 60);
    expect(await secondsToNextAttempt()).toBeLessThanOrEqual(5 * 60);
    await db.run("UPDATE openclaw_mcp_recovery SET deadline_at=now()-interval '31 minutes',next_attempt_at=now()");
    await attemptMcpRecovery(db, '/gateway');
    expect(mockSync).toHaveBeenCalledTimes(2);
    expect(await secondsToNextAttempt()).toBeGreaterThan(9 * 60);
    expect(await secondsToNextAttempt()).toBeLessThanOrEqual(10 * 60);
    expect(await db.value('SELECT last_error FROM openclaw_mcp_recovery')).toBe('connect ECONNREFUSED');
    mockSync.mockImplementation(async () => { await resolveMcpRecovery(db, '/gateway', 1); return { ok: true }; });
    await db.run('UPDATE openclaw_mcp_recovery SET next_attempt_at=now()');
    await attemptMcpRecovery(db, '/gateway');
    expect(await db.value('SELECT state FROM openclaw_mcp_recovery')).toBe('resolved');
    expect(await db.value("SELECT count(*) FROM notification_records WHERE type='mcp_recovery_resolved'")).toBe(1);
  });
  it('passes the durable deadline identity and keeps the episode until reconciliation verifies it', async () => {
    mockSync.mockImplementation(async () => { await resolveMcpRecovery(getDb(), '/gateway', 1); return { ok: true }; });
    await attemptMcpRecovery(getDb(), '/gateway');
    expect(mockSync).toHaveBeenCalledWith(expect.objectContaining({ agentId: 1, forceReconciliation: true, recoveryId: expect.any(Number) }));
    expect(await getDb().value('SELECT state FROM openclaw_mcp_recovery')).toBe('resolved');
  });
});
