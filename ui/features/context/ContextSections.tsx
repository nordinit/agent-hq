'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { Plus, RotateCcw, X } from 'lucide-react';
import type {
  AgentContextSources,
  ContextMcpServer,
  EditableText,
  RecordedMcpServer,
  TaskContextSources,
} from '@/lib/api';
import { formatEstimatedTokens, TOKEN_ESTIMATE_HINT } from '@/lib/tokenCounts';
import type { StagedChanges } from './stagedChanges';

const fieldClass =
  'w-full rounded-lg border border-slate-700 bg-slate-950/60 px-3 py-2 font-mono text-xs leading-relaxed text-slate-100 focus:border-amber-400 focus:outline-none';

function Size({ chars }: { chars: number }) {
  return (
    <span className="tabular-nums text-slate-400" title={TOKEN_ESTIMATE_HINT}>
      {formatEstimatedTokens(chars)} · {chars.toLocaleString('en-US')} chars
    </span>
  );
}

export function Section({ title, hint, children, aside }: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  aside?: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <header className="mb-3 flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

/** A text source with its loaded value, the staged value if any, and a revert. */
function TextSource({
  title,
  hint,
  source,
  stagedValue,
  rows = 10,
  onChange,
}: {
  title: string;
  hint: string;
  source: EditableText;
  stagedValue: string | undefined;
  rows?: number;
  onChange: (value: string) => void;
}) {
  const value = stagedValue ?? source.value;
  const dirty = stagedValue !== undefined;
  return (
    <Section
      title={title}
      hint={hint}
      aside={(
        <div className="flex items-center gap-2 text-[11px]">
          {dirty && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">staged</span>}
          <Size chars={value.length} />
          {dirty && (
            <button
              type="button"
              onClick={() => onChange(source.value)}
              className="inline-flex items-center gap-1 rounded border border-slate-700 px-1.5 py-0.5 text-slate-300 hover:border-amber-500/40 hover:text-amber-300"
            >
              <RotateCcw className="h-3 w-3" /> Revert
            </button>
          )}
        </div>
      )}
    >
      <textarea
        value={value}
        rows={rows}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
        spellCheck={false}
      />
    </Section>
  );
}

// ── Instructions & skills ────────────────────────────────────────────────────

export function InstructionsAndSkills({ sources, staged }: { sources: AgentContextSources; staged: StagedChanges }) {
  const { agent } = sources;
  const instructionsKey = `job_instructions:agent:${agent.id}`;
  const skillsKey = `agent_skills:agent:${agent.id}`;
  const ownSkills = staged.valueFor<string[]>(skillsKey) ?? agent.ownSkillNames.value;
  const teamSkills = sources.skills.filter((skill) => skill.source === 'team').map((skill) => skill.name);
  const [adding, setAdding] = useState('');
  const byName = useMemo(() => new Map(sources.availableSkills.map((skill) => [skill.name, skill])), [sources.availableSkills]);
  const known = useMemo(() => new Map(sources.skills.map((skill) => [skill.name, skill])), [sources.skills]);
  const shown = [...new Set([...ownSkills, ...teamSkills])];
  const listingChars = shown.reduce((sum, name) => {
    const description = known.get(name)?.description ?? byName.get(name)?.description ?? '';
    return sum + name.length + description.length;
  }, 0);

  const setOwnSkills = (next: string[]) =>
    staged.stage(`${agent.name}: skills`, {
      kind: 'agent_skills', agent_id: agent.id, base_hash: agent.ownSkillNames.hash, value: next,
    }, agent.ownSkillNames.value);

  return (
    <div className="space-y-4">
      <TextSource
        title="Job instructions"
        hint={`Sent at the top of every ${agent.name} run. Part of the agent's approved profile: publishing re-approves ${agent.name}.`}
        source={agent.jobInstructions}
        stagedValue={staged.valueFor<string>(instructionsKey)}
        rows={18}
        onChange={(value) => staged.stage(`${agent.name}: job instructions`, {
          kind: 'job_instructions', agent_id: agent.id, base_hash: agent.jobInstructions.hash, value,
        }, agent.jobInstructions.value)}
      />

      <Section
        title="Skills"
        hint={sources.skillDelivery.summary}
        aside={<span className="text-[11px]">Listed: <Size chars={listingChars} /></span>}
      >
        {shown.length === 0 && <p className="text-xs text-slate-500">No skills assigned.</p>}
        <ul className="space-y-2">
          {shown.map((name) => {
            const skill = known.get(name);
            const fromTeam = teamSkills.includes(name) && !ownSkills.includes(name);
            const added = !agent.ownSkillNames.value.includes(name) && ownSkills.includes(name);
            return (
              <li key={name} className="rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-amber-200">
                    {agent.runtimeType === 'claude-code' ? `agent-hq:${name}` : name}
                  </span>
                  {fromTeam && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">from team</span>}
                  {added && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">staged</span>}
                  {skill && (
                    <span className="text-[11px] text-slate-500">
                      full skill {formatEstimatedTokens(skill.contentChars)}{skill.fileCount ? ` + ${skill.fileCount} file(s)` : ''}, loaded on demand
                    </span>
                  )}
                  {!fromTeam && (
                    <button
                      type="button"
                      onClick={() => setOwnSkills(ownSkills.filter((entry) => entry !== name))}
                      className="ml-auto rounded p-1 text-slate-500 hover:bg-slate-800 hover:text-red-300"
                      title="Remove this skill"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-400">{skill?.description ?? byName.get(name)?.description ?? ''}</p>
              </li>
            );
          })}
        </ul>
        {agent.ownSkillNames.value.filter((name) => !ownSkills.includes(name)).map((name) => (
          <p key={name} className="mt-2 text-xs text-amber-300">Removing {name} (staged)</p>
        ))}
        <div className="mt-3 flex items-center gap-2">
          <select
            value={adding}
            onChange={(event) => setAdding(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950/60 px-2 py-1.5 text-xs text-slate-200"
          >
            <option value="">Add a skill…</option>
            {sources.availableSkills.filter((skill) => !shown.includes(skill.name)).map((skill) => (
              <option key={skill.name} value={skill.name}>{skill.name}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={!adding}
            onClick={() => { setOwnSkills([...ownSkills, adding]); setAdding(''); }}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1.5 text-xs text-slate-200 hover:border-amber-500/40 disabled:opacity-40"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>
      </Section>

      {sources.teams.length > 0 && (
        <Section title="Team context" hint="Rendered into every run of a team member. Edit it on the team page.">
          <ul className="space-y-1 text-xs">
            {sources.teams.map((team) => (
              <li key={team.id} className="flex items-center gap-2">
                <Link href={`/teams?team=${team.id}`} className="text-amber-300 hover:underline">{team.name}</Link>
                <Size chars={team.goalChars + team.charterChars} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// ── Tools ────────────────────────────────────────────────────────────────────

function mcpVisibility(runtimeType: string | null): string {
  if (runtimeType === 'claude-code') {
    return 'Claude Code offers every tool on a server to the model (large sets may sit behind tool search); only allowed tools can run.';
  }
  if (runtimeType === 'codex') return 'Codex offers only the allowed tools to the model.';
  return 'Allowed tools are the ones this agent may call.';
}

function McpServerCard({ server, recorded, agentId, agentName, runtimeType, staged }: {
  server: ContextMcpServer;
  recorded: RecordedMcpServer | null;
  agentId: number;
  agentName: string;
  runtimeType: string | null;
  staged: StagedChanges;
}) {
  const key = `mcp_allowlist:agent:${agentId}:server:${server.mcpServerId}`;
  const stagedList = staged.valueFor<string[]>(key);
  const allowlist = stagedList ?? server.allowlist.value;
  const unrestricted = stagedList ? stagedList.length === 0 : server.unrestricted;
  const tools = recorded?.tools ?? [];
  const allowed = (name: string) => unrestricted || allowlist.includes(name);
  const allowedChars = tools.filter((tool) => allowed(tool.name)).reduce((sum, tool) => sum + tool.chars, 0);
  const offeredChars = runtimeType === 'codex' ? allowedChars : recorded?.definitionChars ?? 0;
  const setAllowlist = (next: string[]) => staged.stage(`${agentName}: ${server.slug} tools`, {
    kind: 'mcp_allowlist', agent_id: agentId, mcp_server_id: server.mcpServerId, base_hash: server.allowlist.hash, value: next,
  }, server.unrestricted ? [] : server.allowlist.value);
  // Allowlisted names the server no longer advertises still count for the run; show them.
  const missing = unrestricted ? [] : allowlist.filter((name) => !tools.some((tool) => tool.name === name));

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-amber-200">{server.slug}</span>
        {server.teamName && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">team {server.teamName}</span>}
        {!server.enabled && <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-300">disabled</span>}
        {stagedList && <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">staged</span>}
        <span className="text-[11px] text-slate-500">
          {unrestricted ? 'all tools allowed' : `${allowlist.length} allowed`}{recorded ? ` of ${recorded.toolCount}` : ''}
        </span>
        {recorded && <span className="ml-auto text-[11px]">Offered: <Size chars={offeredChars} /></span>}
      </div>
      {server.editable && recorded && (
        <label className="mt-2 inline-flex items-center gap-2 text-xs text-slate-300">
          <input
            type="checkbox"
            checked={unrestricted}
            onChange={(event) => setAllowlist(event.target.checked ? [] : tools.map((tool) => tool.name))}
          />
          Allow every tool on this server
        </label>
      )}
      {!recorded ? (
        <p className="mt-2 text-xs text-slate-500">No tool list recorded yet. It is captured on this agent’s next run.</p>
      ) : (
        <ul className="mt-2 max-h-80 space-y-0.5 overflow-y-auto">
          {tools.map((tool) => (
            <li key={tool.name} className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={allowed(tool.name)}
                disabled={!server.editable || unrestricted}
                onChange={(event) => setAllowlist(event.target.checked
                  ? [...allowlist, tool.name]
                  : allowlist.filter((name) => name !== tool.name))}
              />
              <span className={`font-mono ${allowed(tool.name) ? 'text-slate-200' : 'text-slate-500'}`}>{tool.name}</span>
              <span className="min-w-0 flex-1 truncate text-slate-500" title={tool.description}>{tool.description}</span>
              <span className="shrink-0 tabular-nums text-slate-500">{formatEstimatedTokens(tool.chars)}</span>
            </li>
          ))}
          {missing.map((name) => (
            <li key={name} className="text-xs text-amber-300">{name}: allowed, but the server did not advertise it</li>
          ))}
        </ul>
      )}
      {!server.editable && <p className="mt-2 text-[11px] text-slate-500">Assigned through a team; edit it on the team page.</p>}
      {recorded?.capturedAt && <p className="mt-1 text-[10px] text-slate-600">Tool list recorded {new Date(recorded.capturedAt).toLocaleString()}</p>}
    </div>
  );
}

export function ToolsSection({ sources, runServers, staged }: {
  sources: AgentContextSources;
  /** Tool lists recorded for the selected run, when one is selected. */
  runServers: RecordedMcpServer[] | null;
  staged: StagedChanges;
}) {
  const { agent, tools } = sources;
  const byRunName = new Map((runServers ?? []).map((server) => [server.serverName, server]));
  const others = runServers
    ? runServers.filter((server) => !tools.mcpServers.some((assigned) => assigned.runName === server.serverName))
    : tools.otherServers;

  return (
    <div className="space-y-4">
      <Section title="Built-in tools" hint="The runtime’s own tools this agent may use.">
        <div className="flex flex-wrap gap-1.5">
          {tools.builtIn.length === 0 && <span className="text-xs text-slate-500">None</span>}
          {tools.builtIn.map((name) => (
            <span key={name} className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-200">{name}</span>
          ))}
        </div>
      </Section>

      <Section
        title="Agent HQ tools"
        hint={`Registry tools assigned directly in Agent HQ, not through an MCP server. ${tools.registryDelivery}`}
        aside={<span className="text-[11px]"><Size chars={tools.registry.reduce((sum, tool) => sum + tool.definitionChars, 0)} /></span>}
      >
        {tools.registry.length === 0 ? <p className="text-xs text-slate-500">None assigned.</p> : (
          <ul className="space-y-1">
            {tools.registry.map((tool) => (
              <li key={tool.id} className="flex items-start gap-2 text-xs">
                <span className="font-mono text-slate-200">{tool.slug}</span>
                {tool.teamName && <span className="rounded bg-slate-800 px-1.5 text-[10px] text-slate-300">team {tool.teamName}</span>}
                <span className="min-w-0 flex-1 truncate text-slate-500" title={tool.description}>{tool.description}</span>
                <span className="shrink-0 tabular-nums text-slate-500">{formatEstimatedTokens(tool.definitionChars)}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="MCP servers" hint={mcpVisibility(agent.runtimeType)}>
        <div className="space-y-3">
          {tools.mcpServers.length === 0 && <p className="text-xs text-slate-500">No MCP servers assigned.</p>}
          {tools.mcpServers.map((server) => (
            <McpServerCard
              key={server.mcpServerId}
              server={server}
              recorded={runServers ? byRunName.get(server.runName) ?? null : server.recorded}
              agentId={agent.id}
              agentName={agent.name}
              runtimeType={agent.runtimeType}
              staged={staged}
            />
          ))}
          {others.map((server) => (
            <div key={server.serverName} className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-slate-200">{server.serverName}</span>
                <span className="text-[11px] text-slate-500">{server.toolCount} tool(s), managed by Agent HQ</span>
                <span className="ml-auto text-[11px]"><Size chars={server.definitionChars} /></span>
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

// ── Workflow, project and task ───────────────────────────────────────────────

export function WorkflowAndProject({ sources, workflowId, staged }: {
  sources: AgentContextSources;
  workflowId: number | null;
  staged: StagedChanges;
}) {
  const workflow = sources.workflows.find((entry) => entry.id === workflowId) ?? null;
  if (!workflow) {
    return <p className="text-sm text-slate-400">Pick a workflow on the left to see and edit its goal and project context.</p>;
  }
  const project = sources.projects.find((entry) => entry.id === workflow.projectId) ?? null;
  return (
    <div className="space-y-4">
      <TextSource
        title={`Workflow goal: ${workflow.name}`}
        hint="Rendered into every run of a task in this workflow, for every agent."
        source={workflow.goal}
        stagedValue={staged.valueFor<string>(`workflow_goal:workflow:${workflow.id}`)}
        rows={6}
        onChange={(value) => staged.stage(`${workflow.name}: goal`, {
          kind: 'workflow_goal', workflow_id: workflow.id, base_hash: workflow.goal.hash, value,
        }, workflow.goal.value)}
      />
      {project && (
        <TextSource
          title={`Project context: ${project.name}`}
          hint="Rendered into every run in this project, for every agent."
          source={project.contextMd}
          stagedValue={staged.valueFor<string>(`project_context:project:${project.id}`)}
          rows={12}
          onChange={(value) => staged.stage(`${project.name}: project context`, {
            kind: 'project_context', project_id: project.id, base_hash: project.contextMd.hash, value,
          }, project.contextMd.value)}
        />
      )}
    </div>
  );
}

export function TaskSection({ task, staged }: { task: TaskContextSources | null; staged: StagedChanges }) {
  if (!task) return <p className="text-sm text-slate-400">Pick a run on the left to see and edit its task.</p>;
  return (
    <div className="space-y-4">
      <TextSource
        title={`Task #${task.task.id}: ${task.task.title}`}
        hint="This task’s description, rendered into each of its runs."
        source={task.task.description}
        stagedValue={staged.valueFor<string>(`task_description:task:${task.task.id}`)}
        rows={10}
        onChange={(value) => staged.stage(`Task #${task.task.id}: description`, {
          kind: 'task_description', task_id: task.task.id, base_hash: task.task.description.hash, value,
        }, task.task.description.value)}
      />
      {task.series && (
        <TextSource
          title={`Recurring series #${task.series.id}: ${task.series.titleTemplate}`}
          hint={`The description template for every task this series creates (${task.series.schedule}${task.series.enabled ? '' : ', paused'}). Existing tasks keep their own description.`}
          source={task.series.descriptionTemplate}
          stagedValue={staged.valueFor<string>(`series_template:series:${task.series.id}`)}
          rows={12}
          onChange={(value) => staged.stage(`Series #${task.series!.id}: template`, {
            kind: 'series_template', series_id: task.series!.id, base_hash: task.series!.descriptionTemplate.hash, value,
          }, task.series!.descriptionTemplate.value)}
        />
      )}
    </div>
  );
}
