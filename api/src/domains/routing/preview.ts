// Preview a routing config change before committing it.
//
// A canvas gesture is a config change to live dispatch, so the operator needs to see what it
// does BEFORE it happens: which row is written, and — more importantly — what it breaks.
//
// The lint delta is the point. buildWorkflowGraph already derives unreachable statuses, dead
// ends, statuses with no agent assigned, transitions that can never fire, and gates whose
// outcome nothing uses (graph.ts). Computing that graph on both sides of a mutation turns
// "this edit introduces a dead end" into a set difference rather than a guess.
//
// WHY THIS IS SERVER-SIDE AND USES THE REAL WRITE PATH
// A client-side simulation — re-running the pure builder over the row set with the change
// applied — is tempting because buildWorkflowGraph is pure. It cannot work here:
//   * Validation, scope resolution and duplicate detection live in the domain layer and would
//     have to be duplicated, which is the drift the graph endpoint was built to avoid.
// So the mutation runs for real inside a transaction that never commits.

import { type Db } from '../../db/adapter/types';
import { getWorkflowGraph, type LintFinding, type WorkflowGraph } from './graph';
import { withStatus } from './scope';
import { createRoutingRule, deleteRoutingRule, updateRoutingRule } from './rules';
import { createRoutingTransition, deleteRoutingTransition, updateRoutingTransition } from './transitions';
import { createTransitionRequirement, deleteTransitionRequirement, updateTransitionRequirement } from './requirements';

export type PreviewEntity = 'transition' | 'rule' | 'requirement';
export type PreviewAction = 'create' | 'update' | 'delete';

export type PreviewOperation = {
  entity: PreviewEntity;
  action: PreviewAction;
  /** The same body the corresponding write endpoint takes. */
  payload: Record<string, unknown>;
};

export type RoutingPreview = {
  scope: WorkflowGraph['scope'];
  operations: Array<{ entity: PreviewEntity; action: PreviewAction; affected: unknown }>;
  /** Findings present after the change that were not present before. */
  introduced: LintFinding[];
  /** Findings the change clears. */
  resolved: LintFinding[];
  before: WorkflowGraph['stats'];
  after: WorkflowGraph['stats'];
  /**
   * Rows the mutation actually wrote, counted per table. Routing writes seed policy as a side
   * effect, so this is frequently larger than the operation list and is the number worth
   * showing an operator before they commit.
   */
  rows_written: Array<{ table: string; delta: number }>;
  /** How many workflows of this type the change reaches. */
  affects_workflows: { total: number; scope: 'workflow' | 'workflow_type' };
};

/** Carries the finished preview out of a transaction that must not commit. */
class PreviewRollback extends Error {
  constructor(readonly payload: RoutingPreview) {
    super('preview rollback');
    this.name = 'PreviewRollback';
  }
}

const MUTATIONS: Record<PreviewEntity, Record<PreviewAction, (db: Db, input: Record<string, unknown>) => Promise<unknown>>> = {
  transition: {
    create: (db, input) => createRoutingTransition(db, input),
    update: (db, input) => updateRoutingTransition(db, input as Record<string, unknown> & { id: unknown }),
    delete: (db, input) => deleteRoutingTransition(db, input as { id: unknown }),
  },
  rule: {
    create: (db, input) => createRoutingRule(db, input),
    update: (db, input) => updateRoutingRule(db, input as Record<string, unknown> & { id: unknown }),
    delete: (db, input) => deleteRoutingRule(db, input as Record<string, unknown> & { id: unknown }),
  },
  requirement: {
    create: (db, input) => createTransitionRequirement(db, input),
    update: (db, input) => updateTransitionRequirement(db, input as Record<string, unknown> & { id: unknown }),
    delete: (db, input) => deleteTransitionRequirement(db, input as { id: unknown }),
  },
};

/** Findings compare on their code plus whatever they are anchored to. */
function findingKey(finding: LintFinding): string {
  // '\u0000' as an escape, not a literal NUL byte: an embedded NUL makes the whole file read
  // as binary, so grep silently matches nothing in it.
  return [finding.code, finding.node ?? '', finding.edge ?? '', finding.outcome ?? ''].join('\u0000');
}

const COUNTED_TABLES = [
  'sprint_task_transitions',
  'sprint_task_routing_rules',
  'sprint_task_transition_requirements',
  'sprint_task_statuses',
] as const;

async function countRows(db: Db): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of COUNTED_TABLES) {
    const row = await db.get(`SELECT COUNT(*) AS n FROM ${table}`) as { n: number | string } | undefined;
    counts[table] = Number(row?.n ?? 0);
  }
  return counts;
}

export async function previewRoutingChange(
  db: Db,
  input: {
    project_id?: unknown;
    sprint_id?: unknown;
    sprint_type?: unknown;
    tenant_id?: unknown;
    operations?: unknown;
  },
): Promise<RoutingPreview> {
  const operations = Array.isArray(input.operations) ? input.operations as PreviewOperation[] : [];
  if (operations.length === 0) {
    throw withStatus('At least one operation is required', 400);
  }
  for (const operation of operations) {
    if (!MUTATIONS[operation?.entity]?.[operation?.action]) {
      throw withStatus(`Unsupported operation ${String(operation?.entity)}/${String(operation?.action)}`, 400);
    }
  }

  const scopeInput = {
    project_id: input.project_id,
    sprint_id: input.sprint_id,
    sprint_type: input.sprint_type,
    tenant_id: input.tenant_id,
  };

  // Read the "before" side outside the transaction. Inside it would be identical, but doing
  // it here keeps the transaction — and the pooled connection it holds — as short as possible.
  const before = await getWorkflowGraph(db, scopeInput);
  const beforeCounts = await countRows(db);
  const beforeKeys = new Set(before.lint.map(findingKey));

  const workflowCount = await countWorkflowsInScope(db, before.scope);

  try {
    await db.withTransaction(async (tx) => {
      const applied: RoutingPreview['operations'] = [];
      for (const operation of operations) {
        // The tenant is resolved for the scope, so carry it onto every payload rather than
        // trusting the client to repeat it.
        const payload = { ...operation.payload, tenant_id: input.tenant_id };
        const affected = await MUTATIONS[operation.entity][operation.action](tx, payload);
        applied.push({ entity: operation.entity, action: operation.action, affected });
      }

      // Everything below must be awaited inside the callback: the handle is poisoned the
      // instant withTransaction returns.
      const after = await getWorkflowGraph(tx, scopeInput);
      const afterCounts = await countRows(tx);
      const afterKeys = new Set(after.lint.map(findingKey));

      throw new PreviewRollback({
        scope: after.scope,
        operations: applied,
        introduced: after.lint.filter((finding) => !beforeKeys.has(findingKey(finding))),
        resolved: before.lint.filter((finding) => !afterKeys.has(findingKey(finding))),
        before: before.stats,
        after: after.stats,
        rows_written: COUNTED_TABLES
          .map((table) => ({ table, delta: (afterCounts[table] ?? 0) - (beforeCounts[table] ?? 0) }))
          .filter((entry) => entry.delta !== 0),
        affects_workflows: {
          total: workflowCount,
          scope: before.scope.workflow_id != null ? 'workflow' : 'workflow_type',
        },
      });
    });
  } catch (err) {
    if (err instanceof PreviewRollback) return err.payload;
    throw err;
  }
  throw new Error('preview transaction committed without producing a result');
}

/**
 * How many workflows a change at this scope reaches. A workflow-scoped edit touches exactly
 * one; a workflow-type default is shared by every workflow of that type in the project, which
 * is the number an operator needs before editing one.
 */
async function countWorkflowsInScope(db: Db, scope: WorkflowGraph['scope']): Promise<number> {
  if (scope.workflow_id != null) return 1;
  if (scope.project_id == null || !scope.workflow_type) return 0;
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM sprints WHERE project_id = ? AND sprint_type = ?`,
    scope.project_id,
    scope.workflow_type,
  ) as { n: number | string } | undefined;
  return Number(row?.n ?? 0);
}
