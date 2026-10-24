import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';

it('replaces enqueue-everyone triggers on a populated database and keeps pending work', async () => {
  const fixture = await historicalTestFixture(44), db = fixture.db;
  try {
    await db.run(`INSERT INTO tenants(id,name,slug) VALUES (1,'T','t')`);
    await db.run(`INSERT INTO agents(id,tenant_id,name,session_key) VALUES (1,1,'A','agent:a:main'),(2,1,'B','agent:b:main')`);
    await db.run(`INSERT INTO mcp_servers(id,tenant_id,name,slug,command) VALUES (10,1,'S','s','run')`);
    await db.run(`INSERT INTO agent_mcp_assignments(agent_id,mcp_server_id) VALUES (1,10)`);
    await db.run(`UPDATE openclaw_mcp_sync_queue SET revision = 7, error = 'pending before upgrade' WHERE agent_id = 2`);
    await db.run(`DELETE FROM openclaw_mcp_sync_queue WHERE agent_id = 1`);

    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('45-openclaw-mcp-targeted-sync.sql');
    expect(await db.get(`SELECT revision, error FROM openclaw_mcp_sync_queue WHERE agent_id = 2`))
      .toEqual({ revision: 7, error: 'pending before upgrade' });
    expect(await db.value(`SELECT count(*) FROM pg_proc WHERE proname = 'enqueue_openclaw_mcp_sync'`)).toBe(0);

    await db.run(`UPDATE mcp_servers SET env = '{"rotated":true}' WHERE id = 10`);
    expect(await db.all(`SELECT agent_id, revision FROM openclaw_mcp_sync_queue ORDER BY agent_id`))
      .toEqual([{ agent_id: 1, revision: 1 }, { agent_id: 2, revision: 7 }]);
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual([]);
  } finally { await fixture.close(); }
});
