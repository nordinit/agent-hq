/**
 * The unified assembler, and the record of what unifying it changed.
 *
 * Agent HQ used to assemble two different prompts. The tests below pin the canonical order, and
 * the "closes the divergence" block states plainly which sections each dispatch path gained —
 * because this was a deliberate behaviour change to what agents receive, and a behaviour change
 * with no test naming it is indistinguishable from a regression six months later.
 */

import {
  buildDispatchContextBundle,
  buildDispatchContextDrafts,
  DISPATCH_CONTEXT_ORDER,
  type DispatchContextInput,
} from './dispatchContext';
import { segmentText } from './contextBundle';
import type { DispatchTaskNotesContext } from './notes';

const TEAM_SECTION = '--- Team: Delivery Squad ---\nGoal: Ship it.\n--- End Team ---';

const NOTES: DispatchTaskNotesContext = {
  firstRun: true,
  cutoff: null,
  totalNotes: 1,
  includedNotes: [{ created_at: '2026-08-10 09:00:00', author: 'piper', content: 'Spec confirmed.' }],
  truncated: false,
};

/** A routed task dispatch with everything resolvable resolved. */
const FULL_TASK_DISPATCH: DispatchContextInput = {
  workflow: { id: 42, name: 'Runtime Refactor', goal: 'Ship the refactor.' },
  team: { section: TEAM_SECTION, teamId: 7, teamName: 'Delivery Squad', contextVersion: 3 },
  project: { id: 86, name: 'Agent HQ', context: 'Monorepo with api/ and ui/.' },
  job: { agentId: 9, title: 'Backend Engineer', instructions: 'Do the backend work.' },
  task: {
    id: 814,
    title: 'Extract dispatcher builders',
    description: 'Move pure helpers into dispatch modules.',
    priority: 'medium',
    status: 'ready',
    workflowName: 'Runtime Refactor',
  },
  taskNotes: { context: NOTES, taskId: 814 },
  workspace: {
    activeRepoRoot: '/Users/dev/workspaces/task-814',
    workspaceContainerRoot: '/Users/dev/workspaces',
    worktreeRoot: '/Users/dev/workspaces/task-814',
    runtimeConfigWorkingDirectory: null,
    pathMode: 'worktree',
    repoRootSource: 'worktree',
    workspaceContainerSource: 'workspace',
  },
  contract: {
    kind: 'callback_contract',
    label: 'Callback Contract',
    text: '## Agent HQ Task Contract\nReport outcomes through MCP.',
    source: { type: 'contract_template', label: 'generic' },
  },
  githubIdentity: {
    resolved: {
      identity: {
        id: 4, tenant_id: 1, github_username: 'nova-bot', token: 'secret',
        git_author_name: 'Nova', git_author_email: 'nova@example.com', lane: 'backend', enabled: 1,
      },
      dedicated: true,
    },
    workingDirectory: '/Users/dev/workspaces/task-814',
  },
};

/** A non-task dispatch: no task, no repo, no notes. */
const NON_TASK_DISPATCH: DispatchContextInput = {
  workflow: { id: 42, name: 'Runtime Refactor', goal: 'Ship the refactor.' },
  team: { section: TEAM_SECTION, teamId: 7, teamName: 'Delivery Squad', contextVersion: 3 },
  project: { id: 86, name: 'Agent HQ', context: 'Monorepo with api/ and ui/.' },
  job: { agentId: 9, title: 'Backend Engineer', instructions: 'Do the backend work.' },
  contract: {
    kind: 'callback_contract',
    label: 'Completion Contract',
    text: '## Completion contract',
    source: { type: 'contract_template', label: 'completion' },
  },
};

describe('canonical section order', () => {
  it('is the same list for every dispatch path', () => {
    for (const input of [FULL_TASK_DISPATCH, NON_TASK_DISPATCH, {}]) {
      expect(buildDispatchContextDrafts(input).map(d => d.kind)).toEqual([...DISPATCH_CONTEXT_ORDER]);
    }
  });

  it('leads with purpose and identity, and trails with the mechanical sections', () => {
    // Pinned literally: the order is the contract with every agent, not an implementation detail.
    expect([...DISPATCH_CONTEXT_ORDER]).toEqual([
      'workflow_goal',
      'team',
      'project_context',
      'job_instructions',
      'task',
      'task_notes',
      'workspace_path',
      'callback_contract',
      'github_identity',
    ]);
  });

  it('preserves order in the rendered prompt', () => {
    const bundle = buildDispatchContextBundle(FULL_TASK_DISPATCH);
    const injected = bundle.segments.filter(s => s.injected);
    for (let i = 1; i < injected.length; i += 1) {
      expect(injected[i].start).toBeGreaterThanOrEqual(injected[i - 1].end);
    }
    expect(injected.map(s => s.kind)).toEqual([
      'workflow_goal', 'team', 'project_context', 'job_instructions', 'task',
      'task_notes', 'workspace_path', 'callback_contract', 'github_identity',
    ]);
  });
});

describe('unification closes the divergence between the two old builders', () => {
  it('gives a routed task dispatch the workflow goal and project context it never had', () => {
    // Before unification these two were emitted only by the workflow/QA builder.
    const bundle = buildDispatchContextBundle(FULL_TASK_DISPATCH);
    const byKind = new Map(bundle.segments.map(s => [s.kind, s]));

    expect(byKind.get('workflow_goal')!.injected).toBe(true);
    expect(segmentText(bundle, byKind.get('workflow_goal')!)).toBe('[Workflow Goal: Ship the refactor.]');
    expect(byKind.get('project_context')!.injected).toBe(true);
    expect(segmentText(bundle, byKind.get('project_context')!))
      .toBe('--- Project Context: Agent HQ ---\nMonorepo with api/ and ui/.\n--- End Project Context ---');
  });

  it('gives a workflow-shaped dispatch the task, workspace and identity sections when it has them', () => {
    // Before unification these three were emitted only by the task builder, so a QA retry of a
    // task carried no Assigned Task block, no workspace paths and no GitHub identity.
    const qaRetry: DispatchContextInput = {
      ...NON_TASK_DISPATCH,
      task: FULL_TASK_DISPATCH.task,
      taskNotes: FULL_TASK_DISPATCH.taskNotes,
      workspace: FULL_TASK_DISPATCH.workspace,
      githubIdentity: FULL_TASK_DISPATCH.githubIdentity,
    };
    const bundle = buildDispatchContextBundle(qaRetry);
    const byKind = new Map(bundle.segments.map(s => [s.kind, s]));

    expect(byKind.get('task')!.injected).toBe(true);
    expect(segmentText(bundle, byKind.get('task')!)).toContain('## Assigned Task');
    expect(byKind.get('workspace_path')!.injected).toBe(true);
    expect(segmentText(bundle, byKind.get('workspace_path')!)).toContain('## Active Workspace Context');
    expect(byKind.get('github_identity')!.injected).toBe(true);
    expect(segmentText(bundle, byKind.get('github_identity')!)).toContain('nova-bot');
  });
});

describe('sections a dispatch genuinely lacks say so', () => {
  it('explains every absent section on a non-task dispatch', () => {
    const bundle = buildDispatchContextBundle(NON_TASK_DISPATCH);
    const absent = bundle.segments.filter(s => !s.injected);

    expect(absent.map(s => s.kind)).toEqual(['task', 'task_notes', 'workspace_path', 'github_identity']);
    for (const segment of absent) {
      expect(segment.omission?.reason).toBeTruthy();
      expect(segment.chars).toBe(0);
    }
    expect(bundle.segments.find(s => s.kind === 'task')!.omission?.reason).toMatch(/not task work/);
    expect(bundle.segments.find(s => s.kind === 'workspace_path')!.omission?.reason).toMatch(/no worktree/);
  });

  it('distinguishes "no team resolved" from "team resolved but empty"', () => {
    const none = buildDispatchContextBundle({}).segments.find(s => s.kind === 'team')!;
    expect(none.omission?.reason).toMatch(/No team speaks/);

    const empty = buildDispatchContextBundle({
      team: { section: '   \n ', teamId: 7, teamName: 'Delivery Squad', contextVersion: 3 },
    }).segments.find(s => s.kind === 'team')!;
    expect(empty.injected).toBe(false);
    expect(empty.omission?.reason).toMatch(/no goal, charter, or teammates/);
  });

  it('distinguishes "no project" from "project without prose"', () => {
    expect(buildDispatchContextBundle({}).segments.find(s => s.kind === 'project_context')!.omission?.reason)
      .toMatch(/not scoped to a project/);
    expect(buildDispatchContextBundle({ project: { id: 86, name: 'Agent HQ', context: '' } })
      .segments.find(s => s.kind === 'project_context')!.omission?.reason)
      .toMatch(/no context prose/);
  });

  it('renders nothing at all when a dispatch supplies nothing', () => {
    const bundle = buildDispatchContextBundle({});
    expect(bundle.promptText).toBe('');
    expect(bundle.segments.every(s => !s.injected)).toBe(true);
    expect(bundle.segments).toHaveLength(DISPATCH_CONTEXT_ORDER.length);
  });
});

describe('section content', () => {
  it('renders the assigned task block with priority and workflow', () => {
    const bundle = buildDispatchContextBundle(FULL_TASK_DISPATCH);
    const task = bundle.segments.find(s => s.kind === 'task')!;
    expect(segmentText(bundle, task)).toBe([
      '## Assigned Task',
      'Task #814: Extract dispatcher builders',
      'Priority: medium | Workflow: Runtime Refactor',
      '',
      'Move pure helpers into dispatch modules.',
    ].join('\n'));
  });

  it('falls back to "none" when a task sits in no workflow', () => {
    const bundle = buildDispatchContextBundle({
      task: { ...FULL_TASK_DISPATCH.task!, workflowName: null },
    });
    expect(segmentText(bundle, bundle.segments.find(s => s.kind === 'task')!))
      .toContain('Priority: medium | Workflow: none');
  });

  it('carries the note cap through as an omission with counts', () => {
    const bundle = buildDispatchContextBundle({
      ...FULL_TASK_DISPATCH,
      taskNotes: { context: { ...NOTES, totalNotes: 40, truncated: true }, taskId: 814 },
    });
    const notes = bundle.segments.find(s => s.kind === 'task_notes')!;
    expect(notes.injected).toBe(true);
    expect(notes.omission).toMatchObject({ includedCount: 1, totalCount: 40 });
  });

  it('links each section back to the record it came from', () => {
    const bundle = buildDispatchContextBundle(FULL_TASK_DISPATCH);
    const byKind = new Map(bundle.segments.map(s => [s.kind, s]));

    expect(byKind.get('team')!.source).toMatchObject({ type: 'team', id: 7, version: 3, href: '/teams?team=7' });
    expect(byKind.get('job_instructions')!.source).toMatchObject({ type: 'job', id: 9, href: '/agents/9' });
    expect(byKind.get('task')!.source).toMatchObject({ type: 'task', id: 814, href: '/tasks?task=814' });
    expect(byKind.get('project_context')!.source).toMatchObject({ type: 'project', id: 86, href: '/projects/86' });
    expect(byKind.get('workflow_goal')!.source).toMatchObject({ type: 'workflow', id: 42 });
  });

  it('reassembles the prompt from its segment spans', () => {
    const bundle = buildDispatchContextBundle(FULL_TASK_DISPATCH);
    let rebuilt = '';
    let cursor = 0;
    for (const segment of bundle.segments.filter(s => s.injected)) {
      rebuilt += bundle.promptText.slice(cursor, segment.start) + segmentText(bundle, segment);
      cursor = segment.end;
    }
    expect(rebuilt + bundle.promptText.slice(cursor)).toBe(bundle.promptText);
  });
});
