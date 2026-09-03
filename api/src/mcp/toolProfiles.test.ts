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

  it('gives the mobile profile the workflow lifecycle controls but not workflow configuration', () => {
    // The board's pause/resume/complete buttons are the point of the phone surface; defining a
    // workflow type is design work that wants the canvas.
    const mobile = resolveMcpToolProfile('mobile');
    expect(mobile.toolNames).toContain('agent_hq_set_workflow_status');
    expect(mobile.capabilities).toEqual(expect.arrayContaining([
      'sprints.pause_active_sprint',
      'sprints.complete_active_sprint',
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
    // The bound is a smell test on profile creep, not a fixed budget. It was a quarter of the
    // full surface when the profile held board reads and task writes alone; workflow lifecycle,
    // routing and project agent management have since roughly doubled it. Widen it only when the
    // additions were asked for, and read a failure here as a prompt to check the profile still
    // describes a phone rather than an admin console.
    expect(mobileNames.length).toBeLessThan(registeredToolNames('full').length / 3);
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
