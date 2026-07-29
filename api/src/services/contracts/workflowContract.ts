import {
  resolveSprintWorkflow,
  type ResolvedSprintWorkflow,
  type ResolvedSprintWorkflowTransition,
} from '../../lib/sprintWorkflow';
import { resolveSprintOutcomeMap, getLegacyOutcomeMeta, type SprintOutcomeDefinition } from '../../domains/sprint-definitions/outcomes';
import { loadSprintTaskTransitionRequirements } from '../../domains/routing/policy/statuses';
import { isBackendSystemOutcome, isBlockerLikeOutcome, isFailureLikeOutcome } from '../../lib/outcomeCatalog';
import { type Db } from "../../db/adapter/types";

// ── Workflow resolution ──────────────────────────────────────────────────────

export type WorkflowPhase = 'implementation' | 'review' | 'release' | 'pm';

export interface ResolvedWorkflow {
  workflowPhase: WorkflowPhase;
  suggestedOutcome: string;
  validOutcomes: string[];
  outcomeHelp: OutcomeHelpEntry[];
  requiresSemanticOutcome: boolean;
  source: 'sprint_type_config' | 'compatibility';
  sprintType?: string | null;
}

export interface OutcomeHelpEntry {
  outcome: string;
  description: string;
}

export interface WorkflowResolutionContext {
  taskStatus: string;
  taskType?: string | null;
  sprintId?: number | null;
  sprintType?: string | null;
  db?: Db | null;
  resolvedWorkflow?: ResolvedSprintWorkflow | null;
}

function normalizeSprintType(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : null;
}

function buildResolvedWorkflow(
  workflowPhase: WorkflowPhase,
  source: ResolvedWorkflow['source'],
  options: {
    sprintType?: string | null;
    suggestedOutcome?: string;
    validOutcomes?: string[];
    outcomeHelp?: OutcomeHelpEntry[];
  } = {},
): ResolvedWorkflow {
  const sprintType = options.sprintType ?? null;

  switch (workflowPhase) {
    case 'review': {
      const suggestedOutcome = options.suggestedOutcome ?? 'qa_pass';
      const validOutcomes = options.validOutcomes ?? ['qa_pass', 'qa_fail', 'blocked', 'failed'];
      return {
        workflowPhase: 'review',
        suggestedOutcome,
        validOutcomes,
        outcomeHelp: options.outcomeHelp ?? validOutcomes.map((outcome) => buildOutcomeHelp(outcome)),
        requiresSemanticOutcome: true,
        source,
        sprintType,
      };
    }
    case 'release': {
      const suggestedOutcome = options.suggestedOutcome ?? 'deployed_live';
      const validOutcomes = options.validOutcomes ?? ['deployed_live', 'blocked', 'failed'];
      return {
        workflowPhase: 'release',
        suggestedOutcome,
        validOutcomes,
        outcomeHelp: options.outcomeHelp ?? validOutcomes.map((outcome) => buildOutcomeHelp(outcome)),
        requiresSemanticOutcome: true,
        source,
        sprintType,
      };
    }
    case 'pm': {
      const suggestedOutcome = options.suggestedOutcome ?? 'completed_for_review';
      const validOutcomes = options.validOutcomes ?? ['completed_for_review', 'blocked', 'failed'];
      return {
        workflowPhase: 'pm',
        suggestedOutcome,
        validOutcomes,
        outcomeHelp: options.outcomeHelp ?? validOutcomes.map((outcome) => buildOutcomeHelp(outcome)),
        requiresSemanticOutcome: true,
        source,
        sprintType,
      };
    }
    default: {
      const suggestedOutcome = options.suggestedOutcome ?? 'completed_for_review';
      const validOutcomes = options.validOutcomes ?? ['completed_for_review', 'dev_deploy_queued', 'blocked', 'failed'];
      return {
        workflowPhase: 'implementation',
        suggestedOutcome,
        validOutcomes,
        outcomeHelp: options.outcomeHelp ?? validOutcomes.map((outcome) => buildOutcomeHelp(outcome)),
        requiresSemanticOutcome: true,
        source,
        sprintType,
      };
    }
  }
}

function buildOutcomeHelp(outcome: string, transition?: ResolvedSprintWorkflowTransition, resolvedDescription?: string): OutcomeHelpEntry {
  const toStatus = transition?.toStatus;
  const fallback = getLegacyOutcomeMeta(outcome);
  return {
    outcome,
    description: resolvedDescription || fallback.description || (toStatus ? `Route the task to ${toStatus}` : `Apply outcome ${outcome}`),
  };
}

function legacyResolveWorkflow(
  taskStatus: string,
  _taskType?: string | null,
  sprintType?: string | null,
): ResolvedWorkflow {
  const normalizedSprintType = normalizeSprintType(sprintType);
  const isReviewLane = taskStatus === 'review';
  const isReleaseLane = taskStatus === 'ready_to_merge' || taskStatus === 'deployed';

  if (isReviewLane) {
    return buildResolvedWorkflow('review', 'compatibility', {
      sprintType: normalizedSprintType,
      suggestedOutcome: 'qa_pass',
      validOutcomes: ['qa_pass', 'qa_fail', 'blocked', 'failed'],
    });
  }

  if (isReleaseLane) {
    if (taskStatus === 'deployed') {
      return buildResolvedWorkflow('release', 'compatibility', {
        sprintType: normalizedSprintType,
        suggestedOutcome: 'live_verified',
        validOutcomes: ['live_verified', 'blocked', 'failed'],
      });
    }
    return buildResolvedWorkflow('release', 'compatibility', { sprintType: normalizedSprintType });
  }

  return buildResolvedWorkflow('implementation', 'compatibility', { sprintType: normalizedSprintType });
}

function getApplicableWorkflowTransitions(
  workflow: ResolvedSprintWorkflow,
  taskStatus: string,
  taskType?: string | null,
): ResolvedSprintWorkflowTransition[] {
  const normalizedTaskType = typeof taskType === 'string' ? taskType.trim() : '';
  const matchesStatus = workflow.transitions.filter((transition) => transition.fromStatus === taskStatus);
  if (matchesStatus.length === 0) return [];

  const byOutcome = new Map<string, ResolvedSprintWorkflowTransition[]>();
  for (const transition of matchesStatus) {
    if (transition.taskType && transition.taskType !== normalizedTaskType) continue;
    const bucket = byOutcome.get(transition.outcome) ?? [];
    bucket.push(transition);
    byOutcome.set(transition.outcome, bucket);
  }

  return [...byOutcome.entries()]
    .map(([, transitions]) => transitions.sort((a, b) => {
      const aSpecific = a.taskType ? 1 : 0;
      const bSpecific = b.taskType ? 1 : 0;
      return bSpecific - aSpecific || b.priority - a.priority || a.outcome.localeCompare(b.outcome);
    })[0])
    .sort((a, b) => {
      const aSpecific = a.taskType ? 1 : 0;
      const bSpecific = b.taskType ? 1 : 0;
      return bSpecific - aSpecific || b.priority - a.priority || a.outcome.localeCompare(b.outcome);
    });
}

function getSuggestedOutcome(
  taskStatus: string,
  taskType: string | null | undefined,
  validOutcomes: string[],
): string | null {
  const preferredByStatus: Record<string, string[]> = {
    review: ['completed', 'qa_pass', 'qa_fail', 'blocked', 'failed'],
    ready_to_merge: ['deployed_live', 'qa_fail', 'failed'],
    deployed: ['live_verified', 'qa_fail', 'failed'],
    stalled: ['retry'],
  };

  const preferred = preferredByStatus[taskStatus] ?? ['completed', 'completed_for_review', 'dev_deploy_queued', 'blocked', 'failed'];

  for (const outcome of preferred) {
    if (validOutcomes.includes(outcome)) return outcome;
  }

  return validOutcomes[0] ?? null;
}

function inferWorkflowPhase(
  taskStatus: string,
  _taskType: string | null | undefined,
  suggestedOutcome: string,
): WorkflowPhase {
  if (taskStatus === 'review') return 'review';
  if (taskStatus === 'ready_to_merge' || taskStatus === 'deployed') return 'release';
  if (suggestedOutcome === 'deployed_live' || suggestedOutcome === 'live_verified') return 'release';
  return 'implementation';
}

async function resolveWorkflowFromResolvedWorkflow(
  db: Db | null | undefined,
  taskStatus: string,
  taskType: string | null | undefined,
  workflow: ResolvedSprintWorkflow,
): Promise<ResolvedWorkflow | null> {
  const transitions = getApplicableWorkflowTransitions(workflow, taskStatus, taskType);
  if (transitions.length === 0) return null;

  const transitionOutcomes = transitions.map((transition) => transition.outcome);
  const validOutcomeSet = new Set(transitionOutcomes);
  const transitionByOutcome = new Map(transitions.map((transition) => [transition.outcome, transition]));
  const hasBlockedRoute = validOutcomeSet.has('blocked');
  const hasFailedRoute = validOutcomeSet.has('failed');
  const outcomeMeta: Map<string, SprintOutcomeDefinition> = db
    ? await resolveSprintOutcomeMap(db, { sprintType: workflow.sprintType, taskType, fallbackOutcomes: transitionOutcomes })
    : new Map<string, SprintOutcomeDefinition>();

  if (hasBlockedRoute || hasFailedRoute) {
    const extras = [...outcomeMeta.values()]
      .filter((outcome) => {
        if (validOutcomeSet.has(outcome.outcome_key)) return false;
        if (isBackendSystemOutcome(outcome.outcome_key)) return false;
        if (hasBlockedRoute && isBlockerLikeOutcome(outcome.outcome_key, outcome)) return true;
        if (hasFailedRoute && outcome.outcome_key !== 'qa_fail' && isFailureLikeOutcome(outcome.outcome_key, outcome)) return true;
        return false;
      })
      .sort((left, right) => Number(left.stage_order ?? 0) - Number(right.stage_order ?? 0) || left.outcome_key.localeCompare(right.outcome_key));
    for (const outcome of extras) validOutcomeSet.add(outcome.outcome_key);
  }

  const validOutcomes = [...validOutcomeSet];
  const suggestedOutcome = getSuggestedOutcome(taskStatus, taskType, validOutcomes);
  if (!suggestedOutcome) return null;

  const workflowPhase = inferWorkflowPhase(taskStatus, taskType, suggestedOutcome);
  return buildResolvedWorkflow(workflowPhase, 'sprint_type_config', {
    sprintType: workflow.sprintType,
    suggestedOutcome,
    validOutcomes,
    outcomeHelp: validOutcomes.map((outcome) => buildOutcomeHelp(outcome, transitionByOutcome.get(outcome), outcomeMeta.get(outcome)?.description)),
  });
}

/**
 * resolveWorkflow — determine the valid workflow outcomes
 * from the task's current status and type.
 *
 * This is the semantic model shared by ALL runtimes. The current status/outcome configuration determines:
 * - Which outcome the agent should report (suggestedOutcome)
 * - Which outcomes are valid for this dispatch
 * - What each outcome means (outcomeHelp)
 *
 * The result contains NO transport details — no URLs, no curl, no JSON blocks.
 */
export async function resolveWorkflow(
  taskStatusOrContext: string | WorkflowResolutionContext,
  taskType?: string | null,
): Promise<ResolvedWorkflow> {
  const ctx: WorkflowResolutionContext = typeof taskStatusOrContext === 'string'
    ? { taskStatus: taskStatusOrContext, taskType }
    : taskStatusOrContext;

  const normalizedSprintType = normalizeSprintType(ctx.sprintType);
  const resolvedWorkflow = ctx.resolvedWorkflow
    ?? (ctx.db ? await resolveSprintWorkflow(ctx.db, ctx.sprintId ?? null, normalizedSprintType) : null);

  if (resolvedWorkflow) {
    const workflowResolved = await resolveWorkflowFromResolvedWorkflow(ctx.db ?? null, ctx.taskStatus, ctx.taskType, resolvedWorkflow);
    if (workflowResolved) return workflowResolved;
  }

  return legacyResolveWorkflow(ctx.taskStatus, ctx.taskType, normalizedSprintType);
}

// ── Pipeline reference ───────────────────────────────────────────────────────

/**
 * The canonical Agent HQ task pipeline stages.
 * Shared by all runtimes as reference documentation.
 */
export const PIPELINE_STAGES = [
  'todo', 'ready', 'in_progress', 'dev_deploy_queued',
  'dev_deploying', 'review',
  'ready_to_merge', 'deployed', 'done',
] as const;

// ── Evidence requirements (shared semantics) ─────────────────────────────────

export interface EvidenceRequirements {
  /** Configured evidence field expressions that should be recorded. */
  fields: string[];
  /** Individual field names from configured expressions. Useful for structured examples. */
  fieldNames: string[];
  /** Human-readable description of the configured evidence gates. */
  description: string;
}

/**
 * getEvidenceRequirements is kept for older imports. New dispatch contracts
 * should call resolveEvidenceRequirements so gate rows, not workflow phase labels, decide
 * which fields are presented as required.
 */
export function getEvidenceRequirements(_workflowPhase: WorkflowPhase): EvidenceRequirements {
  return {
    fields: [],
    fieldNames: [],
    description: 'No phase-specific evidence defaults are inferred. Evidence requirements come from configured gate rows for the active workflow outcomes.',
  };
}

type ContractGateRequirement = {
  outcome: string;
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
};

const NON_EVIDENCE_FIELDS = new Set(['status']);
const NON_ADVANCEMENT_OUTCOMES = new Set(['blocked', 'env_blocked', 'approval_blocked', 'failed', 'qa_fail', 'release_failed', 'infra_failed', 'runtime_failed', 'retry', 'dev_deploy_queued']);

function isAdvancementOutcome(outcome: string): boolean {
  return !NON_ADVANCEMENT_OUTCOMES.has(outcome) && !outcome.startsWith('failed:');
}

function parseFieldExpression(fieldName: string): string[] {
  return fieldName
    .split('|')
    .map((field) => field.trim())
    .filter(Boolean);
}

function formatFieldExpression(fieldName: string): string {
  return parseFieldExpression(fieldName).join(' or ') || fieldName;
}

async function loadConfiguredGateRequirements(
  db: Db,
  outcome: string,
  sprintId?: number | null,
  taskType?: string | null,
): Promise<ContractGateRequirement[]> {
  const sprintRows = await loadSprintTaskTransitionRequirements(db, sprintId ?? null, outcome, taskType);
  if (sprintRows.length > 0) {
    return sprintRows.map((row) => ({
      outcome,
      field_name: row.field_name,
      requirement_type: row.requirement_type,
      match_field: row.match_field,
      severity: row.severity,
      message: row.message,
    }));
  }

  try {
    if (taskType) {
      const typeRows = await db.all(`
        SELECT field_name, requirement_type, match_field, severity, message
        FROM transition_requirements
        WHERE task_type = ? AND outcome = ? AND enabled = 1
        ORDER BY priority DESC, id ASC
      `, taskType, outcome) as Array<Omit<ContractGateRequirement, 'outcome'>>;
      if (typeRows.length > 0) return typeRows.map((row) => ({ ...row, outcome }));
    }

    const rows = await db.all(`
      SELECT field_name, requirement_type, match_field, severity, message
      FROM transition_requirements
      WHERE task_type IS NULL AND outcome = ? AND enabled = 1
      ORDER BY priority DESC, id ASC
    `, outcome) as Array<Omit<ContractGateRequirement, 'outcome'>>;
    return rows.map((row) => ({ ...row, outcome }));
  } catch {
    return [];
  }
}

export function resolveEvidenceRequirements(options: {
  db?: Db | null;
  taskType?: string | null;
  sprintId?: number | null;
  outcomes?: string[];
  suggestedOutcome?: string | null;
}): EvidenceRequirements {
  const outcomes = Array.from(new Set([
    ...(options.outcomes ?? []),
    options.suggestedOutcome ?? '',
  ].filter((outcome): outcome is string => Boolean(outcome) && isAdvancementOutcome(outcome))));

  if (!options.db || outcomes.length === 0) {
    return {
      fields: [],
      fieldNames: [],
      description: 'No configured gate rows were available in this dispatch context. Do not infer required evidence from a workflow phase label; follow the workflow API response if an outcome is refused.',
    };
  }

  const requirements = outcomes.flatMap(async (outcome) => await loadConfiguredGateRequirements(
      options.db as Db,
      outcome,
      options.sprintId ?? null,
      options.taskType ?? null,
    ));

  const blockingRequirements = requirements.filter((requirement) => requirement.severity !== 'warn');
  const fieldExpressions = new Set<string>();
  const fieldNames = new Set<string>();

  for (const requirement of blockingRequirements) {
    if (requirement.requirement_type === 'from_status') continue;
    if (requirement.requirement_type !== 'required' && requirement.requirement_type !== 'match') continue;

    const fields = parseFieldExpression(requirement.field_name).filter((field) => !NON_EVIDENCE_FIELDS.has(field));
    if (fields.length === 0) continue;

    fieldExpressions.add(formatFieldExpression(requirement.field_name));
    for (const field of fields) fieldNames.add(field);
  }

  const outcomeLabel = outcomes.join(', ');
  if (blockingRequirements.length === 0) {
    return {
      fields: [],
      fieldNames: [],
      description: `No blocking evidence gate rows are configured for ${outcomeLabel}. Do not infer additional required fields from a workflow phase label.`,
    };
  }

  if (fieldExpressions.size === 0) {
    return {
      fields: [],
      fieldNames: [],
      description: `Configured gate rows for ${outcomeLabel} do not require additional evidence fields beyond workflow/status checks.`,
    };
  }

  return {
    fields: Array.from(fieldExpressions),
    fieldNames: Array.from(fieldNames),
    description: `Configured gate fields for ${outcomeLabel}: ${Array.from(fieldExpressions).join(', ')}. These come from workflow gate requirement rows; no phase-specific defaults are inferred.`,
  };
}

export async function getAllowedTaskTypesForSprintType(
  db: Db,
  sprintType: string | null | undefined,
): Promise<string[]> {
  const normalizedSprintType = normalizeSprintType(sprintType);
  if (!normalizedSprintType) return [];

  try {
    const rows = await db.all(`
      SELECT task_type
      FROM sprint_type_task_types
      WHERE sprint_type_key = ?
      ORDER BY task_type ASC
    `, normalizedSprintType) as Array<{ task_type: string | null }>;

    return rows
      .map(row => typeof row.task_type === 'string' ? row.task_type.trim() : '')
      .filter((taskType): taskType is string => taskType.length > 0);
  } catch {
    return [];
  }
}

export async function isTaskTypeAllowedForSprintType(
  db: Db,
  sprintType: string | null | undefined,
  taskType: string | null | undefined,
): Promise<boolean> {
  const normalizedSprintType = normalizeSprintType(sprintType);
  const normalizedTaskType = typeof taskType === 'string' ? taskType.trim() : '';

  if (!normalizedSprintType || !normalizedTaskType) return true;

  const allowedTaskTypes = await getAllowedTaskTypesForSprintType(db, normalizedSprintType);
  if (allowedTaskTypes.length === 0) return true;

  return allowedTaskTypes.includes(normalizedTaskType);
}
