import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { taskActorDisplayNames } from './actorDisplay';
import { listTaskAttachments, listTaskHistory, listTaskNotes } from './readModel';
import { createTaskNoteRecord } from './writeModel';

describe('task actor display names', () => {
  beforeEach(async () => {
    await setupTestDb();
    const db = getDb();
    await db.run("INSERT INTO tenants (id,name,slug) VALUES (1,'Agency','agency'),(2,'Other','other') ON CONFLICT (id) DO NOTHING");
    await db.run("INSERT INTO projects (id,tenant_id,name) VALUES (99,1,'Agency'),(100,2,'Other')");
    await db.run("INSERT INTO workflows (id,tenant_id,project_id,name) VALUES (114,1,99,'Lead generation')");
    await db.run("INSERT INTO tasks (id,tenant_id,project_id,workflow_id,title) VALUES (1612,1,99,114,'Lead search')");
    await db.run(`INSERT INTO agents (id,tenant_id,project_id,name,slug,openclaw_agent_id,session_key) VALUES
      (10,1,99,'James',NULL,'agency-lead-research','agent:agency:james:business-development:main'),
      (11,1,99,'Casper','sales-manager','agency-lead-qualifier','agent:agency:casper:business-development:main'),
      (12,2,100,'Other tenant agent','private-agent','agency-lead-research','agent:other:main')`);
  });
  afterEach(teardownTestDb);

  test('resolves runtime tags, explicit slugs, session keys and agent IDs within the task tenant', async () => {
    const display = await taskActorDisplayNames(getDb(), 1612);
    expect(display('agency-lead-research')).toBe('James');
    expect(display('Agency-Lead-Qualifier')).toBe('Casper');
    expect(display('sales-manager')).toBe('Casper');
    expect(display('agent:agency:james:business-development:main')).toBe('James');
    expect(display('agent:11')).toBe('Casper');
    expect(display('Agent #10')).toBe('James');
    for (const actor of ['James', 'User', 'dispatcher', 'unknown-agent', 'private-agent', 'agent:12']) expect(display(actor)).toBe(actor);
    expect((await taskActorDisplayNames(getDb(), 9999))('agency-lead-research')).toBe('agency-lead-research');
  });

  test('names existing notes, new notes, history and attachments without rewriting audit identities', async () => {
    const db = getDb();
    const note = await createTaskNoteRecord(db, 1612, 'agency-lead-research', 'Run complete');
    expect(note).toMatchObject({ author: 'agency-lead-research', author_display_name: 'James' });
    await db.run("INSERT INTO task_history (tenant_id,task_id,changed_by,field,new_value) VALUES (1,1612,'agent:11','status','closed')");
    await db.run("INSERT INTO task_attachments (task_id,filename,filepath,uploaded_by) VALUES (1612,'evidence.txt','/tmp/evidence.txt','sales-manager')");
    expect(await listTaskNotes(db, 1612)).toEqual([expect.objectContaining({ author: 'agency-lead-research', author_display_name: 'James' })]);
    expect(await listTaskHistory(db, 1612)).toEqual([expect.objectContaining({ changed_by: 'agent:11', changed_by_display_name: 'Casper' })]);
    expect(await listTaskAttachments(db, 1612)).toEqual([expect.objectContaining({ uploaded_by: 'sales-manager', uploaded_by_display_name: 'Casper' })]);
    await db.run("UPDATE agents SET name='James Renamed' WHERE id=10");
    expect(await listTaskNotes(db, 1612)).toEqual([expect.objectContaining({ author: 'agency-lead-research', author_display_name: 'James Renamed' })]);
    expect(await db.get('SELECT author FROM task_notes WHERE id=?', note!.id)).toEqual({ author: 'agency-lead-research' });
  });

  test('does not guess when two agents share a legacy alias', async () => {
    await getDb().run("UPDATE agents SET slug='agency-lead-research' WHERE id=11");
    const display = await taskActorDisplayNames(getDb(), 1612);
    expect(display('agency-lead-research')).toBe('agency-lead-research');
    expect(display('agent:10')).toBe('James');
    expect(display('agent:11')).toBe('Casper');
  });
});
