import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import agentsRouter from './agents';
import projectsRouter from './projects';

let tempDir: string;
let dbPath: string;

async function resetDb(): Promise<void> {
  closeDb();
  fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-project-repo-'));
  dbPath = path.join(tempDir, 'agent-hq-test.db');
  process.env.AGENT_HQ_DB_PATH = dbPath;

  const db = getDb();
  await db.exec(`
    CREATE TABLE projects (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      context_md TEXT NOT NULL DEFAULT '',
      repo_path TEXT,
      repo_url TEXT,
      repo_access_mode TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER DEFAULT 1,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      goal TEXT NOT NULL DEFAULT '',
      sprint_type TEXT NOT NULL DEFAULT 'generic',
      status TEXT NOT NULL DEFAULT 'active',
      length_kind TEXT NOT NULL DEFAULT 'time',
      length_value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      tenant_id INTEGER DEFAULT 1,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT '',
      session_key TEXT NOT NULL UNIQUE,
      workspace_path TEXT NOT NULL DEFAULT '',
      repo_path TEXT,
      repo_url TEXT,
      repo_access_mode TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      openclaw_agent_id TEXT,
      model TEXT,
      runtime_type TEXT NOT NULL DEFAULT 'webhook',
      runtime_config TEXT,
      hooks_url TEXT,
      hooks_auth_header TEXT,
      preferred_provider TEXT,
      os_user TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      github_identity_id INTEGER,
      job_title TEXT NOT NULL DEFAULT '',
      schedule TEXT NOT NULL DEFAULT '',
      job_instructions TEXT NOT NULL DEFAULT '',
      skill_names TEXT NOT NULL DEFAULT '[]',
      timeout_seconds INTEGER NOT NULL DEFAULT 900,
      startup_grace_seconds INTEGER,
      heartbeat_stale_seconds INTEGER,
      stall_threshold_min INTEGER NOT NULL DEFAULT 30,
      max_retries INTEGER NOT NULL DEFAULT 3,
      sort_rules TEXT NOT NULL DEFAULT '[]',
      project_id INTEGER,
      sprint_id INTEGER,
      system_role TEXT,
      last_active TEXT,
      job_instructions_updated_at TEXT,
      instructions_version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE provider_config (
      slug TEXT PRIMARY KEY,
      status TEXT NOT NULL
    );

    CREATE TABLE project_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      changes TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.run(`INSERT INTO provider_config (slug, status) VALUES (?, ?)`, 'openai', 'connected');
}

async function startTestServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/agents', agentsRouter);
  app.use('/api/v1/projects', projectsRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopTestServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

describe('agent repo ownership enforcement', () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-project-repo-'));
    dbPath = path.join(tempDir, 'agent-hq-test.db');
    await resetDb();
  });

  it('rejects project-level repo fields on project create', async () => {
    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Agent HQ',
          repo_access_mode: 'worktree',
          repo_path: '/Users/nordini/agent-hq',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.error).toBe('Project-level repository configuration is deprecated. Configure repository access on the workflow instead.');
      expect(body.code).toBe('project_repo_fields_deprecated');
      expect(body.rejected_fields).toEqual(['repo_path', 'repo_access_mode']);

      const count = await getDb().get(`SELECT COUNT(*) AS count FROM projects WHERE name = 'Agent HQ'`) as { count: number };
      expect(count.count).toBe(0);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects project-level repo fields on project update and preserves legacy values', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO projects (id, name, repo_path, repo_url, repo_access_mode)
      VALUES (86, 'Agent HQ', '/Users/nordini/agent-hq', NULL, 'worktree')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/projects/86`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Agent HQ Updated',
          repo_access_mode: 'clone',
          repo_url: 'git@github.com:test/test.git',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.error).toBe('Project-level repository configuration is deprecated. Configure repository access on the workflow instead.');
      expect(body.code).toBe('project_repo_fields_deprecated');
      expect(body.rejected_fields).toEqual(['repo_url', 'repo_access_mode']);

      const project = await db.get(`SELECT name, repo_path, repo_url, repo_access_mode FROM projects WHERE id = 86`) as Record<string, unknown>;
      expect(project).toEqual({
        name: 'Agent HQ',
        repo_path: '/Users/nordini/agent-hq',
        repo_url: null,
        repo_access_mode: 'worktree',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects repo fields on agent create instead of mutating the project', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO projects (id, name, repo_path, repo_url, repo_access_mode)
      VALUES (86, 'Agent HQ', '/Users/nordini/agent-hq', NULL, 'worktree')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Cinder',
          role: 'Backend Engineer',
          session_key: 'agent:cinder:main',
          runtime_type: 'webhook',
          project_id: 86,
          repo_access_mode: 'clone',
          repo_url: 'git@github.com:test/test.git',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.error).toBe('Repository configuration is workflow-owned. Agent create/update flows no longer accept repo_path, repo_url, or repo_access_mode. Update the workflow instead.');
      expect(body.code).toBe('agent_repo_fields_not_supported');
      expect(body.rejected_fields).toEqual(['repo_url', 'repo_access_mode']);

      const project = await db.get(`SELECT repo_path, repo_url, repo_access_mode FROM projects WHERE id = 86`) as {
        repo_path: string | null;
        repo_url: string | null;
        repo_access_mode: string | null;
      };
      expect(project).toEqual({
        repo_path: '/Users/nordini/agent-hq',
        repo_url: null,
        repo_access_mode: 'worktree',
      });

      const created = await db.get(`SELECT COUNT(*) AS count FROM agents WHERE session_key = 'agent:cinder:main'`) as { count: number };
      expect(created.count).toBe(0);
    } finally {
      await stopTestServer(server);
    }
  });

  it('rejects repo fields on agent update and preserves the project repo config', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO projects (id, name, repo_path, repo_url, repo_access_mode)
      VALUES (86, 'Agent HQ', '/Users/nordini/agent-hq', NULL, 'worktree')
    `);
    await db.run(`
      INSERT INTO agents (id, name, role, session_key, runtime_type, project_id)
      VALUES (94, 'Cinder', 'Backend Engineer', 'agent:cinder:main', 'webhook', 86)
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/94`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo_access_mode: 'clone',
          repo_url: 'git@github.com:test/test.git',
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(400);
      expect(body.error).toBe('Repository configuration is workflow-owned. Agent create/update flows no longer accept repo_path, repo_url, or repo_access_mode. Update the workflow instead.');
      expect(body.code).toBe('agent_repo_fields_not_supported');
      expect(body.rejected_fields).toEqual(['repo_url', 'repo_access_mode']);

      const project = await db.get(`SELECT repo_path, repo_url, repo_access_mode FROM projects WHERE id = 86`) as {
        repo_path: string | null;
        repo_url: string | null;
        repo_access_mode: string | null;
      };
      expect(project).toEqual({
        repo_path: '/Users/nordini/agent-hq',
        repo_url: null,
        repo_access_mode: 'worktree',
      });
    } finally {
      await stopTestServer(server);
    }
  });

  it('creates agents as project-scoped even when legacy sprint_id is submitted', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO projects (id, name, repo_path, repo_url, repo_access_mode)
      VALUES (86, 'Agent HQ', '/Users/nordini/agent-hq', NULL, 'worktree')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Project Scoped Agent',
          role: 'Backend Engineer',
          session_key: 'agent:project-scoped:main',
          runtime_type: 'webhook',
          project_id: 86,
          sprint_id: 123,
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(201);
      expect(body.project_id).toBe(86);
      expect(body).not.toHaveProperty('sprint_id');

      const created = await db.get(`SELECT project_id, sprint_id FROM agents WHERE session_key = 'agent:project-scoped:main'`) as {
        project_id: number | null;
        sprint_id: number | null;
      };
      expect(created).toEqual({ project_id: 86, sprint_id: null });
    } finally {
      await stopTestServer(server);
    }
  });

  it('ignores legacy sprint_id on agent update and hides it from responses', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO projects (id, name, repo_path, repo_url, repo_access_mode)
      VALUES (86, 'Agent HQ', '/Users/nordini/agent-hq', NULL, 'worktree')
    `);
    await db.run(`
      INSERT INTO agents (id, name, role, session_key, runtime_type, project_id, sprint_id)
      VALUES (95, 'Legacy Sprint Agent', 'Backend Engineer', 'agent:legacy-sprint:main', 'webhook', 86, 12)
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const response = await fetch(`${baseUrl}/api/v1/agents/95`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Still Project Scoped Agent',
          sprint_id: 999,
        }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.name).toBe('Still Project Scoped Agent');
      expect(body).not.toHaveProperty('sprint_id');

      const stored = await db.get(`SELECT project_id, sprint_id FROM agents WHERE id = 95`) as {
        project_id: number | null;
        sprint_id: number | null;
      };
      expect(stored).toEqual({ project_id: 86, sprint_id: 12 });
    } finally {
      await stopTestServer(server);
    }
  });

  it('keeps project repo config read-only on agent reads while preserving legacy agent fallback metadata', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO projects (id, name, repo_path, repo_url, repo_access_mode)
      VALUES (86, 'Agent HQ', '/Users/nordini/agent-hq', NULL, 'worktree')
    `);
    await db.run(`
      INSERT INTO agents (id, name, role, session_key, runtime_type, project_id, repo_url, repo_access_mode)
      VALUES (94, 'Cinder', 'Backend Engineer', 'agent:cinder:main', 'webhook', 86, 'git@github.com:legacy/fallback.git', 'clone')
    `);

    const { server, baseUrl } = await startTestServer();
    try {
      const initialAgent = await fetch(`${baseUrl}/api/v1/agents/94`).then(async (res) => res.json() as Promise<Record<string, unknown>>);
      expect(initialAgent.repo_path).toBeNull();
      expect(initialAgent.repo_url).toBe('git@github.com:legacy/fallback.git');
      expect(initialAgent.repo_access_mode).toBe('clone');
      expect(initialAgent.repo_config_source).toBe('agent_legacy');
      expect(initialAgent.project_repo_path).toBe('/Users/nordini/agent-hq');
      expect(initialAgent.project_repo_url).toBeNull();
      expect(initialAgent.legacy_repo_url).toBe('git@github.com:legacy/fallback.git');
      expect(initialAgent.legacy_repo_access_mode).toBe('clone');

      const rejectedProjectRepoEdit = await fetch(`${baseUrl}/api/v1/projects/86`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo_access_mode: 'clone',
          repo_url: 'git@github.com:project/canonical.git',
          repo_path: null,
        }),
      });
      expect(rejectedProjectRepoEdit.status).toBe(400);

      const metadataEdit = await fetch(`${baseUrl}/api/v1/projects/86`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Agent HQ Renamed',
        }),
      });
      expect(metadataEdit.status).toBe(200);

      const finalProject = await fetch(`${baseUrl}/api/v1/projects/86`).then(async (res) => res.json() as Promise<Record<string, unknown>>);
      const finalAgent = await fetch(`${baseUrl}/api/v1/agents/94`).then(async (res) => res.json() as Promise<Record<string, unknown>>);
      expect(finalProject.name).toBe('Agent HQ Renamed');
      expect(finalProject.repo_path).toBe('/Users/nordini/agent-hq');
      expect(finalProject.repo_url).toBeNull();
      expect(finalProject.repo_access_mode).toBe('worktree');
      expect(finalAgent.repo_path).toBeNull();
      expect(finalAgent.repo_url).toBe('git@github.com:legacy/fallback.git');
      expect(finalAgent.repo_access_mode).toBe('clone');
      expect(finalAgent.project_repo_path).toBe('/Users/nordini/agent-hq');
      expect(finalAgent.project_repo_url).toBeNull();
      expect(finalAgent.repo_config_source).toBe('agent_legacy');
      expect(finalAgent.legacy_repo_url).toBe('git@github.com:legacy/fallback.git');
    } finally {
      await stopTestServer(server);
    }
  });
});
