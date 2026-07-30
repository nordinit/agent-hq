import fs from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';

/**
 * Structural guard on what "converted to dual-engine" is allowed to mean.
 *
 * The trap this exists to close: running the suite with AGENT_HQ_TEST_PG_URL set and seeing it green
 * is NOT evidence that anything executed against PostgreSQL. A file that still calls initSchema(),
 * or still sets AGENT_HQ_DB_PATH itself, builds SQLite whatever that variable says — and then
 * passes. Two conversion attempts were abandoned after exactly this was spotted, both reporting
 * "postgres: passed" while never having reached PostgreSQL.
 *
 * A runtime assertion cannot catch it, because such a file never routes its database work through
 * setupTestDb() in the first place. So the criterion has to be structural: if a file opts into the
 * dual-engine helper, that helper must be the ONLY thing deciding its engine.
 */
const TEST_ROOT = path.join(__dirname, '..');

/**
 * Strips comments before matching.
 *
 * Without this the guard fires on prose. These conversions are heavily commented precisely
 * BECAUSE of the initSchema seeding difference, so phrases like "on SQLite initSchema() seeds a
 * default tenant" appear all over them — and a naive search reported six clean files as offenders.
 */
function code(src: string): string {
  return src
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

describe('dual-engine test conversion', () => {
  const converted = testFilesUnder(TEST_ROOT)
    .map((file) => ({ file, src: fs.readFileSync(file, 'utf8') }))
    .filter(({ src }) => src.includes('setupTestDb'))
    // This file talks ABOUT the helper rather than using it.
    .filter(({ file }) => path.basename(file) !== 'testDb.test.ts');

  it('has at least one converted file, so this guard cannot pass vacuously', () => {
    expect(converted.length).toBeGreaterThan(0);
  });

  it('lets setupTestDb be the only thing that chooses the engine', () => {
    const offenders = converted
      .filter(({ src }) => {
        const body = code(src);
        // An initSchema() call guarded by usingPostgres() is legitimate: the SQLite branch may
        // still want the seeding, so long as the PostgreSQL branch does something else.
        const unguardedInitSchema = /\binitSchema\s*\(/.test(body) && !/usingPostgres\s*\(/.test(body);
        return unguardedInitSchema || /AGENT_HQ_DB_PATH\s*=/.test(body);
      })
      .map(({ file }) => path.relative(TEST_ROOT, file));

    // Either of those pins the file to SQLite, so a PostgreSQL run of it proves nothing.
    expect(offenders).toEqual([]);
  });

  it('does not let a converted file set DATABASE_URL for itself', () => {
    // setupTestDb owns DATABASE_URL: it points it at the per-worker database and clears it in
    // teardown so the next file in the worker is unaffected. A file setting it by hand would
    // escape that lifecycle and leak an engine choice into unrelated tests.
    const offenders = converted
      .filter(({ src }) => /process\.env\.DATABASE_URL\s*=/.test(code(src)))
      .map(({ file }) => path.relative(TEST_ROOT, file));

    expect(offenders).toEqual([]);
  });
});
