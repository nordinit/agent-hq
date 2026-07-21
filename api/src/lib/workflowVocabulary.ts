export const TASK_FIELD_TYPES = ['text', 'textarea', 'url', 'select', 'number', 'checkbox'] as const;
export const RELATIONSHIP_DIRECTION_SEMANTICS = ['target_blocks_source', 'source_blocks_target', 'informational'] as const;
export const TRANSITION_REQUIREMENT_TYPES = ['required', 'match', 'from_status', 'forbidden_values', 'allowed_values', 'forbidden_pattern', 'allowed_pattern'] as const;
export const TRANSITION_REQUIREMENT_SEVERITIES = ['block', 'warn'] as const;
export const WORKFLOW_EVENT_ACTION_KINDS = ['ignore', 'outcome', 'status'] as const;
export const SPRINT_TYPE_OUTCOME_BEHAVIORS = ['base', 'extend', 'override', 'disable'] as const;
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'adaptive'] as const;
