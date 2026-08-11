import express from 'express';
import type { Server } from 'http';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import instancesRouter from './instances';
import tasksRouter from './tasks';
import { renderContextBundle } from '../services/dispatch/prompt/contextBundle';
import {
  clearContextBundleStoreAvailabilityCache,
  persistDispatchContextBundle,
} from '../services/dispatch/contextBundleStore';
import type { InstanceContextView, TaskContextIndex } from '../domains/runs/contextView';

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/instances', instancesRouter);
  app.use('/api/v1/tasks', tasksRouter);
  const server = await new Promise<Server>((resolve, reject) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
    bound.on('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function seed(): Promise<void> {
  const db = getDb();
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Agent HQ', 'default', 1)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.run(`
    INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `);
  await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (90, 1, 'Agent HQ', '', '')`);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status)
    VALUES (50, 1, 90, 'Viewer', 'Ship the viewer.', 'generic', 'active')
  `);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, role, session_key, workspace_path, status, job_title)
    VALUES (9, 1, 'Nova', 'Implementer', 'agent:nova:test', '/tmp/nova', 'idle', 'Implementer')
  `);
  await db.run(`
    INSERT INTO tasks (id, tenant_id, title, description, status, priority, project_id, sprint_id, task_type, custom_fields_json)
    VALUES (900, 1, 'Ship the context viewer', 'Build it.', 'in_progress', 'high', 90, 50, 'backend', '{}')
  `);
  for (const id of [800, 801]) {
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, session_key, dispatched_at)
      VALUES (?, 1, 9, 900, 'running', ?, '2026-08-09 12:00:00')
    `, id, `run:${id}`);
  }

  clearContextBundleStoreAvailabilityCache(db);

  const first = renderContextBundle([
    {
      kind: 'team',
      label: 'Team Context',
      text: '--- Team: Delivery Squad ---\nGoal: Ship it.\n--- End Team ---',
      source: { type: 'team', label: 'Delivery Squad', id: 3, version: 2, href: '/teams?team=3' },
    },
    {
      kind: 'job_instructions',
      label: 'Job Instructions',
      text: 'Implement carefully. Token: ghp_shouldbehidden',
      source: { type: 'job', label: 'Implementer', id: 9, href: '/agents/9' },
    },
    {
      kind: 'task_notes',
      label: 'Task Notes',
      text: '',
      source: { type: 'task_notes', label: 'Task #900 notes', id: 900 },
      notInjectedReason: 'This task has no notes yet',
    },
  ]);
  await persistDispatchContextBundle(db, {
    tenantId: 1, instanceId: 800, durableRunId: 'run-800', taskId: 900, agentId: 9, bundle: first,
  });

  const second = renderContextBundle([
    {
      kind: 'team',
      label: 'Team Context',
      text: '--- Team: Delivery Squad ---\nGoal: Ship it.\n--- End Team ---',
      source: { type: 'team', label: 'Delivery Squad', id: 3, version: 2, href: '/teams?team=3' },
    },
    {
      kind: 'job_instructions',
      label: 'Job Instructions',
      text: 'Implement carefully. Token: ghp_shouldbehidden',
      source: { type: 'job', label: 'Implementer', id: 9, href: '/agents/9' },
    },
    {
      kind: 'task_notes',
      label: 'Task Notes Since Last Run',
      text: '## Task Notes Since Your Last Run\n- [2026-08-09 12:30:00] piper\n  QA failed, retry.',
      source: { type: 'task_notes', label: 'Task #900 notes', id: 900 },
      omission: { reason: 'Capped at 12,000 characters; oldest 3 note(s) dropped', includedCount: 1, totalCount: 4 },
    },
  ]);
  await persistDispatchContextBundle(db, {
    tenantId: 1, instanceId: 801, durableRunId: 'run-801', taskId: 900, agentId: 9, bundle: second,
  });
}

describe('GET /api/v1/instances/:id/context', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await setupTestDb();
    await seed();
    ({ server, baseUrl } = await startServer());
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await teardownTestDb();
  });

  it('returns the prompt with its segment index and provenance', async () => {
    const res = await fetch(`${baseUrl}/api/v1/instances/801/context`);
    expect(res.status).toBe(200);
    const body = await res.json() as InstanceContextView;

    expect(body.captured).toBe(true);
    expect(body.run.agentName).toBe('Nova');
    expect(body.run.taskTitle).toBe('Ship the context viewer');
    expect(body.prompt?.segments.map(s => s.kind)).toEqual(['team', 'job_instructions', 'task_notes']);

    const team = body.prompt!.segments[0];
    expect(team.source).toMatchObject({ type: 'team', label: 'Delivery Squad', id: 3, version: 2 });
    expect(body.prompt!.promptText.slice(team.start, team.end)).toContain('--- Team: Delivery Squad ---');

    const notes = body.prompt!.segments[2];
    expect(notes.omission).toMatchObject({ includedCount: 1, totalCount: 4 });
  });

  it('redacts secrets while keeping every segment an exact slice', async () => {
    const res = await fetch(`${baseUrl}/api/v1/instances/801/context`);
    const body = await res.json() as InstanceContextView;

    expect(body.prompt?.redacted).toBe(true);
    expect(body.prompt?.promptText).not.toContain('ghp_shouldbehidden');
    expect(body.prompt?.promptChars).toBe(body.prompt?.promptText.length);

    for (const segment of body.prompt!.segments.filter(s => s.injected)) {
      const slice = body.prompt!.promptText.slice(segment.start, segment.end);
      expect(slice.length).toBe(segment.chars);
    }
  });

  it('marks the section that was considered and left out of the earlier run', async () => {
    const res = await fetch(`${baseUrl}/api/v1/instances/800/context`);
    const body = await res.json() as InstanceContextView;

    const notes = body.prompt!.segments.find(s => s.kind === 'task_notes')!;
    expect(notes.injected).toBe(false);
    expect(notes.chars).toBe(0);
    expect(notes.omission?.reason).toMatch(/no notes yet/);
  });

  it('diffs against the previous captured run of the same task', async () => {
    const res = await fetch(`${baseUrl}/api/v1/instances/801/context`);
    const body = await res.json() as InstanceContextView;

    expect(body.diff?.previousInstanceId).toBe(800);
    expect(body.diff?.totals.charDelta).toBeGreaterThan(0);
    const notes = body.diff?.segments.find(s => s.kind === 'task_notes');
    expect(notes?.change).toBe('added');
    expect(body.diff?.segments.find(s => s.kind === 'team')?.change).toBe('unchanged');
  });

  it('omits the diff when asked', async () => {
    const res = await fetch(`${baseUrl}/api/v1/instances/801/context?diff=0`);
    const body = await res.json() as InstanceContextView;
    expect(body.diff).toBeNull();
    expect(body.prompt).not.toBeNull();
  });

  it('has no diff for the earliest captured run', async () => {
    const res = await fetch(`${baseUrl}/api/v1/instances/800/context`);
    expect(((await res.json()) as InstanceContextView).diff).toBeNull();
  });

  it('404s for an unknown instance', async () => {
    expect((await fetch(`${baseUrl}/api/v1/instances/99999/context`)).status).toBe(404);
  });

  it('404s rather than 500s for a non-numeric id', async () => {
    expect((await fetch(`${baseUrl}/api/v1/instances/not-a-number/context`)).status).toBe(404);
  });
});

describe('GET /api/v1/tasks/:id/dispatch-context', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    await setupTestDb();
    await seed();
    ({ server, baseUrl } = await startServer());
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    await teardownTestDb();
  });

  it('lists captured runs newest first and names the one to open', async () => {
    const res = await fetch(`${baseUrl}/api/v1/tasks/900/dispatch-context`);
    expect(res.status).toBe(200);
    const body = await res.json() as TaskContextIndex;

    expect(body.taskId).toBe(900);
    expect(body.runs.map(r => r.instanceId)).toEqual([801, 800]);
    expect(body.latestInstanceId).toBe(801);
    expect(body.runs[0].segmentCount).toBe(3);
    expect(body.runs[0].promptFingerprint).toMatch(/^sha256:/);
  });

  it('404s for an unknown task', async () => {
    expect((await fetch(`${baseUrl}/api/v1/tasks/99999/dispatch-context`)).status).toBe(404);
  });
});
