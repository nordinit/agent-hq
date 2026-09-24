import { historicalTestFixture } from './historicalTestFixture';
import { POSTGRES_MIGRATION_DIRS } from './migrationDirs';
import { runMigrations } from './migrationRunner';
import { seedTelemetryScenario } from '../../domains/telemetry/testScenario';
import { createDefinition, getDefinition } from '../../domains/telemetry/definitions';

it('adds dashboard documents without changing saved report revisions or metric pins', async () => {
  const fixture = await historicalTestFixture(34), db = fixture.db;
  const access = { tenantId: 1, projectId: 11, actor: 'migration-test' };
  try {
    await seedTelemetryScenario(db);
    const metric = await createDefinition(db, access, 'metric', { key: 'count', name: 'Count', definition: {
      version: 1, key: 'count', name: 'Count', grain: 'task', time_basis: 'current', missing_policy: 'exclude_and_report', measure: { kind: 'aggregate', aggregate: 'count' },
    } });
    const report = await createDefinition(db, access, 'report', { key: 'original', name: 'Original', definition: {
      presentation: 'dashboard', metrics: [{ id: 'count', metric_revision_id: metric.latest_revision_id }],
    } });
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toContain('35-dashboard-pages.sql');
    expect(await getDefinition(db, access, 'report', report.id)).toEqual(report);
    const page = await createDefinition(db, access, 'dashboard', { key: 'page', name: 'Page', definition: {
      version: 1, appearance: { width: 'wide', density: 'comfortable' }, metrics: [{ id: 'count', metric_revision_id: metric.latest_revision_id }],
      sections: [{ id: 'section', title: '', columns: [{ id: 'column', width: 12, blocks: [{ id: 'card', type: 'metric', binding_id: 'count' }] }] }],
    } });
    expect(page.definition.metrics[0].metric_revision_id).toBe(metric.latest_revision_id);
    expect(await runMigrations(db, POSTGRES_MIGRATION_DIRS)).toEqual([]);
  } finally { await fixture.close(); }
}, 60000);
