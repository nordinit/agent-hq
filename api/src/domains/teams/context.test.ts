import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { renderTeamContextForAgent, resolveDispatchTeamId, resolveTeamContextForDispatch } from './context';

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

async function createAgent(name: string, options: { enabled?: number } = {}): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO agents (tenant_id, name, session_key, enabled) VALUES (1, ?, ?, ?)`,
    name, `agent:${name.toLowerCase()}`, options.enabled ?? 1,
  );
  return result.lastInsertId as number;
}

async function createTeam(name: string, options: { goal?: string; charter?: string } = {}): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO teams (tenant_id, name, slug, goal, charter) VALUES (1, ?, ?, ?, ?)`,
    name,
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    options.goal ?? 'Ship it.',
    options.charter ?? '',
  );
  return result.lastInsertId as number;
}

async function addMember(
  teamId: number,
  agentId: number,
  options: { role?: string; responsibilities?: string; isPrimary?: number; isLead?: number; sortOrder?: number } = {},
): Promise<void> {
  await getDb().run(
    `INSERT INTO team_members (team_id, agent_id, member_role, responsibilities, is_primary, is_lead, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    teamId, agentId,
    options.role ?? '', options.responsibilities ?? '',
    options.isPrimary ?? 0, options.isLead ?? 0, options.sortOrder ?? 0,
  );
}

async function createWorkflow(name: string, teamId: number | null): Promise<number> {
  const result = await getDb().run(
    `INSERT INTO sprints (tenant_id, project_id, name, team_id) VALUES (1, 1, ?, ?)`,
    name, teamId,
  );
  return result.lastInsertId as number;
}

describe('dispatch team resolution', () => {
  beforeEach(resetDb);
  afterEach(teardownTestDb);

  it('returns nothing for an agent on no team', async () => {
    const agentId = await createAgent('Nova');
    expect(await resolveDispatchTeamId(getDb(), { agentId })).toBeNull();
  });

  it('uses the sole membership when there is no workflow', async () => {
    const agentId = await createAgent('Nova');
    const teamId = await createTeam('Delivery Squad');
    await addMember(teamId, agentId);

    expect(await resolveDispatchTeamId(getDb(), { agentId })).toBe(teamId);
  });

  it('prefers the team that owns the workflow over the agent\'s other memberships', async () => {
    const agentId = await createAgent('Nova');
    const owningTeam = await createTeam('Owning Team');
    const otherTeam = await createTeam('Other Team');
    await addMember(otherTeam, agentId);
    await addMember(owningTeam, agentId);
    const workflowId = await createWorkflow('Billing migration', owningTeam);

    expect(await resolveDispatchTeamId(getDb(), { agentId, sprintId: workflowId })).toBe(owningTeam);
  });

  it('does not claim a workflow\'s team for an agent that is not on it', async () => {
    // A one-off helper pulled onto team-owned work must not be told it is on that team: it
    // would be instructed to hand off through routes that do not exist for it.
    const agentId = await createAgent('Nova');
    const ownTeam = await createTeam('Own Team');
    const owningTeam = await createTeam('Owning Team');
    await addMember(ownTeam, agentId);
    const workflowId = await createWorkflow('Billing migration', owningTeam);

    expect(await resolveDispatchTeamId(getDb(), { agentId, sprintId: workflowId })).toBe(ownTeam);
  });

  it('falls back to the primary membership when several teams apply', async () => {
    const agentId = await createAgent('Nova');
    const first = await createTeam('First');
    const second = await createTeam('Second');
    await addMember(first, agentId);
    await addMember(second, agentId, { isPrimary: 1 });

    expect(await resolveDispatchTeamId(getDb(), { agentId })).toBe(second);
  });

  it('injects nothing when multiple teams apply and none is primary or owns the workflow', async () => {
    const agentId = await createAgent('Nova');
    const first = await createTeam('First');
    const second = await createTeam('Second');
    await addMember(first, agentId);
    await addMember(second, agentId);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await resolveDispatchTeamId(getDb(), { agentId })).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('belongs to 2 teams'));
    warn.mockRestore();
  });

  it('falls back to the primary membership when the workflow owner is a team the agent is not on', async () => {
    const agentId = await createAgent('Nova');
    const first = await createTeam('First');
    const second = await createTeam('Second');
    const stranger = await createTeam('Stranger');
    await addMember(first, agentId);
    await addMember(second, agentId, { isPrimary: 1 });
    const workflowId = await createWorkflow('Billing migration', stranger);

    expect(await resolveDispatchTeamId(getDb(), { agentId, sprintId: workflowId })).toBe(second);
  });
});

describe('team context rendering', () => {
  beforeEach(resetDb);
  afterEach(teardownTestDb);

  it('marks the dispatching agent as self and lists the rest as teammates', async () => {
    const nova = await createAgent('Nova');
    const casper = await createAgent('Casper');
    const teamId = await createTeam('Delivery Squad', { goal: 'Ship billing.' });
    await addMember(teamId, nova, { role: 'Implementer', responsibilities: 'Writes the code', sortOrder: 1 });
    await addMember(teamId, casper, { role: 'Reviewer', responsibilities: 'Reviews diffs', sortOrder: 2 });

    const rendered = await renderTeamContextForAgent(getDb(), { teamId, agentId: nova });
    expect(rendered?.section).toContain('You are Nova, Implementer on this team.');
    expect(rendered?.section).toContain('- Casper — Reviewer. Reviews diffs.');
    expect(rendered?.section).not.toContain('- Nova');
  });

  it('orders members by sort_order then id so the block is byte-stable', async () => {
    const nova = await createAgent('Nova');
    const casper = await createAgent('Casper');
    const piper = await createAgent('Piper');
    const teamId = await createTeam('Delivery Squad');
    await addMember(teamId, nova, { sortOrder: 0 });
    await addMember(teamId, casper, { role: 'Reviewer', sortOrder: 9 });
    await addMember(teamId, piper, { role: 'Planner', sortOrder: 1 });

    const rendered = await renderTeamContextForAgent(getDb(), { teamId, agentId: nova });
    expect(rendered!.section.indexOf('Piper')).toBeLessThan(rendered!.section.indexOf('Casper'));

    const again = await renderTeamContextForAgent(getDb(), { teamId, agentId: nova });
    expect(again!.section).toBe(rendered!.section);
  });

  it('omits disabled and soft-deleted agents from the roster', async () => {
    const nova = await createAgent('Nova');
    const retired = await createAgent('Retired', { enabled: 0 });
    const removed = await createAgent('Removed');
    await getDb().run(`UPDATE agents SET deleted_at = '2026-08-01 00:00:00' WHERE id = ?`, removed);
    const teamId = await createTeam('Delivery Squad');
    await addMember(teamId, nova);
    await addMember(teamId, retired);
    await addMember(teamId, removed);

    const rendered = await renderTeamContextForAgent(getDb(), { teamId, agentId: nova });
    expect(rendered?.section).not.toContain('Retired');
    expect(rendered?.section).not.toContain('Removed');
  });

  it('reports the context version so a run can be tied to the definition it used', async () => {
    const nova = await createAgent('Nova');
    const teamId = await createTeam('Delivery Squad');
    await addMember(teamId, nova);
    await getDb().run(`UPDATE teams SET context_version = 7 WHERE id = ?`, teamId);

    expect((await renderTeamContextForAgent(getDb(), { teamId, agentId: nova }))?.contextVersion).toBe(7);
  });

  it('returns null for a disabled or soft-deleted team', async () => {
    const nova = await createAgent('Nova');
    const teamId = await createTeam('Delivery Squad');
    await addMember(teamId, nova);
    await getDb().run(`UPDATE teams SET enabled = 0 WHERE id = ?`, teamId);

    expect(await renderTeamContextForAgent(getDb(), { teamId, agentId: nova })).toBeNull();
  });
});

describe('resolveTeamContextForDispatch', () => {
  beforeEach(resetDb);
  afterEach(teardownTestDb);

  it('returns the rendered block for a resolvable team', async () => {
    const nova = await createAgent('Nova');
    const casper = await createAgent('Casper');
    const teamId = await createTeam('Delivery Squad', { goal: 'Ship billing.' });
    await addMember(teamId, nova, { role: 'Implementer' });
    await addMember(teamId, casper, { role: 'Reviewer' });

    const resolved = await resolveTeamContextForDispatch(getDb(), { agentId: nova });
    expect(resolved?.teamId).toBe(teamId);
    expect(resolved?.section).toContain('--- Team: Delivery Squad ---');
  });

  it('returns null when the team renders to nothing worth injecting', async () => {
    // Sole member, no goal, no charter: the block would restate what job_instructions say.
    const nova = await createAgent('Nova');
    const teamId = await createTeam('Solo', { goal: '' });
    await addMember(teamId, nova);

    expect(await resolveTeamContextForDispatch(getDb(), { agentId: nova })).toBeNull();
  });

  it('returns null rather than throwing when the agent id is missing', async () => {
    expect(await resolveTeamContextForDispatch(getDb(), { agentId: null })).toBeNull();
  });

  it('degrades to no team context instead of failing a dispatch on a database error', async () => {
    const db = getDb();
    const broken = {
      ...db,
      all: async () => { throw new Error('connection reset'); },
    } as unknown as typeof db;

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await resolveTeamContextForDispatch(broken, { agentId: 1 })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to resolve team context'),
      'connection reset',
    );
    warn.mockRestore();
  });
});
