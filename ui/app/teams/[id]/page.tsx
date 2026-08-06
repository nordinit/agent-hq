'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  api,
  Agent,
  McpServer,
  Team,
  TeamContextPreview,
  TeamMcpAssignment,
  TeamMember,
  TeamRoutingRule,
  TeamToolAssignment,
  Tool,
} from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Eye, Plus, Save, Trash2, Users } from 'lucide-react';

type Tab = 'overview' | 'members' | 'capabilities' | 'routing' | 'context';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'members', label: 'Members' },
  { key: 'capabilities', label: 'Capabilities' },
  { key: 'routing', label: 'Routing defaults' },
  { key: 'context', label: 'Context preview' },
];

const inputClass = 'w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100';

export default function TeamDetailPage() {
  const params = useParams();
  const teamId = Number(params?.id);

  const [tab, setTab] = useState<Tab>('overview');
  const [team, setTeam] = useState<Team | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const loadTeam = useCallback(() => {
    if (!Number.isFinite(teamId)) return;
    Promise.all([api.getTeam(teamId), api.getTeamMembers(teamId)])
      .then(([t, m]) => { setTeam(t); setMembers(m); })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  }, [teamId]);

  useEffect(loadTeam, [loadTeam]);

  if (loading) return <div className="p-6 text-slate-400 text-sm">Loading…</div>;
  if (error) return <div className="p-6"><Card className="p-4 border-red-800 text-red-300 text-sm">{error}</Card></div>;
  if (!team) return <div className="p-6 text-slate-400 text-sm">Team not found.</div>;

  return (
    <div className="p-6 space-y-6">
      <div>
        <Link href="/teams" className="text-sm text-slate-400 hover:text-slate-200 inline-flex items-center gap-1">
          <ArrowLeft className="w-4 h-4" /> Teams
        </Link>
        <h1 className="text-2xl font-semibold text-slate-100 mt-2 flex items-center gap-2">
          <Users className="w-6 h-6" /> {team.name}
        </h1>
        {team.goal && <p className="text-sm text-slate-400 mt-1 max-w-3xl">{team.goal}</p>}
      </div>

      <div className="flex gap-1 border-b border-slate-800">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
              tab === key
                ? 'border-amber-500 text-slate-100'
                : 'border-transparent text-slate-400 hover:text-slate-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab team={team} onSaved={setTeam} />}
      {tab === 'members' && <MembersTab teamId={teamId} members={members} onChanged={loadTeam} />}
      {tab === 'capabilities' && <CapabilitiesTab teamId={teamId} team={team} onTeamSaved={setTeam} />}
      {tab === 'routing' && <RoutingTab teamId={teamId} members={members} />}
      {tab === 'context' && <ContextTab teamId={teamId} members={members} />}
    </div>
  );
}

// ── Overview ─────────────────────────────────────────────────────────────────

function OverviewTab({ team, onSaved }: { team: Team; onSaved: (t: Team) => void }) {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description);
  const [goal, setGoal] = useState(team.goal);
  const [charter, setCharter] = useState(team.charter);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      onSaved(await api.updateTeam(team.id, { name, description, goal, charter }));
    } catch (e) {
      setSaveError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-5 space-y-4 max-w-3xl">
      <div>
        <label className="text-xs text-slate-400 block mb-1">Name</label>
        <input className={inputClass} value={name} onChange={e => setName(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">
          Description <span className="text-slate-600">— operator-facing only, not injected</span>
        </label>
        <textarea className={inputClass} rows={2} value={description} onChange={e => setDescription(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">
          Goal <span className="text-amber-600/80">— injected into every member&apos;s prompt</span>
        </label>
        <textarea className={inputClass} rows={2} value={goal} onChange={e => setGoal(e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-slate-400 block mb-1">
          Working agreements <span className="text-amber-600/80">— injected into every member&apos;s prompt</span>
        </label>
        <textarea className={inputClass} rows={4} value={charter} onChange={e => setCharter(e.target.value)} />
      </div>
      {saveError && <p className="text-sm text-red-400">{saveError}</p>}
      <div className="flex items-center gap-3">
        <Button variant="primary" onClick={save} loading={saving}>
          <Save className="w-4 h-4" /> Save
        </Button>
        <span className="text-xs text-slate-500">
          Context version {team.context_version} — bumps on every change to what members read.
        </span>
      </div>
    </Card>
  );
}

// ── Members ──────────────────────────────────────────────────────────────────

function MembersTab({ teamId, members, onChanged }: { teamId: number; members: TeamMember[]; onChanged: () => void }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [addAgentId, setAddAgentId] = useState('');
  const [addRole, setAddRole] = useState('');
  const [addResponsibilities, setAddResponsibilities] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.getAgents().then(setAgents).catch(() => undefined); }, []);

  const add = async () => {
    setError(null);
    try {
      await api.addTeamMember(teamId, {
        agent_id: Number(addAgentId),
        member_role: addRole,
        responsibilities: addResponsibilities,
      });
      setAddAgentId(''); setAddRole(''); setAddResponsibilities('');
      onChanged();
    } catch (e) { setError(String(e)); }
  };

  const patch = async (agentId: number, data: Partial<TeamMember>) => {
    setError(null);
    try {
      await api.updateTeamMember(teamId, agentId, data);
      onChanged();
    } catch (e) { setError(String(e)); }
  };

  const memberIds = new Set(members.map(m => m.agent_id));
  const available = agents.filter(a => !memberIds.has(a.id));

  return (
    <div className="space-y-4">
      {error && <Card className="p-3 border-red-800 text-red-300 text-sm">{error}</Card>}

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium text-slate-200">Add a member</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <select className={inputClass} value={addAgentId} onChange={e => setAddAgentId(e.target.value)}>
            <option value="">Select an agent…</option>
            {available.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <input className={inputClass} placeholder="Role, e.g. Reviewer" value={addRole} onChange={e => setAddRole(e.target.value)} />
          <input
            className={inputClass}
            placeholder="Responsibilities — shown to teammates"
            value={addResponsibilities}
            onChange={e => setAddResponsibilities(e.target.value)}
          />
        </div>
        <Button variant="primary" onClick={add} disabled={!addAgentId}>
          <Plus className="w-4 h-4" /> Add
        </Button>
      </Card>

      {members.length === 0 ? (
        <Card className="p-8 text-center text-slate-400 text-sm">No members yet.</Card>
      ) : (
        <div className="space-y-2">
          {members.map(member => (
            <Card key={member.id} className="p-4 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-slate-100">{member.agent_name}</span>
                  {member.member_role && <Badge variant="info">{member.member_role}</Badge>}
                  {member.is_lead === 1 && <Badge variant="workspace">lead</Badge>}
                  {member.is_primary === 1 && <Badge variant="review">primary team</Badge>}
                  {member.enabled === 0 && <Badge variant="default">disabled</Badge>}
                </div>
                <button
                  onClick={() => api.removeTeamMember(teamId, member.agent_id).then(onChanged).catch(e => setError(String(e)))}
                  className="text-slate-500 hover:text-red-400 p-1"
                  aria-label={`Remove ${member.agent_name}`}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              {member.responsibilities && <p className="text-sm text-slate-400">{member.responsibilities}</p>}
              <div className="flex gap-2 text-xs">
                <button
                  className="text-slate-400 hover:text-slate-200 underline"
                  onClick={() => patch(member.agent_id, { is_lead: member.is_lead ? 0 : 1 })}
                >
                  {member.is_lead ? 'Unset lead' : 'Set lead'}
                </button>
                <button
                  className="text-slate-400 hover:text-slate-200 underline"
                  onClick={() => patch(member.agent_id, { is_primary: member.is_primary ? 0 : 1 })}
                  title="An agent on several teams uses its primary team when no workflow decides"
                >
                  {member.is_primary ? 'Unset primary' : 'Set primary'}
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Capabilities ─────────────────────────────────────────────────────────────

function CapabilitiesTab({ teamId, team, onTeamSaved }: { teamId: number; team: Team; onTeamSaved: (t: Team) => void }) {
  const [tools, setTools] = useState<TeamToolAssignment[]>([]);
  const [servers, setServers] = useState<TeamMcpAssignment[]>([]);
  const [allTools, setAllTools] = useState<Tool[]>([]);
  const [allServers, setAllServers] = useState<McpServer[]>([]);
  const [skillNames, setSkillNames] = useState<string[]>(() => {
    try { return JSON.parse(team.skill_names) as string[]; } catch { return []; }
  });
  const [newSkill, setNewSkill] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.getTeamTools(teamId), api.getTeamMcpServers(teamId)])
      .then(([t, s]) => { setTools(t); setServers(s); })
      .catch(e => setError(String(e)));
  }, [teamId]);

  useEffect(() => {
    load();
    api.getTools().then(setAllTools).catch(() => undefined);
    api.getMcpServers().then(setAllServers).catch(() => undefined);
  }, [load]);

  const saveSkills = async (next: string[]) => {
    setSkillNames(next);
    try { onTeamSaved(await api.updateTeam(teamId, { skill_names: JSON.stringify(next) })); }
    catch (e) { setError(String(e)); }
  };

  const assignedToolIds = new Set(tools.map(t => t.tool_id));
  const assignedServerIds = new Set(servers.map(s => s.mcp_server_id));

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400 max-w-3xl">
        Everything here is granted to every member. A member&apos;s own assignment overrides the
        team&apos;s for the same tool or server, and a member assignment left disabled is an
        explicit opt-out.
      </p>
      {error && <Card className="p-3 border-red-800 text-red-300 text-sm">{error}</Card>}

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium text-slate-200">Tools</h2>
        <div className="flex flex-wrap gap-2">
          {tools.map(tool => (
            <span key={tool.assignment_id} className="inline-flex items-center gap-1 bg-slate-800 rounded px-2 py-1 text-sm text-slate-200">
              {tool.name}
              <button
                onClick={() => api.removeToolFromTeam(teamId, tool.tool_id).then(load).catch(e => setError(String(e)))}
                className="text-slate-500 hover:text-red-400"
                aria-label={`Remove ${tool.name}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          ))}
          {tools.length === 0 && <span className="text-sm text-slate-500">None</span>}
        </div>
        <select
          className={inputClass}
          value=""
          onChange={e => e.target.value && api.assignToolToTeam(teamId, Number(e.target.value)).then(load).catch(err => setError(String(err)))}
        >
          <option value="">Add a tool…</option>
          {allTools.filter(t => !assignedToolIds.has(t.id)).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Card>

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium text-slate-200">MCP servers</h2>
        <div className="flex flex-wrap gap-2">
          {servers.map(server => (
            <span key={server.assignment_id} className="inline-flex items-center gap-1 bg-slate-800 rounded px-2 py-1 text-sm text-slate-200">
              {server.name}
              <button
                onClick={() => api.removeMcpServerFromTeam(teamId, server.mcp_server_id).then(load).catch(e => setError(String(e)))}
                className="text-slate-500 hover:text-red-400"
                aria-label={`Remove ${server.name}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          ))}
          {servers.length === 0 && <span className="text-sm text-slate-500">None</span>}
        </div>
        <select
          className={inputClass}
          value=""
          onChange={e => e.target.value && api.assignMcpServerToTeam(teamId, Number(e.target.value)).then(load).catch(err => setError(String(err)))}
        >
          <option value="">Add an MCP server…</option>
          {allServers.filter(s => !assignedServerIds.has(s.id)).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </Card>

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium text-slate-200">Skills</h2>
        <div className="flex flex-wrap gap-2">
          {skillNames.map(name => (
            <span key={name} className="inline-flex items-center gap-1 bg-slate-800 rounded px-2 py-1 text-sm text-slate-200">
              {name}
              <button
                onClick={() => saveSkills(skillNames.filter(s => s !== name))}
                className="text-slate-500 hover:text-red-400"
                aria-label={`Remove ${name}`}
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </span>
          ))}
          {skillNames.length === 0 && <span className="text-sm text-slate-500">None</span>}
        </div>
        <div className="flex gap-2">
          <input
            className={inputClass}
            placeholder="Skill name"
            value={newSkill}
            onChange={e => setNewSkill(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && newSkill.trim()) {
                saveSkills([...skillNames, newSkill.trim()]);
                setNewSkill('');
              }
            }}
          />
          <Button
            onClick={() => { if (newSkill.trim()) { saveSkills([...skillNames, newSkill.trim()]); setNewSkill(''); } }}
          >
            <Plus className="w-4 h-4" /> Add
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Routing defaults ─────────────────────────────────────────────────────────

function RoutingTab({ teamId, members }: { teamId: number; members: TeamMember[] }) {
  const [rules, setRules] = useState<TeamRoutingRule[]>([]);
  const [status, setStatus] = useState('');
  const [workflowType, setWorkflowType] = useState('');
  const [taskType, setTaskType] = useState('');
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.getTeamRoutingRules(teamId).then(setRules).catch(e => setError(String(e)));
  }, [teamId]);

  useEffect(load, [load]);

  const roles = Array.from(new Set(members.map(m => m.member_role).filter(Boolean)));

  const create = async () => {
    setError(null);
    const [kind, value] = target.split(':');
    try {
      await api.createTeamRoutingRule(teamId, {
        status,
        workflow_type: workflowType || null,
        task_type: taskType || null,
        ...(kind === 'agent' ? { agent_id: Number(value) } : { member_role: value }),
      });
      setStatus(''); setWorkflowType(''); setTaskType(''); setTarget('');
      load();
    } catch (e) { setError(String(e)); }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-400 max-w-3xl">
        These are templates, not live routing. They are stamped onto a workflow from that
        workflow&apos;s page, which shows a diff before anything is written. Targeting a role
        rather than an agent keeps the template working when membership changes.
      </p>
      {error && <Card className="p-3 border-red-800 text-red-300 text-sm">{error}</Card>}

      <Card className="p-4 space-y-3">
        <h2 className="text-sm font-medium text-slate-200">Add a default rule</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input className={inputClass} placeholder="Status (required)" value={status} onChange={e => setStatus(e.target.value)} />
          <input className={inputClass} placeholder="Workflow type (any)" value={workflowType} onChange={e => setWorkflowType(e.target.value)} />
          <input className={inputClass} placeholder="Task type (any)" value={taskType} onChange={e => setTaskType(e.target.value)} />
          <select className={inputClass} value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">Route to…</option>
            {roles.length > 0 && (
              <optgroup label="Role (portable)">
                {roles.map(role => <option key={role} value={`role:${role}`}>{role}</option>)}
              </optgroup>
            )}
            <optgroup label="Specific agent">
              {members.map(m => <option key={m.agent_id} value={`agent:${m.agent_id}`}>{m.agent_name}</option>)}
            </optgroup>
          </select>
        </div>
        <Button variant="primary" onClick={create} disabled={!status.trim() || !target}>
          <Plus className="w-4 h-4" /> Add rule
        </Button>
      </Card>

      {rules.length === 0 ? (
        <Card className="p-8 text-center text-slate-400 text-sm">No default routing rules yet.</Card>
      ) : (
        <Card className="p-0 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400 border-b border-slate-800">
              <tr>
                <th className="text-left px-4 py-2">Status</th>
                <th className="text-left px-4 py-2">Workflow type</th>
                <th className="text-left px-4 py-2">Task type</th>
                <th className="text-left px-4 py-2">Routes to</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rules.map(rule => (
                <tr key={rule.id} className="border-b border-slate-800/50">
                  <td className="px-4 py-2 text-slate-200">{rule.status}</td>
                  <td className="px-4 py-2 text-slate-400">{rule.workflow_type ?? 'any'}</td>
                  <td className="px-4 py-2 text-slate-400">{rule.task_type ?? 'any'}</td>
                  <td className="px-4 py-2">
                    {rule.member_role
                      ? <Badge variant="info">role: {rule.member_role}</Badge>
                      : <span className="text-slate-200">{rule.agent_name ?? `Agent #${rule.agent_id}`}</span>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => api.deleteTeamRoutingRule(teamId, rule.id).then(load).catch(e => setError(String(e)))}
                      className="text-slate-500 hover:text-red-400"
                      aria-label="Delete rule"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ── Context preview ──────────────────────────────────────────────────────────

function ContextTab({ teamId, members }: { teamId: number; members: TeamMember[] }) {
  const [agentId, setAgentId] = useState<string>(() => String(members[0]?.agent_id ?? ''));
  const [preview, setPreview] = useState<TeamContextPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId) return;
    api.previewTeamContext(teamId, Number(agentId))
      .then(setPreview)
      .catch(e => setError(String(e)));
  }, [teamId, agentId]);

  return (
    <div className="space-y-4 max-w-3xl">
      <p className="text-sm text-slate-400">
        The exact text prepended to this member&apos;s prompt on every dispatch.
      </p>
      <select className={inputClass} value={agentId} onChange={e => setAgentId(e.target.value)}>
        <option value="">Select a member…</option>
        {members.map(m => <option key={m.agent_id} value={m.agent_id}>{m.agent_name}</option>)}
      </select>

      {error && <Card className="p-3 border-red-800 text-red-300 text-sm">{error}</Card>}

      {preview && (
        preview.injected ? (
          <Card className="p-4">
            <div className="flex items-center gap-2 mb-3 text-xs text-slate-400">
              <Eye className="w-4 h-4" /> Context version {preview.contextVersion}
            </div>
            <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono">{preview.section}</pre>
          </Card>
        ) : (
          <Card className="p-4 text-sm text-slate-400">
            Nothing would be injected. A member with no teammates, no goal and no working
            agreements learns nothing from the block that its own instructions do not already say,
            so it is omitted rather than spending tokens.
          </Card>
        )
      )}
    </div>
  );
}
