import type Database from 'better-sqlite3';
import { INLINE_EVIDENCE_FIELD_KEYS } from '../../lib/starterCatalog';
import { parseCustomFields } from './fields';

export type LifecycleEvidenceFieldKey = typeof INLINE_EVIDENCE_FIELD_KEYS[number];

export function taskColumnSet(db: Database.Database): Set<string> {
  try {
    return new Set((db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>).map((col) => col.name));
  } catch {
    return new Set(['custom_fields_json', ...INLINE_EVIDENCE_FIELD_KEYS]);
  }
}

export function taskEvidenceSelects(
  db: Database.Database,
  options: { tableAlias?: string; columns?: Set<string> } = {},
): string[] {
  const columns = options.columns ?? taskColumnSet(db);
  const prefix = options.tableAlias ? `${options.tableAlias}.` : '';
  return INLINE_EVIDENCE_FIELD_KEYS.map((field) => (
    columns.has(field) ? `${prefix}${field}` : `NULL AS ${field}`
  ));
}

export function taskCustomFieldsSelect(
  db: Database.Database,
  options: { tableAlias?: string; columns?: Set<string> } = {},
): string {
  const columns = options.columns ?? taskColumnSet(db);
  const prefix = options.tableAlias ? `${options.tableAlias}.` : '';
  return columns.has('custom_fields_json') ? `${prefix}custom_fields_json` : 'NULL AS custom_fields_json';
}

export function readLifecycleEvidence(row: Record<string, unknown>): Record<LifecycleEvidenceFieldKey, unknown> {
  const customFields = (() => {
    try {
      return parseCustomFields(row.custom_fields_json);
    } catch {
      return {};
    }
  })();
  return Object.fromEntries(INLINE_EVIDENCE_FIELD_KEYS.map((field) => [
    field,
    Object.prototype.hasOwnProperty.call(customFields, field) ? customFields[field] : row[field],
  ])) as Record<LifecycleEvidenceFieldKey, unknown>;
}

export function withLifecycleEvidence(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    ...readLifecycleEvidence(row),
  };
}
