// How the canvas presents inheritance.
//
// Routing rows live at two scopes: workflow-type defaults shared by every workflow of that
// type, and overrides belonging to one workflow. Direct manipulation is not safe until that
// distinction is visible — deleting a shared default while looking at a single workflow
// silently changes every workflow of that type.
//
// The rules are here rather than inline in the component because ui/lib is the only part of
// the UI with test coverage, and because the interesting cases (a superseded default) do not
// exist in the current data, so they can only be pinned by unit test.

/** The scope fields the graph endpoint puts on edges, assignments and gates. */
export interface ScopeAnnotated {
  is_override?: boolean;
  effective_for_sprint?: boolean;
}

export type ScopePresentation =
  /** No workflow selected: every row IS the default, so saying so would be noise. */
  | 'not-applicable'
  /** Belongs to the selected workflow. */
  | 'override'
  /** Inherited from the workflow type and live here. */
  | 'inherited'
  /** Inherited but an override for the same key takes precedence, so it does nothing here. */
  | 'superseded';

export function scopePresentation(row: ScopeAnnotated, workflowSelected: boolean): ScopePresentation {
  if (!workflowSelected) return 'not-applicable';
  // Superseded is checked first: a row can only be superseded if it is inherited, and that is
  // the more important fact about it — it is present in the config but does nothing.
  if (row.effective_for_sprint === false) return 'superseded';
  return row.is_override ? 'override' : 'inherited';
}

/**
 * Whether marking an individual element earns its place.
 *
 * When every element in a group shares one scope — which is common, since a workflow tends to
 * either override a whole area or inherit it wholesale — a badge on each one carries no
 * information and just adds noise. The summary line states it once instead.
 */
export function shouldMarkIndividually(rows: readonly ScopeAnnotated[], workflowSelected: boolean): boolean {
  if (!workflowSelected || rows.length < 2) return false;
  const first = scopePresentation(rows[0], workflowSelected);
  return rows.some((row) => scopePresentation(row, workflowSelected) !== first);
}

export interface ScopeSummary {
  override: number;
  inherited: number;
  superseded: number;
  /** Null when there is nothing worth saying. */
  label: string | null;
}

/** One honest sentence about where the config on screen actually lives. */
export function summarizeScope(rows: readonly ScopeAnnotated[], workflowSelected: boolean): ScopeSummary {
  const counts = { override: 0, inherited: 0, superseded: 0 };
  if (workflowSelected) {
    for (const row of rows) {
      const presentation = scopePresentation(row, true);
      if (presentation === 'override') counts.override += 1;
      else if (presentation === 'inherited') counts.inherited += 1;
      else if (presentation === 'superseded') counts.superseded += 1;
    }
  }

  if (!workflowSelected || rows.length === 0) return { ...counts, label: null };

  const parts: string[] = [];
  if (counts.override > 0) parts.push(`${counts.override} on this workflow`);
  if (counts.inherited > 0) parts.push(`${counts.inherited} inherited`);
  if (counts.superseded > 0) parts.push(`${counts.superseded} superseded`);
  return { ...counts, label: parts.length > 0 ? parts.join(' · ') : null };
}
