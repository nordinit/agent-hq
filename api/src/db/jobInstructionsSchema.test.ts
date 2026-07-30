import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';

let tempDir = '';
let dbPath = '';

function resetDb(): void {
  closeDb();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-instructions-schema-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;
}

describe('initSchema job_instructions canonical migration', () => {
  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      tempDir = '';
      dbPath = '';
    }
  });

  it('renames legacy pre_instructions storage to canonical job_instructions and preserves data', async () => {
    const db = getDb();
    await db.exec(`
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        session_key TEXT NOT NULL UNIQUE,
        workspace_path TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        last_active TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        pre_instructions TEXT NOT NULL DEFAULT '',
        pre_instructions_updated_at TEXT
      );

      INSERT INTO agents (
        id, name, role, session_key, workspace_path, status, pre_instructions, pre_instructions_updated_at
      ) VALUES (
        1, 'Legacy Agent', 'Backend Engineer', 'agent:legacy:main', '/tmp/legacy', 'idle', 'Legacy preserved instructions', '2026-05-05 18:00:00'
      );
    `);

    // expect(fn).toThrow() calls fn SYNCHRONOUSLY. An async fn returns a promise instead of
    // throwing, so not.toThrow() passed trivially while the call ran DETACHED — and then
    // rejected after teardown closed the connection, killing the jest worker. toThrow() on an
    // async fn simply never matched. Both forms must go through the promise.
    await initSchema();

    const columns = await db.all(`PRAGMA table_info(agents)`) as Array<{ name: string }>;
    const names = columns.map((column) => column.name);

    expect(names).toContain('job_instructions');
    expect(names).toContain('job_instructions_updated_at');
    expect(names).not.toContain('pre_instructions');
    expect(names).not.toContain('pre_instructions_updated_at');

    const row = await db.get(`
      SELECT job_instructions, job_instructions_updated_at
      FROM agents
      WHERE id = 1
    `) as {
      job_instructions: string;
      job_instructions_updated_at: string | null;
    };

    expect(row).toEqual({
      job_instructions: 'Legacy preserved instructions',
      job_instructions_updated_at: '2026-05-05 18:00:00',
    });
  });
});
