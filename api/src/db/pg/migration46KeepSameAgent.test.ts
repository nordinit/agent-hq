import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';

it('adds Keep same agent off for existing workflow types and an empty status owner table', async () => {
  const fixture = await historicalTestFixture(45), db = fixture.db;
  try {
    await db.run(`INSERT INTO tenants(id,name,slug) VALUES (1,'T','t')`);
    await db.run(`INSERT INTO workflow_types(tenant_id,key,name) VALUES (1,'delivery','Delivery')`);

    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('46-keep-same-agent.sql');
    expect(await db.value(`SELECT keep_same_agent FROM workflow_types WHERE key = 'delivery'`)).toBe(0);
    expect(await db.value(`SELECT count(*) FROM task_status_owners`)).toBe(0);
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual([]);
  } finally { await fixture.close(); }
});
