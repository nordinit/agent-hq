import { getWorkflowGraph } from '../routing/graph';
import type { Db } from '../../db/adapter/types';
import { fetchAgentToolCandidates, fetchAgentMcpCandidates, resolveAgentToolCandidates, resolveAgentMcpCandidates, resolveEffectiveSkillNames } from '../teams/effectiveCapabilities';
import { resolveDispatchTeamId, renderTeamContextForAgent } from '../teams/context';
import { agentMcpPolicyRevision, getAgentMcpPermissionPolicy } from '../../lib/mcpApiAuth';

export interface ResolutionSource {
  id: string;
  label: string;
  href: string;
  primary?: boolean;
}
export interface ResolutionEntry {
  id: string;
  kind: 'tool' | 'mcp' | 'skill' | 'permission';
  label: string;
  effective: boolean;
  sources: Array<{ source_id: string; state: 'active' | 'overridden' | 'opted_out' | 'disabled'; explanation: string }>;
  description?: string;
}
export interface AgentResolution {
  agent: { id: number; name: string; enabled: boolean; runtime_type: string; model: string | null };
  sources: ResolutionSource[];
  entries: ResolutionEntry[];
  context: { team_id: number | null; team_name: string | null; section: string; workflow_id: number | null };
  workflows: Array<{ id: number; name: string }>;
  routing: Array<{ status: string; task_type: string | null; rule_id: number; effective: boolean }>;
  policy_revision: string;
  policy_mode: 'default' | 'explicit';
  findings: Array<{ code: string; severity: 'warning' | 'info'; message: string; entry_id?: string }>;
}

type Row = Record<string, unknown>;
const names = (raw: unknown): string[] => {
  try { const value = typeof raw === 'string' ? JSON.parse(raw) : raw; return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
};
const sourceId = (row: Row) => row.source === 'team' ? `team:${row.source_team_id}` : 'agent';

/** Project only names and provenance; never serialize commands, environment, or overrides. */
export function describeAssignments(kind: 'tool' | 'mcp', candidates: { teamRows: Row[]; agentRows: Row[] }, effective: Row[]): ResolutionEntry[] {
  const key = (row: Row) => Number(kind === 'tool' ? row.id : row.mcp_server_id);
  const winners = new Map(effective.map(row => [key(row), row]));
  const groups = new Map<number, Row[]>();
  for (const row of [...candidates.teamRows, ...candidates.agentRows]) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups].map(([id, rows]) => {
    const winner = winners.get(id);
    const optOut = rows.some(row => row.source === 'agent' && Number(row.assignment_enabled) === 0);
    return {
      id: `${kind}:${id}`, kind, label: String(rows[0].name ?? rows[0].slug), effective: !!winner,
      sources: rows.map(row => {
        const disabled = Number(kind === 'tool' ? row.enabled : row.server_enabled) !== 1;
        const active = winner && sourceId(winner) === sourceId(row);
        const state = disabled ? 'disabled' : optOut ? 'opted_out' : active ? 'active' : 'overridden';
        return { source_id: sourceId(row), state, explanation: disabled ? 'The resource itself is disabled.' : optOut ? 'An explicit agent opt-out blocks this resource.' : active ? row.source === 'team' ? 'Inherited from this team.' : 'Assigned directly; takes precedence over team grants.' : 'Superseded by an agent assignment or a team with a lower ID.' } as ResolutionEntry['sources'][number];
      }),
    };
  }).sort((a, b) => a.label.localeCompare(b.label));
}

export async function getAgentResolution(db: Db, agentId: number, tenantId: number, workflowId: number | null = null): Promise<AgentResolution> {
  const agent = await db.get<Row>(`SELECT id, name, enabled, runtime_type, model, skill_names, project_id FROM agents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`, agentId, tenantId);
  if (!agent) throw Object.assign(new Error('Agent not found'), { status: 404 });
  let workflowOwner: number | null = null;
  if (workflowId !== null) {
    const workflow = await db.get<Row>(`SELECT id, team_id FROM workflows WHERE id = ? AND tenant_id = ? AND project_id = ?`, workflowId, tenantId, agent.project_id);
    if (!workflow) throw Object.assign(new Error('Workflow not found in this agent’s project'), { status: 404 });
    workflowOwner = workflow.team_id == null ? null : Number(workflow.team_id);
  }
  const [teams, tools, servers, skills, policy, teamId] = await Promise.all([
    db.all<Row>(`SELECT te.id, te.name, te.skill_names, tm.is_primary FROM teams te JOIN team_members tm ON tm.team_id = te.id WHERE tm.agent_id = ? AND te.tenant_id = ? AND te.enabled = 1 AND te.deleted_at IS NULL AND tm.enabled = 1 ORDER BY te.id`, agentId, tenantId),
    fetchAgentToolCandidates(db, agentId), fetchAgentMcpCandidates(db, agentId),
    resolveEffectiveSkillNames(db, agentId, agent.skill_names), getAgentMcpPermissionPolicy(db, agentId),
    resolveDispatchTeamId(db, { agentId, workflowId }),
  ]);
  const teamContext = teamId === null ? null : await renderTeamContextForAgent(db, { agentId, teamId });
  const entries: ResolutionEntry[] = [
    ...describeAssignments('tool', tools, resolveAgentToolCandidates(tools)), ...describeAssignments('mcp', servers, resolveAgentMcpCandidates(servers)),
    ...skills.map(label => ({ id: `skill:${label}`, kind: 'skill' as const, label, effective: true,
      sources: [ ...(names(agent.skill_names).includes(label) ? [{ source_id: 'agent', state: 'active' as const, explanation: 'Assigned directly to the agent.' }] : []),
        ...teams.filter(t => names(t.skill_names).includes(label)).map(t => ({ source_id: `team:${t.id}`, state: 'active' as const, explanation: 'Team skills are combined with agent skills; individual opt-out is not supported.' })) ],
    })),
    ...policy.capabilities.map(c => ({ id: `permission:${c.key}`, kind: 'permission' as const, label: c.key, description: c.description, effective: c.enabled,
      sources: [{ source_id: 'defaults', state: policy.policy_mode === 'explicit' ? 'overridden' as const : c.enabled ? 'active' as const : 'disabled' as const, explanation: `Default policy: ${policy.default_policy}. ${c.default_enabled ? 'Enabled' : 'Disabled'} by default.${policy.policy_mode === 'explicit' ? ' The explicit policy replaces all defaults.' : ''}` },
        ...(policy.policy_mode === 'explicit' ? [{ source_id: 'agent', state: c.enabled ? 'active' as const : 'opted_out' as const, explanation: c.explicit_enabled === null ? 'Not listed in the explicit policy; therefore unavailable.' : c.enabled ? 'Enabled in the explicit policy.' : 'Disabled in the explicit policy.' }] : [])],
    })),
  ];
  const workflows = await db.all<{ id: number; name: string }>(`SELECT id, name FROM workflows WHERE tenant_id = ? AND project_id = ? ORDER BY name`, tenantId, agent.project_id);
  const graph = workflowId === null ? null : await getWorkflowGraph(db, { project_id: agent.project_id, workflow_id: workflowId, tenant_id: tenantId });
  const routing = graph?.nodes.flatMap(node => node.assignments.filter(a => a.agent_id === agentId).map(a => ({ status: node.id, task_type: a.task_type, rule_id: a.rule_id, effective: a.enabled && a.effective_for_workflow }))) ?? [];
  const findings: AgentResolution['findings'] = [];
  if (workflowOwner !== null && !teams.some(t => Number(t.id) === workflowOwner)) findings.push({ code: 'workflow_team_not_member', severity: 'warning', message: 'This agent is not an enabled member of the workflow’s owning team. Team context falls back to its other memberships.' });
  const lifecycleAllowed = policy.capabilities.some(c => c.enabled && ['admin.full_access', 'tasks.write_active_lifecycle', 'tasks.write_project_lifecycle'].includes(c.key));
  if (routing.some(r => r.effective) && !lifecycleAllowed) findings.push({ code: 'routing_without_lifecycle_permission', severity: 'warning', message: 'Routing rules reference this agent, but its Agent HQ MCP policy grants no lifecycle write capability. It cannot submit task outcomes or evidence through those MCP endpoints.' });
  if (!Number(agent.enabled)) findings.push({ code: 'agent_disabled', severity: 'warning', message: 'This agent is disabled. Configured capabilities do not imply it can receive dispatches.' });
  if (teams.length > 1 && teamId === null) findings.push({ code: 'ambiguous_team_context', severity: 'warning', message: 'Multiple teams and no unique primary: no team context is selected for this dispatch scope.' });
  if (teamId !== null && !teamContext?.section) findings.push({ code: 'empty_team_context', severity: 'info', message: 'The selected team produces no context block.' });
  const blocked = policy.capabilities.filter(c => c.default_enabled && !c.enabled);
  if (policy.policy_mode === 'explicit' && blocked.length) findings.push({ code: 'defaults_replaced', severity: 'info', message: `The explicit permission policy excludes ${blocked.length} capabilities that the default policy enables. This may be intentional.` });
  for (const entry of entries.filter(e => e.kind !== 'permission' && !e.effective)) findings.push({ code: 'excluded_resource', severity: 'info', entry_id: entry.id, message: `${entry.label} is excluded: ${entry.sources[0]?.explanation}` });
  return {
    agent: { id: agentId, name: String(agent.name), enabled: Number(agent.enabled) === 1, runtime_type: String(agent.runtime_type ?? 'openclaw'), model: agent.model == null ? null : String(agent.model) },
    sources: [{ id: 'defaults', label: 'Built-in permission defaults', href: `/agents/${agentId}` }, ...teams.map(t => ({ id: `team:${t.id}`, label: String(t.name), primary: Number(t.is_primary) === 1, href: `/teams/${t.id}` })), { id: 'agent', label: String(agent.name), href: `/agents/${agentId}` }],
    workflows, routing, entries, context: { team_id: teamId, team_name: teamContext?.teamName ?? null, section: teamContext?.section ?? '', workflow_id: workflowId }, policy_revision: agentMcpPolicyRevision(policy), policy_mode: policy.policy_mode, findings,
  };
}
