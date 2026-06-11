import type Database from 'better-sqlite3';
import { assertTaskStatusDefinedForWorkflow, WorkflowAllowedValuesError } from './taskStatusValidation';
import { resolveSprintTypeForSprintId, resolveTaskWorkflowContext } from '../domains/sprint-definitions/config';
import {
  listSprintTaskTransitions,
  loadSprintTaskTransitionRequirements,
  resolveSprintTaskTransition,
} from '../domains/routing/policy/statuses';

export type IntegrityState =
  | 'clean'
  | 'missing_review_evidence'
  | 'missing_qa_evidence'
  | 'missing_deploy_evidence'
  | 'missing_live_verification'
  | 'invalid_done_state';

export interface TaskReleaseEvidence {
  review_branch: string | null;
  review_commit: string | null;
  review_url: string | null;
  qa_verified_commit: string | null;
  qa_tested_url: string | null;
  merged_commit: string | null;
  deployed_commit: string | null;
  deployed_at: string | null;
  live_verified_at: string | null;
  live_verified_by: string | null;
  deploy_target: string | null;
  evidence_json: string | null;
}

export interface IntegrityEvaluation {
  integrity_state: IntegrityState;
  integrity_warnings: string[];
  release_state_badge: 'review build' | 'qa passed' | 'ready to merge' | 'live deployed' | 'live verified' | null;
  release_state_label: string | null;
  is_legacy_unverified_done: boolean;
}

export interface TaskReleaseRecord extends Partial<TaskReleaseEvidence> {
  id: number;
  status: string;
  task_type?: string | null;
  sprint_id?: number | null;
  custom_fields_json?: string | null;
}

export function hasImplementationEvidence(task: Partial<TaskReleaseEvidence>): boolean {
  return Boolean(task.review_branch && task.review_commit);
}

export function hasQaEvidence(task: Partial<TaskReleaseEvidence>): boolean {
  return Boolean(task.qa_verified_commit && task.review_commit && task.qa_verified_commit === task.review_commit);
}

export function hasDeployEvidence(task: Partial<TaskReleaseEvidence>): boolean {
  return Boolean((task.merged_commit || task.deployed_commit) && task.deploy_target && task.deployed_at);
}

export function hasLiveVerification(task: Partial<TaskReleaseEvidence>): boolean {
  return Boolean(task.deployed_commit && task.live_verified_by && task.live_verified_at);
}

function isMainlineBranch(branch: string | null | undefined): boolean {
  const normalized = String(branch ?? '').trim().toLowerCase();
  return normalized === 'main' || normalized === 'master' || normalized === 'origin/main' || normalized === 'origin/master';
}

function isProductionLikeUrl(url: string | null | undefined): boolean {
  const value = String(url ?? '').trim().toLowerCase();
  if (!value) return false;
  return value.includes(':3500')
    || value.includes('agent-hq-production')
    || value.includes('agent-hq-prod')
    || value.includes('nordinitiatives.com');
}


const PLACEHOLDER_VALUES = new Set(['-', '—', 'n/a', 'na', 'none', 'null', 'undefined', 'tbd', 'todo', 'pending', 'placeholder']);

function normalizedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isPlaceholderValue(value: unknown): boolean {
  const normalized = normalizedString(value)?.toLowerCase();
  return normalized ? PLACEHOLDER_VALUES.has(normalized) : false;
}

function isValidSha(value: unknown): boolean {
  const normalized = normalizedString(value);
  return normalized ? /^[0-9a-f]{7,40}$/i.test(normalized) : false;
}

function isHttpUrl(value: unknown): boolean {
  const normalized = normalizedString(value);
  return Boolean(normalized && (normalized.startsWith('http://') || normalized.startsWith('https://')));
}

function isValidIsoTimestamp(value: unknown): boolean {
  const normalized = normalizedString(value);
  if (!normalized) return false;
  return !Number.isNaN(new Date(normalized).getTime());
}

type TransitionRequirementRow = {
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
};

function parseCustomFields(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function buildTaskRecord(task: TaskReleaseRecord): Record<string, unknown> {
  return {
    ...(task as unknown as Record<string, unknown>),
    ...parseCustomFields(task.custom_fields_json),
  };
}

function loadTransitionRequirements(
  db: Database.Database,
  outcome: string,
  sprintId?: number | null,
  taskType?: string | null,
): TransitionRequirementRow[] {
  const sprintRows = loadSprintTaskTransitionRequirements(db, sprintId ?? null, outcome, taskType);
  if (sprintRows.length > 0) {
    return sprintRows.map((row) => ({
      field_name: row.field_name,
      requirement_type: row.requirement_type,
      match_field: row.match_field,
      severity: row.severity,
      message: row.message,
    }));
  }

  if (taskType) {
    const typeReqs = db.prepare(`
      SELECT field_name, requirement_type, match_field, severity, message
      FROM transition_requirements
      WHERE task_type = ? AND outcome = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
    `).all(taskType, outcome) as TransitionRequirementRow[];

    if (typeReqs.length > 0) return typeReqs;
  }

  return db.prepare(`
    SELECT field_name, requirement_type, match_field, severity, message
    FROM transition_requirements
    WHERE task_type IS NULL AND outcome = ? AND enabled = 1
    ORDER BY priority DESC, id ASC
  `).all(outcome) as TransitionRequirementRow[];
}

function statusRequiresQaEvidence(
  db: Database.Database | undefined,
  task: ({ status?: string | null; task_type?: string | null; sprint_id?: number | null } & Partial<TaskReleaseEvidence>),
): boolean {
  const status = task.status ?? null;
  if (status !== 'qa_pass' && status !== 'ready_to_merge') return false;
  if (!db) return false;

  try {
    const reqs = loadTransitionRequirements(db, 'qa_pass', task.sprint_id ?? null, task.task_type);
    return reqs.some(req => req.severity !== 'warn' && parseFieldExpression(req.field_name).includes('qa_verified_commit'));
  } catch {
    return false;
  }
}

export function evaluateTaskIntegrity(
  task: { status?: string | null; task_type?: string | null } & Partial<TaskReleaseEvidence>,
  db?: Database.Database,
): IntegrityEvaluation {
  const warnings: string[] = [];
  const status = task.status ?? null;
  const reviewOk = hasImplementationEvidence(task);
  const qaOk = hasQaEvidence(task);
  const deployOk = hasDeployEvidence(task);
  const liveOk = hasLiveVerification(task);
  const requiresQaEvidence = statusRequiresQaEvidence(db, task);

  let integrityState: IntegrityState = 'clean';

  if (status === 'review' && !reviewOk) {
    integrityState = 'missing_review_evidence';
    warnings.push('Task is in review but missing review branch/commit evidence.');
  } else if (requiresQaEvidence && !qaOk) {
    integrityState = 'missing_qa_evidence';
    warnings.push(`Task is ${status} but missing QA verification evidence.`);
  } else if (status === 'deployed' && !deployOk) {
    integrityState = 'missing_deploy_evidence';
    warnings.push('Task is deployed but missing deploy commit/target/timestamp evidence.');
  } else if (status === 'deployed' && !liveOk) {
    integrityState = 'missing_live_verification';
    warnings.push('Task is deployed, awaiting live verification.');
  } else if (status === 'done' && (!deployOk || !liveOk)) {
    integrityState = 'invalid_done_state';
    if (!deployOk) warnings.push('Done task is missing deploy evidence.');
    if (!liveOk) warnings.push('Done task is missing live verification evidence.');
  }

  if (status === 'qa_pass' && !deployOk) {
    warnings.push('QA passed, but not deployed yet.');
  }
  if (status === 'ready_to_merge' && !deployOk) {
    warnings.push('Ready to merge, but deploy evidence has not been recorded yet.');
  }

  if ((status === 'review' || status === 'qa_pass' || status === 'ready_to_merge') && isMainlineBranch(task.review_branch)) {
    warnings.push('Review evidence references main/master. Agent HQ implementation work should use a feature branch/worktree, not main.');
  }
  if ((status === 'review' || status === 'qa_pass' || status === 'ready_to_merge') && isProductionLikeUrl(task.review_url)) {
    warnings.push('Review evidence points at a production-like URL. Use Dev evidence for implementation handoff and keep production for deployed/live verification.');
  }
  if ((status === 'qa_pass' || status === 'ready_to_merge') && isProductionLikeUrl(task.qa_tested_url)) {
    warnings.push('QA evidence points at a production-like URL. For Agent HQ internal tasks, use the Dev environment for QA proof and keep production for live verification.');
  }

  let release_state_badge: IntegrityEvaluation['release_state_badge'] = null;
  let release_state_label: string | null = null;

  if (status === 'review') {
    release_state_badge = 'review build';
    release_state_label = 'Review build only';
  } else if (status === 'qa_pass') {
    release_state_badge = 'qa passed';
    release_state_label = 'QA passed (not live)';
  } else if (status === 'ready_to_merge') {
    release_state_badge = 'ready to merge';
    release_state_label = 'Ready to merge';
  } else if (status === 'deployed') {
    release_state_badge = 'live deployed';
    release_state_label = 'Deployed to live';
  } else if (status === 'done') {
    release_state_badge = liveOk ? 'live verified' : 'live deployed';
    release_state_label = liveOk ? 'Live verified' : 'Done (legacy, unverified)';
  }

  return {
    integrity_state: integrityState,
    integrity_warnings: warnings,
    release_state_badge,
    release_state_label,
    is_legacy_unverified_done: status === 'done' && (!deployOk || !liveOk),
  };
}

export interface ReleaseGateResult {
  errors: string[];
  warnings: string[];
}

/**
 * Evaluate transition requirements for a given outcome.
 *
 * Resolution order for each requirement:
 *  1. transition_requirements WHERE task_type = ? (highest priority first)
 *  2. transition_requirements WHERE task_type IS NULL (defaults)
 *
 * When task-type-specific requirements exist for an outcome, they REPLACE
 * the defaults for that outcome (they are overrides, not additions).
 *
 * Returns {errors, warnings} instead of throwing, so callers can handle
 * warnings vs blocking errors.
 */
export function requireReleaseGate(
  db: Database.Database,
  task: TaskReleaseRecord,
  outcome: string,
  taskType?: string | null,
): ReleaseGateResult {
  let reqs: TransitionRequirementRow[];

  try {
    reqs = loadTransitionRequirements(db, outcome, task.sprint_id ?? null, taskType);
  } catch {
    return { errors: [], warnings: [] };
  }

  if (reqs.length === 0) {
    return { errors: [], warnings: [] };
  }

  const taskRecord = buildTaskRecord(task);
  const result: ReleaseGateResult = { errors: [], warnings: [] };
  const fieldsToValidate = new Set<string>();

  for (const req of reqs) {
    const fields = parseFieldExpression(req.field_name);
    if (req.severity !== 'warn') {
      for (const field of fields) fieldsToValidate.add(field);
      if (req.match_field) fieldsToValidate.add(req.match_field);
    }

    let failed = false;
    if (req.requirement_type === 'required') {
      failed = fields.every(field => !normalizedString(taskRecord[field]));
    } else if (req.requirement_type === 'match') {
      const fieldValue = normalizedString(taskRecord[req.field_name]);
      const matchValue = req.match_field ? normalizedString(taskRecord[req.match_field]) : null;
      failed = !fieldValue || !matchValue || fieldValue !== matchValue;
    } else if (req.requirement_type === 'from_status') {
      failed = task.status !== req.match_field;
    }

    if (failed) {
      const msg = req.message || `${outcome} requires ${formatFieldExpression(req.field_name)}`;
      if (req.severity === 'warn') {
        result.warnings.push(msg);
      } else {
        result.errors.push(msg);
      }
    }
  }

  for (const field of fieldsToValidate) {
    validateEvidenceField(field, taskRecord[field], result.errors);
  }

  return result;
}

function parseFieldExpression(fieldName: string): string[] {
  return fieldName
    .split('|')
    .map(field => field.trim())
    .filter(Boolean);
}

function formatFieldExpression(fieldName: string): string {
  return parseFieldExpression(fieldName).join(' or ') || fieldName;
}

function validateEvidenceField(fieldName: string, value: unknown, errors: string[]): void {
  if (!normalizedString(value)) return;

  if (isPlaceholderValue(value)) {
    errors.push(`${fieldName} cannot be a blank placeholder value`);
    return;
  }

  if (fieldName === 'review_branch' && isMainlineBranch(value as string)) {
    errors.push('review_branch must be a feature branch, not main/master');
    return;
  }

  if (fieldName.endsWith('_commit') && !isValidSha(value)) {
    errors.push(`${fieldName} must be a valid git SHA`);
    return;
  }

  if (fieldName.endsWith('_url') && !isHttpUrl(value)) {
    errors.push(`${fieldName} must be a valid URL`);
    return;
  }

  if ((fieldName === 'review_url' || fieldName === 'qa_tested_url') && isProductionLikeUrl(value as string)) {
    errors.push(`${fieldName} must reference a non-production artifact`);
    return;
  }

  if (fieldName.endsWith('_at') && !isValidIsoTimestamp(value)) {
    errors.push(`${fieldName} must be a valid ISO timestamp`);
  }
}

/**
 * Actors considered human/user-originated. These are allowed to change task
 * status directly via the generic PUT endpoint (same as Atlas), while other
 * automated actors must route through POST /outcome.
 */
export const HUMAN_ACTORS = new Set(['User', 'user', 'Human', 'human']);

export function assertTaskStatusUpdateAllowed(
  existingTask: { status: string },
  nextStatus: string | null | undefined,
  changedBy: string,
): void {
  if (!nextStatus || nextStatus === existingTask.status) return;
  // Atlas (agent) and human users may change task status directly.
  // All other automated actors must use the /outcome endpoint.
  if (changedBy !== 'Atlas' && !HUMAN_ACTORS.has(changedBy)) {
    throw new Error('Only Atlas or a human user may change task status through the generic update endpoint');
  }
}

type SprintWorkflowRouteResolution = {
  nextStatus: string;
  allowedOutcomes: string[];
};

export function resolveSprintWorkflowOutcome(
  db: Database.Database,
  task: { status: string; task_type?: string | null; sprint_id?: number | null; sprint_type?: string | null },
  outcome: string,
): SprintWorkflowRouteResolution | null {
  const sprintType = task.sprint_type ?? resolveSprintTypeForSprintId(db, task.sprint_id ?? null);
  const workflow = resolveTaskWorkflowContext(db, { sprintType, taskType: task.task_type });

  if (workflow.taskType && workflow.allowedTaskTypes.length > 0 && !workflow.allowedTaskTypes.includes(workflow.taskType)) {
    throw new Error(`Cannot move task because task_type "${workflow.taskType}" is not allowed for sprint type "${workflow.sprintType}". Allowed task types: ${workflow.allowedTaskTypes.join(', ')}`);
  }

  const sprintTransitions = listSprintTaskTransitions(db, task.sprint_id ?? null);
  const matchingTransitions = sprintTransitions
    .filter((transition) => transition.enabled !== 0)
    .map((transition) => ({
    fromStatus: transition.from_status,
    outcome: transition.outcome,
    toStatus: transition.to_status,
    taskType: transition.task_type,
    priority: transition.priority,
    isProtected: Boolean(transition.is_protected),
  }))
    .filter((transition) => transition.fromStatus === task.status)
    .filter((transition) => transition.taskType == null || transition.taskType === workflow.taskType)
    .sort((left, right) => {
      const taskTypeSpecificDelta = Number(Boolean(right.taskType)) - Number(Boolean(left.taskType));
      if (taskTypeSpecificDelta !== 0) return taskTypeSpecificDelta;
      return right.priority - left.priority;
    });

  if (matchingTransitions.length === 0) {
    return null;
  }

  const route = matchingTransitions.find((transition) => transition.outcome === outcome) ?? null;
  const allowedOutcomes = Array.from(new Set(matchingTransitions.map((transition) => transition.outcome)));

  if (!route) {
    throw new WorkflowAllowedValuesError({
      message: `Cannot apply outcome "${outcome}" from "${task.status}" for sprint type "${workflow.sprintType}". Allowed outcomes: ${allowedOutcomes.length > 0 ? allowedOutcomes.join(', ') : 'none'}`,
      code: 'task_outcome_not_allowed_for_workflow',
      field: 'outcome',
      attemptedValue: outcome,
      allowedValues: allowedOutcomes,
      scope: {
        sprintId: task.sprint_id ?? null,
        sprintType: workflow.sprintType,
        taskType: workflow.taskType,
        fromStatus: task.status,
      },
    });
  }

  return {
    nextStatus: route.toStatus,
    allowedOutcomes,
  };
}

function resolveConfiguredOutcomeForDirectStatus(
  db: Database.Database,
  task: { status: string; task_type?: string | null; sprint_id?: number | null; sprint_type?: string | null },
  targetStatus: string,
): { outcome: string | null; allowedOutcomes: string[]; allowedStatuses: string[] } {
  const sprintType = task.sprint_type ?? resolveSprintTypeForSprintId(db, task.sprint_id ?? null);
  const workflow = resolveTaskWorkflowContext(db, { sprintType, taskType: task.task_type });
  const sprintTransitions = listSprintTaskTransitions(db, task.sprint_id ?? null);

  const configuredSprintTransitions = sprintTransitions
    .filter((transition) => transition.enabled !== 0)
    .filter((transition) => transition.from_status === task.status)
    .map((transition) => ({
      outcome: transition.outcome,
      toStatus: transition.to_status,
      taskType: transition.task_type,
      priority: transition.priority ?? 0,
      order: transition.id,
    }));

  const matchingTransitions = configuredSprintTransitions
    .filter((transition) => !transition.taskType || transition.taskType === workflow.taskType)
    .sort((a, b) => {
      const aSpecificity = a.taskType ? 1 : 0;
      const bSpecificity = b.taskType ? 1 : 0;
      if (aSpecificity !== bSpecificity) return bSpecificity - aSpecificity;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.order - b.order;
    });

  const matchedTransition = matchingTransitions.find((transition) => transition.toStatus === targetStatus) ?? null;
  return {
    outcome: matchedTransition?.outcome ?? null,
    allowedOutcomes: Array.from(new Set(matchingTransitions.map((transition) => transition.outcome))),
    allowedStatuses: Array.from(new Set(matchingTransitions.map((transition) => transition.toStatus))),
  };
}

export function assertAtlasDirectStatusGate(
  db: Database.Database,
  task: TaskReleaseRecord & { task_type?: string | null; sprint_id?: number | null },
  nextStatus: string | null | undefined,
): void {
  if (!nextStatus || nextStatus === task.status) return;

  const sprintType = resolveSprintTypeForSprintId(db, task.sprint_id ?? null);
  const workflow = resolveTaskWorkflowContext(db, { sprintType, taskType: task.task_type });

  if (workflow.taskType && workflow.allowedTaskTypes.length > 0 && !workflow.allowedTaskTypes.includes(workflow.taskType)) {
    throw new Error(`Cannot move task to "${nextStatus}" because task_type "${workflow.taskType}" is not allowed for sprint type "${workflow.sprintType}". Allowed task types: ${workflow.allowedTaskTypes.join(', ')}`);
  }

  assertTaskStatusDefinedForWorkflow(db, nextStatus, { sprintId: task.sprint_id, sprintType });
}

/**
 * Resolve the next status for a given (from_status, outcome) pair.
 *
 * Single canonical workflow model: explicit sprint-scoped transition rows are
 * authoritative for runtime outcome→status routing.
 *
 * Resolution order:
 *  1. sprint_task_transitions for the active sprint (authoritative)
 */
export function canonicalOutcomeRoute(
  db: Database.Database,
  priorStatus: string,
  outcome: string,
  taskType?: string | null,
  sprintId?: number | null,
  sprintType?: string | null,
): string | null {
  const workflow = resolveTaskWorkflowContext(db, { sprintType: sprintType ?? null, taskType });

  try {
    const sprintTransition = resolveSprintTaskTransition(db, sprintId ?? null, priorStatus, outcome, workflow.taskType);
    if (sprintTransition) return sprintTransition.to_status;

  } catch {
    // sprint-scoped routing may not exist yet (old DB) — fall through
  }

  return null;
}
