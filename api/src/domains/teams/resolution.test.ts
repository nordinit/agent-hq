import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { getTeamResolution, previewTeamSkills } from './resolution';

describe('team capability preview', () => {
  beforeEach(async () => {
    await setupTestDb();
    await getDb().exec(`
      INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'A', 'a', 1), (2, 'B', 'b', 0);
      INSERT INTO agents (id, tenant_id, name, session_key, skill_names) VALUES (1, 1, 'A', 'agent:a', '["shared"]'), (2, 1, 'B', 'agent:b', '[]'), (3, 2, 'Foreign', 'agent:c', '[]');
      INSERT INTO teams (id, tenant_id, name, slug, skill_names) VALUES (1, 1, 'Team', 'team', '["shared"]');
      INSERT INTO team_members (team_id, agent_id) VALUES (1, 1), (1, 2), (1, 3);
    `);
  });
  afterEach(teardownTestDb);
  it('previews member-specific changes using real resolution, then rolls back', async () => {
    const result = await previewTeamSkills(getDb(), 1, 1, ['new']);
    expect(result.after.members.map(m => m.id)).toEqual([1, 2]);
    expect(result.after.members[0].capabilities.map(c => c.label)).toEqual(['shared', 'new']);
    expect(result.after.members[1].capabilities.map(c => c.label)).toEqual(['new']);
    expect(await getTeamResolution(getDb(), 1, 1)).toEqual(result.before);
    expect(result.after.context_version).toBe(result.before.context_version);
  });
  it('refuses other tenants without modifying the team', async () => {
    await expect(previewTeamSkills(getDb(), 1, 2, ['new'])).rejects.toMatchObject({ status: 404 });
    expect((await getTeamResolution(getDb(), 1, 1)).skill_names).toEqual(['shared']);
  });
});
