/**
 * Reproducible telemetry audit. Uses ONLY a disposable, migration-built test database.
 * Run from api/: AGENT_HQ_TEST_PG_URL=postgresql://localhost/postgres npx tsx scripts/audit-telemetry.ts
 * This is an observation harness, not a passing regression suite or a production-data audit.
 */
import express from 'express';
import type { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import path from 'path';
import { runInNewContext } from 'vm';
import ts from 'typescript';
import { setupTestDb, teardownTestDb } from '../src/db/testDb';
import { dropWorkerDatabase } from '../src/db/pg/testFixture';
import { getDb } from '../src/db/client';
import telemetryRouter from '../src/routes/telemetry';
import { listTasks, listTaskHistory } from '../src/domains/tasks/readModel';
import { createTaskRecord } from '../src/domains/tasks/writeModel';
import { resolveTaskFieldSchemaForSprint } from '../src/domains/sprint-definitions/config';
import { normalizeWorkflowRequestAliases } from '../src/lib/workflowCompatibility';

async function main() {
  await setupTestDb();
  const db = getDb();
  const sqlErrors: string[] = [];
  const originalAll = db.all.bind(db);
  db.all = async (...args: Parameters<typeof db.all>) => {
    try { return await originalAll(...args); }
    catch (error) { sqlErrors.push(String(error)); throw error; }
  };
  const observations: Record<string, unknown> = {};
  const app = express();
  app.use(express.json());
  app.use('/api/v1', normalizeWorkflowRequestAliases);
  app.use('/api/v1/telemetry', telemetryRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/telemetry`;
  async function request(route: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + route, {
      method, headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  }
  try {
    await db.exec(`
      INSERT INTO tenants (id, name, slug, is_default) VALUES
        (1, 'Audit One', 'audit-one', 1), (2, 'Audit Two', 'audit-two', 0);
      INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1'), ('active_tenant_id', '2');
      INSERT INTO projects (id, tenant_id, name) VALUES (11, 1, 'Audit Project One'), (22, 2, 'Audit Project Two');
      INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES
        (111, 1, 11, 'Audit Workflow One', 'generic'), (222, 2, 22, 'Audit Workflow Two', 'generic');
      INSERT INTO agents (id, tenant_id, name, job_title, session_key, project_id, runtime_type) VALUES
        (101, 1, 'Audit Agent One', 'One', 'audit:one', 11, 'openclaw'),
        (202, 2, 'Audit Agent Two', 'Two', 'audit:two', 22, 'openclaw');
      INSERT INTO tasks (id, tenant_id, title, status, project_id, sprint_id, agent_id, assigned_agent_id, dispatched_at, routing_reason, custom_fields_json) VALUES
        (1001, 1, 'Audit Task One', 'done', 11, 111, 101, 101, '2026-09-09 08:00:00', 'audit-route-one', '{"amount":10}'),
        (2002, 2, 'Audit Task Two', 'done', 22, 222, 202, 202, '2026-09-09 08:00:00', 'audit-route-two', '{"amount":20}');
      INSERT INTO sessions (tenant_id, external_key, runtime, agent_id, task_id, project_id, status, message_count) VALUES
        (1, 'audit:session:one', 'openclaw', 101, 1001, 11, 'completed', 1),
        (2, 'audit:session:two', 'openclaw', 202, 2002, 22, 'completed', 2);
      INSERT INTO job_instances (tenant_id, task_id, agent_id, status, dispatched_at, failure_stage) VALUES
        (1, 1001, 101, 'failed', '2026-09-09 08:00:00', 'audit-stage-one'),
        (2, 2002, 202, 'failed', '2026-09-09 08:00:00', 'audit-stage-two');
      INSERT INTO task_creation_events (tenant_id, task_id, project_id, sprint_id, job_id, source) VALUES
        (1, 1001, 11, 111, 101, 'manual'), (2, 2002, 22, 222, 202, 'manual');
      INSERT INTO task_outcome_metrics (tenant_id, task_id, project_id, sprint_id, job_id, first_pass_qa, cycle_time_hours) VALUES
        (1, 1001, 11, 111, 101, 0, 10), (2, 2002, 22, 222, 202, 1, 2);
      INSERT INTO integrity_events (tenant_id, task_id, project_id, agent_id, anomaly_type, detail) VALUES
        (1, 1001, 11, 101, 'missing_review_evidence', 'Audit tenant one detail'),
        (2, 2002, 22, 202, 'missing_review_evidence', 'Audit tenant two detail');
      INSERT INTO task_history (tenant_id, task_id, field, old_value, new_value) VALUES
        (2, 2002, 'status', 'review', 'done');
      INSERT INTO task_field_schemas (tenant_id, sprint_type_key, schema_json) VALUES
        (2, 'generic', '{"fields":[{"key":"amount","type":"number","source":"custom_fields"}]}');
    `);
    for (const [taskId, tenantId, projectId, agentId] of [[1001, 1, 11, 101], [2002, 2, 22, 202]]) {
      for (const [i, fromStatus, toStatus] of [[0, null, 'ready'], [1, 'ready', 'in_progress'], [2, 'in_progress', 'review'], [3, 'review', 'in_progress'], [4, 'in_progress', 'review']] as const) {
        await db.run(`INSERT INTO task_events (tenant_id, task_id, project_id, agent_id, from_status, to_status, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`, tenantId, taskId, projectId, agentId, fromStatus, toStatus, `2026-09-08 ${String(10 + i).padStart(2, '0')}:00:00`);
      }
    }
    const allTime = '?from=2020-01-01&to=2030-01-01';
    for (const route of ['/overview', '/review', '/review/2002', '/schema-config', '/recommendations', '/sessions', '/pipeline-health' + allTime,
      '/bottlenecks?project_id=22', '/failures' + allTime, '/integrity', '/routing' + allTime, '/templates' + allTime, '/events']) {
      observations[route] = await request(route);
    }
    observations.swallowed_sql_errors = [...sqlErrors];
    observations.overview_date_filter = await request('/overview' + allTime);
    observations.foreign_task_drilldown = await request('/review/1001');
    observations.foreign_task_metric_write = await request('/outcome-metrics/1001', 'PUT', { first_pass_qa: true });
    observations.foreign_integrity_resolve = await request('/integrity-events/1/resolve', 'PUT', {});
    observations.foreign_integrity_insert = await request('/integrity-events', 'POST', {
      task_id: 1001, anomaly_type: 'missing_qa_evidence', detail: 'Audit foreign write',
    });
    observations.foreign_integrity_insert_persisted = await db.get('SELECT task_id, tenant_id, project_id FROM integrity_events WHERE detail = ?', 'Audit foreign write');
    observations.nonexistent_integrity_insert = await request('/integrity-events', 'POST', {
      task_id: 999999, anomaly_type: 'missing_qa_evidence',
    });
    observations.nonexistent_integrity_rows = await db.value('SELECT COUNT(*) FROM integrity_events WHERE task_id = 999999');
    observations.failures_agent_filter = await request('/failures' + allTime + '&agent_id=202');

    const schemaField = { key: 'revenue', label: 'Revenue', type: 'number', required: true, enabled: true, analytics_enabled: true };
    observations.schema_save = await request('/schema-config', 'PUT', { fields: [schemaField] });
    observations.canonical_fields_after_telemetry_save = (await resolveTaskFieldSchemaForSprint(db, { sprintId: 222 })).schema.fields;
    await db.run("UPDATE app_settings SET value = '1' WHERE key = 'active_tenant_id'");
    observations.schema_read_other_tenant = await request('/schema-config');
    await db.run("UPDATE app_settings SET value = '2' WHERE key = 'active_tenant_id'");
    observations.malformed_schema_save = await request('/schema-config', 'PUT', { fields: [null] });

    observations.duplicate_creation_post = await request('/creation-events', 'POST', { task_id: 2002 });
    const duplicateReview = await request('/review');
    observations.duplicate_review = { status: duplicateReview.status, total: duplicateReview.body.total, ids: duplicateReview.body.tasks?.map((t: any) => t.id) };
    observations.duplicate_creation_overview = await request('/overview');
    observations.duplicate_outcome_post = await request('/outcome-metrics', 'POST', { task_id: 2002 });
    observations.invalid_outcome_values = await request('/outcome-metrics/2002', 'PUT', {
      first_pass_qa: 'false', cycle_time_hours: -10, reopened_count: -3, failure_reasons: 'not JSON',
    });
    observations.invalid_pagination = await request('/review?limit=-1');
    await db.run("UPDATE tasks SET created_at = '2026-09-08 12:00:00' WHERE id = 2002");
    const iso = await request('/review?date_from=2026-09-08T00:00:00Z');
    const sql = await request('/review?date_from=2026-09-08 00:00:00');
    observations.timestamp_formats = { iso_midnight_total: iso.body.total, sql_midnight_total: sql.body.total };

    const beforeClosed = await listTasks(db, { tenant_id: 2 });
    await db.run("UPDATE sprints SET status = 'closed' WHERE id = 222");
    observations.closed_workflow_task_list = {
      before: Array.isArray(beforeClosed) ? beforeClosed.length : beforeClosed,
      after: await listTasks(db, { tenant_id: 2 }),
      explicit_include_closed: (await listTasks(db, { tenant_id: 2, include_closed: 'true' }) as unknown[]).length,
    };
    await db.run("UPDATE sprints SET status = 'planning' WHERE id = 222");
    await db.run('DELETE FROM task_creation_events WHERE task_id = 2002');
    await db.run('UPDATE tasks SET agent_id = NULL, assigned_agent_id = 202 WHERE id = 2002');
    observations.assigned_agent_creation = await request('/creation-events', 'POST', { task_id: 2002 });
    observations.assigned_agent_review_filter = await request('/review?job_id=202');
    observations.history_contract = await listTaskHistory(db, 2002);

    // Exercise the production task-create path without starting dispatch services.
    await db.run(`INSERT INTO sprint_type_task_statuses (tenant_id, sprint_type_key, status_key, label)
      VALUES (2, 'generic', 'audit_pending', 'Audit Pending')`);
    const created = await createTaskRecord(db, { title: 'Audit ordinary creation', status: 'audit_pending', tenant_id: 2, project_id: 22, sprint_id: 222, custom_fields: { amount: 30 } }, 'audit');
    observations.ordinary_task_creation = {
      task_id: created.id,
      stored_custom_fields: created.custom_fields,
      creation_events: await db.value('SELECT COUNT(*) FROM task_creation_events WHERE task_id = ?', created.id),
      outcome_metrics: await db.value('SELECT COUNT(*) FROM task_outcome_metrics WHERE task_id = ?', created.id),
    };

    const uiSource = readFileSync(path.resolve(__dirname, '../../ui/features/telemetry/TelemetryPage.tsx'), 'utf8');
    const uiHelpers = uiSource.slice(uiSource.indexOf('function cycleTime('), uiSource.indexOf('function qaVariant('));
    const helpers = runInNewContext(ts.transpileModule(uiHelpers + '\n({deriveQA, deriveConfidence, cycleTime})', {
      compilerOptions: { target: ts.ScriptTarget.ES2020 },
    }).outputText);
    observations.ui_helpers = {
      failed_task_qa: helpers.deriveQA({ status: 'failed', retry_count: 0 }),
      qa_pass_task_qa: helpers.deriveQA({ status: 'qa_pass', retry_count: 0 }),
      confidence_without_recorded_confidence: helpers.deriveConfidence({ priority: 'medium', agent_name: 'Audit Agent' }),
      done_task_after_retry_qa: helpers.deriveQA({ status: 'done', retry_count: 3 }),
    };
  } finally {
    process.stdout.write(JSON.stringify(observations, null, 2) + '\n');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await teardownTestDb();
    await dropWorkerDatabase();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
