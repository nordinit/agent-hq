import { annotateRequirementScope, annotateRoutingRuleScope, isRowEnabled } from './scope';

/**
 * A disabled workflow-scoped override does NOT supersede the workflow-type default.
 *
 * The resolvers filter on `enabled = 1` inside the query that unions both scopes, so a
 * disabled override simply drops out and resolution falls through to the default — which is
 * the intended behaviour. The annotators, however, built their override-key set from every
 * workflow-scoped row regardless of `enabled`, so the graph reported the default as
 * superseded while the dispatcher was still executing it. The canvas ghosted a live rule.
 *
 * These tests pin the agreement between the two.
 */

const WORKFLOW_ID = 42;

describe('annotateRoutingRuleScope', () => {
  const rule = (over: Record<string, unknown>) => ({
    id: 1, task_type: null, status: 'ready', agent_id: 7, enabled: 1, ...over,
  });

  it('marks the default superseded when an ENABLED override shares its key', () => {
    const [override, fallback] = annotateRoutingRuleScope([
      rule({ id: 1, sprint_id: WORKFLOW_ID, rule_scope_kind: 'sprint_override', enabled: 1 }),
      rule({ id: 2, sprint_id: null, rule_scope_kind: 'sprint_type_default' }),
    ], WORKFLOW_ID);
    expect(override.effective_for_sprint).toBe(true);
    expect(fallback.overridden_by_sprint).toBe(true);
    expect(fallback.effective_for_sprint).toBe(false);
  });

  it('leaves the default EFFECTIVE when the override sharing its key is disabled', () => {
    const [override, fallback] = annotateRoutingRuleScope([
      rule({ id: 1, sprint_id: WORKFLOW_ID, rule_scope_kind: 'sprint_override', enabled: 0 }),
      rule({ id: 2, sprint_id: null, rule_scope_kind: 'sprint_type_default' }),
    ], WORKFLOW_ID);
    // The disabled override is skipped by the resolver and the default does the work.
    expect(fallback.overridden_by_sprint).toBe(false);
    expect(fallback.effective_for_sprint).toBe(true);
    expect(override.is_override).toBe(true);
  });

  it('still supersedes when one of several overrides for the key is enabled', () => {
    const [, , fallback] = annotateRoutingRuleScope([
      rule({ id: 1, sprint_id: WORKFLOW_ID, rule_scope_kind: 'sprint_override', enabled: 0 }),
      rule({ id: 3, sprint_id: WORKFLOW_ID, rule_scope_kind: 'sprint_override', enabled: 1 }),
      rule({ id: 2, sprint_id: null, rule_scope_kind: 'sprint_type_default' }),
    ], WORKFLOW_ID);
    expect(fallback.effective_for_sprint).toBe(false);
  });

  it('does not let an override for one key affect a default for another', () => {
    const [, fallback] = annotateRoutingRuleScope([
      rule({ id: 1, sprint_id: WORKFLOW_ID, rule_scope_kind: 'sprint_override', status: 'review', enabled: 0 }),
      rule({ id: 2, sprint_id: null, rule_scope_kind: 'sprint_type_default', status: 'ready' }),
    ], WORKFLOW_ID);
    expect(fallback.effective_for_sprint).toBe(true);
  });
});

describe('annotateRequirementScope', () => {
  const requirement = (over: Record<string, unknown>) => ({
    id: 1, task_type: null, outcome: 'completed', field_name: 'pr_url',
    requirement_type: 'required', match_field: null, enabled: 1, ...over,
  });

  it('marks the default superseded when an ENABLED override shares its key', () => {
    const [, fallback] = annotateRequirementScope([
      requirement({ id: 1, sprint_id: WORKFLOW_ID, enabled: 1 }),
      requirement({ id: 2, sprint_id: null }),
    ], WORKFLOW_ID);
    expect(fallback.effective_for_sprint).toBe(false);
  });

  it('leaves the default EFFECTIVE when the override sharing its key is disabled', () => {
    const [, fallback] = annotateRequirementScope([
      requirement({ id: 1, sprint_id: WORKFLOW_ID, enabled: 0 }),
      requirement({ id: 2, sprint_id: null }),
    ], WORKFLOW_ID);
    // loadSprintTaskTransitionRequirements filters enabled=1 before dedupe, so the default
    // survives and still gates. The graph must say the same.
    expect(fallback.overridden_by_sprint).toBe(false);
    expect(fallback.effective_for_sprint).toBe(true);
  });
});

describe('isRowEnabled', () => {
  it('accepts supported true representations', () => {
    // Query and serialization paths may expose boolean, numeric, or string values.
    expect([true, 1, '1'].map(isRowEnabled)).toEqual([true, true, true]);
  });

  it('rejects everything else, including the string "0"', () => {
    // Boolean('0') is true, which is exactly the trap this helper exists to avoid.
    expect([false, 0, '0', null, undefined].map(isRowEnabled)).toEqual([false, false, false, false, false]);
  });
});
