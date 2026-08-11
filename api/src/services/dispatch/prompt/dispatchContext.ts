/**
 * The one prompt assembler.
 *
 * WHY ONE
 * Agent HQ used to have two: buildTaskMessage() for routed task work and buildDispatchMessage()
 * for workflow and QA-retry dispatches. They emitted different sections, so the same agent on the
 * same task could be told more on a retry than on its first attempt — the retry carried a
 * workflow goal and project context the first dispatch never saw, while the first dispatch
 * carried workspace paths and a GitHub identity the retry never saw. Nobody could have noticed,
 * because the assembled prompt was not inspectable until the context bundle existed.
 *
 * Now every dispatch path renders through buildDispatchContextDrafts(). A caller supplies what it
 * knows; anything it does not know becomes a not-injected segment with a reason rather than a
 * silent absence.
 *
 * THE ORDER IS THE CONTRACT
 * DISPATCH_CONTEXT_ORDER below is a strict superset of both historical orderings: no section that
 * used to precede another has moved. It reads as an argument the agent works down —
 *
 *   why this work exists   → workflow goal
 *   who is doing it        → team
 *   where it lives         → project context
 *   how this agent works   → job instructions
 *   what to do             → task, skill
 *   what has happened      → task notes
 *   what to produce        → summary request
 *   where on disk          → workspace paths
 *   how to report back     → callback contract
 *   who to commit as       → GitHub identity
 *
 * Identity and purpose lead because they frame how everything after them is read; the mechanical
 * sections trail because they are reference material, not instruction.
 */

import { renderContextBundle, type ContextBundle, type ContextSegmentDraft } from './contextBundle';
import { buildDispatchTaskNotesSegmentDraft, type DispatchTaskNotesContext } from './notes';
import { buildWorkspaceContextSegmentDraft, type DispatchPathContext } from './workspaceContext';
import { buildGitHubIdentitySegmentDraft } from './githubIdentitySegment';
import type { ResolvedGitHubIdentity } from '../../../lib/githubIdentity';
import type { ContextSegmentKind } from './contextBundle';

/** Canonical section order. Exported so tests and the viewer can assert against one source. */
export const DISPATCH_CONTEXT_ORDER: readonly ContextSegmentKind[] = [
  'workflow_goal',
  'team',
  'project_context',
  'job_instructions',
  'task',
  'skill_request',
  'task_notes',
  'summary_request',
  'workspace_path',
  'callback_contract',
  'github_identity',
] as const;

export interface DispatchWorkflowContext {
  id?: number | null;
  name?: string | null;
  goal?: string | null;
}

export interface DispatchTeamContext {
  section: string;
  teamId?: number | null;
  teamName?: string | null;
  contextVersion?: number | null;
}

export interface DispatchProjectContext {
  id?: number | null;
  name?: string | null;
  /** Project prose (projects.context_md). Injected only when both name and prose are present. */
  context?: string | null;
}

export interface DispatchJobContext {
  agentId?: number | null;
  title?: string | null;
  instructions?: string | null;
}

export interface DispatchTaskContext {
  id: number;
  title: string;
  description: string;
  priority: string;
  status: string;
  /** Workflow the task sits in, rendered on the task line. */
  workflowName?: string | null;
}

export interface DispatchContextInput {
  workflow?: DispatchWorkflowContext | null;
  team?: DispatchTeamContext | null;
  project?: DispatchProjectContext | null;
  job?: DispatchJobContext | null;
  task?: DispatchTaskContext | null;
  skillName?: string | null;
  taskNotes?: { context: DispatchTaskNotesContext; taskId: number } | null;
  summaryRequest?: string | null;
  workspace?: DispatchPathContext | null;
  /**
   * Pre-rendered contract segment. Built by the caller because rendering it needs the database
   * and the instance identifiers, which only exist after the run row is created.
   */
  contract?: ContextSegmentDraft | null;
  githubIdentity?: { resolved: ResolvedGitHubIdentity | null; workingDirectory: string | null } | null;
}

function workflowGoalDraft(input: DispatchContextInput): ContextSegmentDraft {
  const workflow = input.workflow;
  const goal = workflow?.goal?.trim() ?? '';
  return {
    kind: 'workflow_goal',
    label: 'Workflow Goal',
    text: goal ? `[Workflow Goal: ${goal}]` : '',
    source: {
      type: 'workflow',
      label: workflow?.name ?? 'No workflow',
      id: workflow?.id ?? null,
      href: workflow?.id ? `/workflows/${workflow.id}` : null,
    },
    notInjectedReason: workflow?.id
      ? 'This workflow has no goal set'
      : 'Dispatch is not scoped to a workflow',
  };
}

function teamDraft(input: DispatchContextInput): ContextSegmentDraft {
  const team = input.team;
  // Trimmed, not merely tested for blankness: a whitespace-only block counts as absent.
  const section = team?.section?.trim() ?? '';
  return {
    kind: 'team',
    label: 'Team Context',
    text: section,
    source: {
      type: 'team',
      label: team?.teamName ?? 'No team resolved',
      id: team?.teamId ?? null,
      version: team?.contextVersion ?? null,
      href: team?.teamId ? `/teams?team=${team.teamId}` : null,
    },
    notInjectedReason: team?.teamId
      ? 'Team resolved but had no goal, charter, or teammates worth rendering'
      : 'No team speaks for this dispatch (see domains/teams/context.ts precedence)',
  };
}

function projectDraft(input: DispatchContextInput): ContextSegmentDraft {
  const project = input.project;
  const prose = project?.context?.trim() ?? '';
  const name = project?.name?.trim() ?? '';
  return {
    kind: 'project_context',
    label: 'Project Context',
    text: name && prose
      ? `--- Project Context: ${name} ---\n${prose}\n--- End Project Context ---`
      : '',
    source: {
      type: 'project',
      label: name || 'No project',
      id: project?.id ?? null,
      href: project?.id ? `/projects/${project.id}` : null,
    },
    notInjectedReason: name
      ? 'Project has no context prose configured'
      : 'Dispatch is not scoped to a project',
  };
}

function jobDraft(input: DispatchContextInput): ContextSegmentDraft {
  const job = input.job;
  return {
    kind: 'job_instructions',
    label: 'Job Instructions',
    text: job?.instructions ?? '',
    source: {
      type: 'job',
      label: job?.title ?? 'Agent job instructions',
      id: job?.agentId ?? null,
      href: job?.agentId ? `/agents/${job.agentId}` : null,
    },
    notInjectedReason: 'This agent has no job instructions configured',
  };
}

function taskDraft(input: DispatchContextInput): ContextSegmentDraft {
  const task = input.task;
  return {
    kind: 'task',
    label: 'Assigned Task',
    text: task
      ? [
        `## Assigned Task`,
        `Task #${task.id}: ${task.title}`,
        `Priority: ${task.priority} | Workflow: ${task.workflowName ?? 'none'}`,
        ``,
        task.description,
      ].join('\n')
      : '',
    source: task
      ? {
        type: 'task',
        label: `Task #${task.id}`,
        id: task.id,
        href: `/tasks?task=${task.id}`,
        detail: {
          priority: task.priority,
          status: task.status,
          workflow: task.workflowName ?? 'none',
        },
      }
      : { type: 'task', label: 'No task' },
    notInjectedReason: 'This dispatch is not task work',
  };
}

function skillDraft(input: DispatchContextInput): ContextSegmentDraft {
  const skillName = input.skillName?.trim() ?? '';
  return {
    kind: 'skill_request',
    label: 'Skill Request',
    text: skillName ? `Run skill: ${skillName}` : '',
    source: {
      type: 'skill',
      label: skillName || 'No skill requested',
      href: skillName ? `/skills?skill=${encodeURIComponent(skillName)}` : null,
    },
    notInjectedReason: 'No skill is configured for this agent',
  };
}

function notesDraft(input: DispatchContextInput): ContextSegmentDraft {
  if (input.taskNotes) {
    return buildDispatchTaskNotesSegmentDraft(input.taskNotes.context, input.taskNotes.taskId);
  }
  return {
    kind: 'task_notes',
    label: 'Task Notes',
    text: '',
    source: { type: 'task_notes', label: 'No task notes' },
    notInjectedReason: 'This dispatch is not task work, so it carries no task notes',
  };
}

function summaryDraft(input: DispatchContextInput): ContextSegmentDraft {
  const summaryRequest = input.summaryRequest?.trim() ?? '';
  return {
    kind: 'summary_request',
    label: 'Summary Request',
    text: summaryRequest,
    source: { type: 'summary_request', label: summaryRequest ? 'Workflow summary request' : 'None' },
    notInjectedReason: 'This dispatch does not ask for a summary',
  };
}

function contractDraft(input: DispatchContextInput): ContextSegmentDraft {
  return input.contract ?? {
    kind: 'callback_contract',
    label: 'Callback Contract',
    text: '',
    source: { type: 'contract_template', label: 'No contract' },
    notInjectedReason: 'No lifecycle contract was rendered for this dispatch',
  };
}

/** Every section this dispatch could carry, in canonical order. */
export function buildDispatchContextDrafts(input: DispatchContextInput): ContextSegmentDraft[] {
  const drafts: ContextSegmentDraft[] = [
    workflowGoalDraft(input),
    teamDraft(input),
    projectDraft(input),
    jobDraft(input),
    taskDraft(input),
    skillDraft(input),
    notesDraft(input),
    summaryDraft(input),
    buildWorkspaceContextSegmentDraft(input.workspace ?? null),
    contractDraft(input),
    buildGitHubIdentitySegmentDraft(
      input.githubIdentity?.resolved ?? null,
      input.githubIdentity?.workingDirectory ?? null,
    ),
  ];

  // Cheap insurance against a future edit reordering a producer: the rendered order is the
  // documented order or the build fails loudly here rather than silently shipping a new prompt.
  const rendered = drafts.map(draft => draft.kind);
  if (rendered.join(',') !== DISPATCH_CONTEXT_ORDER.join(',')) {
    throw new Error(
      `Dispatch context drafts are out of canonical order.\n  expected: ${DISPATCH_CONTEXT_ORDER.join(', ')}\n  actual:   ${rendered.join(', ')}`,
    );
  }

  return drafts;
}

export function buildDispatchContextBundle(input: DispatchContextInput): ContextBundle {
  return renderContextBundle(buildDispatchContextDrafts(input));
}
