import type { Db } from '../adapter/types';
import { closeTestDb, getTestDb } from './testFixture';
import { APP_SCHEMAS, APP_SEARCH_PATH } from './schemas';

/**
 * Guards the layout from migration 51. A later migration that creates a table, function or view
 * without naming a schema puts it in public, and fails here until it names one of APP_SCHEMAS.
 */
describe('PostgreSQL schema layout', () => {
  let db: Db;
  beforeAll(async () => { db = await getTestDb(); });
  afterAll(async () => { await closeTestDb(); });

  it('resolves unqualified names through public first, then every app schema', async () => {
    expect(await db.value('SELECT current_schema()')).toBe('public');
    expect(await db.value('SELECT current_schemas(false)::text[]')).toEqual(APP_SEARCH_PATH);
  });

  it('keeps only the migration ledger in public', async () => {
    expect(await db.all(`SELECT relname, relkind FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm', 'f', 'S')`))
      .toEqual([{ relname: 'schema_migrations', relkind: 'r' }]);
    expect(await db.value(`SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace`)).toBe(0);
  });

  it('puts every table in an app schema, with no name used twice', async () => {
    const tables = await db.all<{ schemaname: string; tablename: string }>(`SELECT schemaname, tablename FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema') AND tablename <> 'schema_migrations'`);
    expect(tables.length).toBeGreaterThan(90);
    expect(tables.filter((t) => !(APP_SCHEMAS as readonly string[]).includes(t.schemaname))).toEqual([]);
    const names = tables.map((t) => t.tablename);
    expect(names.filter((name, index) => names.indexOf(name) !== index)).toEqual([]);
    for (const schema of APP_SCHEMAS) expect(tables.some((t) => t.schemaname === schema)).toBe(true);
  });

  it('has no function body that names an object in public', async () => {
    expect(await db.all(`SELECT proname FROM pg_proc
      WHERE pronamespace::regnamespace::text = ANY(?::text[]) AND prosrc ~ '\\mpublic\\.'`, [...APP_SCHEMAS])).toEqual([]);
  });
});
