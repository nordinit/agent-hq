import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb, usingPostgres } from '../db/testDb';

beforeEach(async () => { await setupTestDb(); });
afterEach(async () => { await teardownTestDb(); });

it('probe', async () => {
  const db = getDb();
  const cols = usingPostgres()
    ? await db.all(`SELECT table_name, column_name, is_nullable FROM information_schema.columns WHERE table_name IN ('task_field_schemas','sprint_type_task_types','sprints') ORDER BY table_name, ordinal_position`)
    : await db.all(`SELECT name, sql FROM sqlite_master WHERE name IN ('task_field_schemas','sprint_type_task_types','sprints')`);
  console.log(JSON.stringify(cols, null, 1));
  console.log('tfs rows', JSON.stringify(await db.all(`SELECT * FROM task_field_schemas ORDER BY id`)).slice(0, 3000));
  console.log('sttt rows', JSON.stringify(await db.all(`SELECT * FROM sprint_type_task_types ORDER BY id`)).slice(0, 2000));
  console.log('tenants', JSON.stringify(await db.all(`SELECT * FROM tenants`)));
  console.log('projects', JSON.stringify(await db.all(`SELECT * FROM projects`)));
});
