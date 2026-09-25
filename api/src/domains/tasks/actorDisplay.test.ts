import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { taskActorDisplayNames } from './actorDisplay';
import { listTaskAttachments, listTaskHistory, listTaskNotes } from './readModel';
import { createTaskNoteRecord } from './writeModel';

describe('task actor display names', () => {
  beforeEach(async () => {
    await setupTestDb();
    const db = getDb();
    await db.run("INSERT INTO tenants (id,name,slug) VALUES (1,'Acme','acme'),(2,'Other','other') ON CONFLICT (id) DO NOTHING");
    await db.run("INSERT INTO projects (id,tenant_id,name) VALUES (7,1,'Sales'),(100,2,'Other')");
    await db.run("INSERT INTO workflows (id,tenant_id,project_id,name) VALUES (21,1,7,'Lead generation')");
    await db.run("INSERT INTO tasks (id,tenant_id,project_id,workflow_id,title) VALUES (305,1,7,21,'Lead search')");
    await db.run(`INSERT INTO agents (id,tenant_id,project_id,name,slug,openclaw_agent_id,session_key) VALUES
      (10,1,7,'Riley',NULL,'lead-research','agent:acme:riley:business-development:main'),
      (11,1,7,'Morgan','sales-manager','lead-qualifier','agent:acme:morgan:business-development:main'),
      (12,2,100,'Other tenant agent','private-agent','lead-research','agent:other:main')`);
  });
  afterEach(teardownTestDb);

  test('resolves runtime tags, explicit slugs, session keys and agent IDs within the task tenant', async () => {
    const display = await taskActorDisplayNames(getDb(), 305);
    expect(display('lead-research')).toBe('Riley');
    expect(display('Lead-Qualifier')).toBe('Morgan');
    expect(display('sales-manager')).toBe('Morgan');
    expect(display('agent:acme:riley:business-development:main')).toBe('Riley');
    expect(display('agent:11')).toBe('Morgan');
    expect(display('Agent #10')).toBe('Riley');
    for (const actor of ['Riley', 'User', 'dispatcher', 'unknown-agent', 'private-agent', 'agent:12']) expect(display(actor)).toBe(actor);
    expect((await taskActorDisplayNames(getDb(), 9999))('lead-research')).toBe('lead-research');
  });

  test('names existing notes, new notes, history and attachments without rewriting audit identities', async () => {
    const db = getDb();
    const note = await createTaskNoteRecord(db, 305, 'lead-research', 'Run complete');
    expect(note).toMatchObject({ author: 'lead-research', author_display_name: 'Riley' });
    await db.run("INSERT INTO task_history (tenant_id,task_id,changed_by,field,new_value) VALUES (1,305,'agent:11','status','closed')");
    await db.run("INSERT INTO task_attachments (task_id,filename,filepath,uploaded_by) VALUES (305,'evidence.txt','/tmp/evidence.txt','sales-manager')");
    expect(await listTaskNotes(db, 305)).toEqual([expect.objectContaining({ author: 'lead-research', author_display_name: 'Riley' })]);
    expect(await listTaskHistory(db, 305)).toEqual([expect.objectContaining({ changed_by: 'agent:11', changed_by_display_name: 'Morgan' })]);
    expect(await listTaskAttachments(db, 305)).toEqual([expect.objectContaining({ uploaded_by: 'sales-manager', uploaded_by_display_name: 'Morgan' })]);
    await db.run("UPDATE agents SET name='Riley Renamed' WHERE id=10");
    expect(await listTaskNotes(db, 305)).toEqual([expect.objectContaining({ author: 'lead-research', author_display_name: 'Riley Renamed' })]);
    expect(await db.get('SELECT author FROM task_notes WHERE id=?', note!.id)).toEqual({ author: 'lead-research' });
  });

  test('does not guess when two agents share a legacy alias', async () => {
    await getDb().run("UPDATE agents SET slug='lead-research' WHERE id=11");
    const display = await taskActorDisplayNames(getDb(), 305);
    expect(display('lead-research')).toBe('lead-research');
    expect(display('agent:10')).toBe('Riley');
    expect(display('agent:11')).toBe('Morgan');
  });
});
