import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { applyTeamRouting, planTeamRoutingApplication } from './routingTemplates';

async function resetDb(): Promise<void> {
  await setupTestDb();
  const db = getDb();
  await db.exec(`
    INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Tenant A', 'tenant-a', 1);
    INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1');
    INSERT INTO app_settings (key, value) VALUES ('active_tenant_id', '1');
    INSERT INTO projects (id, tenant_id, name) VALUES (1, 1, 'Platform');
  `);
}

async function createAgent(name: string): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO agents (tenant_id, name, session_key) VALUES (1, ?, ?)`,
    name, `agent:${name.toLowerCase()}`,
  );
  return result.lastInsertId as number;
}

async function createTeam(name = 'Delivery Squad'): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO teams (tenant_id, name, slug) VALUES (1, ?, ?)`,
    name, name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  );
  return result.lastInsertId as number;
}

async function addMember(teamId: number, agentId: number, role: string): Promise<void> {
  await getDb().run(
    `INSERT INTO team_members (team_id, agent_id, member_role) VALUES (?, ?, ?)`,
    teamId, agentId, role,
  );
}

async function createWorkflow(teamId: number | null, workflowType = 'delivery'): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO sprints (tenant_id, project_id, name, sprint_type, team_id) VALUES (1, 1, 'Billing', ?, ?)`,
    workflowType, teamId,
  );
  return result.lastInsertId as number;
}

async function addTemplateRule(
  teamId: number,
  rule: {
    status: string;
    taskType?: string | null;
    workflowType?: string | null;
    agentId?: number | null;
    memberRole?: string;
    priority?: number;
    enabled?: number;
  },
): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO team_routing_rules
       (tenant_id, team_id, workflow_type, task_type, status, agent_id, member_role, priority, enabled)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    teamId,
    rule.workflowType ?? null,
    rule.taskType ?? null,
    rule.status,
    rule.agentId ?? null,
    rule.memberRole ?? '',
    rule.priority ?? 0,
    rule.enabled ?? 1,
  );
  return result.lastInsertId as number;
}

async function rulesFor(workflowId: number): Promise<Array<Record<string, unknown>>> {
  return await getDb().all(
    `SELECT * FROM sprint_task_routing_rules WHERE sprint_id = ? ORDER BY status ASC`,
    workflowId,
  );
}

describe('team routing template application', () => {
  beforeEach(resetDb);
  afterEach(teardownTestDb);

  it('refuses a workflow with no team assigned', async () => {
    const workflowId = await createWorkflow(null);
    await expect(planTeamRoutingApplication(getDb(), { workflowId }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('plans a create for each resolvable template rule without writing anything', async () => {
    const teamId = await createTeam();
    const nova = await createAgent('Nova');
    await addMember(teamId, nova, 'Implementer');
    await addTemplateRule(teamId, { status: 'ready', agentId: nova });
    const workflowId = await createWorkflow(teamId);

    const plan = await planTeamRoutingApplication(getDb(), { workflowId });
    expect(plan.summary.create).toBe(1);
    expect(plan.entries[0]).toMatchObject({ action: 'create', agent_id: nova, agent_name: 'Nova' });
    expect(plan.applied).toBe(false);
    expect(await rulesFor(workflowId)).toEqual([]);
  });

  it('resolves member_role targeting to the agent holding the role', async () => {
    const teamId = await createTeam();
    const casper = await createAgent('Casper');
    await addMember(teamId, casper, 'Reviewer');
    await addTemplateRule(teamId, { status: 'in_review', memberRole: 'Reviewer' });
    const workflowId = await createWorkflow(teamId);

    await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-1' });

    const [rule] = await rulesFor(workflowId);
    expect(Number(rule.agent_id)).toBe(casper);
    expect(Number(rule.source_team_id)).toBe(teamId);
  });

  it('survives swapping which agent holds a role', async () => {
    // The point of role targeting: the template does not name an agent, so replacing the
    // reviewer is a membership edit, not a routing edit.
    const teamId = await createTeam();
    const casper = await createAgent('Casper');
    await addMember(teamId, casper, 'Reviewer');
    await addTemplateRule(teamId, { status: 'in_review', memberRole: 'Reviewer' });
    const workflowId = await createWorkflow(teamId);
    await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-1' });

    const quinn = await createAgent('Quinn');
    await getDb().run(`DELETE FROM team_members WHERE team_id = ? AND agent_id = ?`, teamId, casper);
    await addMember(teamId, quinn, 'Reviewer');

    const plan = await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-2' });
    expect(plan.summary.update).toBe(1);
    const [rule] = await rulesFor(workflowId);
    expect(Number(rule.agent_id)).toBe(quinn);
  });

  it('skips a rule whose named agent has left the team', async () => {
    const teamId = await createTeam();
    const nova = await createAgent('Nova');
    await addTemplateRule(teamId, { status: 'ready', agentId: nova });
    const workflowId = await createWorkflow(teamId);

    const plan = await planTeamRoutingApplication(getDb(), { workflowId });
    expect(plan.entries[0]).toMatchObject({ action: 'skip' });
    expect(plan.entries[0].reason).toContain('no longer an enabled member');
  });

  it('reports ambiguity rather than picking one of two role holders', async () => {
    const teamId = await createTeam();
    await addMember(teamId, await createAgent('Casper'), 'Reviewer');
    await addMember(teamId, await createAgent('Quinn'), 'Reviewer');
    await addTemplateRule(teamId, { status: 'in_review', memberRole: 'Reviewer' });
    const workflowId = await createWorkflow(teamId);

    const plan = await planTeamRoutingApplication(getDb(), { workflowId });
    expect(plan.entries[0]).toMatchObject({ action: 'conflict' });
    expect(plan.entries[0].reason).toContain('2 members hold the role');
  });

  it('is idempotent — a second apply changes nothing', async () => {
    const teamId = await createTeam();
    const nova = await createAgent('Nova');
    await addMember(teamId, nova, 'Implementer');
    await addTemplateRule(teamId, { status: 'ready', agentId: nova });
    const workflowId = await createWorkflow(teamId);

    await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-1' });
    const second = await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-2' });

    expect(second.summary).toMatchObject({ create: 0, update: 0, unchanged: 1 });
    expect(await rulesFor(workflowId)).toHaveLength(1);
  });

  it('leaves a hand-written rule alone and reports it as a conflict', async () => {
    const teamId = await createTeam();
    const nova = await createAgent('Nova');
    const local = await createAgent('LocalPick');
    await addMember(teamId, nova, 'Implementer');
    await addTemplateRule(teamId, { status: 'ready', agentId: nova });
    const workflowId = await createWorkflow(teamId);

    await getDb().run(`
      INSERT INTO sprint_task_routing_rules (tenant_id, sprint_id, project_id, sprint_type, status, agent_id)
      VALUES (1, ?, 1, 'delivery', 'ready', ?)
    `, workflowId, local);

    const plan = await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-1' });
    expect(plan.summary.conflict).toBe(1);
    expect(plan.entries[0].reason).toContain('hand-written rule');

    const [rule] = await rulesFor(workflowId);
    expect(Number(rule.agent_id)).toBe(local);
  });

  it('lets an operator edit win over a later template change', async () => {
    const teamId = await createTeam();
    const nova = await createAgent('Nova');
    const quinn = await createAgent('Quinn');
    const operatorPick = await createAgent('OperatorPick');
    await addMember(teamId, nova, 'Implementer');
    await addMember(teamId, quinn, 'Backup');
    const ruleId = await addTemplateRule(teamId, { status: 'ready', agentId: nova });
    const workflowId = await createWorkflow(teamId);
    await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-1' });

    // The operator repoints the materialized rule by hand...
    const [materialized] = await rulesFor(workflowId);
    await getDb().run(
      `UPDATE sprint_task_routing_rules SET agent_id = ? WHERE id = ?`,
      operatorPick, materialized.id,
    );
    // ...and the template independently changes.
    await getDb().run(`UPDATE team_routing_rules SET agent_id = ? WHERE id = ?`, quinn, ruleId);

    const plan = await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-2' });
    expect(plan.summary.conflict).toBe(1);
    expect(plan.entries[0].reason).toContain('edited after it was applied');

    const [after] = await rulesFor(workflowId);
    expect(Number(after.agent_id)).toBe(operatorPick);
  });

  it('resyncs an untouched rule when the template changes', async () => {
    const teamId = await createTeam();
    const nova = await createAgent('Nova');
    const quinn = await createAgent('Quinn');
    await addMember(teamId, nova, 'Implementer');
    await addMember(teamId, quinn, 'Backup');
    const ruleId = await addTemplateRule(teamId, { status: 'ready', agentId: nova });
    const workflowId = await createWorkflow(teamId);
    await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-1' });

    await getDb().run(`UPDATE team_routing_rules SET agent_id = ? WHERE id = ?`, quinn, ruleId);

    const plan = await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-2' });
    expect(plan.summary.update).toBe(1);
    const [after] = await rulesFor(workflowId);
    expect(Number(after.agent_id)).toBe(quinn);
  });

  it('only applies template rules matching the workflow type, with the specific one winning', async () => {
    const teamId = await createTeam();
    const nova = await createAgent('Nova');
    const quinn = await createAgent('Quinn');
    const other = await createAgent('Other');
    await addMember(teamId, nova, 'Implementer');
    await addMember(teamId, quinn, 'Specialist');
    await addMember(teamId, other, 'Elsewhere');

    await addTemplateRule(teamId, { status: 'ready', agentId: nova, workflowType: null });
    await addTemplateRule(teamId, { status: 'ready', agentId: quinn, workflowType: 'delivery' });
    await addTemplateRule(teamId, { status: 'ready', agentId: other, workflowType: 'research' });

    const workflowId = await createWorkflow(teamId, 'delivery');
    const plan = await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-1' });

    expect(plan.summary.create).toBe(1);
    expect(plan.summary.skip).toBe(1);
    const [rule] = await rulesFor(workflowId);
    expect(Number(rule.agent_id)).toBe(quinn);
  });

  it('reports a materialized rule whose template row is gone, without deleting it', async () => {
    const teamId = await createTeam();
    const nova = await createAgent('Nova');
    await addMember(teamId, nova, 'Implementer');
    const ruleId = await addTemplateRule(teamId, { status: 'ready', agentId: nova });
    const workflowId = await createWorkflow(teamId);
    await applyTeamRouting(getDb(), { workflowId, batchId: 'batch-1' });

    await getDb().run(`UPDATE team_routing_rules SET enabled = 0 WHERE id = ?`, ruleId);

    const plan = await planTeamRoutingApplication(getDb(), { workflowId });
    expect(plan.orphaned).toHaveLength(1);
    expect(plan.orphaned[0].status).toBe('ready');
    // Still there: the workflow may be mid-flight on it.
    expect(await rulesFor(workflowId)).toHaveLength(1);
  });

  it('audits every write under one batch id', async () => {
    const teamId = await createTeam();
    const nova = await createAgent('Nova');
    await addMember(teamId, nova, 'Implementer');
    await addTemplateRule(teamId, { status: 'ready', agentId: nova });
    await addTemplateRule(teamId, { status: 'in_progress', agentId: nova });
    const workflowId = await createWorkflow(teamId);

    await applyTeamRouting(getDb(), {
      workflowId, batchId: 'batch-42', actor: 'nordini', actorKind: 'user',
    });

    const audits = await getDb().all(
      `SELECT * FROM routing_config_audit_log WHERE batch_id = ? ORDER BY id ASC`,
      'batch-42',
    );
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      entity_table: 'sprint_task_routing_rules', action: 'created', actor: 'nordini', actor_kind: 'user',
    });
  });

  it('scopes to the requesting tenant', async () => {
    const teamId = await createTeam();
    const workflowId = await createWorkflow(teamId);
    await expect(planTeamRoutingApplication(getDb(), { workflowId, tenantId: 2 }))
      .rejects.toMatchObject({ status: 404 });
  });
});
