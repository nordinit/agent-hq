import { Pool } from 'pg';
import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';
import { APP_SEARCH_PATH } from './schemas';

/** One table per schema, plus the tables whose placement was a judgement call. */
const PLACEMENT: Record<string, string> = {
  tenants: 'core', projects: 'core', security_events: 'core',
  agents: 'agents', mcp_servers: 'agents', agent_mcp_recovery: 'agents', teams: 'agents',
  workflows: 'workflow', routing_config: 'workflow', task_statuses: 'workflow', task_field_schemas: 'workflow',
  tasks: 'tasks', recurring_task_series: 'tasks', external_task_event_receipts: 'tasks',
  job_instances: 'runs', instance_artifacts: 'runs', runtime_executions: 'runs', notification_records: 'runs',
  chat_messages: 'chat',
  mcp_api_keys: 'access', executable_secret_values: 'access',
  telemetry_outbox: 'telemetry',
  schema_migrations: 'public',
};

it('moves tables, functions and the view into schemas without touching rows', async () => {
  const fixture = await historicalTestFixture(50), db = fixture.db;
  try {
    await db.run(`INSERT INTO tenants(id,name,slug) VALUES (1,'T','t')`);
    await db.run(`INSERT INTO agents(id,tenant_id,name,session_key) VALUES (1,1,'A','agent:a:main')`);

    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('51-organize-schemas.sql');

    const placed = await db.all<{ table_schema: string; table_name: string }>(`SELECT table_schema, table_name
      FROM information_schema.tables WHERE table_name = ANY(?::text[])`, Object.keys(PLACEMENT));
    expect(Object.fromEntries(placed.map((row) => [row.table_name, row.table_schema]))).toEqual(PLACEMENT);

    // Rows survive, and resolve both through the search path and by qualified name.
    expect(await db.value(`SELECT name FROM agents WHERE id = 1`)).toBe('A');
    expect(await db.value(`SELECT name FROM agents.agents WHERE id = 1`)).toBe('A');

    expect(await db.value(`SELECT pronamespace::regnamespace::text FROM pg_proc WHERE proname = 'enqueue_openclaw_mcp_sync_agents'`)).toBe('agents');
    expect(await db.value(`SELECT pronamespace::regnamespace::text FROM pg_proc WHERE proname = 'protect_execution_audit'`)).toBe('access');
    expect(await db.value(`SELECT schemaname FROM pg_views WHERE viewname = 'telemetry_source_context'`)).toBe('telemetry');
    const captureChange = await db.value<string>(`SELECT pg_get_functiondef('telemetry.telemetry_capture_change()'::regprocedure)`);
    expect(captureChange).toContain("to_regclass('telemetry.telemetry_query_results')");
    expect(captureChange).not.toContain('public.');

    // psql and DBeaver sessions, which set no options, get the same search path from the database.
    const url = new URL(process.env.AGENT_HQ_TEST_PG_URL!);
    url.pathname = `/${await db.value<string>('SELECT current_database()')}`;
    const plain = new Pool({ connectionString: url.toString() });
    try {
      const { rows } = await plain.query('SHOW search_path');
      expect(rows[0].search_path).toBe(APP_SEARCH_PATH.join(', '));
      expect((await plain.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(0);
    } finally { await plain.end(); }

    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual([]);
  } finally { await fixture.close(); }
}, 60000);
