import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { renderContextBundle, type ContextSegmentDraft } from './prompt/contextBundle';
import {
  clearContextBundleStoreAvailabilityCache,
  listContextBundlesForTask,
  loadContextBundleForInstance,
  loadPreviousContextBundleForTask,
  persistDispatchContextBundle,
  redactContextBundleForRead,
} from './contextBundleStore';
import { getInstanceContextView } from '../../domains/runs/contextView';

async function seed(): Promise<void> {
  const db = getDb();
  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Agent HQ', 'default', 1)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, role, session_key, workspace_path, status, job_title)
    VALUES (7, 1, 'Cinder', 'Backend Engineer', 'agent:cinder:test', '/tmp/cinder', 'idle', 'Backend Engineer')
  `);
  await db.run(`INSERT INTO projects (id, tenant_id, name, description, context_md) VALUES (86, 1, 'Agent HQ', '', '')`);
  await db.run(`
    INSERT INTO sprints (id, tenant_id, project_id, name, goal, sprint_type, status)
    VALUES (42, 1, 86, 'Enhancements', 'Ship the viewer.', 'generic', 'active')
  `);
  await db.run(`
    INSERT INTO tasks (id, tenant_id, title, description, status, priority, project_id, sprint_id, task_type, custom_fields_json)
    VALUES (460, 1, 'Add the context viewer', 'Build it.', 'in_progress', 'high', 86, 42, 'backend', '{}')
  `);
  for (const instanceId of [700, 701]) {
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, session_key, dispatched_at)
      VALUES (?, 1, 7, 460, 'running', ?, '2026-08-09 10:00:00')
    `, instanceId, `run:${instanceId}`);
  }
}

function drafts(overrides: { instructions?: string; notes?: string } = {}): ContextSegmentDraft[] {
  return [
    {
      kind: 'job_instructions',
      label: 'Job Instructions',
      text: overrides.instructions ?? 'Do the backend work.',
      source: { type: 'job', label: 'Backend Engineer', id: 7 },
    },
    {
      kind: 'task',
      label: 'Assigned Task',
      text: '## Assigned Task\nTask #460: Add the context viewer',
      source: { type: 'task', label: 'Task #460', id: 460 },
    },
    {
      kind: 'task_notes',
      label: 'Task Notes',
      text: overrides.notes ?? '',
      source: { type: 'task_notes', label: 'Task #460 notes', id: 460 },
      notInjectedReason: 'This task has no notes yet',
    },
  ];
}

describe('dispatch context bundle store', () => {
  beforeAll(async () => {
    await setupTestDb();
    await seed();
    clearContextBundleStoreAvailabilityCache(getDb());
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it('round-trips a bundle with its segments and fingerprint', async () => {
    const bundle = renderContextBundle(drafts());
    const id = await persistDispatchContextBundle(getDb(), {
      tenantId: 1,
      instanceId: 700,
      durableRunId: 'run-700',
      taskId: 460,
      agentId: 7,
      bundle,
    });
    expect(id).toBeGreaterThan(0);

    const stored = await loadContextBundleForInstance(getDb(), { instanceId: 700, tenantId: 1 });
    expect(stored?.promptText).toBe(bundle.promptText);
    expect(stored?.promptChars).toBe(bundle.promptText.length);
    expect(stored?.segments.map(s => s.kind)).toEqual(['job_instructions', 'task', 'task_notes']);
    expect(stored?.promptFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    // The stored offsets still slice the stored text.
    const jobSegment = stored!.segments[0];
    expect(stored!.promptText.slice(jobSegment.start, jobSegment.end)).toBe('Do the backend work.');
  });

  it('keeps the first write when the same instance is recorded twice', async () => {
    const second = renderContextBundle(drafts({ instructions: 'Changed instructions.' }));
    await persistDispatchContextBundle(getDb(), {
      tenantId: 1, instanceId: 700, taskId: 460, agentId: 7, bundle: second,
    });

    const stored = await loadContextBundleForInstance(getDb(), { instanceId: 700, tenantId: 1 });
    expect(stored?.promptText).toContain('Do the backend work.');
  });

  it('never leaks a bundle across tenants', async () => {
    expect(await loadContextBundleForInstance(getDb(), { instanceId: 700, tenantId: 2 })).toBeNull();
  });

  it('lists captured runs for a task newest first and finds the diff baseline', async () => {
    await persistDispatchContextBundle(getDb(), {
      tenantId: 1,
      instanceId: 701,
      durableRunId: 'run-701',
      taskId: 460,
      agentId: 7,
      bundle: renderContextBundle(drafts({ notes: '## Task Notes\n- [2026-08-09] piper\n  Retry, please.' })),
    });

    const runs = await listContextBundlesForTask(getDb(), { taskId: 460, tenantId: 1 });
    expect(runs.map(r => r.instanceId)).toEqual([701, 700]);
    expect(runs[0].segmentCount).toBe(3);

    const baseline = await loadPreviousContextBundleForTask(getDb(), {
      taskId: 460, beforeInstanceId: 701, tenantId: 1,
    });
    expect(baseline?.instanceId).toBe(700);

    // The oldest run has nothing before it.
    expect(await loadPreviousContextBundleForTask(getDb(), {
      taskId: 460, beforeInstanceId: 700, tenantId: 1,
    })).toBeNull();
  });

  it('diffs the newer run against the previous one', async () => {
    const view = await getInstanceContextView(getDb(), { instanceId: 701, tenantId: 1 });
    expect(view?.captured).toBe(true);
    expect(view?.run.taskTitle).toBe('Add the context viewer');
    expect(view?.diff?.previousInstanceId).toBe(700);

    const notes = view?.diff?.segments.find(s => s.kind === 'task_notes');
    expect(notes?.change).toBe('added');
    expect(notes?.charDelta).toBeGreaterThan(0);

    const instructions = view?.diff?.segments.find(s => s.kind === 'job_instructions');
    expect(instructions?.change).toBe('unchanged');
    expect(view?.diff?.totals.changedSegments).toBe(1);
  });

  it('reports an uncaptured run without failing', async () => {
    const db = getDb();
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, session_key)
      VALUES (702, 1, 7, 460, 'running', 'run:702')
    `);
    const view = await getInstanceContextView(db, { instanceId: 702, tenantId: 1 });
    expect(view?.captured).toBe(false);
    expect(view?.prompt).toBeNull();
    // The run picker still lists its siblings, so the viewer can offer a captured run instead.
    expect(view?.runs.map(r => r.instanceId)).toEqual([701, 700]);
  });

  it('returns null for an instance in another tenant', async () => {
    expect(await getInstanceContextView(getDb(), { instanceId: 700, tenantId: 2 })).toBeNull();
  });
});

describe('read-time redaction', () => {
  it('redacts secrets while keeping every segment an exact slice', () => {
    const bundle = renderContextBundle([
      {
        kind: 'job_instructions',
        label: 'Job Instructions',
        text: 'Use GH_TOKEN=ghp_supersecretvalue when pushing.',
        source: { type: 'job', label: 'Backend Engineer', id: 7 },
      },
      {
        kind: 'callback_contract',
        label: 'Callback Contract',
        text: 'Authorization: Bearer abc.def.ghi\nReport outcomes via MCP.',
        source: { type: 'contract_template', label: 'generic' },
      },
    ]);

    const redacted = redactContextBundleForRead({
      id: 1,
      instanceId: 700,
      durableRunId: null,
      taskId: 460,
      agentId: 7,
      bundleVersion: 1,
      promptText: bundle.promptText,
      segments: bundle.segments,
      promptChars: bundle.totalChars,
      promptFingerprint: 'sha256:test',
      createdAt: null,
      redacted: false,
    });

    expect(redacted.redacted).toBe(true);
    expect(redacted.promptText).not.toContain('ghp_supersecretvalue');
    expect(redacted.promptText).not.toContain('abc.def.ghi');
    expect(redacted.promptChars).toBe(redacted.promptText.length);

    // The invariant that makes the viewer trustworthy: offsets still slice their own segment.
    for (const segment of redacted.segments.filter(s => s.injected)) {
      const slice = redacted.promptText.slice(segment.start, segment.end);
      expect(slice.length).toBe(segment.chars);
      expect(redacted.promptText.indexOf(slice)).toBeGreaterThanOrEqual(0);
    }
    const contract = redacted.segments.find(s => s.kind === 'callback_contract')!;
    expect(redacted.promptText.slice(contract.start, contract.end)).toContain('Report outcomes via MCP.');
  });
});
