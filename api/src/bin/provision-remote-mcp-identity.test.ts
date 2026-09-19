import { parseArgs, resolveProvisionedIdentityPolicy } from './provision-remote-mcp-identity';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { replaceAgentMcpPermissionPolicy } from '../lib/mcpApiAuth';

test('omitted permissions preserve policy; explicit grants are validated before provisioning', () => {
  expect(parseArgs(['--project-id', '99']).capabilities).toBeNull();
  expect(parseArgs(['--capability', 'tasks.create', '--capability', 'tasks.read_project_context']).capabilities)
    .toEqual(['tasks.create', 'tasks.read_project_context']);
  expect(() => parseArgs(['--capability', 'invented'])).toThrow('Unknown Agent HQ MCP capability');
  expect(() => parseArgs(['--profile', 'mobile'])).toThrow('--profile has been removed');
  expect(() => parseArgs(['--capability', 'tasks.create', '--permissions-file', '/unused'])).toThrow('Use either');
});

test('new identities get explicit empty access and re-provisioning preserves saved grants', async () => {
  const db = await setupTestDb();
  try {
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, enabled) VALUES (7, 1, 'Mobile', 'agent:mobile:main', 1)`);
    const created = await resolveProvisionedIdentityPolicy(db, 7, true, null);
    expect(created.policy_mode).toBe('explicit');
    expect(created.capabilities.filter(capability => capability.enabled)).toEqual([]);
    const saved = await replaceAgentMcpPermissionPolicy(db, 7, ['tasks.create', 'workflow_definitions.manage_project_scope']);
    expect(await resolveProvisionedIdentityPolicy(db, 7, false, null)).toEqual(saved);
    const replaced = await resolveProvisionedIdentityPolicy(db, 7, false, ['tasks.read_project_context']);
    expect(replaced.capabilities.filter(capability => capability.enabled).map(capability => capability.key)).toEqual(['tasks.read_project_context']);
  } finally { await teardownTestDb(); }
});
