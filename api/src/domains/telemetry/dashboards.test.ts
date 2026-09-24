import { setupTestDb, teardownTestDb } from '../../db/testDb';
import type { Db } from '../../db/adapter/types';
import { seedTelemetryScenario } from './testScenario';
import { createDefinition, getDefinition, reviseDefinition } from './definitions';
import { dashboardSchema } from './dashboards';
import { exportTelemetry, importTelemetry } from './portability';
import { queryTelemetry } from './queries';

let db: Db;
const access = { tenantId: 1, projectId: 11, actor: 'test' };
const page = (revision?: string) => ({ version: 1, scope: { project_id: 11 }, timezone: 'UTC', appearance: { width: 'wide', density: 'comfortable' },
  metrics: revision ? [{ id: 'count', metric_revision_id: revision }] : [],
  sections: [{ id: 'section', title: 'Main', columns: [{ id: 'column', width: 12, blocks: revision ? [{ id: 'card', type: 'metric', binding_id: 'count', display: 'card' }] : [{ id: 'note', type: 'note', text: 'Hello' }] }] }],
});
beforeEach(async () => { db = await setupTestDb(); await seedTelemetryScenario(db); });
afterAll(teardownTestDb);
async function metric(projectId = 11) { return createDefinition(db, { ...access, projectId }, 'metric', { key: 'count', name: 'Tasks', scope: { project_id: projectId }, definition: { version: 1, key: 'count', name: 'Tasks', grain: 'task', time_basis: 'current', missing_policy: 'exclude_and_report', measure: { kind: 'aggregate', aggregate: 'count' }, group_by: [{ field: 'status' }] } }); }

test('dashboard pages save independently, preserve metric pins, and reject stale revisions', async () => {
  const source = await metric();
  const saved = await createDefinition(db, access, 'dashboard', { key: 'page', name: 'Page', scope: { project_id: 11 }, definition: page(source.latest_revision_id) });
  const old = await getDefinition(db, access, 'dashboard', saved.id);
  const revised = await reviseDefinition(db, access, 'dashboard', saved.id, { expected_revision_id: saved.latest_revision_id, definition: { ...saved.definition, description: 'Updated layout' } });
  expect(revised.revision).toBe(2); expect(revised.definition.metrics[0].metric_revision_id).toBe(source.latest_revision_id);
  expect(old.definition.description).toBeUndefined();
  await expect(reviseDefinition(db, access, 'dashboard', saved.id, { expected_revision_id: saved.latest_revision_id, definition: saved.definition })).rejects.toMatchObject({ code: 'revision_conflict' });
  const result = await queryTelemetry(db, access, { metric_revision_id: source.latest_revision_id }); expect(result.value).toBe(6);
  await expect(queryTelemetry(db, access, { report_revision_id: revised.latest_revision_id })).rejects.toMatchObject({ code: 'unknown_reference' });
});
test('pages cannot borrow another project metric or expand their saved scope', async () => {
  const privateMetric = await metric(12);
  await expect(createDefinition(db, access, 'dashboard', { key: 'bad', name: 'Bad', scope: { project_id: 11 }, definition: page(privateMetric.latest_revision_id) })).rejects.toMatchObject({ code: 'not_found' });
  await expect(createDefinition(db, access, 'dashboard', { key: 'bad', name: 'Bad', scope: { project_id: 11 }, definition: { ...page(), scope: { project_id: 12 } } })).rejects.toMatchObject({ code: 'incompatible_scope' });
});
test('empty pages are valid; invalid tree identities, dangling references, links and fabricated charts are rejected', async () => {
  expect(dashboardSchema.safeParse({ ...page(), sections: [] }).success).toBe(true);
  const bad = page(); bad.sections[0].columns[0].id = 'section'; expect(dashboardSchema.safeParse(bad).success).toBe(false);
  expect(dashboardSchema.safeParse(page('missing')).success).toBe(true); // Reference authorization is asynchronous.
  const dangling = page(); (dangling.sections[0].columns[0] as any).blocks = [{ id: 'metric', type: 'metric', binding_id: 'missing' }]; expect(dashboardSchema.safeParse(dangling).success).toBe(false);
  for (const url of ['javascript:alert(1)', '//outside.test', '/\\outside.test']) {
    const badLink = page(); (badLink.sections[0].columns[0] as any).blocks = [{ id: 'link', type: 'link', url }]; expect(dashboardSchema.safeParse(badLink).success).toBe(false);
  }
  const source = await metric(), badChart = page(source.latest_revision_id); (badChart.sections[0].columns[0].blocks[0] as any).display = 'line';
  await expect(createDefinition(db, access, 'dashboard', { key: 'bad', name: 'Bad', definition: badChart })).rejects.toMatchObject({ code: 'invalid_definition' });
});
test('dashboard export and import remap pinned metric dependencies while preserving block links', async () => {
  const source = await metric(), saved = await createDefinition(db, access, 'dashboard', { key: 'page', name: 'Page', definition: page(source.latest_revision_id) });
  const bundle = await exportTelemetry(db, access, { dashboard_ids: [saved.id] });
  expect(bundle.resources.map(row => row.kind).sort()).toEqual(['dashboard', 'metric']);
  const imported = await importTelemetry(db, { ...access, projectId: null }, { bundle, scope: { project_id: 12 } });
  expect(imported.drafts).toBe(0);
  const copied = await getDefinition(db, { ...access, projectId: 12 }, 'dashboard', imported.imported.find(row => row.kind === 'dashboard')!.id);
  expect(copied.definition.metrics[0].metric_revision_id).not.toBe(source.latest_revision_id);
  expect(copied.definition.sections[0].columns[0].blocks[0].binding_id).toBe('count');
  expect(copied.definition.scope.project_id).toBe(12);
});
