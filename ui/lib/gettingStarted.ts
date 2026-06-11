import type { AtlasWidgetCommand } from './atlasWidget';

export type GettingStartedStatus = 'not_started' | 'active' | 'dismissed' | 'completed';

export interface GettingStartedStep {
  id: string;
  route: string;
  selector: string;
  title: string;
  description: string;
  continueLabel?: string;
  enterCommand?: AtlasWidgetCommand;
  preferredCardSide?: 'left' | 'right';
}

export interface GettingStartedSnapshot {
  status: GettingStartedStatus;
  stepIndex: number;
}

const STATUS_KEY = 'agent-hq:getting-started:status';
const STEP_KEY = 'agent-hq:getting-started:step';

export const GETTING_STARTED_CHANGED_EVENT = 'agent-hq:getting-started:changed';

export const GETTING_STARTED_STEPS: GettingStartedStep[] = [
  {
    id: 'atlas-bubble',
    route: '/',
    selector: '[data-tour-target="atlas-chat-bubble"]',
    title: 'Atlas can help while you configure',
    description: 'Use the Atlas bubble when you want plain-English help. It can answer setup questions, explain pages, and help translate your workflow into Agent HQ configuration.',
  },
  {
    id: 'dashboard',
    route: '/',
    selector: '[data-tour-target="dashboard-overview"]',
    title: 'Start from the dashboard',
    description: 'The dashboard is the control center for a fresh install. It summarizes active work, recent outcomes, and quick paths into the setup and monitoring pages.',
  },
  {
    id: 'projects',
    route: '/projects',
    selector: '[data-tour-target="projects-list"]',
    title: 'Create or import your first project',
    description: 'Projects group related tasks, workflows, agents, and context files. Base installs may include sample defaults, but your first real setup step is creating or importing the project your agents will work on.',
  },
  {
    id: 'agents',
    route: '/agents',
    selector: '[data-tour-target="agents-list"]',
    title: 'Configure the agents that will do the work',
    description: 'Agents define roles, runtime settings, workspace instructions, and project ownership. Start with the seeded agents if they fit, then add or edit agents for the workflows your project actually needs.',
  },
  {
    id: 'capabilities',
    route: '/capabilities',
    selector: '[data-tour-target="capabilities-main"]',
    title: 'Capabilities are the agent toolbox',
    description: 'Capabilities combines Skills, Tools, and MCP servers. Skills teach agents repeatable procedures, Tools expose callable actions, and MCP servers connect Agent HQ to structured external capabilities.',
  },
  {
    id: 'workflows',
    route: '/workflows',
    selector: '[data-tour-target="sprints-list"]',
    title: 'Workflows organize current work',
    description: 'Workflows focus a batch of tasks for a project. Use them to separate backlog work from active execution and to give assignment rules a concrete workflow context.',
  },
  {
    id: 'workflow-definitions',
    route: '/workflow-definitions',
    selector: '[data-tour-target="sprint-definitions-main"]',
    title: 'Workflow Definitions set workflow defaults',
    description: 'Workflow Definitions define reusable workflow types, task types, statuses, outcomes, gates, and task fields. Base installs can seed a starter workflow; customize it before relying on automation.',
  },
  {
    id: 'routing',
    route: '/routing',
    selector: '[data-tour-target="routing-rules"]',
    title: 'Assignment Rules decide who gets each task',
    description: 'Assignment Rules map workflow type, task type, and status to agents. Configure them alongside transitions and gates so tasks move predictably from planning through review or completion.',
  },
  {
    id: 'model-routing',
    route: '/model-routing',
    selector: '[data-tour-target="model-routing-main"]',
    title: 'Model Routing controls runtime model policy',
    description: 'Model Routing chooses providers, models, reasoning effort, turn limits, and budgets by story point complexity. Use workflow overrides for special cases and project or workflow-type defaults for normal work.',
  },
  {
    id: 'tasks',
    route: '/tasks',
    selector: '[data-tour-target="tasks-board"]',
    title: 'Create the first task flow',
    description: 'Tasks are the core unit of work. After project, agent, capability, workflow, assignment, and model policy are in place, create a task and move it into the workflow status that triggers dispatch.',
  },
  {
    id: 'recurring-tasks',
    route: '/tasks/recurring',
    selector: '[data-tour-target="recurring-tasks-main"]',
    title: 'Recurring Tasks automate repeat work',
    description: 'Recurring Tasks create normal tasks on a schedule inside a fixed workflow. They do not launch agents directly; the generated tasks still follow your configured workflow and assignment rules.',
  },
  {
    id: 'chat',
    route: '/chat',
    selector: '[data-tour-target="chat-main-panel"]',
    title: 'Chats show agent conversations',
    description: 'Use Chat to inspect conversation history, continue direct conversations, and understand what an agent saw or said while working through a task.',
  },
  {
    id: 'telemetry',
    route: '/telemetry',
    selector: '[data-tour-target="telemetry-main"]',
    title: 'Telemetry shows how the system is performing',
    description: 'Telemetry and dashboard views help you monitor cycle time, QA outcomes, routing health, model usage, and schema fields so you can tune your workflow after real runs.',
  },
  {
    id: 'settings-api',
    route: '/settings/api',
    selector: '[data-tour-target="settings-api-main"]',
    title: 'Settings holds install and API configuration',
    description: 'Settings covers display, providers, gateway, GitHub, and the API console. Configure provider credentials manually for your install, and use the API tab when integrating external clients or scripts.',
  },
  {
    id: 'atlas-customize',
    route: '/',
    selector: '[data-tour-target="atlas-widget-composer"]',
    title: 'Now ask Atlas to tailor the setup',
    description: 'I opened Atlas with a generic starter prompt. Edit it with your real project and team workflow, then send it to get help choosing workflow definitions, assignment rules, and model policy.',
    continueLabel: 'Finish',
    preferredCardSide: 'left',
    enterCommand: {
      type: 'open-chat-with-draft',
      text: `Help me customize Agent HQ for my workflow.\n\nI want help defining:\n- the first project and workflow structure\n- the agents and capabilities I should configure\n- the workflow definitions and assignment rules I should start with\n- the model routing policy for small, medium, and complex tasks\n- the first task flow I should run to verify the setup\n\nPlease distinguish base defaults from optional manual configuration and recommend a simple starting setup.`,
      focus: true,
    },
  },
];

function emitChange(snapshot: GettingStartedSnapshot) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(GETTING_STARTED_CHANGED_EVENT, { detail: snapshot }));
}

function readStatus(): GettingStartedStatus {
  if (typeof window === 'undefined') return 'not_started';
  const raw = localStorage.getItem(STATUS_KEY);
  if (raw === 'active' || raw === 'dismissed' || raw === 'completed') return raw;
  return 'not_started';
}

function readStepIndex(): number {
  if (typeof window === 'undefined') return 0;
  const raw = Number(localStorage.getItem(STEP_KEY) ?? '0');
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(raw, Math.max(0, GETTING_STARTED_STEPS.length - 1));
}

export function getGettingStartedSnapshot(): GettingStartedSnapshot {
  return {
    status: readStatus(),
    stepIndex: readStepIndex(),
  };
}

export function beginGettingStartedGuide(stepIndex = 0) {
  if (typeof window === 'undefined') return;
  const nextIndex = Math.min(Math.max(stepIndex, 0), Math.max(0, GETTING_STARTED_STEPS.length - 1));
  localStorage.setItem(STATUS_KEY, 'active');
  localStorage.setItem(STEP_KEY, String(nextIndex));
  emitChange({ status: 'active', stepIndex: nextIndex });
}

export function setGettingStartedStep(stepIndex: number) {
  if (typeof window === 'undefined') return;
  const nextIndex = Math.min(Math.max(stepIndex, 0), Math.max(0, GETTING_STARTED_STEPS.length - 1));
  localStorage.setItem(STEP_KEY, String(nextIndex));
  emitChange({ status: readStatus(), stepIndex: nextIndex });
}

export function dismissGettingStartedGuide() {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STATUS_KEY, 'dismissed');
  emitChange({ status: 'dismissed', stepIndex: readStepIndex() });
}

export function completeGettingStartedGuide() {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STATUS_KEY, 'completed');
  emitChange({ status: 'completed', stepIndex: GETTING_STARTED_STEPS.length - 1 });
}
