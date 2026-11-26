import type { ProfileChange } from './api';
import { summarizeEnvironmentSetup } from './environmentSetup.ts';

/**
 * What each setting on the Approvals page is, why Agent HQ asks before it runs with it, and where
 * it is changed. Keyed by the change's path, as GET /execution/approvals reports it.
 */
export interface FieldGuide {
  what: string;
  why: string;
  where: { label: string; href: string } | null;
}

export interface FieldContext {
  agentId: number;
  agentName: string;
  workflowId?: number;
  workflowName?: string;
}

const agentPage = (ctx: FieldContext) => ({ label: `${ctx.agentName}’s agent page`, href: `/agents/${ctx.agentId}` });
const workflowPage = (ctx: FieldContext) => ctx.workflowId
  ? { label: `Workflows → ${ctx.workflowName ?? `#${ctx.workflowId}`} → Edit`, href: `/workflows/${ctx.workflowId}` }
  : null;

const FIELDS: Record<string, (ctx: FieldContext) => FieldGuide> = {
  name: ctx => ({ what: 'The name the agent goes by in tasks, notes and its own prompt.', why: 'It is part of what the agent is told about itself.', where: agentPage(ctx) }),
  role: ctx => ({ what: 'The agent’s role, included in its prompt.', why: 'It shapes how the agent understands its job.', where: agentPage(ctx) }),
  model: ctx => ({ what: 'The AI model that runs this agent.', why: 'A different model can behave differently and costs differently.', where: agentPage(ctx) }),
  preferred_provider: ctx => ({ what: 'The provider account that serves the agent’s model.', why: 'It decides whose account the work runs on and is billed to.', where: agentPage(ctx) }),
  runtime_type: ctx => ({ what: 'The program that runs the agent: Claude Code, Codex or OpenClaw.', why: 'Each runtime can do different things on this machine.', where: agentPage(ctx) }),
  runtime_config: ctx => ({ what: 'Settings passed to the runtime, such as its sandbox, approval policy or config folder.', why: 'They decide what the runtime may do on this machine without asking first.', where: agentPage(ctx) }),
  workspace_path: ctx => ({ what: 'The folder on this machine the agent works in when a task has no repository.', why: 'The agent can read and change files there.', where: agentPage(ctx) }),
  hooks_url: ctx => ({ what: 'The address Agent HQ sends this agent’s events to.', why: 'Task data is sent to this address.', where: agentPage(ctx) }),
  hooks_auth_header: ctx => ({ what: 'The secret Agent HQ sends with those events.', why: 'Whoever holds it can pose as Agent HQ to that address.', where: agentPage(ctx) }),
  os_user: ctx => ({ what: 'The user account on this machine that the agent’s commands run as.', why: 'It decides which files and logins the agent can reach.', where: agentPage(ctx) }),
  github_identity_id: ctx => ({ what: 'The GitHub account the agent uses to push code and open pull requests.', why: 'The agent acts on GitHub as that account.', where: agentPage(ctx) }),
  provider_connection_id: ctx => ({ what: 'The model login or API key the agent’s runtime uses.', why: 'The agent’s work runs on, and is billed to, that login.', where: agentPage(ctx) }),
  job_instructions: ctx => ({ what: 'The standing instructions the agent receives with every task.', why: 'They decide what the agent does.', where: agentPage(ctx) }),
  skill_names: ctx => ({ what: 'The skills the agent is given: instructions it can load when a task needs them.', why: 'Each skill adds to what the agent is told to do.', where: agentPage(ctx) }),
  repo_path: ctx => ({ what: 'The repository on this machine the agent works in, through its own git worktree for each task.', why: 'The agent can read and change that code.', where: workflowPage(ctx) }),
  repo_url: ctx => ({ what: 'The repository Agent HQ clones for each task in this workflow.', why: 'The agent can read and change that code.', where: workflowPage(ctx) }),
  repo_access_mode: ctx => ({ what: 'How the agent gets the workflow’s code: its own worktree of a repository on this machine, a fresh clone, or no repository.', why: 'It decides which code the agent can read and change.', where: workflowPage(ctx) }),
  environment_setup: ctx => ({
    what: 'Commands Agent HQ runs in the task’s repository before the agent starts, usually to install the project’s dependencies. It is set on the workflow, so every agent in it gets the same setup, but each agent needs its own approval.',
    why: 'These commands run on this machine, as your user account, before the agent does anything.',
    where: workflowPage(ctx),
  }),
};

function decode(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value); } catch { return value; }
}

/** The guide for one change, or a generic one for a setting this page doesn't know yet. */
export function fieldGuide(change: ProfileChange, ctx: FieldContext): FieldGuide {
  const field = FIELDS[change.path];
  if (field) return field(ctx);
  const [kind, ...rest] = change.path.split('.');
  const key = rest.join('.');
  if (kind === 'skills') {
    return { what: `The text of the skill “${key}”: instructions the agent loads when a task needs them. Every agent with this skill gets the same text.`, why: 'It is part of what the agent is told to do.', where: { label: `Skills → ${key}`, href: `/skills/${encodeURIComponent(key)}` } };
  }
  if (kind === 'skill_files') {
    const skill = key.split('/')[0];
    return { what: `A file that comes with the skill “${skill}”, such as a script or reference the agent may read or run.`, why: 'The agent may run or follow it.', where: { label: `Skills → ${skill}`, href: `/skills/${encodeURIComponent(skill)}` } };
  }
  if (kind === 'teams') {
    return { what: 'A team the agent belongs to: its goal, charter and shared skills, which every member is given.', why: 'It is part of what the agent is told to do.', where: { label: 'The team’s page', href: `/teams/${encodeURIComponent(key)}` } };
  }
  if (kind === 'credentials') {
    const github = key.startsWith('github_identities');
    return {
      what: github ? 'The saved GitHub account record the agent uses.' : 'The saved model login or API key record the agent uses.',
      why: 'Its saved record changed, for example when it was checked again. The secret itself is never shown here.',
      where: github ? { label: 'Settings → GitHub', href: '/settings/github' } : { label: 'Settings → Providers', href: '/settings/providers' },
    };
  }
  if (kind === 'files') {
    return { what: `A file this setup runs from or locks its dependencies with (${key}). Only its fingerprint is compared.`, why: 'A changed file changes what actually runs.', where: null };
  }
  return { what: change.label, why: 'It changes what the agent runs or is told.', where: null };
}

const RUNTIMES: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', openclaw: 'OpenClaw' };

/**
 * A value in plain words, for settings whose saved form is code or JSON. Null means the raw value
 * already reads plainly.
 */
export function describeValue(path: string, value: string | null): string | null {
  if (value === null) {
    if (path === 'repo_access_mode') return 'No repository: the agent works in its own workspace folder.';
    if (path === 'environment_setup') return 'Off: nothing runs before the agent starts.';
    return null;
  }
  const parsed = decode(value);
  if (path === 'environment_setup') {
    const setup = summarizeEnvironmentSetup(parsed);
    if (setup) {
      const lower = setup.description.charAt(0).toLowerCase() + setup.description.slice(1);
      const limit = setup.timeoutSeconds === null ? '' : `It stops after ${setup.timeoutSeconds} seconds.`;
      if (setup.mode === 'off') return `Off: ${lower}`;
      if (setup.mode === 'auto') return `Automatic: ${setup.description}${limit ? ` ${limit}` : ''}`;
      const list = setup.steps.map((step, index) => `${index + 1}. ${step.command}${step.cwd !== '.' ? ` (in ${step.cwd})` : ''}`).join('\n');
      return `Custom: ${lower}\n${list}\n${limit}`.trim();
    }
  }
  if (path === 'repo_access_mode') {
    if (parsed === 'worktree') return 'Worktree: each task gets its own git worktree of a repository on this machine.';
    if (parsed === 'clone') return 'Clone: each task gets a fresh clone of the repository URL.';
  }
  if (path === 'runtime_type' && typeof parsed === 'string') return RUNTIMES[parsed] ?? null;
  if (path === 'skill_names' && Array.isArray(parsed)) return parsed.length > 0 ? parsed.map(String).join(', ') : 'No skills.';
  return null;
}
