// Routing traces — "what would happen" and "what did happen".
//
// Both modes answer the same question in different tenses, and both resolve against
// the SAME graph the canvas renders (see graph.ts). That is deliberate: deriving a
// second, independent answer from the raw tables is how a trace panel ends up
// confidently disagreeing with the diagram sitting next to it.
//
// Consequently a trace step is always expressed as a graph edge id, so the UI has one
// overlay renderer and two data sources.
//
// NOTE ON PRECEDENCE: the hypothetical resolver below reproduces the ordering used by
// resolveRoutingRuleForSprint and the dispatcher — task-type specificity first, then
// priority DESC, then id ASC. buildWorkflowGraph already applies exactly this rule when
// it computes `shadowed_by`, so a shadowed edge can never win here either. If that
// ordering ever changes, graph.ts, rules.ts and dispatcher.ts must change together.

import { type Db } from '../../db/adapter/types';
import { getWorkflowGraph, type GraphEdge, type WorkflowGraph } from './graph';
import { withStatus } from './scope';

// ── Shared ────────────────────────────────────────────────────────────────────

export type TraceGate = {
  requirement_id: number;
  field_name: string;
  requirement_type: string;
  match_field: string | null;
  severity: string;
  message: string;
  task_type: string | null;
};

export type TraceCandidate = {
  edge_id: string;
  to_status: string;
  task_type: string | null;
  priority: number;
  wins: boolean;
  /** Why this candidate lost, when it did. */
  reason: string | null;
};

// ── Mode A: hypothetical ──────────────────────────────────────────────────────

export type HypotheticalTrace = {
  scope: WorkflowGraph['scope'];
  input: { task_type: string | null; from_status: string; outcome: string };
  matched: boolean;
  /** The winning edge, when one matched. */
  result: {
    edge_id: string;
    to_status: string;
    to_status_label: string;
    is_back_edge: boolean;
  } | null;
  candidates: TraceCandidate[];
  /**
   * Gate requirements that would be evaluated. Deliberately NOT evaluated pass/fail:
   * that needs real evidence values off a real task, and a made-up verdict is worse
   * than an honest list of what gets checked.
   */
  gates: TraceGate[];
  /** Who picks the task up once it lands in the destination status. */
  assignment: {
    status: string;
    agent_id: number | null;
    agent_name: string | null;
    rule_id: number | null;
    candidates: Array<{ rule_id: number; agent_id: number | null; agent_name: string | null; task_type: string | null; priority: number; wins: boolean }>;
  } | null;
  notes: string[];
};

/** Task-type specificity, then priority DESC, then id ASC — see the note at the top. */
function rankEdges(edges: GraphEdge[]): GraphEdge[] {
  return [...edges].sort((a, b) => {
    const aSpecific = a.task_type ? 0 : 1;
    const bSpecific = b.task_type ? 0 : 1;
    if (aSpecific !== bSpecific) return aSpecific - bSpecific;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  });
}

export async function traceHypothetical(
  db: Db,
  input: {
    project_id?: unknown;
    sprint_id?: unknown;
    sprint_type?: unknown;
    tenant_id?: unknown;
    task_type?: unknown;
    from_status?: unknown;
    outcome?: unknown;
  },
): Promise<HypotheticalTrace> {
  const fromStatus = typeof input.from_status === 'string' ? input.from_status.trim() : '';
  const outcome = typeof input.outcome === 'string' ? input.outcome.trim() : '';
  const taskType = typeof input.task_type === 'string' && input.task_type.trim().length > 0
    ? input.task_type.trim()
    : null;
  if (!fromStatus || !outcome) {
    throw withStatus('from_status and outcome are required', 400);
  }

  // The task-type lens is applied here rather than passed to the graph, because the
  // trace needs the catch-all (task_type = null) rows too: for a 'bug' task, a
  // task_type=null transition is still a legitimate — just lower-precedence — match.
  const graph = await getWorkflowGraph(db, {
    project_id: input.project_id,
    sprint_id: input.sprint_id,
    sprint_type: input.sprint_type,
    tenant_id: input.tenant_id,
  });

  const notes: string[] = [];
  const applicable = graph.edges.filter((edge) => edge.kind === 'transition'
    && edge.enabled
    && edge.from === fromStatus
    && edge.outcome === outcome
    && (edge.task_type === null || edge.task_type === taskType));

  const ranked = rankEdges(applicable);
  const winner = ranked[0] ?? null;

  const candidates: TraceCandidate[] = ranked.map((edge, index) => ({
    edge_id: edge.id,
    to_status: edge.to,
    task_type: edge.task_type,
    priority: edge.priority,
    wins: index === 0,
    reason: index === 0
      ? null
      : edge.task_type === null && winner?.task_type !== null
        ? `A ${winner?.task_type} transition is more specific.`
        : edge.priority < (winner?.priority ?? 0)
          ? `Lower priority than ${winner?.id} (${edge.priority} < ${winner?.priority}).`
          : 'Loses the tie on row id.',
  }));

  if (!winner) {
    // Distinguish "the outcome does nothing here" from "the outcome does not exist".
    const outcomeUsedElsewhere = graph.edges.some((edge) => edge.outcome === outcome);
    notes.push(outcomeUsedElsewhere
      ? `No transition is configured for "${outcome}" from this status, though other statuses do use that outcome.`
      : `No transition anywhere in this workflow uses the outcome "${outcome}".`);
  }

  // Gates hang off the outcome, so they apply whether or not a transition matched —
  // and a gate with no transition to gate is itself worth showing.
  const gateSource = winner ?? graph.edges.find((edge) => edge.outcome === outcome);
  const gates: TraceGate[] = (gateSource?.gates ?? [])
    .filter((gate) => gate.task_type == null || taskType == null || gate.task_type === taskType)
    .map((gate) => ({
      requirement_id: gate.requirement_id,
      field_name: gate.field_name,
      requirement_type: gate.requirement_type,
      match_field: null,
      severity: gate.severity,
      message: gate.message,
      task_type: gate.task_type,
    }));

  let assignment: HypotheticalTrace['assignment'] = null;
  if (winner) {
    const target = graph.nodes.find((node) => node.id === winner.to);
    if (target) {
      const rules = [...target.assignments]
        .filter((rule) => rule.enabled && (rule.task_type === null || rule.task_type === taskType))
        .sort((a, b) => {
          const aSpecific = a.task_type ? 0 : 1;
          const bSpecific = b.task_type ? 0 : 1;
          if (aSpecific !== bSpecific) return aSpecific - bSpecific;
          if (a.priority !== b.priority) return b.priority - a.priority;
          return a.rule_id - b.rule_id;
        });
      const top = rules[0] ?? null;
      assignment = {
        status: winner.to,
        agent_id: top?.agent_id ?? null,
        agent_name: top?.agent_name ?? null,
        rule_id: top?.rule_id ?? null,
        candidates: rules.map((rule, index) => ({
          rule_id: rule.rule_id,
          agent_id: rule.agent_id,
          agent_name: rule.agent_name,
          task_type: rule.task_type,
          priority: rule.priority,
          wins: index === 0,
        })),
      };
      if (!top && !target.terminal) {
        notes.push(`Nothing is assigned to "${target.label}", so the task would sit there unpicked.`);
      }
      if (top && !rules[0].agent_enabled) {
        notes.push(`The winning rule targets "${top.agent_name}", which is disabled.`);
      }
    }
  }

  return {
    scope: graph.scope,
    input: { task_type: taskType, from_status: fromStatus, outcome },
    matched: Boolean(winner),
    result: winner
      ? {
        edge_id: winner.id,
        to_status: winner.to,
        to_status_label: graph.nodes.find((node) => node.id === winner.to)?.label ?? winner.to,
        is_back_edge: winner.is_back_edge,
      }
      : null,
    candidates,
    gates,
    assignment,
    notes,
  };
}

// ── Mode B: historical ────────────────────────────────────────────────────────

export type TraceStepMatch =
  | 'transition'      // matched a configured transition edge
  | 'event'           // matched a workflow event mapping
  | 'off_graph'       // a human moved it; no edge is expected to exist
  | 'no_current_edge'; // happened under configuration that no longer exists

export type TraceStep = {
  seq: number;
  event_id: number;
  from_status: string | null;
  to_status: string;
  move_type: string;
  moved_by: string;
  agent_id: number | null;
  instance_id: number | null;
  outcome: string | null;
  reason: string | null;
  created_at: string;
  edge_id: string | null;
  match: TraceStepMatch;
};

export type HistoricalTrace = {
  task: {
    id: number;
    title: string;
    status: string;
    task_type: string | null;
    project_id: number | null;
    sprint_id: number | null;
    sprint_type: string | null;
  };
  scope: WorkflowGraph['scope'];
  steps: TraceStep[];
  /** edge id -> how many times this task traversed it. Loops are common. */
  visits: Record<string, number>;
  /** Steps whose configuration no longer exists, i.e. the rules changed since. */
  drift: Array<{ seq: number; message: string }>;
  stats: {
    step_count: number;
    matched: number;
    off_graph: number;
    drifted: number;
    distinct_edges: number;
  };
};

export async function traceTaskHistory(
  db: Db,
  input: { task_id: unknown; tenant_id?: unknown },
): Promise<HistoricalTrace> {
  const taskId = Number(input.task_id);
  if (!Number.isFinite(taskId)) throw withStatus('A valid task id is required', 400);

  const task = await db.get(`
    SELECT t.id, t.title, t.status, t.task_type, t.sprint_id,
           COALESCE(s.project_id, t.project_id) AS project_id,
           s.sprint_type
    FROM tasks t
    LEFT JOIN sprints s ON s.id = t.sprint_id
    WHERE t.id = ?
    LIMIT 1
  `, taskId) as Record<string, unknown> | undefined;
  if (!task) throw withStatus(`Task ${taskId} not found`, 404);

  const sprintType = typeof task.sprint_type === 'string' ? task.sprint_type : null;

  // Resolve the trace against the graph for the task's own workflow, so what the user
  // sees highlighted is exactly the configuration the task is governed by today.
  const graph = sprintType
    ? await getWorkflowGraph(db, {
      project_id: task.project_id,
      sprint_id: task.sprint_id,
      sprint_type: sprintType,
      tenant_id: input.tenant_id,
    })
    : null;

  const rows = await db.all(`
    SELECT e.id, e.from_status, e.to_status, e.move_type, e.moved_by, e.agent_id,
           e.instance_id, e.reason, e.created_at, i.task_outcome
    FROM task_events e
    LEFT JOIN job_instances i ON i.id = e.instance_id
    WHERE e.task_id = ?
    ORDER BY e.created_at ASC, e.id ASC
  `, taskId) as Array<Record<string, unknown>>;

  const taskType = typeof task.task_type === 'string' ? task.task_type : null;
  const visits: Record<string, number> = {};
  const drift: HistoricalTrace['drift'] = [];

  const steps: TraceStep[] = rows.map((row, index) => {
    const fromStatus = typeof row.from_status === 'string' ? row.from_status : null;
    const toStatus = String(row.to_status ?? '');
    const moveType = String(row.move_type ?? 'automatic');
    const outcome = typeof row.task_outcome === 'string' && row.task_outcome.length > 0
      ? row.task_outcome
      : null;

    let edgeId: string | null = null;
    let match: TraceStepMatch = 'no_current_edge';

    // A human moving a task is not required to follow the machine, so a missing edge
    // here is expected rather than drift. 11% of real events are manual.
    if (moveType === 'manual' || moveType === 'rescue') {
      match = 'off_graph';
    } else if (graph && fromStatus) {
      const transition = graph.edges.find((edge) => edge.kind === 'transition'
        && edge.from === fromStatus
        && edge.to === toStatus
        && (outcome === null || edge.outcome === outcome)
        && (edge.task_type === null || edge.task_type === taskType));
      if (transition) {
        edgeId = transition.id;
        match = 'transition';
      } else {
        const eventEdge = graph.edges.find((edge) => edge.kind === 'event'
          && edge.from === fromStatus
          && edge.to === toStatus);
        if (eventEdge) {
          edgeId = eventEdge.id;
          match = 'event';
        } else {
          // Ambient event mappings are not drawn as arcs but still move tasks — a
          // dispatch move into in_progress is normally one of these, and would look
          // like drift if we did not check them.
          const ambient = graph.nodes
            .find((node) => node.id === toStatus)?.inbound_events
            .find((event) => event.from.includes(fromStatus));
          if (ambient) {
            edgeId = `e${ambient.mapping_id}`;
            match = 'event';
          }
        }
      }
    }

    if (match === 'no_current_edge') {
      drift.push({
        seq: index,
        message: graph
          ? `No current rule produces ${fromStatus ?? 'start'} → ${toStatus}${outcome ? ` on "${outcome}"` : ''}. The configuration has changed since this happened.`
          : 'This task has no workflow type, so its moves cannot be matched to a graph.',
      });
    }
    if (edgeId) visits[edgeId] = (visits[edgeId] ?? 0) + 1;

    return {
      seq: index,
      event_id: Number(row.id),
      from_status: fromStatus,
      to_status: toStatus,
      move_type: moveType,
      moved_by: String(row.moved_by ?? 'system'),
      agent_id: row.agent_id == null ? null : Number(row.agent_id),
      instance_id: row.instance_id == null ? null : Number(row.instance_id),
      outcome,
      reason: typeof row.reason === 'string' ? row.reason : null,
      created_at: String(row.created_at ?? ''),
      edge_id: edgeId,
      match,
    };
  });

  return {
    task: {
      id: Number(task.id),
      title: String(task.title ?? ''),
      status: String(task.status ?? ''),
      task_type: taskType,
      project_id: task.project_id == null ? null : Number(task.project_id),
      sprint_id: task.sprint_id == null ? null : Number(task.sprint_id),
      sprint_type: sprintType,
    },
    scope: graph?.scope ?? {
      project_id: task.project_id == null ? null : Number(task.project_id),
      workflow_type: sprintType,
      workflow_id: task.sprint_id == null ? null : Number(task.sprint_id),
      task_type: null,
    },
    steps,
    visits,
    drift,
    stats: {
      step_count: steps.length,
      matched: steps.filter((step) => step.match === 'transition' || step.match === 'event').length,
      off_graph: steps.filter((step) => step.match === 'off_graph').length,
      drifted: steps.filter((step) => step.match === 'no_current_edge').length,
      distinct_edges: Object.keys(visits).length,
    },
  };
}
