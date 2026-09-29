import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { drainOpenClawMcpSyncQueue } from './openclawMcpSyncWorker';
const mockSync = jest.fn();
jest.mock('../runtimes/mcpMaterialization', () => ({ syncAssignedMcpForAgent: (...args: unknown[]) => mockSync(...args) }));
jest.mock('./openclawMcpReconciliation', () => ({ reconcileOpenClawMcp: jest.fn() }));

describe('durable MCP sync work', () => {
  beforeEach(async () => {
    await setupTestDb();
    await getDb().run("INSERT INTO tenants (id,name,slug,is_default) VALUES (1,'Test','test',1)");
    await getDb().run("INSERT INTO agents (id,tenant_id,name,session_key) VALUES (1,1,'One','agent:one:main')");
    mockSync.mockReset(); mockSync.mockResolvedValue({ ok: true });
  });
  afterEach(teardownTestDb);
  it('recovers a committed edit without any in-memory enqueue callback', async () => {
    await drainOpenClawMcpSyncQueue(getDb());
    await getDb().run("UPDATE agents SET workspace_path = '/new/path' WHERE id = 1");
    expect(await getDb().value('SELECT count(*) FROM openclaw_mcp_sync_queue')).toBe(1);
    await drainOpenClawMcpSyncQueue(getDb());
    expect(await getDb().value('SELECT count(*) FROM openclaw_mcp_sync_queue')).toBe(0);
    expect(mockSync).toHaveBeenCalledTimes(2);
  });
  it('does not enqueue activity updates or rolled-back configuration changes', async () => {
    await drainOpenClawMcpSyncQueue(getDb());
    await getDb().run("UPDATE agents SET status = 'running', last_active = 'now' WHERE id = 1");
    await expect(getDb().withTransaction(async tx => {
      await tx.run("UPDATE agents SET workspace_path = '/rolled-back' WHERE id = 1");
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await getDb().value('SELECT count(*) FROM openclaw_mcp_sync_queue')).toBe(0);
  });
  it('retains a newer edit arriving during processing', async () => {
    mockSync.mockImplementationOnce(async () => {
      await getDb().run("UPDATE agents SET workspace_path = '/newer' WHERE id = 1");
      return { ok: true };
    });
    await drainOpenClawMcpSyncQueue(getDb());
    expect(await getDb().value('SELECT revision FROM openclaw_mcp_sync_queue')).toBe(2);
    await drainOpenClawMcpSyncQueue(getDb());
    expect(await getDb().value('SELECT count(*) FROM openclaw_mcp_sync_queue')).toBe(0);
  });
  it('retains failed work with bounded retries', async () => {
    mockSync.mockResolvedValue({ ok: false, error: 'unavailable' });
    await drainOpenClawMcpSyncQueue(getDb());
    const job = await getDb().get('SELECT attempts,error FROM openclaw_mcp_sync_queue');
    expect(job).toEqual({ attempts: 1, error: 'unavailable' });
    await drainOpenClawMcpSyncQueue(getDb());
    expect(mockSync).toHaveBeenCalledTimes(1);
  });
});
