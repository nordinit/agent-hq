import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { type Db } from '../../db/adapter/types';
import { BOARD_FAILURE_DETAIL_CHARS, listBoardTasks, parseExpandedBuckets } from './boardReadModel';
import { getTaskById, listTaskHistory, listTaskInstances, listTaskNotes } from './readModel';

const TENANT = 1;
const PROJECT = 86;
const WORKFLOW = 10;
const OTHER_WORKFLOW = 11;

async function setupDb(): Promise<Db> {
  const db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (?, 'Default Tenant', 'default', 1)`, TENANT);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (?, ?, 'Agent HQ')`, PROJECT, TENANT);
  await db.run(`INSERT INTO workflow_types (tenant_id, key, name, repo_required) VALUES (?, 'dev', 'Development', 0)`, TENANT);
  await db.run(`INSERT INTO workflows (id, tenant_id, project_id, name, workflow_type, status) VALUES
    (?, ?, ?, 'Enhancements', 'dev', 'active'), (?, ?, ?, 'Repairs', 'dev', 'active')`,
  WORKFLOW, TENANT, PROJECT, OTHER_WORKFLOW, TENANT, PROJECT);
  await db.run(`
    INSERT INTO workflow_type_relationship_types (tenant_id, workflow_type_key, key, label, inverse_label, category, affects_dispatch_eligibility, direction_semantics, resolved_statuses_json)
    VALUES
      (?, 'dev', 'blocked_by', 'Blocked by', 'Blocks', 'dependency', 1, 'target_blocks_source', '["done"]'),
      (?, 'dev', 'blocks', 'Blocks', 'Blocked by', 'dependency', 1, 'source_blocks_target', '["done"]'),
      (?, 'dev', 'related_to', 'Related to', 'Related to', 'reference', 0, 'target_blocks_source', '[]')
  `, TENANT, TENANT, TENANT);
  await db.run(`INSERT INTO task_statuses (name, label, terminal) VALUES ('done', 'Done', 1), ('cancelled', 'Cancelled', 1), ('closed', 'Closed', 1)`);
  await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, openclaw_agent_id, runtime_type)
    VALUES (501, ?, 'James', 'james', 'james', 'openclaw'), (502, ?, 'Casper', 'casper', 'casper', 'openclaw')`, TENANT, TENANT);
  return db;
}

let clock = 0;
async function insertTask(db: Db, id: number, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  clock += 1;
  const createdAt = `2026-05-20 12:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}`;
  const columns = { workflow_id: WORKFLOW, task_type: 'backend', priority: 'high', ...extra };
  const keys = Object.keys(columns);
  await db.run(`
    INSERT INTO tasks (id, title, description, status, project_id, tenant_id, created_at, updated_at, ${keys.join(', ')})
    VALUES (?, ?, 'A long description the board does not need', ?, ?, ?, ?, ?, ${keys.map(() => '?').join(', ')})
  `, id, `Task ${id}`, status, PROJECT, TENANT, createdAt, createdAt, ...keys.map(key => columns[key as keyof typeof columns]));
}

describe('task board read model', () => {
  beforeEach(() => { clock = 0; });
  afterEach(async () => { await teardownTestDb(); });

  it('returns only the newest tasks of each column, with every column total', async () => {
    const db = await setupDb();
    for (let id = 1; id <= 7; id += 1) await insertTask(db, id, 'closed');
    for (let id = 11; id <= 13; id += 1) await insertTask(db, id, 'ready');
    await insertTask(db, 21, 'closed', { workflow_id: OTHER_WORKFLOW });

    const board = await listBoardTasks(db, { tenant_id: TENANT, project_id: PROJECT, per_status_limit: 3 });

    expect(board.tasks.map(task => task.id)).toEqual([21, 13, 12, 11, 7, 6, 5]);
    expect(board.total).toBe(11);
    expect(board.per_status_limit).toBe(3);
    expect(new Set(board.buckets.map(bucket => JSON.stringify(bucket)))).toEqual(new Set([
      JSON.stringify({ workflow_id: WORKFLOW, status: 'closed', total: 7, loaded: 3 }),
      JSON.stringify({ workflow_id: WORKFLOW, status: 'ready', total: 3, loaded: 3 }),
      JSON.stringify({ workflow_id: OTHER_WORKFLOW, status: 'closed', total: 1, loaded: 1 }),
    ]));
    // Cards do not get the description; the task page loads it.
    expect(board.tasks[0]).not.toHaveProperty('description');
  });

  it('gives an expanded column its own larger limit', async () => {
    const db = await setupDb();
    for (let id = 1; id <= 7; id += 1) await insertTask(db, id, 'closed');
    for (let id = 11; id <= 15; id += 1) await insertTask(db, id, 'ready');

    const board = await listBoardTasks(db, {
      tenant_id: TENANT, project_id: PROJECT, per_status_limit: 2, expand: `${WORKFLOW}:closed:6`,
    });

    expect(board.tasks.filter(task => task.status === 'closed').map(task => task.id)).toEqual([7, 6, 5, 4, 3, 2]);
    expect(board.tasks.filter(task => task.status === 'ready').map(task => task.id)).toEqual([15, 14]);
  });

  it('parses expanded columns, including tasks with no workflow, and ignores malformed entries', () => {
    expect(parseExpandedBuckets('10:closed:60,none:ready:40,bad,10::5,x:ready:5,10:in_progress:0')).toEqual([
      { workflowId: 10, status: 'closed', limit: 60 },
      { workflowId: null, status: 'ready', limit: 40 },
    ]);
  });

  it('searches every task, not only the loaded columns, by title or exact id', async () => {
    const db = await setupDb();
    for (let id = 1; id <= 5; id += 1) await insertTask(db, id, 'closed');
    await db.run(`UPDATE tasks SET title = 'Fix the 100% progress_bar' WHERE id = 1`);

    const byTitle = await listBoardTasks(db, { tenant_id: TENANT, project_id: PROJECT, per_status_limit: 2, q: '100% progress_' });
    expect(byTitle.tasks.map(task => task.id)).toEqual([1]);
    expect(byTitle.total).toBe(1);

    const byId = await listBoardTasks(db, { tenant_id: TENANT, project_id: PROJECT, per_status_limit: 2, q: '#2' });
    expect(byId.tasks.map(task => task.id)).toEqual([2]);
  });

  it('filters by task type, workflow and live run on the server', async () => {
    const db = await setupDb();
    await insertTask(db, 1, 'ready', { task_type: 'frontend' });
    await insertTask(db, 2, 'ready');
    await insertTask(db, 3, 'in_progress', { workflow_id: OTHER_WORKFLOW });
    await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status) VALUES (900, ?, 501, 3, 'running')`, TENANT);
    await db.run(`UPDATE tasks SET active_instance_id = 900, agent_id = 501 WHERE id = 3`);

    const ids = async (query: Record<string, unknown>) =>
      (await listBoardTasks(db, { tenant_id: TENANT, project_id: PROJECT, ...query })).tasks.map(task => task.id);
    expect(await ids({ task_type: 'frontend' })).toEqual([1]);
    expect(await ids({ workflow_id: String(OTHER_WORKFLOW) })).toEqual([3]);
    expect(await ids({ live_instances_only: 'true' })).toEqual([3]);
  });

  it('shortens a long failure detail and says so', async () => {
    const db = await setupDb();
    await insertTask(db, 1, 'ready', { failure_detail: 'x'.repeat(BOARD_FAILURE_DETAIL_CHARS + 50) });
    await insertTask(db, 2, 'ready', { failure_detail: 'short' });

    const board = await listBoardTasks(db, { tenant_id: TENANT, project_id: PROJECT });
    const byId = new Map(board.tasks.map(task => [task.id, task]));
    expect(String(byId.get(1)?.failure_detail)).toHaveLength(BOARD_FAILURE_DETAIL_CHARS);
    expect(byId.get(1)?.failure_detail_truncated).toBe(true);
    expect(byId.get(2)).toMatchObject({ failure_detail: 'short', failure_detail_truncated: false });
  });

  it('agrees with the full task view on every field a card shows', async () => {
    const db = await setupDb();
    await insertTask(db, 530, 'blocked', { assigned_agent_id: 501, story_points: 3, paused_at: '2026-05-20 13:00:00', pause_reason: 'hold' });
    await insertTask(db, 567, 'in_progress', { agent_id: 502 });
    await insertTask(db, 568, 'done');
    await insertTask(db, 569, 'cancelled');
    await insertTask(db, 600, 'ready', { origin_task_id: 530, defect_type: 'regression' });
    await insertTask(db, 601, 'done');
    await insertTask(db, 602, 'ready', { assigned_agent_id: 502 });
    // 530 is blocked by an unfinished task, a done one and a cancelled one, and 567 blocks 601 the other way round.
    await db.run(`INSERT INTO task_relationships (source_task_id, target_task_id, relationship_type_key) VALUES
      (530, 567, 'blocked_by'), (530, 568, 'blocked_by'), (530, 569, 'blocked_by'), (567, 601, 'blocks'), (600, 530, 'related_to')`);
    await db.run(`INSERT INTO task_dependencies (blocker_id, blocked_id) VALUES (568, 600)`);
    await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, task_outcome, completed_at) VALUES
      (900, ?, 502, 567, 'running', NULL, NULL), (901, ?, 501, 530, 'done', 'blocked', '2026-05-20 12:30:00')`, TENANT, TENANT);
    await db.run(`UPDATE tasks SET active_instance_id = 900 WHERE id = 567`);
    // Casper's tools are recovering, so his unstarted task shows it; James's is not affected.
    await db.run(`INSERT INTO agent_mcp_recovery (id, target_key, agent_id, last_error) VALUES (1, 'agent:502', 502, 'probe timed out')`);

    const board = await listBoardTasks(db, { tenant_id: TENANT, project_id: PROJECT });
    const CARD_FIELDS = [
      'id', 'title', 'status', 'priority', 'project_id', 'workflow_id', 'workflow_name', 'task_type', 'story_points',
      'agent_id', 'agent_name', 'assigned_agent_id', 'assigned_agent_name', 'active_agent_name',
      'active_instance_id', 'active_instance_status', 'active_instance_task_outcome', 'latest_task_outcome',
      'recurring', 'recurring_series_id', 'scheduled_for', 'schedule_run_id', 'generated_from',
      'origin_task_id', 'origin_task_title', 'defect_type', 'spawned_defects', 'paused_at', 'pause_reason',
      'is_blocked', 'runtime_recovery',
    ];
    const pick = (task: Record<string, unknown>) => Object.fromEntries(CARD_FIELDS.map(key => [key, task[key] ?? null]));
    const links = (list: unknown, withFlag: boolean) => (list as Array<Record<string, unknown>>)
      .map(link => ({ id: Number(link.id), title: link.title, status: link.status, ...(withFlag ? { blocks_dispatch: link.blocks_dispatch } : {}) }))
      .sort((a, b) => a.id - b.id);

    expect(board.tasks).toHaveLength(7);
    for (const row of board.tasks) {
      const full = await getTaskById(db, Number(row.id)) as Record<string, unknown>;
      expect({ id: row.id, ...pick(row) }).toEqual({ id: row.id, ...pick(full) });
      expect(links(row.blockers, true)).toEqual(links(full.blockers, true));
      expect(links(row.blocking, false)).toEqual(links(full.blocking, false));
    }
    const byId = new Map(board.tasks.map(task => [task.id, task]));
    expect(byId.get(530)).toMatchObject({ is_blocked: true });
    expect(byId.get(602)?.runtime_recovery).toMatchObject({ agent_id: 502 });
  });
});

describe('task log paging', () => {
  afterEach(async () => { await teardownTestDb(); });

  it('pages notes newest first and returns each page oldest first', async () => {
    const db = await setupDb();
    await insertTask(db, 1, 'ready');
    for (let n = 1; n <= 5; n += 1) {
      await db.run(`INSERT INTO task_notes (tenant_id, task_id, author, content) VALUES (?, 1, 'James', ?)`, TENANT, `note ${n}`);
    }

    const first = await listTaskNotes(db, 1, { limit: '2' }) as unknown as { items: Array<{ content: string }>; total: number; has_more: boolean; next_before_id: number };
    expect(first.items.map(note => note.content)).toEqual(['note 4', 'note 5']);
    expect(first).toMatchObject({ total: 5, has_more: true });

    const second = await listTaskNotes(db, 1, { limit: '2', before_id: String(first.next_before_id) }) as unknown as typeof first;
    expect(second.items.map(note => note.content)).toEqual(['note 2', 'note 3']);
    const third = await listTaskNotes(db, 1, { limit: '2', before_id: String(second.next_before_id) }) as unknown as typeof first;
    expect(third.items.map(note => note.content)).toEqual(['note 1']);
    expect(third).toMatchObject({ has_more: false, next_before_id: null });

    // Without limit the response is the original full array, for existing callers.
    expect((await listTaskNotes(db, 1) as unknown[]).length).toBe(5);
  });

  it('pages history, hides run bookkeeping on request, and filters by field', async () => {
    const db = await setupDb();
    await insertTask(db, 1, 'ready');
    const rows: Array<[string, string]> = [
      ['status', 'in_progress'], ['active_instance_id', '900'], ['runtime_failed_instance_id', '900'],
      ['workflow_event_source', 'agent_hq_runtime'], ['runtime_failed_unrouted', 'stays'], ['status', 'ready'],
    ];
    for (const [field, value] of rows) {
      await db.run(`INSERT INTO task_history (tenant_id, task_id, changed_by, field, new_value) VALUES (?, 1, 'agent:501', ?, ?)`, TENANT, field, value);
    }

    const all = await listTaskHistory(db, 1, { limit: '50' }) as unknown as { items: Array<{ field: string }>; total: number };
    expect(all.total).toBe(6);
    const meaningful = await listTaskHistory(db, 1, { limit: '50', exclude_internal: '1' }) as unknown as typeof all;
    expect(meaningful.items.map(entry => entry.field)).toEqual(['status', 'runtime_failed_unrouted', 'status']);
    expect(meaningful.total).toBe(3);
    const lastStatus = await listTaskHistory(db, 1, { limit: '1', field: 'status' }) as unknown as { items: Array<{ new_value: string }> };
    expect(lastStatus.items.map(entry => entry.new_value)).toEqual(['ready']);
    expect((await listTaskHistory(db, 1) as unknown[]).length).toBe(6);
  });

  it('pages runs and leaves the large per-run fields out of the lean listing', async () => {
    const db = await setupDb();
    await insertTask(db, 1, 'ready');
    for (let id = 900; id < 905; id += 1) {
      await db.run(`INSERT INTO job_instances (id, tenant_id, agent_id, task_id, status, payload_sent, response) VALUES (?, ?, 501, 1, 'failed', 'big payload', 'big response')`, id, TENANT);
    }

    const page = await listTaskInstances(db, 1, { limit: '2', lean: '1' }) as unknown as { items: Array<Record<string, unknown>>; total: number; has_more: boolean; next_before_id: number };
    expect(page.items.map(run => run.id)).toEqual([904, 903]);
    expect(page).toMatchObject({ total: 5, has_more: true, next_before_id: 903 });
    expect(page.items[0]).not.toHaveProperty('payload_sent');
    expect(page.items[0]).not.toHaveProperty('response');
    expect(page.items[0]).toMatchObject({ agent_name: 'James', status: 'failed' });

    const full = await listTaskInstances(db, 1, { limit: '2' }) as unknown as typeof page;
    expect(full.items[0]).toMatchObject({ payload_sent: 'big payload' });
    expect((await listTaskInstances(db, 1) as unknown[]).length).toBe(5);
  });
});
