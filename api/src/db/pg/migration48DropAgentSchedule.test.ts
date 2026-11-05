import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';

const scheduleColumn = `SELECT count(*) FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'agents' AND column_name = 'schedule'`;

it('drops the legacy agents.schedule column and keeps the agent rows', async () => {
  const fixture = await historicalTestFixture(45), db = fixture.db;
  try {
    await db.run(`INSERT INTO tenants(id,name,slug) VALUES (1,'T','t')`);
    await db.run(`INSERT INTO agents(id,tenant_id,name,session_key,schedule) VALUES (7,1,'Worker','agent:worker:main','0 9 * * 1-5')`);
    expect(Number(await db.value(scheduleColumn))).toBe(1);

    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('48-drop-agent-schedule.sql');
    expect(Number(await db.value(scheduleColumn))).toBe(0);
    expect(await db.value(`SELECT name FROM agents WHERE id = 7`)).toBe('Worker');
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual([]);
  } finally { await fixture.close(); }
});
