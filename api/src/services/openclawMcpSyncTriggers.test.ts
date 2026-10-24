import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';

const queued = async () => (await getDb().all<{ agent_id: number }>('SELECT agent_id FROM openclaw_mcp_sync_queue ORDER BY agent_id'))
  .map(row => Number(row.agent_id));
const clear = () => getDb().run('DELETE FROM openclaw_mcp_sync_queue');

describe('MCP configuration edits enqueue only the agents they affect', () => {
  beforeEach(async () => {
    await setupTestDb();
    const db = getDb();
    await db.run("INSERT INTO tenants (id,name,slug,is_default) VALUES (1,'Test','test',1)");
    // 1-3 OpenClaw; 4 another runtime; 5 deleted; 6 shares agent 1's workspace.
    await db.run(`INSERT INTO agents (id,tenant_id,name,session_key,workspace_path,runtime_type,deleted_at) VALUES
      (1,1,'Selene','agent:selene:main','/ws/selene','openclaw',NULL),
      (2,1,'Casper','agent:casper:main','/ws/casper','openclaw',NULL),
      (3,1,'James','agent:james:main','/ws/james','openclaw',NULL),
      (4,1,'Julian','agent:julian:main','/ws/julian','claude-code',NULL),
      (5,1,'Gone','agent:gone:main','/ws/gone','openclaw','2026-10-01 00:00:00'),
      (6,1,'Twin','agent:twin:main','/ws/selene','openclaw',NULL)`);
    await db.run(`INSERT INTO mcp_servers (id,tenant_id,name,slug,command) VALUES
      (10,1,'QA','agency-crm-qa','run-mcp.sh'),(11,1,'CRM','agency-crm','run-mcp.sh'),(12,1,'Team tools','team-tools','run-mcp.sh')`);
    await db.run(`INSERT INTO agent_mcp_assignments (agent_id,mcp_server_id) VALUES (1,10),(2,11),(3,11),(4,10),(5,10)`);
    await db.run(`INSERT INTO teams (id,tenant_id,name,slug) VALUES (20,1,'Sales','sales')`);
    await db.run(`INSERT INTO team_members (team_id,agent_id) VALUES (20,2),(20,3)`);
    await db.run(`INSERT INTO team_mcp_assignments (team_id,mcp_server_id) VALUES (20,12)`);
    await clear();
  });
  afterEach(teardownTestDb);

  it('resyncs only a server\'s assigned agents, and nobody for an edit that changes nothing', async () => {
    await getDb().run(`UPDATE mcp_servers SET env = '{"CRM_AGENT_KEY_FILE":"selene-qa.env"}' WHERE id = 10`);
    expect(await queued()).toEqual([1]);
    await clear();
    await getDb().run('UPDATE mcp_servers SET command = command WHERE id = 10');
    expect(await queued()).toEqual([]);
    await getDb().run("UPDATE mcp_servers SET description = 'team' WHERE id = 12");
    expect(await queued()).toEqual([2, 3]);
  });

  it('resyncs the one agent named by an assignment, policy or membership row', async () => {
    const db = getDb();
    await db.run(`UPDATE agent_mcp_assignments SET overrides = '{"tool_allowlist":["crm_lookup_lead"]}' WHERE agent_id = 3`);
    expect(await queued()).toEqual([3]);
    await clear();
    await db.run(`INSERT INTO agent_mcp_capability_policies (agent_id,capability_key,enabled) VALUES (2,'tasks.read_active_context',1)`);
    await db.run('DELETE FROM agent_mcp_assignments WHERE agent_id = 1');
    expect(await queued()).toEqual([1, 2]);
    await clear();
    await db.run('UPDATE team_members SET enabled = 0 WHERE agent_id = 2');
    expect(await queued()).toEqual([2]);
  });

  it('resyncs a team\'s members when its servers or availability change', async () => {
    await getDb().run('UPDATE team_mcp_assignments SET enabled = 0 WHERE team_id = 20');
    expect(await queued()).toEqual([2, 3]);
    await clear();
    await getDb().run("UPDATE teams SET deleted_at = '2026-10-24 00:00:00' WHERE id = 20");
    expect(await queued()).toEqual([2, 3]);
    await clear();
    await getDb().run("UPDATE teams SET name = 'Renamed' WHERE id = 20");
    expect(await queued()).toEqual([]);
  });

  it('resyncs agents that share the old or new workspace when an agent moves', async () => {
    await getDb().run("UPDATE agents SET workspace_path = '/ws/casper' WHERE id = 1");
    expect(await queued()).toEqual([1, 2, 6]);
    await clear();
    await getDb().run("INSERT INTO agents (id,tenant_id,name,session_key,workspace_path) VALUES (7,1,'New','agent:new:main','/ws/james')");
    expect(await queued()).toEqual([3, 7]);
  });

  it('never enqueues agents of other runtimes or deleted agents', async () => {
    await getDb().run(`UPDATE mcp_servers SET env = '{"rotated":true}' WHERE id = 10`);
    expect(await queued()).toEqual([1]);
  });
});
