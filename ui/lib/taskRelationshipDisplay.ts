import type { TaskRelationshipTypeConfig } from '@/lib/api';

export function relationshipTypeOptionLabel(type: TaskRelationshipTypeConfig): string {
  const inverse = type.inverse_label?.trim();
  if (inverse && inverse !== type.label) return `${type.label} / ${inverse}`;
  return type.label;
}

export function relationshipDispatchImpactLabel(type: TaskRelationshipTypeConfig): string {
  if (type.affects_dispatch_eligibility !== 1) return 'Informational';
  return type.direction_semantics === 'source_blocks_target'
    ? 'Source can block target dispatch'
    : 'Target can block source dispatch';
}
