import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from './client';
import { initSchema } from './schema';

describe('workflow repo backfill migration', () => {
  const originalDbPath = process.env.AGENT_HQ_DB_PATH;
  let tempDir = '';

  beforeEach(() => {
    closeDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-repo-backfill-'));
    process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  });

  afterEach(() => {
    closeDb();
    if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
    else process.env.AGENT_HQ_DB_PATH = originalDbPath;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  });

  async function seedLegacyProjectRepoDatabase(): Promise<void> {
    const db = getDb();
    await db.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        context_md TEXT NOT NULL DEFAULT '',
        repo_path TEXT,
        repo_url TEXT,
        repo_access_mode TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE sprints (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        sprint_type TEXT NOT NULL DEFAULT 'generic',
        status TEXT NOT NULL DEFAULT 'active',
        length_kind TEXT NOT NULL DEFAULT 'time',
        length_value TEXT NOT NULL DEFAULT '',
        repo_path TEXT,
        repo_url TEXT,
        repo_access_mode TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE sprint_types (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        is_system INTEGER NOT NULL DEFAULT 1,
        repo_required INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    await db.run(`
      INSERT INTO sprint_types (key, name, repo_required)
      VALUES ('dev', 'Development', 1), ('ops', 'Operations', 0)
    `);
    await db.run(`
      INSERT INTO projects (id, name, repo_path, repo_access_mode)
      VALUES (1, 'Repo Project', '/repos/project', 'worktree')
    `);
    await db.run(`
      INSERT INTO projects (id, name)
      VALUES (2, 'Manual Project')
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, sprint_type, repo_url, repo_access_mode)
      VALUES (10, 1, 'Explicit Dev', 'dev', 'git@github.com:explicit/repo.git', 'clone')
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, sprint_type)
      VALUES (11, 1, 'Needs Backfill', 'dev')
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, sprint_type)
      VALUES (12, 1, 'Ops Workflow', 'ops')
    `);
    await db.run(`
      INSERT INTO sprints (id, project_id, name, sprint_type)
      VALUES (13, 2, 'Manual Dev', 'dev')
    `);
  }

  it('backfills only repo-required workflows without overwriting explicit workflow config', async () => {
    await seedLegacyProjectRepoDatabase();

    await initSchema();
    await initSchema();

    const db = getDb();
    const rows = await db.all(`
      SELECT id, repo_path, repo_url, repo_access_mode
      FROM sprints
      WHERE id IN (10, 11, 12, 13)
      ORDER BY id ASC
    `) as Array<{ id: number; repo_path: string | null; repo_url: string | null; repo_access_mode: string | null }>;

    expect(rows).toEqual([
      { id: 10, repo_path: null, repo_url: 'git@github.com:explicit/repo.git', repo_access_mode: 'clone' },
      { id: 11, repo_path: '/repos/project', repo_url: null, repo_access_mode: 'worktree' },
      { id: 12, repo_path: null, repo_url: null, repo_access_mode: null },
      { id: 13, repo_path: null, repo_url: null, repo_access_mode: null },
    ]);
  });
});
