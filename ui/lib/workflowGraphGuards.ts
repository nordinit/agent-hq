// What the canvas is allowed to do, and what it must warn about first.
//
// Editing from a diagram is fast, and speed is exactly the danger: the gestures are small but
// the rows behind them are shared. These rules are pure and tested because getting one wrong
// silently changes how every workflow of a type dispatches work.

export type GuardVerdict =
  /** Proceed, no caveat. */
  | { allow: true; warning: null; alternative: null }
  /** Proceed, but the operator must be told this first. */
  | { allow: true; warning: string; alternative: string | null }
  /** Refuse, and say what to do instead. */
  | { allow: false; warning: string; alternative: string | null };

export interface GuardTarget {
  /** True when the row belongs to the selected workflow rather than the workflow type. */
  is_override?: boolean;
  enabled?: boolean;
}

export interface GuardContext {
  /** The workflow the canvas is scoped to, or null at workflow-type scope. */
  workflowId: number | null;
  /** Null means "All Projects", where rows are unreachable at dispatch. */
  projectId: number | null;
  /** How many workflows of this type exist in the project. */
  workflowCount: number;
}

const ok: GuardVerdict = { allow: true, warning: null, alternative: null };

/**
 * "All Projects" is a trap, not a scope.
 *
 * The dispatcher requires `rr.project_id = ?` and the transition resolver uses
 * `COALESCE(project_id, s.project_id) = ?`, neither of which a NULL ever matches — so a row
 * created here can never fire. Worse, the update and delete guards compare with `= ?` too, so
 * once created it cannot be addressed again through the API.
 */
export function guardProjectScope(context: GuardContext): GuardVerdict | null {
  if (context.projectId != null) return null;
  return {
    allow: false,
    warning: 'Rows created without a project never match at dispatch, and cannot be edited or deleted afterwards.',
    alternative: 'Select a project first.',
  };
}

/** Creating a row: the only question is which scope it lands in. */
export function guardCreate(context: GuardContext): GuardVerdict {
  const scopeIssue = guardProjectScope(context);
  if (scopeIssue) return scopeIssue;
  if (context.workflowId != null) return ok;
  return {
    allow: true,
    warning: context.workflowCount === 1
      ? 'This is a workflow-type default. It applies to the 1 workflow of this type.'
      : `This is a workflow-type default. It applies to all ${context.workflowCount} workflows of this type.`,
    alternative: null,
  };
}

/**
 * Editing or deleting.
 *
 * The dangerous case is acting on an INHERITED row while scoped to a single workflow: the row
 * is shared, so the change reaches every workflow of the type even though the operator is
 * looking at one. Rather than destroy it, offer the override — which is what they almost
 * certainly meant, and is reversible.
 */
export function guardMutate(
  action: 'update' | 'delete' | 'disable',
  target: GuardTarget,
  context: GuardContext,
): GuardVerdict {
  const scopeIssue = guardProjectScope(context);
  if (scopeIssue) return scopeIssue;

  const inheritedHere = context.workflowId != null && !target.is_override;
  if (inheritedHere) {
    return {
      allow: false,
      warning: `This row is a workflow-type default shared by ${context.workflowCount} workflows. `
        + `${action === 'delete' ? 'Deleting' : 'Changing'} it here would change all of them.`,
      alternative: action === 'delete'
        ? 'Create an override for this workflow instead, so only this workflow is affected.'
        : 'Override it for this workflow instead, leaving the shared default alone.',
    };
  }

  // At workflow-type scope the operator IS editing the shared row, which is legitimate — but
  // the blast radius should be stated rather than assumed.
  if (context.workflowId == null && context.workflowCount > 1) {
    return {
      allow: true,
      warning: `This is a workflow-type default: the change reaches all ${context.workflowCount} workflows of this type.`,
      alternative: null,
    };
  }
  return ok;
}

/**
 * Extra consequences worth stating for a delete, beyond scope.
 *
 * These are not blockers — they are things an operator would be annoyed to discover after the
 * fact, which is the definition of something a confirmation should say.
 */
export function deleteConsequences(entity: 'transition' | 'rule' | 'requirement'): string[] {
  const notes: string[] = [];
  if (entity === 'rule') {
    // reconciler.ts clears assigned_agent_id for tasks whose rule disappeared, but skips any
    // task holding a live instance.
    notes.push('Tasks currently assigned by this rule will be unassigned, except any with a run in flight.');
  }
  if (entity === 'transition') {
    // seedSprintTaskPolicy re-inserts starter policy on the next routing write, and there is
    // no tombstone for transitions the way there is for requirements.
    notes.push('If this is a starter transition, the next routing change to this workflow may recreate it.');
  }
  if (entity === 'requirement') {
    notes.push('A tombstone is recorded, so this requirement will not be re-seeded.');
  }
  return notes;
}
