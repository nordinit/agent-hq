export const TASK_LIFECYCLE_EVIDENCE_FIELD_KEYS = [
  'review_branch',
  'review_commit',
  'review_url',
  'qa_verified_commit',
  'qa_tested_url',
  'merged_commit',
  'deployed_commit',
  'deploy_target',
  'deployed_at',
  'live_verified_by',
  'live_verified_at',
] as const;

export type TaskLifecycleEvidenceFieldKey = typeof TASK_LIFECYCLE_EVIDENCE_FIELD_KEYS[number];

export type TaskLifecycleEvidenceRecord = Partial<Record<TaskLifecycleEvidenceFieldKey, string | null>>;

export function parseTaskCustomFields(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function hasConcreteValue(value: unknown): boolean {
  return value !== null && value !== undefined && value !== '';
}

export function getCanonicalTaskRecord<T extends Record<string, unknown>>(row: T): T & TaskLifecycleEvidenceRecord {
  const customFields = parseTaskCustomFields(row.custom_fields_json);
  const canonical = { ...row, ...customFields } as T & TaskLifecycleEvidenceRecord;
  for (const field of TASK_LIFECYCLE_EVIDENCE_FIELD_KEYS) {
    if (hasConcreteValue(canonical[field])) continue;
    const value = customFields[field];
    if (hasConcreteValue(value)) {
      canonical[field] = typeof value === 'string' ? value : String(value);
    }
  }
  return canonical;
}

export function getCanonicalTaskCustomFields(row: Record<string, unknown>): Record<string, unknown> {
  const customFields = parseTaskCustomFields(row.custom_fields_json);
  for (const field of TASK_LIFECYCLE_EVIDENCE_FIELD_KEYS) {
    if (hasConcreteValue(customFields[field])) continue;
    const value = row[field];
    if (hasConcreteValue(value)) customFields[field] = value;
  }
  return customFields;
}
