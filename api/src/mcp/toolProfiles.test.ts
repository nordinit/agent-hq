import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AGENT_MCP_CAPABILITY_CATALOG } from '../lib/mcpApiAuth';
import { AgentHqApiClient } from './apiClient';
import { getMcpCatalog } from './catalog';
import { registerAgentHqMcpCatalog } from './registerCatalog';
import { registerAgentHqMcpDomains } from './registerDomains';
import { createMcpRegistrar, type McpToolResult } from './registrar';
import {
  MCP_TOOL_PROFILES,
  resolveMcpToolProfile,
  selectProfileToolNames,
} from './toolProfiles';

/** Every name the domains register, canonical and alias alike. */
function allRegisteredToolNames(): Set<string> {
  registerAgentHqMcpCatalog();
  const names = new Set<string>();
  for (const tool of getMcpCatalog().tools) {
    names.add(tool.canonical_name);
    for (const alias of tool.aliases) names.add(alias);
  }
  return names;
}

describe('MCP tool profiles', () => {
  it('exposes only names the domains actually register', () => {
    // A typo here is invisible until a client asks for a tool that was silently never registered.
    const registered = allRegisteredToolNames();

    for (const profile of Object.values(MCP_TOOL_PROFILES)) {
      if (!profile.toolNames) continue;
      const unknown = [...profile.toolNames].filter((name) => !registered.has(name));
      expect({ profile: profile.name, unknown }).toEqual({ profile: profile.name, unknown: [] });
    }
  });

  it('pairs each narrowed profile with real capability keys', () => {
    // The policy is applied verbatim by the provisioning script, and
    // replaceAgentMcpPermissionPolicy throws on an unknown key — better to catch it here.
    const known = new Set<string>(AGENT_MCP_CAPABILITY_CATALOG.map((capability) => capability.key));

    for (const profile of Object.values(MCP_TOOL_PROFILES)) {
      if (!profile.capabilities) continue;
      const unknown = profile.capabilities.filter((key) => !known.has(key));
      expect({ profile: profile.name, unknown }).toEqual({ profile: profile.name, unknown: [] });
    }
  });

  it('keeps administrative and cross-tenant capabilities out of the mobile policy', () => {
    // This profile exists to be handed to a client running outside this machine.
    const mobile = resolveMcpToolProfile('mobile');
    expect(mobile.capabilities).not.toContain('admin.full_access');
    expect(mobile.capabilities).not.toContain('admin.cross_tenant');
    expect(mobile.capabilities).not.toContain('mcp_capability_policies.write');
  });

  it('exposes every telemetry tool and pairs them with the complete UI permission group', () => {
    registerAgentHqMcpCatalog();
    const mobile = resolveMcpToolProfile('mobile');
    const telemetry = getMcpCatalog().tools.filter(tool => tool.domain === 'telemetry').map(tool => tool.canonical_name);
    expect(telemetry).toHaveLength(30);
    expect([...mobile.toolNames!].filter(name => name.includes('_telemetry_')).sort()).toEqual(telemetry.sort());
    const grants = AGENT_MCP_CAPABILITY_CATALOG.filter(capability => capability.group === 'Telemetry');
    expect(grants).toHaveLength(5);
    expect(mobile.capabilities!.filter(key => key.startsWith('telemetry.')).sort()).toEqual(grants.map(capability => capability.key).sort());
    expect(grants.every(capability => !capability.defaultEnabled.scoped_runtime)).toBe(true);
  });

  it('gives the mobile profile the workflow lifecycle controls but not workflow configuration', () => {
    // The board's pause/resume/complete buttons are the point of the phone surface; defining a
    // workflow type is design work that wants the canvas.
    const mobile = resolveMcpToolProfile('mobile');
    expect(mobile.toolNames).toContain('agent_hq_set_workflow_status');
    expect(mobile.capabilities).toEqual(expect.arrayContaining([
      'workflows.pause_active_workflow',
      'workflows.complete_active_workflow',
    ]));

    expect(mobile.toolNames).not.toContain('agent_hq_update_workflow');
    expect(mobile.toolNames).not.toContain('agent_hq_create_workflow');
    expect(mobile.toolNames).not.toContain('agent_hq_delete_workflow');
    expect(mobile.capabilities).not.toContain('workflow_definitions.manage_project_scope');
  });

  it('gives the mobile profile project agent CRUD but not agent provisioning or policy edits', () => {
    const mobile = resolveMcpToolProfile('mobile');
    expect(mobile.toolNames).toContain('agent_hq_update_agent');
    expect(mobile.capabilities).toContain('agents.manage_project_agents');

    // Building a workspace, syncing credentials, or deciding what an agent may do over MCP are
    // a different kind of authority from editing its job instructions.
    expect(mobile.toolNames).not.toContain('agent_hq_provision_full_agent');
    expect(mobile.toolNames).not.toContain('agent_hq_sync_agent_mcp');
    expect(mobile.toolNames).not.toContain('agent_hq_update_agent_mcp_capability_policy');
    expect(mobile.capabilities).not.toContain('mcp_capability_policies.write');
  });

  it('resolves the full profile by default and rejects unknown names', () => {
    expect(resolveMcpToolProfile().name).toBe('full');
    expect(resolveMcpToolProfile('').name).toBe('full');
    expect(resolveMcpToolProfile('mobile').name).toBe('mobile');
    expect(() => resolveMcpToolProfile('phone')).toThrow(/Unknown Agent HQ MCP tool profile/);
  });

  it('exposes supervisory outcomes and relationship deletion without generic status moves or run callbacks', () => {
    const mobile = resolveMcpToolProfile('mobile');
    expect(mobile.capabilities).toContain('tasks.write_project_lifecycle');
    expect(mobile.capabilities).not.toContain('tasks.write_active_lifecycle');
    expect(mobile.toolNames).toContain('agent_hq_post_task_outcome');
    expect(mobile.toolNames).toContain('agent_hq_delete_task_relationship');
    expect(mobile.toolNames).not.toContain('agent_hq_move_task');
    expect(mobile.toolNames).not.toContain('agent_hq_start_task_run');
  });

  it('selects only the profile names out of a tool name list', () => {
    const mobile = resolveMcpToolProfile('mobile');
    expect(selectProfileToolNames(mobile, ['agent_hq_list_tasks', 'agent_hq_provision_full_agent']))
      .toEqual(['agent_hq_list_tasks']);
    expect(selectProfileToolNames(resolveMcpToolProfile('full'), ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('profile-scoped registrar', () => {
  function registeredToolNames(profileName: string): string[] {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const names: string[] = [];
    const tool = jest.spyOn(server, 'tool').mockImplementation(((name: string) => {
      names.push(name);
      return undefined as never;
    }) as never);

    const profile = resolveMcpToolProfile(profileName);
    const registrar = createMcpRegistrar(server, { profile: profile.toolNames ? profile : null });
    const wrap = <T>(_fn: () => Promise<T>) => async (): Promise<McpToolResult> => ({
      content: [{ type: 'text' as const, text: '{}' }],
    });
    registerAgentHqMcpDomains({ api: new AgentHqApiClient('http://127.0.0.1'), wrap, ...registrar });

    tool.mockRestore();
    return names;
  }

  it('registers exactly the mobile profile names, and far fewer than the full surface', () => {
    const mobile = resolveMcpToolProfile('mobile');
    const mobileNames = registeredToolNames('mobile');

    expect(new Set(mobileNames)).toEqual(mobile.toolNames);
    // Duplicate registrations would mean a name appears in two domains.
    expect(mobileNames.length).toBe(new Set(mobileNames).size);
    // Project telemetry adds 30 explicitly requested tools to the previous 56.
    // The profile still excludes provisioning and administrative configuration.
    expect(mobileNames).toHaveLength(86);
    expect(mobileNames.length).toBeLessThan(registeredToolNames('full').length / 2);
  });

  it('does not let a profile-scoped server rewrite the process-wide catalog', () => {
    // The catalog documents the product, not one client's view of it, and the HTTP transport
    // builds a profile-scoped server per request.
    registerAgentHqMcpCatalog();
    const before = getMcpCatalog().tools.length;

    registeredToolNames('mobile');

    expect(getMcpCatalog().tools.length).toBe(before);
  });

  it('registers nothing outside the profile', () => {
    const names = new Set(registeredToolNames('mobile'));
    expect(names.has('agent_hq_list_tasks')).toBe(true);
    // Administrative surfaces a remote connector has no business seeing.
    expect(names.has('agent_hq_provision_full_agent')).toBe(false);
    expect(names.has('agent_hq_api_request')).toBe(false);
    expect(names.has('agent_hq_update_workflow_type')).toBe(false);
  });
});
