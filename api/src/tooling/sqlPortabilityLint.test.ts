import path from 'path';
import { Project } from 'ts-morph';
import { analyzeSqlPortabilitySourceFile } from './sqlPortabilityLint';

const API_ROOT = path.resolve('/virtual/agent-hq/api');

function analyze(relativeFile: string, source: string) {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile(path.join(API_ROOT, relativeFile), source);
  return analyzeSqlPortabilitySourceFile(sourceFile, API_ROOT);
}

describe('SQL portability lint', () => {
  it('detects SQLite translator debt and runtime schema DDL in SQL literals', () => {
    const findings = analyze('src/routes/example.ts', `
      const query = \`
        CREATE TABLE cache (id INTEGER PRIMARY KEY AUTOINCREMENT);
        INSERT OR IGNORE INTO cache VALUES (1);
        SELECT json_extract(payload, ?), datetime('now'), rowid AS mixedCase FROM cache;
      \`;
    `);

    expect(findings.map((finding) => finding.construct)).toEqual(expect.arrayContaining([
      'runtime schema DDL',
      'AUTOINCREMENT',
      'INSERT OR IGNORE',
      'json_extract()',
      'datetime()',
      'rowid',
      'unquoted mixed-case alias',
    ]));
  });

  it('ignores debt words inside SQL values and comments', () => {
    const findings = analyze('src/routes/example.ts', `
      const query = \`
        SELECT 'INSERT OR IGNORE and datetime(''now'')' AS note
        -- PRAGMA is discussed here
        FROM events
      \`;
    `);
    expect(findings).toEqual([]);
  });

  it('accepts native PostgreSQL equivalents', () => {
    const findings = analyze('src/routes/example.ts', `
      const query = \`
        SELECT jsonb_extract_path_text(payload::jsonb, ?),
               round((AVG(duration))::numeric, 1) AS "averageDuration"
        FROM events
        WHERE (?::text IS NULL OR tenant_id = ?)
          AND project_id IS NOT DISTINCT FROM ?
      \`;
    `);
    expect(findings).toEqual([]);
  });

  it('rejects raw SQLite access outside the exact external reader', () => {
    const findings = analyze('src/lib/notOpenclawOAuthProfiles.ts', `
      import Database from 'better-sqlite3';
      const db = new Database('data.db');
      db.prepare('SELECT * FROM sqlite_master').all();
    `);
    expect(findings.map((finding) => finding.construct)).toEqual(expect.arrayContaining([
      'better-sqlite3 import',
      'raw .prepare()',
      'sqlite_master',
    ]));
  });

  it('rejects SQLite imports in the core database layer too', () => {
    const findings = analyze('src/db/client.ts', `
      import Database from 'better-sqlite3';
      const raw = new Database('agent-hq.db');
      raw.prepare('SELECT 1').get();
    `);
    expect(findings.map((finding) => finding.construct)).toEqual(expect.arrayContaining([
      'better-sqlite3 import',
      'raw .prepare()',
    ]));
  });

  it('detects SQLite SQL and runtime DDL in an ordinary production database module', () => {
    const findings = analyze('src/db/runtimeCache.ts', `
      const initialize = "CREATE TABLE runtime_cache (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT OR IGNORE INTO runtime_cache VALUES (1); SELECT datetime('now') FROM runtime_cache;";
    `);

    expect(findings.map((finding) => finding.construct)).toEqual(expect.arrayContaining([
      'runtime schema DDL',
      'AUTOINCREMENT',
      'INSERT OR IGNORE',
      'datetime()',
    ]));
  });

  it('allows migration-ledger DDL but still rejects SQLite syntax in the migration runner', () => {
    const findings = analyze('src/db/pg/migrationRunner.ts', `
      const ledger = 'CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())';
      const invalid = 'INSERT OR IGNORE INTO schema_migrations VALUES (?)';
    `);

    expect(findings.map((finding) => finding.construct)).not.toContain('runtime schema DDL');
    expect(findings.map((finding) => finding.construct)).toContain('INSERT OR IGNORE');
  });

  it('allows PostgreSQL catalog SQL in the adapter and shared introspection modules', () => {
    const adapterFindings = analyze('src/db/adapter/PostgresAdapter.ts', `
      const primaryKey = 'SELECT a.attname AS column_name FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid WHERE i.indrelid = to_regclass($1) AND i.indisprimary';
    `);
    const introspectionFindings = analyze('src/db/introspection.ts', `
      const columns = 'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?';
    `);

    expect(adapterFindings).toEqual([]);
    expect(introspectionFindings).toEqual([]);
  });

  it('rejects CommonJS SQLite imports outside the external reader', () => {
    const findings = analyze('src/lib/legacy.ts', `
      const Database = require('better-sqlite3');
      export default Database;
    `);
    expect(findings.map((finding) => finding.construct)).toContain('better-sqlite3 import');
  });

  it('allows SQLite only within prepare calls in the external OpenClaw reader', () => {
    const findings = analyze('src/lib/openclawOAuthProfiles.ts', `
      import Database from 'better-sqlite3';
      const external = new Database('openclaw.db');
      external.prepare('SELECT name FROM sqlite_master WHERE type = ?').all('table');
      db.run("UPDATE provider_config SET updated_at = datetime('now')");
    `);
    expect(findings).toHaveLength(1);
    expect(findings[0].construct).toBe('datetime()');
  });

  it('flags two-argument round calls whose first argument is not numeric', () => {
    const findings = analyze('src/routes/example.ts', `
      const query = 'SELECT round(AVG(duration), 2) FROM events';
    `);
    expect(findings.map((finding) => finding.construct)).toContain('round(expr, precision) without numeric cast');
  });

  it('accepts PostgreSQL numeric literals and explicit CAST in round calls', () => {
    const findings = analyze('src/routes/example.ts', `
      const query = 'SELECT round(1.25, 1), round(CAST(score AS numeric), 2) FROM events';
    `);
    expect(findings).toEqual([]);
  });

  it('rejects workflow policy seeding from ordinary config mutation paths', () => {
    const findings = analyze('src/domains/routing/transitions.ts', `
      async function createTransition(db: unknown, sprintId: number) {
        await seedSprintTaskPolicy(db, sprintId);
        await seedSprintTypeTaskStatuses(db, 'dev');
      }
    `);
    expect(findings.map((finding) => finding.construct)).toContain('implicit workflow policy seeding');
  });

  it('allows workflow policy seeding at an explicit workflow-creation boundary', () => {
    const findings = analyze('src/lib/starterTemplates.ts', `
      async function insertWorkflow(db: unknown, sprintId: number) {
        await seedSprintTaskPolicy(db, sprintId);
      }
    `);
    expect(findings).toEqual([]);
  });

  it('rejects implicit default-project writes from read or unrelated mutation paths', () => {
    const findings = analyze('src/routes/projects.ts', `
      router.get('/', async () => {
        await setDefaultProjectId(db, 7);
      });
    `);
    expect(findings.map((finding) => finding.construct)).toContain('implicit default-project write');
  });

  it('allows default-project writes only in the explicit setter endpoint', () => {
    const findings = analyze('src/routes/projects.ts', `
      router.put('/:id/default', async () => {
        await setDefaultProjectId(db, 7);
      });
    `);
    expect(findings).toEqual([]);
  });
});
