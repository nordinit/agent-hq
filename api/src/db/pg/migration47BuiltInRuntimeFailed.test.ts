import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';

it('removes the mappings that decided what a dead run does and keeps every other mapping', async () => {
  const fixture = await historicalTestFixture(46), db = fixture.db;
  try {
    await db.run(`INSERT INTO tenants(id,name,slug) VALUES (1,'T','t')`);
    await db.run(`DELETE FROM external_event_mappings`);
    await db.run(`INSERT INTO external_event_mappings (tenant_id, source, event_name, status_includes_json, status_excludes_json, action_kind, action_target, enabled, priority)
      VALUES
        (1, 'agent_hq_runtime', 'runtime_failed', '[]', '[]', 'outcome', 'runtime_failed', 1, 100),
        (1, 'agent_hq_runtime', 'runtime_failed', '["ready"]', '[]', 'ignore', NULL, 1, 200),
        (1, 'deploy_bot', 'deploy_failed', '[]', '[]', 'outcome', 'runtime_failed', 1, 100),
        (1, 'agent_hq_runtime', 'agent_started', '[]', '[]', 'status', 'in_progress', 1, 100),
        (1, 'deploy_bot', 'deploy_failed', '[]', '[]', 'outcome', 'blocked', 1, 200)`);

    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('47-built-in-runtime-failed.sql');
    expect(await db.all(`SELECT source, event_name, action_target FROM external_event_mappings ORDER BY id`)).toEqual([
      { source: 'agent_hq_runtime', event_name: 'agent_started', action_target: 'in_progress' },
      { source: 'deploy_bot', event_name: 'deploy_failed', action_target: 'blocked' },
    ]);
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual([]);
  } finally { await fixture.close(); }
});
