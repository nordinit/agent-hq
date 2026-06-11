/**
 * lib/defectTypes.ts — single source of truth for valid defect_type values.
 *
 * Used by schema CHECK constraints and route validation.
 */
export const VALID_DEFECT_TYPES = [
  'incomplete_implementation',
  'qa_miss',
  'scope_gap',
  'regression',
  'spec_error',
] as const;

export type DefectType = typeof VALID_DEFECT_TYPES[number];

export function isValidDefectType(value: unknown): value is DefectType {
  return typeof value === 'string' && (VALID_DEFECT_TYPES as readonly string[]).includes(value);
}
