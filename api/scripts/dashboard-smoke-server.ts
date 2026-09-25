/** Disposable dashboard preview. All records are synthetic; never uses a saved database. */
import express from 'express';
import cors from 'cors';
import { setupTestDb, teardownTestDb } from '../src/db/testDb';
import { dropWorkerDatabase } from '../src/db/pg/testFixture';
import { seedTelemetryScenario } from '../src/domains/telemetry/testScenario';
import { getTelemetryCatalog } from '../src/domains/telemetry/catalog';
import { createDefinition } from '../src/domains/telemetry/definitions';
import { startTelemetryCaptureWorker } from '../src/domains/telemetry/capture';
import { startTelemetryQueryWorker } from '../src/domains/telemetry/queries';
import telemetryRouter from '../src/routes/telemetry-v2';
import type { AggregateMeasure, MetricDefinition } from '../src/domains/telemetry/contracts';

async function main() {
  const db = await setupTestDb();
  await seedTelemetryScenario(db);
  const access = { tenantId: 1, projectId: 11, actor: 'dashboard-preview' };
  const scope = { project_id: 11, workflow_id: 111, workflow_type: 'content', task_type: 'article' };
  await db.run('UPDATE projects SET name=? WHERE id=11', 'Agency · synthetic preview');
  const fields = ['retrieved', 'reviewed', 'qualified', 'drafts', 'rejected', 'score_sum', 'refused'];
  await db.run('UPDATE task_field_schemas SET schema_json=? WHERE id=701', JSON.stringify({ fields: [
    ...fields.map(key => ({ key, label: key.replace('_', ' '), type: 'number' })),
    { key: 'source_platform', label: 'Platform', type: 'text' },
  ] }));
  const titles = ['workflow automation', 'CRM integration', 'AI customer support', 'data enrichment', 'email outreach', 'reporting dashboard', 'Zapier automation', 'Notion workspace', 'operations assistant'];
  const retrieved = [20, 20, 20, 20, 20, 20, 10, 10, 0];
  const reviewed = [15, 15, 15, 15, 10, 10, 5, 5, 0], qualified = [5, 4, 4, 3, 2, 2, 1, 1, 0];
  const drafts = [2, 1, 1, 1, 0, 0, 0, 0, 0], scores = [90, 80, 75, 65, 45, 40, 20, 16.1, 0];
  for (let i = 0; i < titles.length; i++) {
    const values = JSON.stringify({ retrieved: retrieved[i], reviewed: reviewed[i], qualified: qualified[i], drafts: drafts[i],
      rejected: reviewed[i] - qualified[i], score_sum: scores[i], refused: qualified[i] - drafts[i], source_platform: i % 2 ? 'Freelancer' : 'Upwork' });
    if (i < 6) await db.run('UPDATE tasks SET title=?,custom_fields_json=?,status=? WHERE id=?', titles[i], values, 'approved', 1001 + i);
    else await db.run('INSERT INTO tasks(id,tenant_id,title,status,project_id,workflow_id,task_type,assigned_agent_id,custom_fields_json) VALUES(?,1,?,?,11,111,?,101,?)', 1001 + i, titles[i], 'approved', 'article', values);
  }
  const catalog = await getTelemetryCatalog(db, access, scope);
  const field = (key: string) => catalog.fields.find(item => item.key === key)!.id;
  const sum = (key: string): AggregateMeasure => ({ kind: 'aggregate', aggregate: 'sum', value: { field: field(key) } });
  const count: AggregateMeasure = { kind: 'aggregate', aggregate: 'count' };
  const definitions: Array<[string, string, string, MetricDefinition['measure']]> = [
    ['searches', 'Verified searches by query', 'searches', count],
    ['raw_hits', 'Retrieved result entries', 'entries', sum('retrieved')],
    ['reviewed', 'Fresh candidates reviewed', 'candidates', sum('reviewed')],
    ['qualification_rate', 'Qualification rate — duplicates excluded', 'percent', { kind: 'ratio', numerator: sum('qualified'), denominator: sum('reviewed') }],
    ['qualified_per_search', 'Qualified candidates per verified search', 'number', { kind: 'ratio', numerator: sum('qualified'), denominator: count }],
    ['drafts_per_search', 'Drafts per verified search', 'number', { kind: 'ratio', numerator: sum('drafts'), denominator: count }],
    ['rejection_rate', 'Screening rejection rate', 'percent', { kind: 'ratio', numerator: sum('rejected'), denominator: sum('reviewed') }],
    ['average_score', 'Weighted candidate score / 10', 'number', { kind: 'ratio', numerator: sum('score_sum'), denominator: sum('reviewed') }],
    ['commercial_refusal', 'Commercial/pricing refusals among qualified', 'percent', { kind: 'ratio', numerator: sum('refused'), denominator: sum('qualified') }],
  ];
  const metrics = [];
  for (const [key, name, unit, measure] of definitions) {
    const metric = await createDefinition(db, access, 'metric', { key, name, scope, definition: {
      version: 1, key, name, unit, grain: 'task', time_basis: 'current', missing_policy: 'exclude_and_report',
      description: 'Synthetic dashboard preview data for layout and evidence testing.', measure,
      group_by: [{ field: 'title' }, { field: field('source_platform') }],
    } });
    metrics.push({ id: key, title: name, metric_id: metric.id, metric_revision_id: metric.latest_revision_id, display: 'table', view: { bucket: null } });
  }
  // The Agency page layout: six summary cards, a query comparison beside three outcome rates, and a collapsed note.
  const cardTitles: Record<string, string> = { searches: 'Verified searches', raw_hits: 'Retrieved entries', reviewed: 'Fresh candidates reviewed', qualification_rate: 'Qualification rate', qualified_per_search: 'Qualified per search', drafts_per_search: 'Drafts per search', rejection_rate: 'Screening rejection', average_score: 'Weighted score / 10', commercial_refusal: 'Commercial refusals' };
  const accents = ['blue', 'cyan', 'violet', 'green', 'amber', 'blue'], icons = ['search', 'layers', 'users', 'check', 'target', 'file'];
  const card = (key: string, i: number) => ({ id: `${key}_card`, type: 'metric', binding_id: key, title: cardTitles[key], display: 'card',
    precision: ['qualification_rate', 'rejection_rate', 'commercial_refusal'].includes(key) ? 1 : 2, accent: accents[i % accents.length], icon: icons[i % icons.length] });
  const summary = metrics.slice(0, 6).map((metric, i) => card(metric.id, i));
  const dashboard = await createDefinition(db, access, 'dashboard', { key: 'agency_preview', name: 'Agency overview', scope,
    description: 'Synthetic preview: sample records only.', definition: {
      version: 1, template: 'agency', description: 'Search activity, candidate quality, and outreach outcomes.', scope, timezone: 'UTC',
      appearance: { width: 'wide', density: 'comfortable' }, metrics, sections: [
        { id: 'summary', title: '', columns: [0, 1, 2].map(column => ({ id: `summary_${column}`, width: 4, blocks: summary.filter((_, i) => i % 3 === column) })) },
        { id: 'performance', title: 'Query performance & outcomes', columns: [
          { id: 'performance_table', width: 8, blocks: [{ id: 'query_performance', type: 'comparison', title: 'Query performance', binding_ids: ['qualified_per_search', 'drafts_per_search', 'qualification_rate'], rows: 9, sort: 'value_desc', sort_by: 'qualified_per_search' }] },
          { id: 'performance_rates', width: 4, blocks: metrics.slice(6).map((metric, i) => ({ ...card(metric.id, i + 6), surface: 'plain', accent: 'neutral' })) },
        ] },
        { id: 'about', title: 'About these metrics', collapsed: true, columns: [{ id: 'about_notes', width: 12, blocks: [{ id: 'about_note', type: 'note', text: 'Synthetic preview: sample records only.', surface: 'plain' }] }] },
      ],
    } });
  const app = express(); app.use(cors()); app.use(express.json({ limit: '10mb' }));
  app.use('/api/v1/telemetry/v2', telemetryRouter);
  app.get('/api/v1/projects', async (_req, res) => res.json(await db.all('SELECT id,name,tenant_id FROM projects WHERE tenant_id=1')));
  app.get('/api/v1/tenants', async (_req, res) => res.json(await db.all('SELECT * FROM tenants WHERE id=1')));
  app.get('/api/v1/setup/status', (_req, res) => res.json({ onboarding_completed: true, hasProjects: true, onboarding_provider_gate_passed: true }));
  app.get('/api/v1/stats', (_req, res) => res.json({ totalAgents: 2, activeJobs: 0, enabledTemplates: 0, recentRuns: 0, doneRecent: 0, failedRecent: 0, tokensLast24h: 0, recentFailed: [] }));
  app.get('/api/v1/tasks/completed-recent', (_req, res) => res.json({ tasks: [], total: 0 }));
  app.get('/api/v1/agents', (_req, res) => res.json([]));
  app.get('/api/v1/notifications', (_req, res) => res.json([]));
  const stopCapture = startTelemetryCaptureWorker(db), stopQueries = startTelemetryQueryWorker(db);
  const server = app.listen(56183, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  console.log(JSON.stringify({ api_url: 'http://127.0.0.1:56183', preview_url: `http://127.0.0.1:3560/?dashboard=${dashboard.id}`, database: 'disposable synthetic fixture' }));
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true; stopCapture(); stopQueries();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await teardownTestDb(); await dropWorkerDatabase(); process.exit(0);
  };
  process.on('SIGTERM', () => void close()); process.on('SIGINT', () => void close());
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
