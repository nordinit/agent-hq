import type { AtlasWidgetCommand } from './atlasWidget';

export type GettingStartedStatus = 'not_started' | 'choosing' | 'active' | 'dismissed' | 'completed';

export type GettingStartedPartId = 'essentials' | 'advanced';

export interface GettingStartedStep {
  id: string;
  route: string;
  // Short page name for the "Opening …" state while the route loads.
  pageLabel: string;
  // Tried in order; the first one that renders with a visible size gets the spotlight.
  // When none render, the card shows centered without a spotlight.
  selectors: string[];
  title: string;
  description: string;
  continueLabel?: string;
  enterCommand?: AtlasWidgetCommand;
  preferredCardSide?: 'left' | 'right';
}

export interface GettingStartedPart {
  id: GettingStartedPartId;
  label: string;
  title: string;
  summary: string;
  steps: GettingStartedStep[];
}

export interface GettingStartedSnapshot {
  status: GettingStartedStatus;
  partId: GettingStartedPartId;
  stepIndex: number;
  completedParts: GettingStartedPartId[];
}

const STATUS_KEY = 'agent-hq:getting-started:status';
const PART_KEY = 'agent-hq:getting-started:part';
const STEP_KEY = 'agent-hq:getting-started:step';
const COMPLETED_PARTS_KEY = 'agent-hq:getting-started:completed-parts';

export const GETTING_STARTED_CHANGED_EVENT = 'agent-hq:getting-started:changed';

const target = (name: string) => `[data-tour-target="${name}"]`;

const ESSENTIALS_ATLAS_PROMPT = `Help me set up Agent HQ to run my first real task.

My project: <what the project is and what the agents should produce>
My team workflow: <the steps work goes through today, e.g. plan → build → review>

Please help me:
- confirm the project and its Project Context
- choose the first agents and their roles (I plan to use the Claude Code runtime unless you see a reason to use another runtime)
- pick a workflow type and write a Workflow Goal
- set the assignment rules so each status reaches the right agent
- create a first task and check that it dispatches

Separate what base defaults or guided setup already created from optional manual configuration, and keep the starting setup simple.`;

const ADVANCED_ATLAS_PROMPT = `Help me tune my Agent HQ setup now that the basics work.

My project: <what the project is>
What I want to improve: <e.g. fewer manual status changes, a review gate, cheaper models for small tasks>

Please recommend:
- workflow definition changes: status labels, task fields, relationships, and run outcomes
- automatic transitions and gate requirements for my review and QA steps
- a model routing policy for small, medium, and complex tasks
- the capabilities each agent needs, and whether a team would help
- recurring tasks and telemetry metrics worth tracking

Separate base defaults from optional manual configuration and suggest the order to make the changes in.`;

export const GETTING_STARTED_PARTS: GettingStartedPart[] = [
  {
    id: 'essentials',
    label: 'Part 1',
    title: 'Essentials',
    summary: 'Projects, agents, providers, workflows, and routing, through to running and following your first task.',
    steps: [
      {
        id: 'atlas-bubble',
        route: '/',
        pageLabel: 'Dashboard',
        selectors: [target('atlas-chat-bubble')],
        title: 'Atlas is here whenever you need help',
        description: 'Open the Atlas bubble any time for plain-English help. Atlas answers setup questions, explains the page you are on, and turns a description of your workflow into Agent HQ configuration. Part 1 covers what you need to run your first task; Part 2 covers advanced tuning.',
      },
      {
        id: 'dashboard',
        route: '/',
        pageLabel: 'Dashboard',
        selectors: [target('dashboard-overview'), target('dashboard-toolbar')],
        title: 'The dashboard shows what is happening',
        description: 'The Operational overview summarizes active work, recent outcomes, and agent activity. Click a number to inspect the records behind it. You can build your own dashboards later; Part 2 shows how.',
      },
      {
        id: 'projects',
        route: '/projects',
        pageLabel: 'Projects',
        selectors: [target('projects-list')],
        title: 'Projects hold your work',
        description: 'A project groups related tasks, workflows, agents, and context. If you used guided setup, your first project is already here; otherwise use New Project, or Import to bring in an exported project. Open a project to write its Project Context, which is prepended to every agent dispatch.',
      },
      {
        id: 'agents',
        route: '/agents',
        pageLabel: 'Agents',
        selectors: [target('agents-list')],
        title: 'Set up the agents that do the work',
        description: 'Each agent has a role, instructions, and a Runtime Adapter that executes its tasks. We recommend Claude Code for your first agents: it runs tasks through the Claude Code CLI and uses an Anthropic provider connection. Any other runtime your install supports also works, including OpenClaw, Codex, Hermes, and Webhook, and you can change an agent\'s runtime later. Use New Agent, or edit the starter agents from guided setup.',
      },
      {
        id: 'providers',
        route: '/settings/providers',
        pageLabel: 'Providers',
        selectors: [target('settings-providers-main'), target('settings-tabs')],
        title: 'Connect the providers your agents use',
        description: 'Agents need a connected provider to run. Add, rotate, or revalidate credentials here. For Claude Code agents, connect Anthropic. An agent can only select providers that are connected on this page.',
      },
      {
        id: 'workflows',
        route: '/workflows',
        pageLabel: 'Workflows',
        selectors: [target('workflows-list')],
        title: 'Workflows focus a batch of work',
        description: 'A workflow collects a project\'s tasks around a shared goal. Use New Workflow, pick a Workflow Type, and write a Workflow Goal; the goal is added to the payload of every task an agent receives. Clone Workflow Setup copies assignment rules and model routing from an existing workflow, without its tasks. Only tasks in an active workflow are dispatched.',
      },
      {
        id: 'routing',
        route: '/routing',
        pageLabel: 'Task Routing',
        selectors: [target('routing-tabs')],
        title: 'Task Routing decides who works on each task',
        description: 'The Graph tab, open below, shows how tasks move through statuses and which agent picks them up at each step. Choose a project and workflow type above to see a flow. The Assignment Rules tab maps task type and status to an agent; guided setup creates starter rules. Part 2 covers transitions, gates, and events.',
      },
      {
        id: 'tasks',
        route: '/tasks',
        pageLabel: 'Tasks',
        selectors: [target('tasks-board')],
        title: 'Run your first task',
        description: 'Tasks are the core unit of work. Use Create Task, choose its project and workflow, then put it in a status that has an assignment rule. Agent HQ dispatches it to the matching agent once its workflow is active. Click a task to follow its progress, notes, and outcome.',
      },
      {
        id: 'chat',
        route: '/chat',
        pageLabel: 'Chat',
        // On a phone the conversation pane is hidden until a chat is opened, so fall back to the agent list.
        selectors: [target('chat-main-panel'), target('chat-agents-panel')],
        title: 'Follow agent conversations',
        description: 'Chat shows each agent conversation, including what the agent saw and said while it worked on a task. You can also continue a direct conversation with an agent here.',
      },
      {
        id: 'workspaces',
        route: '/workspaces',
        pageLabel: 'Workspaces',
        selectors: [target('workspaces-main')],
        title: 'Workspaces hold what agents produce',
        description: 'Each agent has a workspace. Browse and preview the files agents write while they work, and filter by project.',
      },
      {
        id: 'atlas-customize',
        route: '/',
        pageLabel: 'Dashboard',
        selectors: [target('atlas-widget-composer')],
        title: 'Ask Atlas to tailor your setup',
        description: 'Atlas is open with a starter prompt. Replace the placeholders with your real project and team workflow, then send it for help with your first agents, workflow, and assignment rules. When you are ready, Part 2 covers advanced tuning.',
        continueLabel: 'Finish',
        preferredCardSide: 'left',
        enterCommand: {
          type: 'open-chat-with-draft',
          text: ESSENTIALS_ATLAS_PROMPT,
          focus: true,
        },
      },
    ],
  },
  {
    id: 'advanced',
    label: 'Part 2',
    title: 'Advanced',
    summary: 'Workflow definitions, automation and gates, model routing, capabilities, teams, telemetry, and tenants.',
    steps: [
      {
        id: 'workflow-definitions',
        route: '/workflow-definitions',
        pageLabel: 'Workflow Definitions',
        selectors: [target('workflow-definitions-main')],
        title: 'Workflow Definitions shape every workflow',
        description: 'A workflow definition is a reusable workflow type. Its tabs set the Status Labels tasks move through, the Task Fields they carry, the Relationships between tasks, the Run Outcomes agents can report, and Metrics. Base installs can seed a starter definition; customize it before relying on automation.',
      },
      {
        id: 'routing-automation',
        route: '/routing',
        pageLabel: 'Task Routing',
        selectors: [target('routing-tabs')],
        title: 'Automate transitions and add gates',
        description: 'Automatic Transitions set a task\'s next status when an agent reports a run outcome. Gate Requirements check task evidence before an outcome is accepted, and either block or warn. Workflow Events map events from outside systems to task changes. Agent Contract is the text template injected into every dispatched run for a workflow type.',
      },
      {
        id: 'model-routing',
        route: '/model-routing',
        pageLabel: 'Model Routing',
        selectors: [target('model-routing-main')],
        title: 'Model Routing sets model policy',
        description: 'Model Routing chooses the provider, model, reasoning effort, turn limits, and budget for a dispatch based on the task\'s story points. Set project or workflow-type defaults for normal work, and workflow overrides for special cases.',
      },
      {
        id: 'capabilities',
        route: '/capabilities',
        pageLabel: 'Capabilities',
        selectors: [target('capabilities-main')],
        title: 'Capabilities extend what agents can do',
        description: 'Skills teach agents repeatable procedures, Tools expose callable actions, and MCP Servers connect external systems. Assign each agent only the capabilities it needs.',
      },
      {
        id: 'teams',
        route: '/teams',
        pageLabel: 'Teams',
        selectors: [target('teams-main')],
        title: 'Teams coordinate groups of agents',
        description: 'A team gives its members a shared goal, awareness of who else is working the same problem, a default capability bundle, and a reusable routing shape. Create a team when several agents work together on one problem.',
      },
      {
        id: 'recurring-tasks',
        route: '/tasks/recurring',
        pageLabel: 'Recurring Tasks',
        selectors: [target('recurring-tasks-main')],
        title: 'Recurring Tasks automate repeat work',
        description: 'Recurring Tasks create normal tasks on a schedule inside a fixed workflow. They do not launch agents directly; the generated tasks still follow your workflow and assignment rules.',
      },
      {
        id: 'telemetry',
        route: '/telemetry',
        pageLabel: 'Telemetry',
        selectors: [target('telemetry-tabs')],
        title: 'Telemetry measures how work is going',
        description: 'Explorer answers ad hoc questions about tasks and runs, and Analyze digs into one metric. Save definitions you reuse in the Metric library and Reports. Coverage shows which history has recorded evidence; missing history is excluded or reported as unknown.',
      },
      {
        id: 'dashboard-editing',
        route: '/',
        pageLabel: 'Dashboard',
        selectors: [target('dashboard-toolbar')],
        title: 'Build your own dashboards',
        description: 'Use Edit layout to add sections and blocks, including saved metrics and reports from Telemetry. New dashboard starts from a blank page or the Operational overview template.',
      },
      {
        id: 'settings',
        route: '/settings/notifications',
        pageLabel: 'Settings',
        selectors: [target('settings-tabs')],
        title: 'Settings covers the rest of your install',
        description: 'Notifications controls how you are alerted, GitHub holds the token agents use to open and merge pull requests, OpenClaw Gateway links an OpenClaw runtime, Logs shows system logs, and Display sets interface preferences.',
      },
      {
        id: 'settings-mcp',
        route: '/settings/mcp',
        pageLabel: 'MCP',
        selectors: [target('settings-mcp-main')],
        title: 'Connect external clients',
        description: 'The MCP tab documents the Agent HQ MCP server, so other agents and tools can manage tasks, routing, and telemetry. The API tab is an interactive console for the REST API when you integrate scripts or services.',
      },
      {
        id: 'tenants',
        route: '/settings/tenants',
        pageLabel: 'Tenants',
        selectors: [target('settings-tenants-main')],
        title: 'Tenants keep workspaces separate',
        description: 'Each tenant is an isolated Agent HQ workspace. Create a tenant to keep a client or team separate, and choose which tenant is active here.',
      },
      {
        id: 'atlas-advanced',
        route: '/',
        pageLabel: 'Dashboard',
        selectors: [target('atlas-widget-composer')],
        title: 'Ask Atlas what to tune next',
        description: 'Atlas is open with a tuning prompt. Describe what you want to improve, then send it for recommendations on definitions, gates, model policy, and telemetry.',
        continueLabel: 'Finish',
        preferredCardSide: 'left',
        enterCommand: {
          type: 'open-chat-with-draft',
          text: ADVANCED_ATLAS_PROMPT,
          focus: true,
        },
      },
    ],
  },
];

export function getGettingStartedPart(partId: GettingStartedPartId): GettingStartedPart {
  return GETTING_STARTED_PARTS.find(part => part.id === partId) ?? GETTING_STARTED_PARTS[0];
}

export function getNextGettingStartedPart(partId: GettingStartedPartId): GettingStartedPart | null {
  const index = GETTING_STARTED_PARTS.findIndex(part => part.id === partId);
  return GETTING_STARTED_PARTS[index + 1] ?? null;
}

function isPartId(value: unknown): value is GettingStartedPartId {
  return GETTING_STARTED_PARTS.some(part => part.id === value);
}

function clampStepIndex(partId: GettingStartedPartId, stepIndex: number): number {
  const lastIndex = Math.max(0, getGettingStartedPart(partId).steps.length - 1);
  if (!Number.isFinite(stepIndex)) return 0;
  return Math.min(Math.max(Math.trunc(stepIndex), 0), lastIndex);
}

function emitChange() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(GETTING_STARTED_CHANGED_EVENT, { detail: getGettingStartedSnapshot() }));
}

function readStatus(): GettingStartedStatus {
  const raw = localStorage.getItem(STATUS_KEY);
  if (raw === 'choosing' || raw === 'active' || raw === 'dismissed' || raw === 'completed') return raw;
  return 'not_started';
}

function readPartId(): GettingStartedPartId {
  const raw = localStorage.getItem(PART_KEY);
  return isPartId(raw) ? raw : 'essentials';
}

function readCompletedParts(): GettingStartedPartId[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COMPLETED_PARTS_KEY) ?? '[]');
    return Array.isArray(parsed) ? GETTING_STARTED_PARTS.map(part => part.id).filter(id => parsed.includes(id)) : [];
  } catch {
    return [];
  }
}

export function getGettingStartedSnapshot(): GettingStartedSnapshot {
  if (typeof window === 'undefined') {
    return { status: 'not_started', partId: 'essentials', stepIndex: 0, completedParts: [] };
  }
  const partId = readPartId();
  return {
    status: readStatus(),
    partId,
    stepIndex: clampStepIndex(partId, Number(localStorage.getItem(STEP_KEY) ?? '0')),
    completedParts: readCompletedParts(),
  };
}

export function beginGettingStartedGuide(partId: GettingStartedPartId = 'essentials', stepIndex = 0) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STATUS_KEY, 'active');
  localStorage.setItem(PART_KEY, partId);
  localStorage.setItem(STEP_KEY, String(clampStepIndex(partId, stepIndex)));
  emitChange();
}

// The sidebar's Getting Started button opens this chooser so either part can be started or replayed.
export function openGettingStartedChooser() {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STATUS_KEY, 'choosing');
  emitChange();
}

export function setGettingStartedStep(stepIndex: number) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STEP_KEY, String(clampStepIndex(readPartId(), stepIndex)));
  emitChange();
}

export function dismissGettingStartedGuide() {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STATUS_KEY, 'dismissed');
  emitChange();
}

export function completeGettingStartedPart() {
  if (typeof window === 'undefined') return;
  const partId = readPartId();
  const completed = new Set(readCompletedParts());
  completed.add(partId);
  localStorage.setItem(COMPLETED_PARTS_KEY, JSON.stringify(GETTING_STARTED_PARTS.map(part => part.id).filter(id => completed.has(id))));
  localStorage.setItem(STATUS_KEY, 'completed');
  emitChange();
}
