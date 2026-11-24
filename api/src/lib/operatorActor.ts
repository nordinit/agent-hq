/**
 * The actor recorded for operator actions: the operator token, admin MCP keys, and requests that
 * name `operator`, `manual` or the legacy `atlas` as their authority.
 */
export const OPERATOR_ACTOR = 'operator';

/**
 * What operator actions were recorded as before the Atlas assistant was removed. Existing task
 * history keeps it, so readers still treat it as the operator; nothing new writes it.
 */
export const LEGACY_OPERATOR_ACTOR = 'Atlas';

export function isOperatorActor(actor: string | null | undefined): boolean {
  return actor === OPERATOR_ACTOR || actor === LEGACY_OPERATOR_ACTOR;
}
