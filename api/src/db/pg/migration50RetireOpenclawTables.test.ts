import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';

const RETIRED = [
  'dev_db_sync_audit', 'telemetry_schema_config', 'task_creation_events', 'openclaw_transcript_ingest_state',
  'openclaw_mcp_sync_queue', 'openclaw_mcp_reconciliation', 'openclaw_mcp_recovery', 'openclaw_mcp_recovery_tasks',
];

it('moves transcript cursors onto artifacts, keeps MCP sync rows under the new names and drops legacy tables', async () => {
  const fixture = await historicalTestFixture(49), db = fixture.db;
  try {
    await db.run(`INSERT INTO tenants(id,name,slug) VALUES (1,'T','t')`);
    await db.run(`INSERT INTO projects(id,tenant_id,name) VALUES (1,1,'P')`);
    await db.run(`INSERT INTO workflows(id,tenant_id,project_id,name) VALUES (1,1,1,'W')`);
    await db.run(`INSERT INTO agents(id,tenant_id,name,session_key,runtime_type) VALUES (1,1,'A','agent:a:main','openclaw')`);
    await db.run(`INSERT INTO tasks(id,tenant_id,workflow_id,title) VALUES (5,1,1,'Held back')`);
    await db.run(`INSERT INTO job_instances(id,tenant_id,agent_id,task_id,status) VALUES (11,1,1,5,'done'),(12,1,1,5,'done')`);
    // Run 12 never produced liveness, so it has no artifacts row to carry its cursor.
    await db.run(`INSERT INTO instance_artifacts(instance_id,task_id,last_agent_heartbeat_at,updated_at)
      VALUES (11,5,'2026-11-01 10:00:00','2026-11-01 10:00:09')`);
    await db.run(`INSERT INTO openclaw_transcript_ingest_state(instance_id,session_file,last_line_index,last_event_at,last_heartbeat_at)
      VALUES (11,'/sessions/a.jsonl',40,'2026-11-01 10:00:05','2026-11-01 10:00:00'),(12,'/sessions/b.jsonl',7,NULL,NULL)`);
    await db.run(`INSERT INTO task_creation_events(task_id) VALUES (5)`);

    await db.run(`DELETE FROM openclaw_mcp_sync_queue`);
    await db.run(`INSERT INTO openclaw_mcp_reconciliation(target_key,agent_id,desired_revision,state) VALUES ('gateway',1,'r2','pending')`);
    await db.run(`INSERT INTO openclaw_mcp_recovery(target_key,agent_id,state,last_error) VALUES ('gateway',1,'attention','reload failed')`);
    await db.run(`INSERT INTO openclaw_mcp_recovery_tasks(recovery_id,task_id) VALUES (1,5)`);

    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('50-retire-openclaw-and-legacy-tables.sql');

    expect(await db.all(`SELECT instance_id, transcript_cursor, last_agent_heartbeat_at, updated_at
      FROM instance_artifacts ORDER BY instance_id`)).toEqual([{
      instance_id: 11,
      transcript_cursor: { session_file: '/sessions/a.jsonl', line_index: 40, last_event_at: '2026-11-01 10:00:05' },
      last_agent_heartbeat_at: '2026-11-01 10:00:00',
      updated_at: '2026-11-01 10:00:09',
    }]);
    expect(await db.value(`SELECT count(*) FROM pg_class WHERE relname = ANY(?::text[])`, RETIRED)).toBe(0);

    expect(await db.all(`SELECT target_key, state FROM agent_mcp_reconciliation`)).toEqual([{ target_key: 'gateway', state: 'pending' }]);
    expect(await db.all(`SELECT id, state FROM agent_mcp_recovery`)).toEqual([{ id: 1, state: 'attention' }]);
    expect(await db.all(`SELECT recovery_id, task_id FROM agent_mcp_recovery_tasks`)).toEqual([{ recovery_id: 1, task_id: 5 }]);

    // The renamed sequence still feeds the id, and the active-incident index still applies.
    await db.run(`UPDATE agent_mcp_recovery SET state = 'resolved', resolved_at = now()`);
    expect(await db.get(`INSERT INTO agent_mcp_recovery(target_key,agent_id,last_error) VALUES ('gateway',1,'again') RETURNING id`))
      .toEqual({ id: 2 });
    await expect(db.run(`INSERT INTO agent_mcp_recovery(target_key,agent_id,last_error) VALUES ('gateway',1,'duplicate')`))
      .rejects.toThrow(/agent_mcp_recovery_active/);

    // Assignment triggers enqueue into the renamed queue.
    await db.run(`INSERT INTO mcp_servers(id,tenant_id,name,slug,command) VALUES (10,1,'S','s','run')`);
    await db.run(`INSERT INTO agent_mcp_assignments(agent_id,mcp_server_id) VALUES (1,10)`);
    expect(await db.all(`SELECT agent_id, revision FROM agent_mcp_sync_queue`)).toEqual([{ agent_id: 1, revision: 1 }]);

    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual([]);
  } finally { await fixture.close(); }
}, 60000);
