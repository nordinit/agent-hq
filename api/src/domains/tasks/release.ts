import type Database from 'better-sqlite3';
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
import { INLINE_EVIDENCE_FIELD_KEYS } from '../../lib/starterCatalog';
import { loadSprintTaskTransitionRequirements } from '../routing/policy/statuses';
import type { McpApiIdentity } from '../../lib/mcpApiAuth';
import { parseCustomFields } from './fields';
import { getTaskInstanceAuthorityFailure } from './authority';
import {
  addTaskNote,
  maybeTriggerDispatch,
  taskTableHasColumn,
  updateTaskEvidence,
} from './mutations';
import { enrichTask, TASK_SELECT } from './readModel';

function loadTask(taskId: number, db: Database.Database): Record<string, unknown> | undefined {
  return db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(taskId) as Record<string, unknown> | undefined;
}

function requireTask(taskId: number, db: Database.Database): Record<string, unknown> {
  const task = loadTask(taskId, db);
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

function normalizeOutcomeBody(body: Record<string, unknown>): Record<string, unknown> {
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
    ? body.payload as Record<string, unknown>
    : {};
  const payloadCustomFields = payload.custom_fields && typeof payload.custom_fields === 'object' && !Array.isArray(payload.custom_fields)
    ? payload.custom_fields as Record<string, unknown>
    : {};
  const { custom_fields: _customFields, ...payloadFields } = payload;
  const { payload: _payload, ...topLevel } = body;
  return { ...payloadCustomFields, ...payloadFields, ...topLevel };
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

function tableColumnExists(db: Database.Database, table: string, column: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((row) => row.name === column);
  } catch {
    return false;
  }
}

function resolveMcpActiveOutcomeInstance(
  db: Database.Database,
  taskId: number,
  identity: McpApiIdentity,
): number {
  const taskTenantSelect = tableColumnExists(db, 'tasks', 'tenant_id') ? 't.tenant_id AS task_tenant_id,' : 'NULL AS task_tenant_id,';
  const instanceTenantSelect = tableColumnExists(db, 'job_instances', 'tenant_id') ? 'ji.tenant_id AS instance_tenant_id,' : 'NULL AS instance_tenant_id,';
  const row = db.prepare(`
    SELECT
      t.id AS task_id,
      ${taskTenantSelect}
      t.active_instance_id,
      ji.id AS instance_id,
      ${instanceTenantSelect}
      ji.task_id AS instance_task_id,
      ji.agent_id AS instance_agent_id,
      ji.status AS instance_status
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.id = ?
  `).get(taskId) as {
    task_id: number;
    task_tenant_id: number | null;
    active_instance_id: number | null;
    instance_id: number | null;
    instance_tenant_id: number | null;
    instance_task_id: number | null;
    instance_agent_id: number | null;
    instance_status: string | null;
  } | undefined;

  if (!row) throw errorWithBody(404, { error: 'Task not found' });
  if (row.task_tenant_id != null && row.task_tenant_id !== identity.tenantId) {
    throw errorWithBody(404, { error: 'Task not found' });
  }
  if (row.active_instance_id == null) {
    throw errorWithBody(409, {
      error: 'Task outcome rejected: task has no active instance',
      reason: 'no_active_instance',
      task_id: taskId,
      authenticated_agent_id: identity.agentId,
    });
  }
  if (row.instance_tenant_id != null && row.instance_tenant_id !== identity.tenantId) {
    throw errorWithBody(403, {
      error: 'Task outcome rejected: active instance belongs to a different tenant',
      reason: 'active_instance_tenant_mismatch',
      task_id: taskId,
      active_instance_id: row.active_instance_id,
      authenticated_tenant_id: identity.tenantId,
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
  if (row.instance_status && !['running', 'started', 'in_progress'].includes(row.instance_status)) {
    throw errorWithBody(409, {
      error: 'Task outcome rejected: active instance is not running',
      reason: 'active_instance_not_running',
      task_id: taskId,
      active_instance_id: row.active_instance_id,
      active_instance_status: row.instance_status,
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

function parseRequirementFieldExpression(fieldName: string): string[] {
  return fieldName
    .split('|')
    .map(field => field.trim())
    .filter(Boolean);
}

const OUTCOME_PAYLOAD_CONTROL_FIELDS = new Set([
  'outcome',
  'summary',
  'failure_detail',
  'blocker_reason',
  'instance_id',
  'instanceId',
  'dry_run',
  'dryRun',
  'changed_by',
]);

function buildAllowedInlineEvidenceFields(requirements: GateRequirement[]): Set<string> {
  const allowed = new Set<string>(INLINE_EVIDENCE_FIELD_KEYS);
  for (const requirement of requirements) {
    for (const field of parseRequirementFieldExpression(requirement.field_name)) {
      allowed.add(field);
    }
  }
  return allowed;
}

function validateOutcomePayloadFields(
  body: Record<string, unknown>,
  allowedEvidenceFields: Set<string>,
): string[] {
  const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
    ? body.payload as Record<string, unknown>
    : null;
  if (!payload) return [];

  const errors: string[] = [];
  for (const key of Object.keys(payload)) {
    if (key === 'custom_fields') {
      const customFields = payload.custom_fields;
      if (customFields == null || (typeof customFields === 'object' && !Array.isArray(customFields))) {
        continue;
      }
      errors.push('payload.custom_fields must be an object when provided');
      continue;
    }
    if (!OUTCOME_PAYLOAD_CONTROL_FIELDS.has(key) && !allowedEvidenceFields.has(key)) {
      errors.push(`payload field "${key}" is not declared as an evidence gate for this outcome`);
    }
  }

  const customFields = payload.custom_fields;
  if (customFields && typeof customFields === 'object' && !Array.isArray(customFields)) {
    for (const key of Object.keys(customFields as Record<string, unknown>)) {
      if (!allowedEvidenceFields.has(key)) {
        errors.push(`payload.custom_fields field "${key}" is not declared as an evidence gate for this outcome`);
      }
    }
  }

  return errors;
}

function resolveMcpDuplicateSuccessfulOutcome(
  db: Database.Database,
  taskId: number,
  outcome: string,
  identity: McpApiIdentity,
): { instance_id: number; status: string } | null {
  const taskTenantSelect = tableColumnExists(db, 'tasks', 'tenant_id') ? 't.tenant_id AS task_tenant_id,' : 'NULL AS task_tenant_id,';
  const instanceTenantSelect = tableColumnExists(db, 'job_instances', 'tenant_id') ? 'ji.tenant_id AS instance_tenant_id,' : 'NULL AS instance_tenant_id,';
  const row = db.prepare(`
    SELECT
      t.active_instance_id,
      ${taskTenantSelect}
      ji.id AS instance_id,
      ${instanceTenantSelect}
      ji.agent_id AS instance_agent_id,
      ji.task_id AS instance_task_id,
      ji.status AS instance_status,
      ji.task_outcome,
      ji.lifecycle_outcome_posted_at
    FROM tasks t
    LEFT JOIN job_instances ji ON ji.id = t.active_instance_id
    WHERE t.id = ?
  `).get(taskId) as {
    active_instance_id: number | null;
    task_tenant_id: number | null;
    instance_id: number | null;
    instance_tenant_id: number | null;
    instance_agent_id: number | null;
    instance_task_id: number | null;
    instance_status: string | null;
    task_outcome: string | null;
    lifecycle_outcome_posted_at: string | null;
  } | undefined;

  if (!row) return null;
  if (row.task_tenant_id != null && row.task_tenant_id !== identity.tenantId) return null;
  if (row.instance_tenant_id != null && row.instance_tenant_id !== identity.tenantId) return null;
  if (row.active_instance_id == null || row.instance_id == null) return null;
  if (row.instance_task_id !== taskId || row.instance_agent_id !== identity.agentId) return null;
  if (row.task_outcome !== outcome || !row.lifecycle_outcome_posted_at) return null;
  if (row.instance_status !== 'done') return null;
  return { instance_id: row.instance_id, status: row.instance_status };
}

function formatEvidenceNoteFields(inlineEvidence: Record<string, unknown>): string[] {
  const labels: Record<string, string> = {
    review_branch: 'Branch',
    review_commit: 'Commit',
    review_url: 'URL',
    qa_verified_commit: 'QA commit',
    qa_tested_url: 'QA URL',
    merged_commit: 'Merged',
    deployed_commit: 'Deployed',
    deploy_target: 'Target',
    deployed_at: 'At',
    live_verified_by: 'Verified by',
    live_verified_at: 'Verified at',
  };
  return Object.entries(inlineEvidence)
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim().length > 0)
    .map(([field, value]) => `${labels[field] ?? field}: ${String(value)}`);
}

export async function postTaskOutcome(
  db: Database.Database,
  taskId: number,
  body: Record<string, unknown>,
  changedBy: string,
  options: { mcpIdentity?: McpApiIdentity | null } = {},
) {
  const normalizedBody = normalizeOutcomeBody(body);
  const dryRun = normalizedBody.dry_run === true || normalizedBody.dry_run === 'true';
  const customFieldsSelect = taskTableHasColumn(db, 'custom_fields_json') ? 'custom_fields_json' : 'NULL AS custom_fields_json';
  const existing = db.prepare(
    `SELECT id, status, task_type, sprint_id,
            review_branch, review_commit, review_url,
            qa_verified_commit, qa_tested_url,
            merged_commit, deployed_commit, deploy_target, deployed_at,
            live_verified_by, live_verified_at,
            ${customFieldsSelect}
     FROM tasks WHERE id = ?`,
  ).get(taskId) as {
    id: number;
    status: string;
    task_type: string | null;
    sprint_id: number | null;
    review_branch: string | null;
    review_commit: string | null;
    review_url: string | null;
    qa_verified_commit: string | null;
    qa_tested_url: string | null;
    merged_commit: string | null;
    deployed_commit: string | null;
    deploy_target: string | null;
    deployed_at: string | null;
    live_verified_by: string | null;
    live_verified_at: string | null;
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

  const transitionRequirements = loadSprintTaskTransitionRequirements(db, existing.sprint_id ?? null, outcome, existing.task_type ?? null)
    .map((row): GateRequirement => ({
      field_name: row.field_name,
      requirement_type: row.requirement_type,
      match_field: row.match_field,
      severity: row.severity,
      message: row.message,
    }));
  const allowedEvidenceFields = buildAllowedInlineEvidenceFields(transitionRequirements);
  const payloadFieldErrors = validateOutcomePayloadFields(body, allowedEvidenceFields);
  if (payloadFieldErrors.length > 0) {
    if (dryRun) {
      return {
        ok: false,
        dry_run: true,
        applied: false,
        outcome,
        prior_status: existing.status,
        next_status: existing.status,
        evidence_written: false,
        validation_errors: payloadFieldErrors,
        missing_evidence_requirements: transitionRequirements,
        proposed_changes: {
          task_id: taskId,
          status: { from: existing.status, to: existing.status },
          evidence: {},
        },
      };
    }
    const error = new Error('Evidence validation failed') as Error & {
      status?: number;
      validation_errors?: string[];
    };
    error.status = 400;
    error.validation_errors = payloadFieldErrors;
    throw error;
  }

  const inlineEvidence = extractInlineEvidence(normalizedBody, allowedEvidenceFields);
  const hasInline = hasAnyEvidence(inlineEvidence);

  const existingCustomFields = parseCustomFields(existing.custom_fields_json);
  const evidenceValidation = validateInlineEvidenceForOutcome(outcome, inlineEvidence, {
    status: existing.status,
    review_branch: existing.review_branch,
    review_commit: existing.review_commit,
    review_url: existing.review_url,
    qa_verified_commit: existing.qa_verified_commit,
    qa_tested_url: existing.qa_tested_url,
    merged_commit: existing.merged_commit,
    deployed_commit: existing.deployed_commit,
    deploy_target: existing.deploy_target,
    deployed_at: existing.deployed_at,
    live_verified_by: existing.live_verified_by,
    live_verified_at: existing.live_verified_at,
    ...existingCustomFields,
  }, transitionRequirements);

  if (options.mcpIdentity && !dryRun) {
    const duplicate = resolveMcpDuplicateSuccessfulOutcome(db, taskId, outcome, options.mcpIdentity);
    if (duplicate) {
      const task = requireTask(taskId, db);
      return {
        ok: true,
        applied: false,
        ignored: true,
        reason: 'duplicate_success',
        prior_status: existing.status,
        next_status: existing.status,
        outcome,
        instance_closed: true,
        evidence_written: false,
        auto_recovered: false,
        recovery_description: null,
        task: enrichTask(task),
      };
    }
  }

  const authoritativeInstanceId = options.mcpIdentity
    ? resolveMcpActiveOutcomeInstance(db, taskId, options.mcpIdentity)
    : normalizeOptionalInstanceId(normalizedBody.instance_id ?? normalizedBody.instanceId);
  if (!options.mcpIdentity && authoritativeInstanceId != null) {
    const authorityFailure = getTaskInstanceAuthorityFailure(db, taskId, authoritativeInstanceId, 'task outcome');
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
    resolveRefusedTaskOutcome(db, {
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

  const persistOutcomeRefusal = (reason: string) => {
    resolveRefusedTaskOutcome(db, {
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
        updateTaskEvidence(taskId, changedBy, inlineEvidence as Record<string, unknown>, { db });
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
      updateTaskEvidence(taskId, changedBy, inlineEvidence as Record<string, unknown>, { db });

      const evFields = formatEvidenceNoteFields(inlineEvidence as Record<string, unknown>);
      if (evFields.length > 0) {
        addTaskNote(taskId, changedBy, `Atomic evidence (with ${outcome})\n${evFields.join('\n')}`, db);
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

  const task = requireTask(taskId, db);
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
    task: enrichTask(task),
  };
}

export function putReviewEvidence(
  db: Database.Database,
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
    const authorityFailure = getTaskInstanceAuthorityFailure(db, taskId, authoritativeInstanceId, 'review evidence write');
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

  updateTaskEvidence(taskId, changedBy, {
    review_branch: reviewBranch ?? null,
    review_commit: reviewCommit ?? null,
    review_url: reviewUrl ?? null,
  });

  addTaskNote(
    taskId,
    changedBy,
    `Review evidence recorded\nBranch: ${reviewBranch ?? '—'}\nCommit: ${reviewCommit ?? '—'}\nURL: ${reviewUrl ?? '—'}${summary ? `\nSummary: ${summary}` : ''}`,
  );

  return enrichTask(requireTask(taskId, db));
}

export function putQaEvidence(
  db: Database.Database,
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
    const authorityFailure = getTaskInstanceAuthorityFailure(db, taskId, authoritativeInstanceId, 'QA evidence write');
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
    const customFieldsSelect = taskTableHasColumn(db, 'custom_fields_json') ? 'custom_fields_json' : 'NULL AS custom_fields_json';
    const taskRow = db.prepare(`SELECT review_commit, ${customFieldsSelect} FROM tasks WHERE id = ?`).get(taskId) as {
      review_commit: string | null;
      custom_fields_json: string | null;
    } | undefined;
    const taskCustomFields = taskRow ? parseCustomFields(taskRow.custom_fields_json) : {};
    const existingReviewCommit = (taskCustomFields.review_commit as string | null | undefined) ?? taskRow?.review_commit ?? null;
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

  updateTaskEvidence(taskId, changedBy, {
    qa_verified_commit: resolvedQaVerifiedCommit ?? null,
    qa_tested_url: resolvedQaTestedUrl ?? null,
  }, { explicitClears });

  const commitDisplay = explicitClears.has('qa_verified_commit') ? '[cleared]' : (resolvedQaVerifiedCommit ?? '—');
  const urlDisplay = explicitClears.has('qa_tested_url') ? '[cleared]' : (resolvedQaTestedUrl ?? '—');
  const actionLabel = explicitClears.size > 0 ? 'QA evidence reset (intentional clear)' : 'QA evidence recorded';

  addTaskNote(
    taskId,
    changedBy,
    `${actionLabel}\nVerified commit: ${String(commitDisplay)}\nTested URL: ${String(urlDisplay)}${summary ? `\nSummary: ${summary}` : ''}`,
  );

  return enrichTask(requireTask(taskId, db));
}

export function putDeployEvidence(
  db: Database.Database,
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

  updateTaskEvidence(taskId, changedBy, {
    merged_commit: mergedCommit ?? null,
    deployed_commit: deployedCommit ?? null,
    deploy_target: deployTarget ?? null,
    deployed_at: deployedAt ?? null,
  });

  addTaskNote(
    taskId,
    changedBy,
    `Deploy evidence recorded\nMerged commit: ${mergedCommit ?? '—'}\nDeployed commit: ${deployedCommit ?? '—'}\nDeploy target: ${deployTarget ?? '—'}\nDeployed at: ${deployedAt ?? '—'}${summary ? `\nSummary: ${summary}` : ''}`,
  );

  return enrichTask(requireTask(taskId, db));
}

export function putLiveVerification(
  db: Database.Database,
  taskId: number,
  body: Record<string, unknown>,
  changedBy: string,
) {
  const liveVerifiedBy = typeof body.live_verified_by === 'string' || body.live_verified_by === null ? body.live_verified_by : undefined;
  const liveVerifiedAt = typeof body.live_verified_at === 'string' || body.live_verified_at === null ? body.live_verified_at : undefined;
  const summary = typeof body.summary === 'string' || body.summary === null ? body.summary : null;
  const verifiedAt = liveVerifiedAt ?? new Date().toISOString();

  updateTaskEvidence(taskId, changedBy, {
    live_verified_by: liveVerifiedBy ?? null,
    live_verified_at: verifiedAt,
  });

  addTaskNote(
    taskId,
    changedBy,
    `Live verification recorded\nVerified by: ${liveVerifiedBy ?? '—'}\nVerified at: ${verifiedAt}${summary ? `\nSummary: ${summary}` : ''}`,
  );

  return enrichTask(requireTask(taskId, db));
}
