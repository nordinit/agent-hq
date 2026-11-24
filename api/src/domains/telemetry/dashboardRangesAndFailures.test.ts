import { setupTestDb, teardownTestDb } from '../../db/testDb';
import type { Db } from '../../db/adapter/types';
import { seedTelemetryScenario } from './testScenario';
import { createDefinition } from './definitions';
import { DASHBOARD_METRIC_LIMIT, dashboardSchema } from './dashboards';
import { reportSchema } from './views';
import { queryTelemetry } from './queries';
import { RUN_SNAPSHOT_ROW, createdAtWindow } from './data';
import { getTelemetryCatalog } from './catalog';
import { listTasks } from '../tasks/readModel';

let db: Db;
const access = { tenantId: 1, projectId: 11, actor: 'test' };
const bindings = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `m${i}`, metric_revision_id: 'revision' }));
const page = (extra: Record<string, unknown> = {}, blocks: unknown[] = []) => ({ version: 1, scope: { project_id: 11 }, timezone: 'UTC',
  appearance: { width: 'wide', density: 'comfortable' }, metrics: [], sections: [{ id: 'section', title: 'Main', columns: [{ id: 'column', width: 12, blocks }] }], ...extra });
const metric = (key: string, grain: 'task' | 'run', extra: Record<string, unknown> = {}) => createDefinition(db, access, 'metric', { key, name: key, scope: { project_id: 11 },
  definition: { version: 1, key, name: key, grain, time_basis: 'current', missing_policy: 'exclude_and_report', measure: { kind: 'aggregate', aggregate: 'count' }, ...extra } });

beforeEach(async () => { db = await setupTestDb(); await seedTelemetryScenario(db); });
afterAll(teardownTestDb);

test('pages pin up to 30 metrics while reports keep their limit of 10', () => {
  expect(DASHBOARD_METRIC_LIMIT).toBe(30);
  expect(dashboardSchema.safeParse(page({ metrics: bindings(30) })).success).toBe(true);
  expect(dashboardSchema.safeParse(page({ metrics: bindings(31) })).success).toBe(false);
  expect(reportSchema.safeParse({ presentation: 'dashboard', metrics: bindings(30) }).success).toBe(true);
  expect(reportSchema.safeParse({ presentation: 'report', metrics: bindings(11) }).success).toBe(false);
  expect(reportSchema.safeParse({ metrics: bindings(11) }).success).toBe(false);
});

test('a page keeps either a relative range or explicit dates', () => {
  expect(dashboardSchema.safeParse(page({ range: '48h' })).success).toBe(true);
  expect(dashboardSchema.safeParse(page({ range: '12h' })).success).toBe(false);
  expect(dashboardSchema.safeParse(page({ range: '7d', from: '2026-11-01T00:00:00Z' })).success).toBe(false);
});

test('task list blocks need at least one status and stay within bounds', async () => {
  const list = { id: 'list', type: 'task_list', statuses: ['blocked', 'stalled'], task_types: ['proposal'], workflow_id: 111, limit: 10 };
  expect(dashboardSchema.safeParse(page({}, [list])).success).toBe(true);
  expect(dashboardSchema.safeParse(page({}, [{ ...list, statuses: [] }])).success).toBe(false);
  expect(dashboardSchema.safeParse(page({}, [{ ...list, limit: 51 }])).success).toBe(false);
  expect(dashboardSchema.safeParse(page({}, [{ ...list, detail: { kind: 'outcome' } }])).success).toBe(true);
  expect(dashboardSchema.safeParse(page({}, [{ ...list, detail: { kind: 'field', key: 'verdict_summary' } }])).success).toBe(true);
  expect(dashboardSchema.safeParse(page({}, [{ ...list, detail: { kind: 'field' } }])).success).toBe(false);
  expect(dashboardSchema.safeParse(page({}, [{ ...list, detail: { kind: 'description' } }])).success).toBe(false);
  // Unlike operational blocks, a task list may sit on a workflow-scoped page.
  const saved = await createDefinition(db, access, 'dashboard', { key: 'needs', name: 'Needs attention', scope: { project_id: 11 },
    definition: page({ scope: { project_id: 11, workflow_id: 111 } }, [list]) });
  expect(saved.definition.sections[0].columns[0].blocks[0]).toMatchObject({ type: 'task_list', statuses: ['blocked', 'stalled'] });
});

test('a created_at filter limits a current snapshot to the tasks created in the window', async () => {
  await db.run(`UPDATE tasks SET created_at='2026-01-01 00:00:00' WHERE id IN (1001,1002)`);
  const count = await metric('tasks', 'task');
  expect((await queryTelemetry(db, access, { metric_revision_id: count.latest_revision_id })).value).toBe(6);
  const from = new Date(Date.now() - 86_400_000).toISOString(), to = new Date(Date.now() + 60_000).toISOString();
  const recent = await queryTelemetry(db, access, { metric_revision_id: count.latest_revision_id,
    filter: { all: [{ field: 'created_at', op: 'gte', value: from }, { field: 'created_at', op: 'lt', value: to }] } });
  expect(recent.value).toBe(4);
});

test('failed runs carry a failure reason derived from their recorded errors', async () => {
  const reason = (status: string, error: string | null, runtimeEndError: string | null, handoff: string | null = null, source: string | null = null) =>
    db.value(`SELECT runs.run_failure_reason(?, ?, ?, ?, ?)`, status, error, runtimeEndError, handoff, source);
  expect(await reason('done', null, 'Provider limit reached')).toBeNull();
  expect(await reason('failed', '', 'Provider limit reached: type=five_hour status=rejected overage=rejected reason=out_of_credits', null, 'claude-code')).toBe('provider_limit');
  expect(await reason('failed', "ENOSPC: no space left on device, open '/var/folders/x'", '')).toBe('host_error');
  expect(await reason('failed', 'could not open file "base/1/2": Interrupted system call', '')).toBe('host_error');
  expect(await reason('failed', 'Claude Code runtime refused to start without durable execution state: could not open file "global/1"', '')).toBe('host_error');
  expect(await reason('failed', 'Executable assignment overrides must be published as a new revision.', '')).toBe('not_authorized');
  expect(await reason('failed', 'Runtime credential preparation failed for anthropic: Version probe exceeded 5000ms.', '')).toBe('setup_failed');
  expect(await reason('failed', 'Agent HQ MCP server(s) failed preflight and the agent would have been unable to reach Agent HQ', '')).toBe('setup_failed');
  expect(await reason('failed', 'Watchdog: startup timeout: no Agent HQ call/start within 5m', 'Watchdog: startup timeout: no Agent HQ call/start within 5m', null, 'watchdog')).toBe('timeout');
  expect(await reason('failed', '', 'Claude Code runtime ended without required lifecycle outcome', 'missing', 'claude-code')).toBe('no_outcome');
  expect(await reason('failed', '', 'Run stopped successfully.', null, 'manual_stop')).toBe('stopped');
  expect(await reason('stopped', null, null)).toBe('stopped');
  expect(await reason('failed', '', 'error', null, 'instance_complete')).toBe('runtime_error');

  await db.run(`INSERT INTO job_instances(id,tenant_id,task_id,agent_id,status,runtime_end_error) VALUES
    (601,1,1001,101,'failed','Provider limit reached: type=five_hour'),(602,1,1002,101,'failed','Provider limit reached: type=five_hour'),
    (603,1,1004,101,'failed','Claude Code runtime ended without required lifecycle outcome'),(604,1,1005,101,'done',NULL)`);
  const failures = await metric('run_failures', 'run', { population: { field: 'status', op: 'eq', value: 'failed' }, group_by: [{ field: 'failure_reason' }] });
  const result = await queryTelemetry(db, access, { metric_revision_id: failures.latest_revision_id });
  const groups = Object.fromEntries(result.groups.map((group: { key: unknown[]; value: unknown }) => [String(group.key[0]), group.value]));
  // Run 501 from the shared scenario failed with no recorded error text.
  expect(groups).toEqual({ provider_limit: 2, no_outcome: 1, runtime_error: 1 });
});

test('task lists filter by one or more task types', async () => {
  const page = await listTasks(db, { tenant_id: 1, project_id: 11, task_type: 'article', status: 'approved,rejected', limit: 10 }) as { tasks: { id: number }[]; total: number };
  expect(page.tasks.map(task => task.id).sort()).toEqual([1001, 1002, 1003, 1004]);
  const none = await listTasks(db, { tenant_id: 1, project_id: 11, task_type: 'lead,proposal', limit: 10 }) as { total: number };
  expect(none.total).toBe(0);
});

test('a breakdown sent with the query matches outcome signals like the saved one', async () => {
  // Saved metrics usually select an outcome by its catalog signal ID, which only compilation resolves.
  const signal = (await getTelemetryCatalog(db, access, { project_id: 11 })).outcomes.find(item => item.key === 'changes_requested')!.id;
  const changed = { left: { event_exists: { field: 'event.outcome', op: 'eq', value: signal } }, op: 'eq', right: { literal: true } };
  const group_by = [{ if: changed, then: { literal: 'Changed' }, else: { literal: 'Clean' } }];
  const labelled = await metric('labelled', 'task', { group_by });
  const groups = (result: any) => Object.fromEntries(result.groups.map((group: { key: unknown[]; value: unknown }) => [String(group.key[0]), group.value]));
  const saved = await queryTelemetry(db, access, { metric_revision_id: labelled.latest_revision_id });
  expect(groups(saved)).toEqual({ Changed: 1, Clean: 5 });
  // The dashboard UI always sends the metric's breakdown back with the query.
  const requested = await queryTelemetry(db, access, { metric_revision_id: labelled.latest_revision_id, group_by });
  expect(groups(requested)).toEqual({ Changed: 1, Clean: 5 });
});

test('a creation window narrows run reads without changing which runs count', async () => {
  expect(createdAtWindow({ all: [{ field: 'status', op: 'eq', value: 'failed' }, { all: [{ field: 'created_at', op: 'gte', value: '2026-11-22T00:00:00Z' }, { field: 'created_at', op: 'lt', value: '2026-11-24T00:00:00Z' }] }] }))
    .toEqual({ from: Date.parse('2026-11-22T00:00:00Z'), to: Date.parse('2026-11-24T00:00:00Z') });
  // Bounds under `any` or `not` do not limit every entity, so they never narrow the read.
  expect(createdAtWindow({ any: [{ field: 'created_at', op: 'gte', value: '2026-11-22T00:00:00Z' }] })).toEqual({});
  expect(createdAtWindow({ field: 'created_at', basis: 'at_event', op: 'gte', value: '2026-11-22T00:00:00Z' } as any)).toEqual({});
  const now = Date.now(), iso = (offset: number) => new Date(now + offset).toISOString();
  const text = (offset: number) => iso(offset).replace('T', ' ').slice(0, 19);
  await db.run(`INSERT INTO job_instances(id,tenant_id,task_id,agent_id,status,created_at) VALUES
    (701,1,1001,101,'done',?),(702,1,1002,101,'done',?),(703,1,1003,101,'done',?),(704,1,1004,101,'done',?)`,
    text(-30 * 86_400_000), text(-3_600_000), iso(-7_200_000), text(-49 * 3_600_000));
  const runs = await metric('runs', 'run');
  const recent = await queryTelemetry(db, access, { metric_revision_id: runs.latest_revision_id,
    filter: { all: [{ field: 'created_at', op: 'gte', value: iso(-48 * 3_600_000) }, { field: 'created_at', op: 'lt', value: iso(60_000) }] } });
  // 702 (stored as text), 703 (stored as ISO) and the scenario's run 501 (created now) are inside the window; 701 and 704 are not.
  expect(recent.value).toBe(3);
});

test('run reads build the same snapshot from the slim row as from the whole run row', async () => {
  await db.run(`INSERT INTO job_instances(id,tenant_id,task_id,agent_id,status,error,runtime_end_error,payload_sent,response,token_input,token_output,lifecycle_handoff_status)
    VALUES (801,1,1001,101,'failed','e','Provider limit reached','prompt text','transcript text',10,5,'missing'),(802,1,1002,101,'done',NULL,NULL,NULL,NULL,NULL,NULL,NULL)`);
  const rows = await db.all<{ id: number; slim: unknown; whole: unknown }>(`SELECT j.id, telemetry_run_snapshot(${RUN_SNAPSHOT_ROW}) AS slim,
    telemetry_run_snapshot(to_jsonb(j)) AS whole FROM job_instances j WHERE j.tenant_id = 1 ORDER BY j.id`);
  expect(rows.length).toBeGreaterThanOrEqual(3);
  for (const row of rows) expect(row.slim).toEqual(row.whole);
});
