import {
  getCustomFieldDefinitions,
  getGateRequirementFieldDefinitions,
  resolveTaskFieldSchemaForWorkflow,
  validateRequirementFieldExpression,
} from './workflowTypeConfig';
import { getDb } from "../db/client";
import { setupTestDb, teardownTestDb } from "../db/testDb";
import { type Db } from "../db/adapter/types";

async function createDb(): Promise<Db> {
  return getDb();
}

describe('workflow type field config', () => {
  beforeEach(async () => {
    const db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
    await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Test')`);
  });
  afterEach(async () => { await teardownTestDb(); });

  it('resolves fields from the workflow type without falling back to generic schemas', async () => {
    const db = await createDb();
    await db.run(`INSERT INTO workflows (id, project_id, tenant_id, name, workflow_type) VALUES (1, 1, 1, 'Dev', 'dev'), (2, 1, 1, 'Ops', 'ops')`);
    await db.run(`
      INSERT INTO task_field_schemas (tenant_id, workflow_type_key, task_type, schema_json)
      VALUES
        (1, 'generic', NULL, ?),
        (1, 'dev', NULL, ?),
        (1, 'dev', 'backend', ?)
    `, JSON.stringify({ fields: [{ key: 'generic_only', type: 'text', source: 'custom_fields', gate_requirement: false }] }), JSON.stringify({ fields: [
              { key: 'target_surface', type: 'select', options: ['api', 'ui'], source: 'custom_fields', gate_requirement: false },
              { key: 'review_branch', type: 'text', source: 'task_column', gate_requirement: true },
            ] }), JSON.stringify({ fields: [
              { key: 'backend_notes', type: 'textarea', source: 'custom_fields', gate_requirement: false },
              { key: 'review_branch', label: 'Backend Review Branch', type: 'text', source: 'task_column', gate_requirement: true },
            ] }));

    const dev = await resolveTaskFieldSchemaForWorkflow(db, { workflowId: 1, taskType: 'backend' });
    expect(dev.schema.fields.map(field => field.key)).toEqual(['target_surface', 'review_branch', 'backend_notes']);
    expect(dev.schema.fields.find(field => field.key === 'review_branch')?.label).toBe('Backend Review Branch');
    expect(getCustomFieldDefinitions(dev.schema.fields).map(field => field.key)).toEqual(['target_surface', 'review_branch', 'backend_notes']);
    expect(getGateRequirementFieldDefinitions(dev.schema.fields).map(field => field.key)).toEqual(['target_surface', 'review_branch', 'backend_notes']);

    const devByType = await resolveTaskFieldSchemaForWorkflow(db, { workflowType: 'dev', taskType: 'backend' });
    expect(devByType.schema.fields.map(field => field.key)).toEqual(['target_surface', 'review_branch', 'backend_notes']);

    const ops = await resolveTaskFieldSchemaForWorkflow(db, { workflowId: 2, taskType: 'ops' });
    expect(ops.schema.fields).toEqual([]);
  });

  it('validates transition requirement field expressions against workflow-defined fields', async () => {
    const db = await createDb();
    await db.run(`INSERT INTO workflows (id, project_id, tenant_id, name, workflow_type) VALUES (1, 1, 1, 'Dev', 'dev')`);
    await db.run(`
      INSERT INTO task_field_schemas (tenant_id, workflow_type_key, task_type, schema_json)
      VALUES (1, 'dev', NULL, ?)
    `, JSON.stringify({ fields: [
            { key: 'merged_commit', type: 'text', source: 'task_column', gate_requirement: true },
            { key: 'deployed_commit', type: 'text', source: 'task_column', gate_requirement: true },
            { key: 'test_plan', type: 'textarea', source: 'custom_fields', gate_requirement: false },
          ] }));

    await (async () => await validateRequirementFieldExpression(db, {
                workflowId: 1,
                fieldName: 'merged_commit|deployed_commit',
              }))();

    await (async () => await validateRequirementFieldExpression(db, {
                workflowId: 1,
                fieldName: 'test_plan',
              }))();

    await expect((async () => await validateRequirementFieldExpression(db, {
                workflowId: 1,
                fieldName: 'missing_field',
              }))()).rejects.toThrow('not defined for workflow type "dev"');
  });
});
