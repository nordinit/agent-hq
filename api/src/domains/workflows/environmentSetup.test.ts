import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { createWorkflow, updateWorkflow } from './admin';
import type { Db } from '../../db/adapter/types';
import { normalizeEnvironmentSetup } from '../../lib/environmentSetup';

let db: Db;
beforeEach(async () => {
  db = await setupTestDb();
  await db.run(`INSERT INTO tenants (id, name, slug) VALUES (1, 'Test', 'test')`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Test')`);
  await db.run(`INSERT INTO workflow_types (tenant_id, key, name) VALUES (1, 'generic', 'Generic')`);
});
afterEach(teardownTestDb);
it('defaults repository access to preparation off and saves an independent policy', async () => {
  const workflow = await createWorkflow(db, { tenant_id: 1, project_id: 1, name: 'Repo only', repo_access_mode: 'clone', repo_url: 'https://example.com/repo.git' }, 'test') as { id: number; environment_setup: unknown };
  expect(workflow.environment_setup).toEqual({ mode: 'off' });
  const setup = normalizeEnvironmentSetup({ mode: 'auto', roots: ['api', 'ui'] });
  await updateWorkflow(db, workflow.id, { environment_setup: setup }, 'test');
  const audit = await db.get("SELECT changes FROM project_audit_log WHERE entity_id = ? AND action = 'updated' ORDER BY id DESC LIMIT 1", workflow.id) as { changes: string };
  expect(JSON.parse(audit.changes)).toMatchObject({ environment_setup: { old: { mode: 'off' }, new: setup } });
  await updateWorkflow(db, workflow.id, { name: 'Renamed' }, 'test');
  expect(await db.get('SELECT repo_access_mode, environment_setup FROM workflows WHERE id = ?', workflow.id)).toMatchObject({ repo_access_mode: 'clone', environment_setup: setup });
  await updateWorkflow(db, workflow.id, { environment_setup: { mode: 'off' } }, 'test');
  expect(await db.get('SELECT repo_url, environment_setup FROM workflows WHERE id = ?', workflow.id)).toMatchObject({ repo_url: 'https://example.com/repo.git', environment_setup: { mode: 'off' } });
});
it.each([{ mode: 'guess' }, { mode: 'auto', roots: ['../escape'] }, { mode: 'custom', steps: [] }, { mode: 'off', install: true }])('rejects invalid setup %j before saving', async environment_setup => {
  await expect(createWorkflow(db, { tenant_id: 1, project_id: 1, name: 'Invalid', environment_setup } as never, 'test')).rejects.toMatchObject({ status: 400 });
  expect(await db.get('SELECT COUNT(*) AS n FROM workflows')).toMatchObject({ n: 0 });
});
it('copies preparation settings only when no explicit policy is supplied', async () => {
  const setup = normalizeEnvironmentSetup({ mode: 'custom', steps: [{ command: ['mise', 'run', 'setup'] }] });
  const source = await createWorkflow(db, { tenant_id: 1, project_id: 1, name: 'Source', environment_setup: setup }, 'test') as { id: number };
  const clone = await createWorkflow(db, { tenant_id: 1, project_id: 1, name: 'Copy', source_workflow_id: source.id }, 'test') as { environment_setup: unknown };
  expect(clone.environment_setup).toEqual(setup);
  const disabled = await createWorkflow(db, { tenant_id: 1, project_id: 1, name: 'Copy off', source_workflow_id: source.id, environment_setup: { mode: 'off' } }, 'test') as { environment_setup: unknown };
  expect(disabled.environment_setup).toEqual({ mode: 'off' });
});
