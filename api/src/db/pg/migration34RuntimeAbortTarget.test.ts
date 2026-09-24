import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';

it('adds nullable abort targets without rewriting legacy run identity or response', async () => {
  const fixture = await historicalTestFixture(33);
  const db = fixture.db;
  try {
    await db.exec(`
      INSERT INTO tenants (id, name, slug) VALUES (1, 'Migration', 'migration');
      INSERT INTO agents (id, tenant_id, name, session_key) VALUES (1, 1, 'Harlow', 'agent:harlow:main');
      INSERT INTO job_instances (id, tenant_id, agent_id, session_key, response, status)
        VALUES (1, 1, 1, 'run:1:durable', '{"runId":"gateway-run"}', 'running');
    `);
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual(expect.arrayContaining(['34-runtime-abort-target.sql']));
    expect(await db.get('SELECT session_key, response, status, runtime_abort_target, stop_requested_at FROM job_instances WHERE id = 1')).toEqual({
      session_key: 'run:1:durable', response: '{"runId":"gateway-run"}', status: 'running',
      runtime_abort_target: null, stop_requested_at: null,
    });
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual([]);
  } finally { await fixture.close(); }
}, 60000);
