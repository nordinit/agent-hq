import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskRelationshipTypeConfig } from './api/types.ts';
import { relationshipDispatchImpactLabel, relationshipTypeOptionLabel } from './taskRelationshipDisplay.ts';

function relationshipType(overrides: Partial<TaskRelationshipTypeConfig>): TaskRelationshipTypeConfig {
  return {
    id: 1,
    sprint_type_key: 'dev',
    key: 'blocked_by',
    label: 'Blocked by',
    inverse_label: 'Blocks',
    category: 'dependency',
    affects_dispatch_eligibility: 1,
    direction_semantics: 'target_blocks_source',
    active_statuses: [],
    resolved_statuses: [],
    allow_create_related_task: 0,
    default_related_task_type: null,
    default_related_task_status: null,
    is_system: 1,
    metadata: {},
    ...overrides,
  };
}

test('relationshipTypeOptionLabel shows both relationship directions when labels differ', () => {
  assert.equal(
    relationshipTypeOptionLabel(relationshipType({ label: 'Blocked by', inverse_label: 'Blocks' })),
    'Blocked by / Blocks',
  );
});

test('relationshipTypeOptionLabel avoids duplicate direction labels', () => {
  assert.equal(
    relationshipTypeOptionLabel(relationshipType({ label: 'Duplicate of', inverse_label: 'Duplicate of' })),
    'Duplicate of',
  );
});

test('relationshipDispatchImpactLabel describes dispatch blocking direction', () => {
  assert.equal(
    relationshipDispatchImpactLabel(relationshipType({ direction_semantics: 'target_blocks_source' })),
    'Target can block source dispatch',
  );
  assert.equal(
    relationshipDispatchImpactLabel(relationshipType({ direction_semantics: 'source_blocks_target' })),
    'Source can block target dispatch',
  );
  assert.equal(
    relationshipDispatchImpactLabel(relationshipType({ affects_dispatch_eligibility: 0, direction_semantics: 'informational' })),
    'Informational',
  );
});
