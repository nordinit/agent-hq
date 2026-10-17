import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { beginMcpRecovery, escalateMcpRecoveries, resolveMcpRecovery, getAgentMcpRecovery, getTaskMcpRecovery, assertRecoveryActive, restoreMcpRecoveries } from './mcpRecovery';

describe('durable MCP recovery incidents', () => {
  beforeEach(async () => {
    await setupTestDb();
    await getDb().run("INSERT INTO tenants (id,name,slug,is_default) VALUES (1,'Test','test',1),(2,'Other','other',0)");
    await getDb().run("INSERT INTO agents (id,tenant_id,name,session_key) VALUES (1,1,'James','agent:james:main')");
    await getDb().run("INSERT INTO projects (id,tenant_id,name) VALUES (1,1,'Agency'),(2,2,'Other')");
    await getDb().run("INSERT INTO workflows (id,tenant_id,project_id,name) VALUES (1,1,1,'Lead gen'),(2,2,2,'Other')");
    await getDb().run("INSERT INTO task_statuses (name,label,terminal) VALUES ('done','Done',1) ON CONFLICT (name) DO UPDATE SET terminal=1");
    await getDb().run(`INSERT INTO tasks (id,tenant_id,workflow_id,title,status,assigned_agent_id) VALUES
      (1,1,1,'Automation','ready',1),(2,1,1,'AI','in_progress',1),(3,1,1,'Historical','done',1),(4,2,2,'Other tenant','ready',1)`);
  });
  afterEach(teardownTestDb);
  it('restores an interrupted update after process death using its original timestamp', async () => {
    const db = getDb();
    await db.run(`INSERT INTO openclaw_mcp_reconciliation (target_key,agent_id,desired_revision,state,operation_phase,updated_at)
      VALUES ('/gateway',1,'revision','pending','reload',now()-interval '11 minutes')`);
    await restoreMcpRecoveries(db);
    await restoreMcpRecoveries(db);
    await escalateMcpRecoveries(db);
    expect(await db.value('SELECT count(*) FROM openclaw_mcp_recovery')).toBe(1);
    expect((await getAgentMcpRecovery(db, 1))?.state).toBe('attention');
    expect(await db.value('SELECT count(*) FROM notification_records')).toBe(1);
  });
  it('shares one durable deadline across tasks and retries without changing task status or touching history that is terminal', async () => {
    const db = getDb();
    const first = await beginMcpRecovery(db, '/gateway', 1, 'disconnected');
    const again = await beginMcpRecovery(db, '/gateway', 1, 'still disconnected');
    expect(again.id).toBe(first.id);
    expect(again.deadline_at).toEqual(first.deadline_at);
    expect(await db.all('SELECT task_id FROM openclaw_mcp_recovery_tasks ORDER BY task_id')).toEqual([{ task_id: 1 }, { task_id: 2 }]);
    expect(await db.value('SELECT count(*) FROM task_notes')).toBe(2);
    expect(await db.value('SELECT status FROM tasks WHERE id=2')).toBe('in_progress');
    expect(await getTaskMcpRecovery(db, (await db.get('SELECT * FROM tasks WHERE id=4'))!)).toBeNull();
  });
  it('escalates once after ten minutes, survives repeat workers, and creates one shared alert and delivery', async () => {
    const db = getDb();
    const incident = await beginMcpRecovery(db, '/gateway', 1, 'disconnected');
    await escalateMcpRecoveries(db);
    expect(await db.value('SELECT count(*) FROM notification_records')).toBe(0);
    await db.run("UPDATE openclaw_mcp_recovery SET started_at=now()-interval '11 minutes',deadline_at=now()-interval '1 minute'");
    await Promise.all([escalateMcpRecoveries(db), escalateMcpRecoveries(db)]);
    await escalateMcpRecoveries(db);
    expect((await getAgentMcpRecovery(db, 1))?.state).toBe('attention');
    expect(await db.value('SELECT count(*) FROM notification_records')).toBe(1);
    expect(await db.value('SELECT count(*) FROM notification_deliveries')).toBe(1);
    const metadata = JSON.parse((await db.value<string>('SELECT metadata_json FROM notification_records'))!);
    expect(metadata.taskIds).toEqual([1, 2]);
    await expect(assertRecoveryActive(db, incident.id)).rejects.toThrow('deadline');
    await resolveMcpRecovery(db, '/gateway', 1);
    await resolveMcpRecovery(db, '/gateway', 1);
    expect(await getAgentMcpRecovery(db, 1)).toBeNull();
    expect(await db.value('SELECT count(*) FROM notification_records')).toBe(2);
    expect(await db.value('SELECT status FROM tasks WHERE id=1')).toBe('ready');
    const second = await beginMcpRecovery(db, '/gateway', 1, 'new outage');
    expect(second.id).not.toBe(incident.id);
    expect(second.state).toBe('recovering');
  });
});
