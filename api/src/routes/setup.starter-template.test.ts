import express from 'express';
import type { Server } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../db/client';
import { initSchema } from '../db/schema';
import { saveRuntimeConnectionConfig } from '../lib/runtimeOnboarding';
import setupRouter from './setup';
import sprintsRouter from './sprints';

const originalDbPath = process.env.AGENT_HQ_DB_PATH;
let tempDir = '';

async function resetDb(): Promise<void> {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-setup-template-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  await initSchema();
}

function cleanup(): void {
  closeDb();
  if (originalDbPath == null) delete process.env.AGENT_HQ_DB_PATH;
  else process.env.AGENT_HQ_DB_PATH = originalDbPath;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
}

async function startServer(): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/setup', setupRouter);
  app.use('/api/v1/sprints', sprintsRouter);
  const server = await new Promise<Server>((resolve) => {
    const bound = app.listen(0, '127.0.0.1', () => resolve(bound));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function seedCompatibility(): Promise<void> {
  const db = getDb();
  await db.run(`
    INSERT INTO provider_config (tenant_id, slug, display_name, status, config)
    VALUES (1, 'openai', 'OpenAI', 'connected', '{}')
  `);
  await saveRuntimeConnectionConfig(db, {
        kind: 'openclaw',
        endpoint: 'ws://127.0.0.1:17601',
        authToken: 'test',
      });
}

describe('starter template setup API', () => {
  beforeEach(resetDb);
  afterEach(cleanup);

  it('lists only MVP starter templates', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const res = await fetch(`${baseUrl}/api/v1/setup/templates`);
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, any>;
      expect(body.templates.map((template: any) => template.key)).toEqual(['development', 'ops', 'lead-generation', 'blank']);
    } finally {
      await stopServer(server);
    }
  });

  it('previews development routes from ownership answers and applies consistent records', async () => {
    await seedCompatibility();
    const { server, baseUrl } = await startServer();
    try {
      const payload = {
        template_key: 'development',
        project_name: 'Acme App',
        workflow_name: 'Delivery',
        owners: {
          implementation: 'Cinder Dev',
          review: 'QA Desk',
          release: 'Release Desk',
          pm: 'Atlas PM',
        },
        routing_plan: [
          { task_type: 'frontend', status: 'ready', owner_role: 'implementation', owner_name: 'Cinder Dev', enabled: false },
          { task_type: 'docs', status: 'ready', owner_role: 'pm', owner_name: 'Atlas PM', enabled: true },
        ],
      };

      const previewRes = await fetch(`${baseUrl}/api/v1/setup/starter-plan/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as Record<string, any>;
      expect(preview.plan.compatibility.ok).toBe(true);
      expect(preview.plan.workflows[0].statuses).not.toContain('qa_pass');
      expect(preview.plan.workflows[0].statuses).toEqual(expect.arrayContaining(['review', 'ready_to_merge']));
      expect(preview.plan.workflows[0].verification.evidence_gates.join('\n')).toMatch(/review_branch/);
      expect(preview.plan.workflows[0].verification.evidence_gates.join('\n')).toMatch(/qa_pass/);
      expect(preview.plan.routes).toEqual(expect.arrayContaining([
        expect.objectContaining({ key: 'development:backend:ready', owner_name: 'Cinder Dev' }),
        expect.objectContaining({ key: 'development:frontend:ready', enabled: false }),
        expect.objectContaining({ key: 'development:docs:ready', owner_role: 'pm' }),
      ]));

      const applyRes = await fetch(`${baseUrl}/api/v1/setup/starter-plan/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(applyRes.status).toBe(201);
      const applied = await applyRes.json() as Record<string, any>;
      expect(applied.project_id).toBeGreaterThan(0);
      expect(applied.workflow_id).toBeGreaterThan(0);
      expect(applied.agent_ids.implementation).toBeGreaterThan(0);
      expect(applied.agent_ids.review).toBeGreaterThan(0);
      expect(applied.agent_ids.release).toBeGreaterThan(0);
      expect(applied.agent_ids.pm).toBeGreaterThan(0);

      const db = getDb();
      const workflowStatuses = await db.all(`
        SELECT status_key
        FROM sprint_task_statuses
        WHERE sprint_id = ?
        ORDER BY stage_order ASC
      `, applied.workflow_id) as Array<{ status_key: string }>;
      expect(workflowStatuses.map(row => row.status_key)).not.toContain('qa_pass');
      expect(workflowStatuses.map(row => row.status_key)).toEqual(expect.arrayContaining(['review', 'ready_to_merge']));
      expect(await db.get(`
        SELECT to_status
        FROM sprint_task_transitions
        WHERE sprint_id = ? AND from_status = 'review' AND outcome = 'qa_pass'
      `, applied.workflow_id)).toEqual({ to_status: 'ready_to_merge' });
      expect(await db.get(`
        SELECT outcome_key
        FROM sprint_type_outcomes
        WHERE sprint_type_key = 'dev' AND outcome_key = 'qa_pass'
      `)).toEqual({ outcome_key: 'qa_pass' });
      const agentCount = (await db.get(`SELECT COUNT(*) AS n FROM agents WHERE project_id = ?`, applied.project_id) as { n: number }).n;
      expect(agentCount).toBe(4);
      const disabledRoute = await db.get(`
        SELECT enabled
        FROM sprint_task_routing_rules
        WHERE sprint_id = ? AND task_type = 'frontend' AND status = 'ready'
      `, applied.workflow_id) as { enabled: number } | undefined;
      expect(disabledRoute?.enabled).toBe(0);
      const docsRoute = await db.get(`
        SELECT rr.agent_id, a.name
        FROM sprint_task_routing_rules rr
        JOIN agents a ON a.id = rr.agent_id
        WHERE rr.sprint_id = ? AND rr.task_type = 'docs' AND rr.status = 'ready'
      `, applied.workflow_id) as { name: string } | undefined;
      expect(docsRoute?.name).toBe('Atlas PM');
    } finally {
      await stopServer(server);
    }
  });

  it('blocks apply before creating starter agents when runtime or provider compatibility is missing', async () => {
    const { server, baseUrl } = await startServer();
    try {
      const applyRes = await fetch(`${baseUrl}/api/v1/setup/starter-plan/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template_key: 'development', project_name: 'Blocked' }),
      });
      expect(applyRes.status).toBe(422);
      const body = await applyRes.json() as Record<string, any>;
      expect(body.code).toBe('starter_template_incompatible');
      expect(body.compatibility.errors.join('\n')).toMatch(/connected provider/);

      const db = getDb();
      const project = await db.get(`SELECT id FROM projects WHERE name = 'Blocked'`);
      expect(project).toBeUndefined();
    } finally {
      await stopServer(server);
    }
  });

  it('previews and applies selected development, ops, and lead generation workflows together', async () => {
    await seedCompatibility();
    const { server, baseUrl } = await startServer();
    try {
      const payload = {
        template_keys: ['development', 'ops', 'lead-generation'],
        project_name: 'Growth Ops',
        owners: {
          implementation: 'Dev Owner',
          review: 'Risk Review',
          release: 'Release Owner',
          pm: 'Ops PM',
          ops: 'Ops Owner',
          research: 'Research Owner',
          outreach: 'Outreach Owner',
          approval: 'Approval Owner',
        },
      };
      const previewRes = await fetch(`${baseUrl}/api/v1/setup/starter-plan/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(previewRes.status).toBe(200);
      const preview = await previewRes.json() as Record<string, any>;
      expect(preview.plan.workflows.map((workflow: any) => workflow.template.key)).toEqual(['development', 'ops', 'lead-generation']);
      expect(preview.plan.workflows.find((workflow: any) => workflow.template.key === 'ops').fields.map((field: any) => field.key)).toEqual(expect.arrayContaining([
        'affected_system_client',
        'compliance_risk_impact',
        'cost_impact',
        'schedule_impact',
        'stakeholder_impact',
        'approval_owner',
        'supporting_docs',
      ]));
      expect(preview.plan.workflows.find((workflow: any) => workflow.template.key === 'ops').statuses).toEqual(expect.arrayContaining([
        'triage',
        'risk_review',
        'impact_review',
        'action_plan',
        'stakeholder_update',
        'human_approval',
      ]));
      expect(preview.plan.workflows.find((workflow: any) => workflow.template.key === 'lead-generation').statuses).toEqual(expect.arrayContaining([
        'qualification',
        'research',
        'outreach_draft',
        'human_approval',
        'sent',
        'follow_up',
      ]));

      const applyRes = await fetch(`${baseUrl}/api/v1/setup/starter-plan/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(applyRes.status).toBe(201);
      const applied = await applyRes.json() as Record<string, any>;
      expect(Object.keys(applied.workflow_ids).sort()).toEqual(['development', 'lead-generation', 'ops']);
      const db = getDb();
      const workflows = await db.all(`SELECT sprint_type, workflow_template_key FROM sprints WHERE project_id = ? ORDER BY workflow_template_key`, applied.project_id) as Array<{ sprint_type: string; workflow_template_key: string }>;
      expect(workflows).toEqual([
        { sprint_type: 'development'.replace('development', 'dev'), workflow_template_key: 'development' },
        { sprint_type: 'lead_generation', workflow_template_key: 'lead-generation' },
        { sprint_type: 'ops', workflow_template_key: 'ops' },
      ]);
      const leadRoute = await db.get(`
        SELECT a.name
        FROM sprint_task_routing_rules rr
        JOIN agents a ON a.id = rr.agent_id
        WHERE rr.sprint_id = ? AND rr.task_type = 'proposal' AND rr.status = 'human_approval'
      `, applied.workflow_ids['lead-generation']) as { name: string } | undefined;
      expect(leadRoute?.name).toBe('Approval Owner');

      const opsTypeRes = await fetch(`${baseUrl}/api/v1/sprints/types/ops`);
      expect(opsTypeRes.status).toBe(200);
      const opsType = await opsTypeRes.json() as Record<string, any>;
      expect(opsType.task_types.map((row: any) => row.task_type).sort()).toEqual(['adhoc', 'data', 'ops', 'pm_operational']);
      expect(opsType.statuses.map((row: any) => row.name)).toEqual([
        'todo',
        'intake',
        'triage',
        'risk_review',
        'impact_review',
        'action_plan',
        'stakeholder_update',
        'human_approval',
        'blocked',
        'stalled',
        'done',
      ]);
      expect(opsType.field_schemas[0].schema.fields.map((field: any) => field.key)).toEqual([
        'affected_system_client',
        'source',
        'severity',
        'compliance_risk_impact',
        'cost_impact',
        'schedule_impact',
        'stakeholder_impact',
        'approval_owner',
        'supporting_docs',
      ]);

      const leadTypeRes = await fetch(`${baseUrl}/api/v1/sprints/types/lead_generation`);
      expect(leadTypeRes.status).toBe(200);
      const leadType = await leadTypeRes.json() as Record<string, any>;
      expect(leadType.task_types.map((row: any) => row.task_type).sort()).toEqual(['follow_up', 'lead', 'outreach', 'proposal', 'research']);
      expect(leadType.statuses.map((row: any) => row.name)).toEqual([
        'intake',
        'qualification',
        'research',
        'outreach_draft',
        'human_approval',
        'sent',
        'follow_up',
        'done',
      ]);
      expect(leadType.field_schemas[0].schema.fields.map((field: any) => field.key)).toEqual(expect.arrayContaining([
        'prospect_company',
        'fit_notes',
        'research_notes',
        'outreach_angle',
        'approval_owner',
        'follow_up_date',
      ]));
    } finally {
      await stopServer(server);
    }
  });

  it('reconciles stale system-owned ops registry rows when the ops template is applied', async () => {
    await seedCompatibility();
    const db = getDb();
    await db.run(`
      INSERT INTO sprint_type_task_types (sprint_type_key, task_type, is_system)
      VALUES ('ops', 'backend', 1), ('ops', 'qa', 1)
    `);
    await db.run(`
      INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json, is_system)
      VALUES ('ops', NULL, ?, 1)
    `, JSON.stringify({ fields: [
            { key: 'environment', label: 'Environment', type: 'text', required: false },
            { key: 'runbook_url', label: 'Runbook URL', type: 'url', required: false },
          ] }));

    const { server, baseUrl } = await startServer();
    try {
      const applyRes = await fetch(`${baseUrl}/api/v1/setup/starter-plan/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          template_keys: ['ops'],
          project_name: 'Ops Registry',
          owners: {
            pm: 'Ops PM',
            ops: 'Ops Owner',
            review: 'Risk Review',
            approval: 'Approval Owner',
          },
        }),
      });
      expect(applyRes.status).toBe(201);

      const opsTaskTypesRes = await fetch(`${baseUrl}/api/v1/sprints/types/ops/task-types`);
      expect(opsTaskTypesRes.status).toBe(200);
      const opsTaskTypes = await opsTaskTypesRes.json() as Record<string, any>;
      expect(opsTaskTypes.task_types.map((row: any) => row.task_type).sort()).toEqual(['adhoc', 'data', 'ops', 'pm_operational']);

      const opsFieldSchemasRes = await fetch(`${baseUrl}/api/v1/sprints/types/ops/field-schemas`);
      expect(opsFieldSchemasRes.status).toBe(200);
      const opsFieldSchemas = await opsFieldSchemasRes.json() as Record<string, any>;
      expect(opsFieldSchemas.field_schemas[0].schema.fields.map((field: any) => field.key)).toEqual(expect.arrayContaining([
        'affected_system_client',
        'severity',
        'compliance_risk_impact',
        'stakeholder_impact',
        'supporting_docs',
      ]));
      expect(opsFieldSchemas.field_schemas[0].schema.fields.map((field: any) => field.key)).not.toContain('runbook_url');
    } finally {
      await stopServer(server);
    }
  });
});
