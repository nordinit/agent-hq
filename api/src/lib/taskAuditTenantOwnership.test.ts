import fs from 'fs';
import path from 'path';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { writeTaskHistory } from '../domains/tasks/history';
import { addTaskNote } from '../domains/tasks/mutations';

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionTypeScriptFiles(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(absolute);
    }
  }
  return files;
}

describe('task audit writer tenant ownership', () => {
  it('requires every production task_history/task_notes insert to bind tenant ownership', () => {
    const sourceRoot = path.resolve(__dirname, '..');
    const violations: string[] = [];
    let auditedWrites = 0;
    const insertPattern = /INSERT\s+INTO\s+(task_history|task_notes)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/gi;

    for (const filename of productionTypeScriptFiles(sourceRoot)) {
      const source = fs.readFileSync(filename, 'utf8');
      for (const match of source.matchAll(insertPattern)) {
        auditedWrites += 1;
        const columns = match[2];
        const values = match[3];
        const hasExplicitTenant = /\btenant_id\b/.test(columns);
        const hasDynamicTenantColumn = /\$\{[^}]*\.columnSql\}/.test(columns);
        const hasDynamicTenantValue = /\$\{[^}]*\.valueSql\}/.test(values);
        if (!hasExplicitTenant && !(hasDynamicTenantColumn && hasDynamicTenantValue)) {
          const line = source.slice(0, match.index).split('\n').length;
          violations.push(`${path.relative(sourceRoot, filename)}:${line} (${match[1]})`);
        }
      }
    }

    expect(auditedWrites).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('derives history and note ownership from a non-default owning task', async () => {
    const db = await setupTestDb();
    try {
      await db.run(`
        INSERT INTO tenants (id, name, slug, is_default)
        VALUES (1, 'Default', 'default', 1), (2, 'Workspace Two', 'workspace-two', 0)
      `);
      await db.run(`
        INSERT INTO app_settings (key, value)
        VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
      `);
      await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (9202, 2, 'Workspace Two Project')`);
      await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name) VALUES (9203, 2, 9202, 'Workspace Two Workflow')`);
      await db.run(`INSERT INTO tasks (id, tenant_id, project_id, sprint_id, title) VALUES (9204, 2, 9202, 9203, 'Workspace Two Task')`);

      await writeTaskHistory(db, 9204, 'tenant-test', 'status', 'todo', 'ready');
      await addTaskNote(9204, 'tenant-test', 'Owned by the task workspace', db);

      expect(await db.get(`SELECT tenant_id FROM task_history WHERE task_id = 9204`)).toEqual({ tenant_id: 2 });
      expect(await db.get(`SELECT tenant_id FROM task_notes WHERE task_id = 9204`)).toEqual({ tenant_id: 2 });
    } finally {
      await teardownTestDb();
    }
  });
});
