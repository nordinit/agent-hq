import type { Db } from '../../db/adapter/types';
import { tableColumns } from '../../db/introspection';
import { DEV_LIFECYCLE_FIELD_DEFINITIONS, INLINE_EVIDENCE_FIELD_KEYS } from '../../lib/starterCatalog';
import { extractInlineEvidence, type OutcomeEvidence } from '../../lib/evidenceValidation';
import { resolveTaskFieldSchemaForSprint } from '../sprint-definitions/config';
import { TaskCustomFieldValidationError, validateTaskCustomFields } from './fields';

// Failure metadata has an established lifecycle meaning and is not task-field evidence.
export const OUTCOME_PAYLOAD_METADATA_KEYS = new Set(['failure_detail', 'blocker_reason']);
const RESERVED_PAYLOAD_KEYS = new Set([
  '__proto__', 'constructor', 'prototype', 'payload', 'changed_by', 'authority_by',
  'summary', 'dry_run', 'instance_id', 'instanceId', 'sprint_type', 'workflow_id', 'workflow_type',
]);

export function outcomePayload(body: Record<string, unknown>): Record<string, unknown> {
  if (body.payload === undefined || body.payload === null) return {};
  if (typeof body.payload !== 'object' || Array.isArray(body.payload)) {
    throw new TaskCustomFieldValidationError([{ field: 'payload', code: 'invalid_type', message: 'payload must be an object', expected: 'object' }]);
  }
  return body.payload as Record<string, unknown>;
}

/** Match payload evidence against this task's schema; never silently drop an unknown key. */
export async function extractTaskOutcomeEvidence(
  db: Db,
  task: { sprint_id: number | null; task_type: string | null },
  payload: Record<string, unknown>,
): Promise<OutcomeEvidence> {
  const resolved = await resolveTaskFieldSchemaForSprint(db, { sprintId: task.sprint_id, taskType: task.task_type });
  const lifecycleKeys = new Set<string>(INLINE_EVIDENCE_FIELD_KEYS);
  const protectedKeys = new Set([
    ...RESERVED_PAYLOAD_KEYS,
    ...(await tableColumns(db, 'tasks')).filter(key => !lifecycleKeys.has(key)),
  ]);
  const protectedFields = Object.keys(payload).filter(key => protectedKeys.has(key) && !OUTCOME_PAYLOAD_METADATA_KEYS.has(key));
  if (protectedFields.length) {
    throw new TaskCustomFieldValidationError(protectedFields.map(field => ({
      field, code: 'unknown_field', message: `Protected task/control field "${field}" cannot be written through outcome payload`,
    })));
  }
  for (const field of OUTCOME_PAYLOAD_METADATA_KEYS) {
    if (payload[field] != null && typeof payload[field] !== 'string') {
      throw new TaskCustomFieldValidationError([{ field, code: 'invalid_type', message: `${field} must be a string or null`, expected: 'string | null' }]);
    }
  }
  const fields = [
    ...resolved.schema.fields.filter(field => !lifecycleKeys.has(field.key) && !protectedKeys.has(field.key)),
    // Typed lifecycle fields remain supported even in older workflows without a schema.
    ...DEV_LIFECYCLE_FIELD_DEFINITIONS,
  ];
  const evidence = Object.fromEntries(Object.entries(payload).filter(([key]) => !OUTCOME_PAYLOAD_METADATA_KEYS.has(key)));
  validateTaskCustomFields(evidence, { fields }, { requireRequiredFields: false });
  return extractInlineEvidence(evidence, fields.map(field => field.key));
}
