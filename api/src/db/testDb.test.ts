import fs from 'fs';
import path from 'path';

const TEST_ROOT = path.join(__dirname, '..');
const SQLITE_EXCEPTION = path.join(TEST_ROOT, 'lib', 'openclawOAuthProfiles.test.ts');
const SQLITE_LINT_FIXTURE = path.join(TEST_ROOT, 'tooling', 'sqlPortabilityLint.test.ts');
const POSTGRES_DDL_FIXTURES = new Set([
  path.join(TEST_ROOT, 'db', 'adapter', 'adapter.postgres.test.ts'),
  path.join(TEST_ROOT, 'db', 'pg', 'migrationVerification.test.ts'),
]);

function withoutCaptureFaultInjection(body: string): string {
  // These tests still use the complete migrated schema. Temporary constraints
  // and trigger outages verify atomic writes/recovery, not a substitute schema.
  return body
    .replace(/\bALTER\s+TABLE\s+(?:telemetry_outbox|telemetry_observations)\s+(?:ADD|DROP)\s+CONSTRAINT\s+(?:capture|projection)_failure_fixture\b/gi, '')
    .replace(/\bALTER\s+TABLE\s+(?:runtime_executions|tasks)\s+(?:DISABLE|ENABLE)\s+TRIGGER\s+telemetry_capture\b/gi, '')
    .replace(/\bALTER\s+TABLE\s+tasks\s+(?:DISABLE|ENABLE)\s+TRIGGER\s+telemetry_task_status_identity\b/gi, '')
    .replace(/\bALTER\s+TABLE\s+sprint_type_task_statuses\s+(?:DISABLE|ENABLE)\s+TRIGGER\s+telemetry_signal_generation\b/gi, '');
}

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

function testFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFilesUnder(full);
    return entry.isFile() && entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

describe('PostgreSQL-only test suite', () => {
  const tests = testFilesUnder(TEST_ROOT)
    .filter((file) => path.basename(file) !== 'testDb.test.ts')
    .map((file) => ({ file, body: code(fs.readFileSync(file, 'utf8')) }));

  it('has no Agent HQ SQLite bootstrap or adapter usage', () => {
    const offenders = tests
      .filter(({ file, body }) => ![SQLITE_EXCEPTION, SQLITE_LINT_FIXTURE].includes(file) && (
        /\binitSchema\s*\(/.test(body)
        || /AGENT_HQ_DB_PATH\s*=/.test(body)
        || /\bSqliteAdapter\b/.test(body)
        || /from\s+['"]better-sqlite3['"]/.test(body)
        || /\bnew\s+Database\s*\(/.test(body)
      ))
      .map(({ file }) => path.relative(TEST_ROOT, file));

    expect(offenders).toEqual([]);
  });

  it('keeps the external OpenClaw SQLite reader covered as the sole exception', () => {
    const externalReader = tests.find(({ file }) => file === SQLITE_EXCEPTION);
    expect(externalReader?.body).toMatch(/from\s+['"]better-sqlite3['"]/);
    expect(externalReader?.body).toMatch(/\bnew\s+Database\s*\(/);
  });

  it('does not replace the migrated schema with hand-built per-suite DDL', () => {
    const offenders = tests
      .filter(({ file, body }) => (
        !POSTGRES_DDL_FIXTURES.has(file)
        && ![SQLITE_EXCEPTION, SQLITE_LINT_FIXTURE].includes(file)
        && /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX)\b/i.test(withoutCaptureFaultInjection(body))
      ))
      .map(({ file }) => path.relative(TEST_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
