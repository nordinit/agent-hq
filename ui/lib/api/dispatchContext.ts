import { apiFetch } from './http';

/**
 * The dispatch context surface: what Agent HQ handed an agent, segment by segment.
 *
 * Mirrors api/src/services/dispatch/prompt/contextBundle.ts and
 * api/src/domains/runs/contextView.ts. Offsets index into `promptText` as UTF-16 code units,
 * exactly what String.prototype.slice takes, so a segment is always a literal slice of the text
 * the agent received.
 */

export type ContextSegmentKind =
  | 'workflow_goal'
  | 'team'
  | 'project_context'
  | 'job_instructions'
  | 'task'
  | 'task_notes'
  | 'summary_request'
  | 'workspace_path'
  | 'callback_contract'
  | 'github_identity';

export interface ContextSegmentSource {
  type: string;
  label: string;
  id?: number | null;
  version?: number | null;
  href?: string | null;
  detail?: Record<string, string | number | boolean | null>;
}

export interface ContextOmission {
  reason: string;
  includedCount?: number | null;
  totalCount?: number | null;
  droppedChars?: number | null;
}

export interface ContextSegment {
  kind: ContextSegmentKind;
  label: string;
  start: number;
  end: number;
  chars: number;
  injected: boolean;
  source: ContextSegmentSource;
  omission?: ContextOmission | null;
}

export interface ContextPrompt {
  id: number;
  bundleVersion: number;
  promptText: string;
  segments: ContextSegment[];
  promptChars: number;
  promptFingerprint: string;
  createdAt: string | null;
  /** True when redaction rewrote the served text. */
  redacted: boolean;
}

export interface ContextRunHeader {
  instanceId: number;
  durableRunId: string | null;
  taskId: number | null;
  taskTitle: string | null;
  agentId: number | null;
  agentName: string | null;
  jobTitle: string | null;
  status: string | null;
  dispatchedAt: string | null;
  completedAt: string | null;
}

export interface ContextBundleSummary {
  instanceId: number;
  durableRunId: string | null;
  taskId: number | null;
  agentId: number | null;
  promptChars: number;
  promptFingerprint: string;
  createdAt: string | null;
  segmentCount: number;
}

export type ContextSegmentChange = 'added' | 'removed' | 'changed' | 'unchanged';

export interface ContextDiffLine {
  type: 'add' | 'remove' | 'context';
  text: string;
}

export interface ContextSegmentDiff {
  kind: string;
  label: string;
  change: ContextSegmentChange;
  previousChars: number;
  currentChars: number;
  charDelta: number;
  addedLines: number;
  removedLines: number;
  hunks: ContextDiffLine[] | null;
  hunksTruncated: boolean;
  source: ContextSegmentSource;
  previousSource: ContextSegmentSource | null;
  sourceChanged: boolean;
}

export interface ContextBundleDiff {
  previousInstanceId: number;
  previousCreatedAt: string | null;
  segments: ContextSegmentDiff[];
  totals: {
    previousChars: number;
    currentChars: number;
    charDelta: number;
    changedSegments: number;
  };
}

/** Shape of runtime_executions.boundary_json, already redacted by the API. */
export interface RuntimeBoundaryView {
  runtime?: {
    type?: string;
    model?: string | null;
    reasoning?: string | null;
    fastMode?: boolean | null;
    timeoutSeconds?: number;
    tokenBudget?: number | null;
    turnLimit?: number | null;
    config?: Record<string, unknown>;
  };
  workspace?: {
    workspaceRoot?: string | null;
    activeRepoRoot?: string | null;
    repoAccessMode?: string | null;
    repoSource?: string | null;
    branch?: string | null;
    commit?: string | null;
  };
  tools?: {
    builtIn?: string[];
    mcpServers?: Array<{ name: string; requiredToolNames?: string[]; [key: string]: unknown }>;
    requiredLifecycleTools?: string[];
    skills?: Array<{ name: string; [key: string]: unknown }>;
    registryTools?: Array<{ name: string; [key: string]: unknown }>;
  };
  auth?: { provider?: string | null; providerConnectionId?: number | null };
  executionTarget?: { id?: string; kind?: string; capabilities?: string[] };
  [key: string]: unknown;
}

export interface RuntimeContextView {
  id: number | null;
  instance_id: number;
  driver_type: string | null;
  backend_type: string | null;
  execution_target_id: string | null;
  state: string | null;
  session_id: string | null;
  boundary_version: number | null;
  boundary: RuntimeBoundaryView | null;
  checkpoint_fingerprint: string | null;
  started_at: string | null;
  ended_at: string | null;
  [key: string]: unknown;
}

export interface InstanceContextView {
  instanceId: number;
  captured: boolean;
  run: ContextRunHeader;
  prompt: ContextPrompt | null;
  runtime: RuntimeContextView | null;
  diff: ContextBundleDiff | null;
  runs: ContextBundleSummary[];
}

export interface TaskContextIndex {
  taskId: number;
  runs: ContextBundleSummary[];
  latestInstanceId: number | null;
}

export const dispatchContextClient = {
  getInstanceContext: (instanceId: number, options?: { diff?: boolean }) =>
    apiFetch<InstanceContextView>(
      `/api/v1/instances/${instanceId}/context${options?.diff === false ? '?diff=0' : ''}`,
    ),
  getTaskDispatchContext: (taskId: number) =>
    apiFetch<TaskContextIndex>(`/api/v1/tasks/${taskId}/dispatch-context`),
};
