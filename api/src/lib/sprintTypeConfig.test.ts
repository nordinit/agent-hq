import Database from 'better-sqlite3';
import {
  getCustomFieldDefinitions,
  getGateRequirementFieldDefinitions,
  resolveTaskFieldSchemaForSprint,
  validateRequirementFieldExpression,
} from './sprintTypeConfig';
import { type Db } from "../db/adapter/types";

async function createDb(): Promise<Db> {
  const db = new Database(':memory:');
  await db.exec(`
    CREATE TABLE sprints (
      id INTEGER PRIMARY KEY,
      sprint_type TEXT NOT NULL DEFAULT 'generic'
    );
    CREATE TABLE sprint_type_task_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE task_field_schemas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sprint_type_key TEXT NOT NULL,
      task_type TEXT,
      schema_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

describe('sprint type field config', () => {
  it('resolves fields from the sprint type without falling back to generic schemas', async () => {
    const db = await createDb();
    await db.run(`INSERT INTO sprints (id, sprint_type) VALUES (1, 'dev'), (2, 'ops')`);
    await db.run(`
      INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json)
      VALUES
        ('generic', NULL, ?),
        ('dev', NULL, ?),
        ('dev', 'backend', ?)
    `, JSON.stringify({ fields: [{ key: 'generic_only', type: 'text', source: 'custom_fields', gate_requirement: false }] }), JSON.stringify({ fields: [
              { key: 'target_surface', type: 'select', options: ['api', 'ui'], source: 'custom_fields', gate_requirement: false },
              { key: 'review_branch', type: 'text', source: 'task_column', gate_requirement: true },
            ] }), JSON.stringify({ fields: [
              { key: 'backend_notes', type: 'textarea', source: 'custom_fields', gate_requirement: false },
              { key: 'review_branch', label: 'Backend Review Branch', type: 'text', source: 'task_column', gate_requirement: true },
            ] }));

    const dev = await resolveTaskFieldSchemaForSprint(db, { sprintId: 1, taskType: 'backend' });
    expect(dev.schema.fields.map(field => field.key)).toEqual(['target_surface', 'review_branch', 'backend_notes']);
    expect(dev.schema.fields.find(field => field.key === 'review_branch')?.label).toBe('Backend Review Branch');
    expect(getCustomFieldDefinitions(dev.schema.fields).map(field => field.key)).toEqual(['target_surface', 'review_branch', 'backend_notes']);
    expect(getGateRequirementFieldDefinitions(dev.schema.fields).map(field => field.key)).toEqual(['target_surface', 'review_branch', 'backend_notes']);

    const devByType = await resolveTaskFieldSchemaForSprint(db, { sprintType: 'dev', taskType: 'backend' });
    expect(devByType.schema.fields.map(field => field.key)).toEqual(['target_surface', 'review_branch', 'backend_notes']);

    const ops = await resolveTaskFieldSchemaForSprint(db, { sprintId: 2, taskType: 'ops' });
    expect(ops.schema.fields).toEqual([]);
  });

  it('validates transition requirement field expressions against sprint-defined fields', async () => {
    const db = await createDb();
    await db.run(`INSERT INTO sprints (id, sprint_type) VALUES (1, 'dev')`);
    await db.run(`
      INSERT INTO task_field_schemas (sprint_type_key, task_type, schema_json)
      VALUES ('dev', NULL, ?)
    `, JSON.stringify({ fields: [
            { key: 'merged_commit', type: 'text', source: 'task_column', gate_requirement: true },
            { key: 'deployed_commit', type: 'text', source: 'task_column', gate_requirement: true },
            { key: 'test_plan', type: 'textarea', source: 'custom_fields', gate_requirement: false },
          ] }));

    expect(async () => await validateRequirementFieldExpression(db, {
          sprintId: 1,
          fieldName: 'merged_commit|deployed_commit',
        })).not.toThrow();

    expect(async () => await validateRequirementFieldExpression(db, {
          sprintId: 1,
          fieldName: 'test_plan',
        })).not.toThrow();

    expect(async () => await validateRequirementFieldExpression(db, {
          sprintId: 1,
          fieldName: 'missing_field',
        })).toThrow('not defined for sprint type "dev"');
  });
});
