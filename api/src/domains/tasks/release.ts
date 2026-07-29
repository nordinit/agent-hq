import { applyTaskOutcome, RefusedTaskOutcomeError, resolveRefusedTaskOutcome } from '../../lib/taskOutcome';
import {
  extractInlineEvidence,
  hasAnyEvidence,
  validateInlineEvidenceForOutcome,
  validateReviewEvidence,
  validateQaEvidence,
  validateDeployEvidence,
  type GateRequirement,
} from '../../lib/evidenceValidation';
import { loadSprintTaskTransitionRequirements } from '../routing/policy/statuses';
import type { McpApiIdentity } from '../../lib/mcpApiAuth';
import { parseCustomFields } from './fields';
import { getCanonicalTaskRecord } from './evidence';
import { getTaskInstanceAuthorityFailure } from './authority';
import {
  addTaskNote,
  maybeTriggerDispatch,
  taskTableHasColumn,
  updateTaskEvidence,
} from './mutations';
import { enrichTask, TASK_SELECT } from './readModel';
import { INLINE_EVIDENCE_FIELD_KEYS } from '../../lib/starterCatalog';
import { toCanonicalTimestampOrNow } from '../../lib/timestamps';
import { type Db } from "../../db/adapter/types";

async function loadTask(taskId: number, db: Db): Promise<Record<string, unknown> | undefined> {
  return await db.get(`${TASK_SELECT} WHERE t.id = ?`, taskId) as Record<string, unknown> | undefined;
}

async function requireTask(taskId: number, db: Db): Promise<Record<string, unknown>> {
  const task = await loadTask(taskId, db);
  if (!task) {
    const error = new Error('Task not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }
  return task;
}

function normalizeOptionalInstanceId(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const OUTCOME_CONTROL_FIELD_KEYS = new Set([
  'outcome',
  'changed_by',
  'summary',
  'dry_run',
  'instance_id',
  'instanceId',
  'failure_detail',
  'blocker_reason',
]);

function topLevelLifecycleEvidenceFields(body: Record<string, unknown>): string[] {
  return INLINE_EVIDENCE_FIELD_KEYS.filter((field) => Object.prototype.hasOwnProperty.call(body, field));
}

function normalizeOutcomeBody(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
    ? body.payload as Record<string, unknown>
    : {};
  const controls = Object.fromEntries(
    Object.entries(body).filter(([key]) => OUTCOME_CONTROL_FIELD_KEYS.has(key)),
  );
  return { ...payload, ...controls };
}

function errorWithBody(status: number, body: Record<string, unknown>): Error & { status?: number; body?: Record<string, unknown> } {
  const error = new Error(String(body.error ?? 'Task outcome rejected')) as Error & {
    status?: number;
    body?: Record<string, unknown>;
  };
  error.status = status;
  error.body = body;
  return error;
}

async function resolveMcpActiveOutcomeInstance(
  db: Db,
  taskId: number,
  identity: McpApiIdentity,
): Promise<number> {
  const row = await db.get(`
    SELECT
      t.id AS task_id,
      t.active_instance_id,
      ji.id AS instance_id,
      ji.task_id AS instance_task_id,
      ji.agent_id AS instance_agent_id
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.id = ?
  `, taskId) as {
    task_id: number;
    active_instance_id: number | null;
    instance_id: number | null;
    instance_task_id: number | null;
    instance_agent_id: number | null;
  } | undefined;

  if (!row) throw errorWithBody(404, { error: 'Task not found' });
  if (row.active_instance_id == null) {
    throw errorWithBody(409, {
      error: 'Task outcome rejected: task has no active instance',
      reason: 'no_active_instance',
      task_id: taskId,
      authenticated_agent_id: identity.agentId,
    });
  }
  if (row.instance_id == null || row.instance_task_id !== taskId) {
    throw errorWithBody(409, {
      error: 'Task outcome rejected: active instance is missing or not linked to this task',
      reason: 'active_instance_not_authoritative',
      task_id: taskId,
      active_instance_id: row.active_instance_id,
      authenticated_agent_id: identity.agentId,
    });
  }
  if (row.instance_agent_id !== identity.agentId) {
    throw errorWithBody(403, {
      error: 'Task outcome rejected: MCP key does not own the task active instance',
      reason: 'active_instance_agent_mismatch',
      task_id: taskId,
      active_instance_id: row.active_instance_id,
      active_instance_agent_id: row.instance_agent_id,
      authenticated_agent_id: identity.agentId,
    });
  }

  return row.active_instance_id;
}

export async function postTaskOutcome(
  db: Db,
  taskId: number,
  body: Record<string, unknown>,
  changedBy: string,
  options: { mcpIdentity?: McpApiIdentity | null } = {},
) {
  const unsupportedTopLevelEvidenceFields = topLevelLifecycleEvidenceFields(body);
  if (unsupportedTopLevelEvidenceFields.length > 0) {
    throw errorWithBody(400, {
      ok: false,
      code: 'top_level_lifecycle_evidence_not_supported',
      error: 'Top-level lifecycle evidence fields are no longer accepted on task outcome requests. Put workflow evidence under payload or use the typed lifecycle evidence endpoints.',
      fields: unsupportedTopLevelEvidenceFields,
    });
  }
  const normalizedBody = normalizeOutcomeBody(body);
  const dryRun = normalizedBody.dry_run === true || normalizedBody.dry_run === 'true';
  const customFieldsSelect = await taskTableHasColumn(db, 'custom_fields_json') ? 'custom_fields_json' : 'NULL AS custom_fields_json';
  const existing = await db.get(`SELECT id, status, task_type, sprint_id, ${customFieldsSelect}
     FROM tasks WHERE id = ?`, taskId) as {
    id: number;
    status: string;
    task_type: string | null;
    sprint_id: number | null;
    custom_fields_json: string | null;
  } | undefined;
  if (!existing) {
    const error = new Error('Task not found') as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  const outcome = typeof normalizedBody.outcome === 'string' ? normalizedBody.outcome : '';
  const summary = typeof normalizedBody.summary === 'string' ? normalizedBody.summary : null;
  const failureDetail = typeof normalizedBody.failure_detail === 'string' ? normalizedBody.failure_detail : null;
  if (!outcome) {
    const error = new Error('outcome is required') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const inlineEvidence = extractInlineEvidence(normalizedBody);
  const hasInline = hasAnyEvidence(inlineEvidence);
  const transitionRequirements = (await loadSprintTaskTransitionRequirements(db, existing.sprint_id ?? null, outcome, existing.task_type ?? null))
    .map((row): GateRequirement => ({
      field_name: row.field_name,
      requirement_type: row.requirement_type,
      match_field: row.match_field,
      severity: row.severity,
      message: row.message,
    }));

  const canonicalExisting = getCanonicalTaskRecord(existing as unknown as Record<string, unknown>);
  const existingCustomFields = parseCustomFields(existing.custom_fields_json);
  const evidenceValidation = validateInlineEvidenceForOutcome(outcome, inlineEvidence, {
    status: existing.status,
    review_branch: canonicalExisting.review_branch,
    review_commit: canonicalExisting.review_commit,
    review_url: canonicalExisting.review_url,
    qa_verified_commit: canonicalExisting.qa_verified_commit,
    qa_tested_url: canonicalExisting.qa_tested_url,
    merged_commit: canonicalExisting.merged_commit,
    deployed_commit: canonicalExisting.deployed_commit,
    deploy_target: canonicalExisting.deploy_target,
    deployed_at: canonicalExisting.deployed_at,
    live_verified_by: canonicalExisting.live_verified_by,
    live_verified_at: canonicalExisting.live_verified_at,
    ...existingCustomFields,
  }, transitionRequirements);

  const authoritativeInstanceId = options.mcpIdentity
    ? await resolveMcpActiveOutcomeInstance(db, taskId, options.mcpIdentity)
    : normalizeOptionalInstanceId(normalizedBody.instance_id ?? normalizedBody.instanceId);
  if (!options.mcpIdentity && authoritativeInstanceId != null) {
    const authorityFailure = await getTaskInstanceAuthorityFailure(db, taskId, authoritativeInstanceId, 'task outcome');
    if (authorityFailure) {
      throw errorWithBody(authorityFailure.status, authorityFailure.body);
    }
  }

  if (!evidenceValidation.valid) {
    if (dryRun) {
      return {
        ok: false,
        dry_run: true,
        applied: false,
        outcome,
        prior_status: existing.status,
        next_status: existing.status,
        evidence_written: false,
        validation_errors: evidenceValidation.errors,
        missing_evidence_requirements: transitionRequirements,
        proposed_changes: {
          task_id: taskId,
          status: { from: existing.status, to: existing.status },
          evidence: inlineEvidence,
        },
      };
    }
    await resolveRefusedTaskOutcome(db, {
            taskId,
            outcome,
            changedBy,
            reason: evidenceValidation.errors[0] ?? 'Evidence validation failed',
            summary,
            instanceId: authoritativeInstanceId,
          });
    const error = new Error('Evidence validation failed') as Error & {
      status?: number;
      validation_errors?: string[];
    };
    error.status = 400;
    error.validation_errors = evidenceValidation.errors;
    throw error;
  }

  const persistOutcomeRefusal = async (reason: string) => {
    await resolveRefusedTaskOutcome(db, {
            taskId,
            outcome,
            changedBy,
            reason,
            summary,
            instanceId: authoritativeInstanceId,
          });
  };

  const isOutcomeRefusalMessage = (message: string) => (
    message.includes('requires ')
    || message.startsWith('qa_pass requires')
    || message.startsWith('deployed_live requires')
    || message.startsWith('live_verified requires')
  );

  if (dryRun) {
    await db.exec('BEGIN');
    try {
      if (hasInline) {
        await updateTaskEvidence(taskId, changedBy, inlineEvidence as Record<string, unknown>);
      }
      const result = await applyTaskOutcome(db, {
        taskId,
        outcome,
        changedBy,
        summary,
        instanceId: authoritativeInstanceId,
        failureDetail,
        dryRun: true,
      });
      await db.exec('ROLLBACK');
      return {
        ok: true,
        dry_run: true,
        applied: result.applied,
        ignored: result.ignored,
        reason: result.reason,
        prior_status: result.priorStatus,
        next_status: result.nextStatus,
        outcome: result.outcome,
        instance_closed: result.instanceClosed ?? false,
        evidence_written: false,
        evidence_would_write: hasInline,
        auto_recovered: result.autoRecovered ?? false,
        recovery_description: result.recoveryDescription ?? null,
        validation_errors: [],
        missing_evidence_requirements: [],
        gate_requirements: transitionRequirements,
        proposed_changes: {
          task_id: taskId,
          status: { from: result.priorStatus, to: result.nextStatus },
          evidence: inlineEvidence,
          instance: {
            instance_id: authoritativeInstanceId,
            would_close: result.instanceClosed ?? false,
          },
        },
      };
    } catch (error) {
      try {
        await db.exec('ROLLBACK');
      } catch {
        // surface original preview failure below
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        dry_run: true,
        applied: false,
        outcome,
        prior_status: existing.status,
        next_status: existing.status,
        evidence_written: false,
        evidence_would_write: hasInline,
        validation_errors: [message],
        missing_evidence_requirements: transitionRequirements,
        proposed_changes: {
          task_id: taskId,
          status: { from: existing.status, to: existing.status },
          evidence: inlineEvidence,
        },
      };
    }
  }

  await db.exec('BEGIN');
  let result;
  try {
    if (hasInline) {
      await updateTaskEvidence(taskId, changedBy, inlineEvidence as Record<string, unknown>);

      const evFields: string[] = [];
      if (inlineEvidence.review_branch) evFields.push(`Branch: ${inlineEvidence.review_branch}`);
      if (inlineEvidence.review_commit) evFields.push(`Commit: ${inlineEvidence.review_commit}`);
      if (inlineEvidence.review_url) evFields.push(`URL: ${inlineEvidence.review_url}`);
      if (inlineEvidence.qa_verified_commit) evFields.push(`QA commit: ${inlineEvidence.qa_verified_commit}`);
      if (inlineEvidence.qa_tested_url) evFields.push(`QA URL: ${inlineEvidence.qa_tested_url}`);
      if (inlineEvidence.merged_commit) evFields.push(`Merged: ${inlineEvidence.merged_commit}`);
      if (inlineEvidence.deployed_commit) evFields.push(`Deployed: ${inlineEvidence.deployed_commit}`);
      if (inlineEvidence.deploy_target) evFields.push(`Target: ${inlineEvidence.deploy_target}`);
      if (inlineEvidence.deployed_at) evFields.push(`At: ${inlineEvidence.deployed_at}`);
      if (inlineEvidence.live_verified_by) evFields.push(`Verified by: ${inlineEvidence.live_verified_by}`);
      if (evFields.length > 0) {
        await addTaskNote(taskId, changedBy, `Atomic evidence (with ${outcome})\n${evFields.join('\n')}`);
      }
    }

    result = await applyTaskOutcome(db, {
      taskId,
      outcome,
      changedBy,
      summary,
      instanceId: authoritativeInstanceId,
      failureDetail,
    });
    await db.exec('COMMIT');
  } catch (error) {
    try {
      await db.exec('ROLLBACK');
    } catch {
      // surface original failure below
    }
    const message = error instanceof Error ? error.message : String(error);
    if (isOutcomeRefusalMessage(message) && !(error instanceof RefusedTaskOutcomeError)) {
      persistOutcomeRefusal(message);
    }
    throw error;
  }

  const task = await requireTask(taskId, db);
  maybeTriggerDispatch(task.project_id as number | null | undefined);
  return {
    ok: true,
    applied: result.applied,
    ignored: result.ignored,
    reason: result.reason,
    prior_status: result.priorStatus,
    next_status: result.nextStatus,
    outcome: result.outcome,
    instance_closed: result.instanceClosed ?? false,
    evidence_written: hasInline,
    auto_recovered: result.autoRecovered ?? false,
    recovery_description: result.recoveryDescription ?? null,
    task: await enrichTask(task),
  };
}

export async function putReviewEvidence(
  db: Db,
  taskId: number,
  body: Record<string, unknown>,
  changedBy: string,
) {
  const reviewBranch = typeof body.review_branch === 'string' || body.review_branch === null ? body.review_branch : undefined;
  const reviewCommit = typeof body.review_commit === 'string' || body.review_commit === null ? body.review_commit : undefined;
  const reviewUrl = typeof body.review_url === 'string' || body.review_url === null ? body.review_url : undefined;
  const summary = typeof body.summary === 'string' || body.summary === null ? body.summary : null;

  const authoritativeInstanceId = body.instance_id != null ? normalizeOptionalInstanceId(body.instance_id) : null;
  if (body.instance_id != null && authoritativeInstanceId == null) {
    const error = new Error('Invalid instance_id') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  if (authoritativeInstanceId != null) {
    const authorityFailure = await getTaskInstanceAuthorityFailure(db, taskId, authoritativeInstanceId, 'review evidence write');
    if (authorityFailure) {
      const error = new Error(String(authorityFailure.body.error ?? 'Review evidence rejected')) as Error & {
        status?: number;
        body?: Record<string, unknown>;
      };
      error.status = authorityFailure.status;
      error.body = authorityFailure.body;
      throw error;
    }
  }

  const validation = validateReviewEvidence({
    review_branch: reviewBranch as string | null | undefined,
    review_commit: reviewCommit as string | null | undefined,
    review_url: reviewUrl as string | null | undefined,
  });
  if (!validation.valid) {
    const error = new Error('Review evidence validation failed') as Error & {
      status?: number;
      validation_errors?: string[];
    };
    error.status = 400;
    error.validation_errors = validation.errors;
    throw error;
  }

  await updateTaskEvidence(taskId, changedBy, {
        review_branch: reviewBranch ?? null,
        review_commit: reviewCommit ?? null,
        review_url: reviewUrl ?? null,
      });

  await addTaskNote(
        taskId,
        changedBy,
        `Review evidence recorded\nBranch: ${reviewBranch ?? '—'}\nCommit: ${reviewCommit ?? '—'}\nURL: ${reviewUrl ?? '—'}${summary ? `\nSummary: ${summary}` : ''}`,
      );

  return await enrichTask(await requireTask(taskId, db));
}

export async function putQaEvidence(
  db: Db,
  taskId: number,
  body: Record<string, unknown>,
  changedBy: string,
) {
  const summary = typeof body.summary === 'string' || body.summary === null ? body.summary : null;
  const resolvedQaVerifiedCommit = body.qa_verified_commit ?? body.verified_commit;
  const resolvedQaTestedUrl = body.qa_tested_url ?? body.tested_url ?? body.qa_url;

  const authoritativeInstanceId = body.instance_id != null ? normalizeOptionalInstanceId(body.instance_id) : null;
  if (body.instance_id != null && authoritativeInstanceId == null) {
    const error = new Error('Invalid instance_id') as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  if (authoritativeInstanceId != null) {
    const authorityFailure = await getTaskInstanceAuthorityFailure(db, taskId, authoritativeInstanceId, 'QA evidence write');
    if (authorityFailure) {
      const error = new Error(String(authorityFailure.body.error ?? 'QA evidence rejected')) as Error & {
        status?: number;
        body?: Record<string, unknown>;
      };
      error.status = authorityFailure.status;
      error.body = authorityFailure.body;
      throw error;
    }
  }

  const explicitClears = new Set<string>();
  if (body.force_clear === true) {
    if (
      (Object.prototype.hasOwnProperty.call(body, 'qa_verified_commit') && body.qa_verified_commit === null)
      || (Object.prototype.hasOwnProperty.call(body, 'verified_commit') && body.verified_commit === null)
    ) {
      explicitClears.add('qa_verified_commit');
    }
    if (
      (Object.prototype.hasOwnProperty.call(body, 'qa_tested_url') && body.qa_tested_url === null)
      || (Object.prototype.hasOwnProperty.call(body, 'tested_url') && body.tested_url === null)
      || (Object.prototype.hasOwnProperty.call(body, 'qa_url') && body.qa_url === null)
    ) {
      explicitClears.add('qa_tested_url');
    }
  }

  const hasSubstantiveCommit = resolvedQaVerifiedCommit !== undefined && resolvedQaVerifiedCommit !== null && resolvedQaVerifiedCommit !== '';
  if (explicitClears.size === 0 && hasSubstantiveCommit) {
    const customFieldsSelect = await taskTableHasColumn(db, 'custom_fields_json') ? 'custom_fields_json' : 'NULL AS custom_fields_json';
    const taskRow = await db.get(`SELECT ${customFieldsSelect} FROM tasks WHERE id = ?`, taskId) as {
      custom_fields_json: string | null;
    } | undefined;
    const canonicalTaskRow = taskRow ? getCanonicalTaskRecord(taskRow as unknown as Record<string, unknown>) : null;
    const existingReviewCommit = canonicalTaskRow?.review_commit ?? null;
    const qaValidation = validateQaEvidence(
      {
        qa_verified_commit: resolvedQaVerifiedCommit as string | null | undefined,
        qa_tested_url: resolvedQaTestedUrl as string | null | undefined,
      },
      existingReviewCommit,
    );
    if (!qaValidation.valid) {
      const error = new Error('QA evidence validation failed') as Error & {
        status?: number;
        validation_errors?: string[];
      };
      error.status = 400;
      error.validation_errors = qaValidation.errors;
      throw error;
    }
  }

  await updateTaskEvidence(taskId, changedBy, {
        qa_verified_commit: resolvedQaVerifiedCommit ?? null,
        qa_tested_url: resolvedQaTestedUrl ?? null,
      }, { explicitClears });

  const commitDisplay = explicitClears.has('qa_verified_commit') ? '[cleared]' : (resolvedQaVerifiedCommit ?? '—');
  const urlDisplay = explicitClears.has('qa_tested_url') ? '[cleared]' : (resolvedQaTestedUrl ?? '—');
  const actionLabel = explicitClears.size > 0 ? 'QA evidence reset (intentional clear)' : 'QA evidence recorded';

  await addTaskNote(
        taskId,
        changedBy,
        `${actionLabel}\nVerified commit: ${String(commitDisplay)}\nTested URL: ${String(urlDisplay)}${summary ? `\nSummary: ${summary}` : ''}`,
      );

  return await enrichTask(await requireTask(taskId, db));
}

export async function putDeployEvidence(
  db: Db,
  taskId: number,
  body: Record<string, unknown>,
  changedBy: string,
) {
  const mergedCommit = typeof body.merged_commit === 'string' || body.merged_commit === null ? body.merged_commit : undefined;
  const deployedCommit = typeof body.deployed_commit === 'string' || body.deployed_commit === null ? body.deployed_commit : undefined;
  const deployTarget = typeof body.deploy_target === 'string' || body.deploy_target === null ? body.deploy_target : undefined;
  const deployedAt = typeof body.deployed_at === 'string' || body.deployed_at === null ? body.deployed_at : undefined;
  const summary = typeof body.summary === 'string' || body.summary === null ? body.summary : null;

  const deployValidation = validateDeployEvidence({
    merged_commit: mergedCommit as string | null | undefined,
    deployed_commit: deployedCommit as string | null | undefined,
    deploy_target: deployTarget as string | null | undefined,
    deployed_at: deployedAt as string | null | undefined,
  });
  if (!deployValidation.valid) {
    const error = new Error('Deploy evidence validation failed') as Error & {
      status?: number;
      validation_errors?: string[];
    };
    error.status = 400;
    error.validation_errors = deployValidation.errors;
    throw error;
  }

  await updateTaskEvidence(taskId, changedBy, {
        merged_commit: mergedCommit ?? null,
        deployed_commit: deployedCommit ?? null,
        deploy_target: deployTarget ?? null,
        deployed_at: deployedAt ?? null,
      });

  await addTaskNote(
        taskId,
        changedBy,
        `Deploy evidence recorded\nMerged commit: ${mergedCommit ?? '—'}\nDeployed commit: ${deployedCommit ?? '—'}\nDeploy target: ${deployTarget ?? '—'}\nDeployed at: ${deployedAt ?? '—'}${summary ? `\nSummary: ${summary}` : ''}`,
      );

  return await enrichTask(await requireTask(taskId, db));
}

export async function putLiveVerification(
  db: Db,
  taskId: number,
  body: Record<string, unknown>,
  changedBy: string,
) {
  const liveVerifiedBy = typeof body.live_verified_by === 'string' || body.live_verified_by === null ? body.live_verified_by : undefined;
  const liveVerifiedAt = typeof body.live_verified_at === 'string' || body.live_verified_at === null ? body.live_verified_at : undefined;
  const summary = typeof body.summary === 'string' || body.summary === null ? body.summary : null;
  const verifiedAt = toCanonicalTimestampOrNow(liveVerifiedAt);

  await updateTaskEvidence(taskId, changedBy, {
        live_verified_by: liveVerifiedBy ?? null,
        live_verified_at: verifiedAt,
      });

  await addTaskNote(
        taskId,
        changedBy,
        `Live verification recorded\nVerified by: ${liveVerifiedBy ?? '—'}\nVerified at: ${verifiedAt}${summary ? `\nSummary: ${summary}` : ''}`,
      );

  return await enrichTask(await requireTask(taskId, db));
}
