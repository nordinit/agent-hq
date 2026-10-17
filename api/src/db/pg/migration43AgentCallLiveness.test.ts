import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';

it('adds inbound-call clocks without rewriting historical run evidence or inferring activity', async () => {
  const fixture = await historicalTestFixture(42), db = fixture.db;
  try {
    await db.run(`INSERT INTO tenants(id,name,slug) VALUES (1,'T','t')`);
    await db.run(`INSERT INTO agents(id,tenant_id,name,session_key) VALUES (1,1,'A','agent:a:main')`);
    await db.run(`INSERT INTO job_instances(id,tenant_id,agent_id,status,started_at,error)
      VALUES (42,1,1,'failed','2026-10-16 12:00:00','Historical evidence')`);
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('43-agent-call-liveness.sql');
    expect(await db.get('SELECT status, started_at, error, first_agent_call_at, last_agent_call_at FROM job_instances WHERE id = 42')).toEqual({
      status: 'failed', started_at: '2026-10-16 12:00:00', error: 'Historical evidence',
      first_agent_call_at: null, last_agent_call_at: null,
    });
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual([]);
  } finally { await fixture.close(); }
});
