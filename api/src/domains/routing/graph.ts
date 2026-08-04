// Workflow routing graph.
//
// Agent HQ's routing config is a state machine that is currently only ever shown as
// flat tables: statuses are nodes, transitions are edges, gate requirements are edge
// conditions, and assignment rules say which agent owns a node. This module derives
// that machine once, server-side, so the canvas UI and Atlas reason over exactly the
// same representation instead of each re-deriving it (and disagreeing).
//
// buildWorkflowGraph is intentionally PURE: every query lives in getWorkflowGraph.
// The lint rules are the valuable part and they are all pure set arithmetic over the
// row inputs, which is what makes them cheap to test exhaustively.
//
// Precedence note: everywhere in routing, higher priority wins and ties break toward
// the LOWER row id (ORDER BY priority DESC, id ASC). The shadowing rule below must
// stay consistent with resolveRoutingRuleForSprint and the dispatcher, or the canvas
// will confidently draw the wrong winner.

import { type Db } from '../../db/adapter/types';
import { listSprintTypeTaskStatuses } from './policy/statuses';
import { listRoutingTransitions } from './transitions';
import { listRoutingRulesForSprint } from './rules';
import { listTransitionRequirements } from './requirements';
import { listWorkflowEventMappings } from './externalEventMappings';
import { requireProjectSprintTypeScope, withStatus } from './scope';

// ── Inputs to the pure builder ────────────────────────────────────────────────

export type GraphStatusInput = {
  name: string;
  label: string;
  color: string;
  terminal: boolean;
  stage_order: number;
  is_default_entry: boolean;
};

export type GraphScopeAnnotation = {
  scope_kind?: string | null;
  is_inherited?: boolean;
  is_override?: boolean;
  effective_for_sprint?: boolean;
};

export type GraphTransitionInput = GraphScopeAnnotation & {
  id: number;
  from_status: string;
  to_status: string;
  outcome: string;
  task_type: string | null;
  priority: number;
  enabled: boolean;
  is_protected?: boolean;
};

export type GraphRuleInput = GraphScopeAnnotation & {
  id: number;
  status: string;
  task_type: string | null;
  agent_id: number | null;
  priority: number;
  enabled: boolean;
};

export type GraphRequirementInput = GraphScopeAnnotation & {
  id: number;
  outcome: string;
  task_type: string | null;
  field_name: string;
  requirement_type: string;
  severity: string;
  message: string;
  enabled: boolean;
};

/**
 * A workflow event mapping. action_kind decides how it affects the machine:
 *
 *   'status'  — sets the task status directly to action_target. A real edge.
 *   'outcome' — reports action_target as an OUTCOME, which then flows through the
 *               normal transition table. NOT a new edge: it is another way to fire
 *               transitions that already exist, so it decorates them instead.
 *   'ignore'  — no effect on the machine.
 *
 * An empty status_includes means "from any status except the excludes", which is how
 * every mapping in practice is written. Expanding those into one edge per source
 * status would more than double the graph with ambient noise, so they are surfaced as
 * an inbound marker on the target node instead — while still counting for reachability.
 */
export type GraphEventMappingInput = {
  id: number;
  event_name: string;
  source: string | null;
  task_type: string | null;
  status_includes: string[];
  status_excludes: string[];
  action_kind: string;
  action_target: string | null;
  enabled: boolean;
  priority: number;
};

export type GraphAgentInput = {
  id: number;
  name: string;
  enabled: boolean;
};

// ── Output ────────────────────────────────────────────────────────────────────

export type LintSeverity = 'error' | 'warn' | 'info';

export type LintFinding = {
  code: string;
  severity: LintSeverity;
  message: string;
  /** status_key this finding is anchored to, when node-scoped. */
  node?: string;
  /** GraphEdge.id this finding is anchored to, when edge-scoped. */
  edge?: string;
};

export type GraphAssignment = {
  rule_id: number;
  task_type: string | null;
  agent_id: number | null;
  agent_name: string | null;
  agent_enabled: boolean;
  priority: number;
  enabled: boolean;
  scope_kind: string;
  is_inherited: boolean;
  is_override: boolean;
  /** False when a workflow-scoped override supersedes this inherited row. */
  effective_for_sprint: boolean;
};

/** An ambient event mapping that can drop a task into this status from many others. */
export type GraphInboundEvent = {
  mapping_id: number;
  event_name: string;
  source: string | null;
  task_type: string | null;
  /** Statuses this event can actually fire from, after applying includes/excludes. */
  from: string[];
  priority: number;
};

export type GraphNode = {
  id: string;
  label: string;
  color: string;
  terminal: boolean;
  stage_order: number;
  is_default_entry: boolean;
  /** Layout layer. Equal to stage_order, which already encodes pipeline position. */
  layer: number;
  assignments: GraphAssignment[];
  inbound_events: GraphInboundEvent[];
  inbound: number;
  outbound: number;
  lint: string[];
};

export type GraphGate = {
  requirement_id: number;
  field_name: string;
  requirement_type: string;
  severity: string;
  message: string;
  task_type: string | null;
  enabled: boolean;
  scope_kind: string;
  is_inherited: boolean;
  is_override: boolean;
  effective_for_sprint: boolean;
};

/** A workflow event that can also fire this edge, alongside an agent reporting it. */
export type GraphEventTrigger = {
  mapping_id: number;
  event_name: string;
  source: string | null;
  task_type: string | null;
};

export type GraphEdge = {
  /** Stable identity: `t<transition_id>` for transitions, `e<mapping_id>` for events. */
  id: string;
  kind: 'transition' | 'event';
  transition_id: number | null;
  mapping_id: number | null;
  from: string;
  to: string;
  /** Outcome for a transition; the triggering event name for an event edge. */
  outcome: string;
  task_type: string | null;
  priority: number;
  enabled: boolean;
  is_protected: boolean;
  scope_kind: string;
  is_inherited: boolean;
  is_override: boolean;
  /** False when a workflow-scoped override supersedes this inherited row. */
  effective_for_sprint: boolean;
  /** Key for collapsing parallel edges between the same node pair in the UI. */
  parallel_group: string;
  /** True when to_status sits at or before from_status — a rework loop. */
  is_back_edge: boolean;
  /** Edge id that always beats this one for the same (from, outcome, task_type). */
  shadowed_by: string | null;
  gates: GraphGate[];
  /** Outcome-kind event mappings that can fire this transition without an agent. */
  event_triggers: GraphEventTrigger[];
  lint: string[];
};

export type WorkflowGraph = {
  scope: {
    project_id: number | null;
    workflow_type: string | null;
    workflow_id: number | null;
    task_type: string | null;
  };
  nodes: GraphNode[];
  edges: GraphEdge[];
  lint: LintFinding[];
  stats: {
    node_count: number;
    edge_count: number;
    error_count: number;
    warn_count: number;
  };
};

// ── Pure derivation ───────────────────────────────────────────────────────────

/** Rows that are shadowed by a higher-precedence row are still returned, but flagged. */
function isLive(row: GraphScopeAnnotation & { enabled: boolean }): boolean {
  // effective_for_sprint is undefined when no workflow is selected, in which case
  // every enabled row participates. When a workflow IS selected, an inherited row
  // that a workflow-scoped override supersedes must not count toward reachability.
  return row.enabled && row.effective_for_sprint !== false;
}

/**
 * Statuses an event mapping can fire from. An explicit includes list means the author
 * enumerated the sources; an empty one means "anywhere", which we expand against the
 * status catalog. Excludes always win.
 */
export function effectiveEventSources(
  mapping: Pick<GraphEventMappingInput, 'status_includes' | 'status_excludes'>,
  allStatuses: string[],
): string[] {
  const base = mapping.status_includes.length > 0 ? mapping.status_includes : allStatuses;
  const excluded = new Set(mapping.status_excludes);
  return base.filter((status) => !excluded.has(status) && allStatuses.includes(status));
}

export function buildWorkflowGraph(input: {
  scope: WorkflowGraph['scope'];
  statuses: GraphStatusInput[];
  transitions: GraphTransitionInput[];
  rules: GraphRuleInput[];
  requirements: GraphRequirementInput[];
  agents: GraphAgentInput[];
  eventMappings?: GraphEventMappingInput[];
}): WorkflowGraph {
  const { scope, statuses, transitions, rules, requirements, agents } = input;
  const eventMappings = (input.eventMappings ?? []).filter((mapping) => mapping.enabled);

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const statusByKey = new Map(statuses.map((status) => [status.name, status]));
  const stageOf = (key: string): number => statusByKey.get(key)?.stage_order ?? Number.MAX_SAFE_INTEGER;

  const lint: LintFinding[] = [];
  const nodeLint = new Map<string, string[]>();
  const edgeLint = new Map<string, string[]>();

  const addNodeFinding = (node: string, code: string, severity: LintSeverity, message: string): void => {
    lint.push({ code, severity, message, node });
    nodeLint.set(node, [...(nodeLint.get(node) ?? []), code]);
  };
  const addEdgeFinding = (edge: string, code: string, severity: LintSeverity, message: string): void => {
    lint.push({ code, severity, message, edge });
    edgeLint.set(edge, [...(edgeLint.get(edge) ?? []), code]);
  };

  // ── Event mappings ──────────────────────────────────────────────────────────
  const statusKeys = statuses.map((status) => status.name);

  // 'status' mappings move a task directly. Scoped ones (the author enumerated the
  // source statuses) become real edges; ambient ones become an inbound marker on the
  // target node. Both count toward reachability.
  const statusMappings = eventMappings
    .filter((mapping) => mapping.action_kind === 'status' && mapping.action_target)
    .map((mapping) => ({
      mapping,
      target: mapping.action_target as string,
      sources: effectiveEventSources(mapping, statusKeys),
      scoped: mapping.status_includes.length > 0,
    }))
    .filter((entry) => entry.sources.length > 0);

  // 'outcome' mappings inject an outcome rather than a status, so they fire whichever
  // transitions already carry that outcome. They decorate, never duplicate.
  const triggersByOutcome = new Map<string, GraphEventTrigger[]>();
  for (const mapping of eventMappings) {
    if (mapping.action_kind !== 'outcome' || !mapping.action_target) continue;
    const trigger: GraphEventTrigger = {
      mapping_id: mapping.id,
      event_name: mapping.event_name,
      source: mapping.source,
      task_type: mapping.task_type,
    };
    triggersByOutcome.set(mapping.action_target, [...(triggersByOutcome.get(mapping.action_target) ?? []), trigger]);
  }

  // ── Shadowing ───────────────────────────────────────────────────────────────
  // Within one (from_status, outcome, task_type) group exactly one transition can
  // ever fire. Group by all three: a task_type=null row does NOT shadow a
  // task_type='bug' row, because the null row still serves every other task type.
  const shadowedBy = new Map<string, string>();
  const groups = new Map<string, GraphTransitionInput[]>();
  for (const transition of transitions) {
    if (!isLive(transition)) continue;
    const key = `${transition.from_status}\u0000${transition.outcome}\u0000${transition.task_type ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), transition]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ranked = [...group].sort((a, b) => (b.priority - a.priority) || (a.id - b.id));
    const winner = ranked[0];
    for (const loser of ranked.slice(1)) {
      shadowedBy.set(`t${loser.id}`, `t${winner.id}`);
      addEdgeFinding(
        `t${loser.id}`,
        'shadowed_transition',
        'warn',
        `Never fires: transition #${winner.id} always wins for ${loser.from_status} + ${loser.outcome}`
          + `${loser.task_type ? ` (${loser.task_type})` : ''}.`,
      );
    }
  }

  // ── Edges ───────────────────────────────────────────────────────────────────
  const gatesByOutcome = new Map<string, GraphRequirementInput[]>();
  for (const requirement of requirements) {
    if (!requirement.enabled) continue;
    gatesByOutcome.set(requirement.outcome, [...(gatesByOutcome.get(requirement.outcome) ?? []), requirement]);
  }

  const edges: GraphEdge[] = transitions.map((transition) => {
    // A gate on task_type=null applies to every task type; a task-type-scoped gate
    // only decorates transitions that can carry that task type.
    const gates = (gatesByOutcome.get(transition.outcome) ?? [])
      .filter((requirement) => requirement.task_type == null
        || transition.task_type == null
        || requirement.task_type === transition.task_type)
      .map((requirement): GraphGate => ({
        requirement_id: requirement.id,
        field_name: requirement.field_name,
        requirement_type: requirement.requirement_type,
        severity: requirement.severity,
        message: requirement.message,
        task_type: requirement.task_type,
        enabled: requirement.enabled,
        scope_kind: requirement.scope_kind ?? 'sprint_type_default',
        is_inherited: Boolean(requirement.is_inherited),
        is_override: Boolean(requirement.is_override),
        effective_for_sprint: requirement.effective_for_sprint !== false,
      }));

    if (!statusByKey.has(transition.from_status)) {
      addEdgeFinding(`t${transition.id}`, 'transition_from_unknown_status', 'error',
        `From-status "${transition.from_status}" is not in this workflow type's status catalog.`);
    }
    if (!statusByKey.has(transition.to_status)) {
      addEdgeFinding(`t${transition.id}`, 'transition_to_unknown_status', 'error',
        `To-status "${transition.to_status}" is not in this workflow type's status catalog.`);
    }

    return {
      id: `t${transition.id}`,
      kind: 'transition' as const,
      transition_id: transition.id,
      mapping_id: null,
      from: transition.from_status,
      to: transition.to_status,
      outcome: transition.outcome,
      task_type: transition.task_type,
      priority: transition.priority,
      enabled: transition.enabled,
      is_protected: Boolean(transition.is_protected),
      scope_kind: transition.scope_kind ?? 'sprint_type_default',
      is_inherited: Boolean(transition.is_inherited),
      is_override: Boolean(transition.is_override),
      effective_for_sprint: transition.effective_for_sprint !== false,
      parallel_group: `${transition.from_status}->${transition.to_status}`,
      is_back_edge: stageOf(transition.to_status) <= stageOf(transition.from_status),
      shadowed_by: shadowedBy.get(`t${transition.id}`) ?? null,
      gates,
      // An outcome-kind event mapping fires this transition without an agent
      // reporting anything, so it belongs on the edge it actually triggers.
      event_triggers: (triggersByOutcome.get(transition.outcome) ?? [])
        .filter((trigger) => trigger.task_type == null
          || transition.task_type == null
          || trigger.task_type === transition.task_type),
      lint: [],
    };
  });

  // Scoped 'status' mappings are real edges: the author named the source statuses, so
  // there are few enough to draw without burying the pipeline.
  for (const entry of statusMappings) {
    if (!entry.scoped) continue;
    if (!statusByKey.has(entry.target)) {
      addEdgeFinding(`e${entry.mapping.id}`, 'event_to_unknown_status', 'error',
        `Event "${entry.mapping.event_name}" targets status "${entry.target}", which is not in this workflow type's status catalog.`);
    }
    for (const from of entry.sources) {
      edges.push({
        id: `e${entry.mapping.id}:${from}`,
        kind: 'event',
        transition_id: null,
        mapping_id: entry.mapping.id,
        from,
        to: entry.target,
        outcome: entry.mapping.event_name,
        task_type: entry.mapping.task_type,
        priority: entry.mapping.priority,
        enabled: entry.mapping.enabled,
        is_protected: false,
        scope_kind: 'workflow_event',
        // A mapping belongs to the workflow itself, so there is nothing to inherit
        // from or be superseded by: it always applies at the scope it was read at.
        is_inherited: false,
        is_override: false,
        effective_for_sprint: true,
        parallel_group: `${from}->${entry.target}`,
        is_back_edge: stageOf(entry.target) <= stageOf(from),
        shadowed_by: null,
        gates: [],
        event_triggers: [],
        lint: [],
      });
    }
  }

  // ── Nodes ───────────────────────────────────────────────────────────────────
  const liveEdges = transitions.filter(isLive).filter((transition) => !shadowedBy.has(`t${transition.id}`));
  const inboundCount = new Map<string, number>();
  const outboundCount = new Map<string, number>();
  for (const edge of liveEdges) {
    // A self-loop is not a way to reach a status, so it must not count as inbound.
    if (edge.to_status !== edge.from_status) {
      inboundCount.set(edge.to_status, (inboundCount.get(edge.to_status) ?? 0) + 1);
    }
    outboundCount.set(edge.from_status, (outboundCount.get(edge.from_status) ?? 0) + 1);
  }

  // Event mappings move tasks for real, so they must count toward reachability whether
  // or not they are drawn as arcs. Without this the graph reports statuses that only
  // events reach as unreachable, and statuses that only events leave as dead ends —
  // which is exactly what a transitions-only view got wrong.
  const inboundEventsByStatus = new Map<string, GraphInboundEvent[]>();
  for (const entry of statusMappings) {
    if (!statusByKey.has(entry.target)) continue;
    const inbound: GraphInboundEvent = {
      mapping_id: entry.mapping.id,
      event_name: entry.mapping.event_name,
      source: entry.mapping.source,
      task_type: entry.mapping.task_type,
      from: entry.sources.filter((from) => from !== entry.target),
      priority: entry.mapping.priority,
    };
    // Ambient mappings are not drawn as arcs, so the node carries the marker instead.
    // Scoped ones already became edges above and would be shown twice.
    if (!entry.scoped) {
      inboundEventsByStatus.set(entry.target, [...(inboundEventsByStatus.get(entry.target) ?? []), inbound]);
    }
    // Counting is independent of how the mapping is drawn: both kinds move tasks.
    for (const from of entry.sources) {
      if (from === entry.target) continue;
      inboundCount.set(entry.target, (inboundCount.get(entry.target) ?? 0) + 1);
      outboundCount.set(from, (outboundCount.get(from) ?? 0) + 1);
    }
  }

  const rulesByStatus = new Map<string, GraphRuleInput[]>();
  for (const rule of rules) {
    rulesByStatus.set(rule.status, [...(rulesByStatus.get(rule.status) ?? []), rule]);
  }

  // Many projects define no workflow-type defaults at all and configure everything
  // per workflow, so the default scope legitimately resolves to nothing. Reporting
  // "unreachable / dead end / unassigned" for every status there would be one warning
  // per status of pure noise, and it would read as "this workflow is broken" when the
  // real answer is "you are looking at a scope that was never configured". Structural
  // findings therefore only apply once the scope actually has edges.
  // A scope with event mappings but no transitions is configured, just event-driven.
  const scopeIsEmpty = liveEdges.length === 0 && statusMappings.length === 0;

  const nodes: GraphNode[] = statuses.map((status) => {
    const statusRules = rulesByStatus.get(status.name) ?? [];
    const assignments: GraphAssignment[] = statusRules.map((rule) => {
      const agent = rule.agent_id == null ? null : agentsById.get(rule.agent_id) ?? null;
      if (isLive(rule) && (agent == null || !agent.enabled)) {
        addNodeFinding(status.name, 'rule_targets_disabled_agent', 'error',
          agent == null
            ? `Assignment rule #${rule.id} points at agent ${rule.agent_id ?? 'null'}, which no longer exists.`
            : `Assignment rule #${rule.id} points at "${agent.name}", which is disabled.`);
      }
      return {
        rule_id: rule.id,
        task_type: rule.task_type,
        agent_id: rule.agent_id,
        agent_name: agent?.name ?? null,
        agent_enabled: Boolean(agent?.enabled),
        priority: rule.priority,
        enabled: rule.enabled,
        scope_kind: rule.scope_kind ?? 'sprint_type_default',
        is_inherited: Boolean(rule.is_inherited),
        is_override: Boolean(rule.is_override),
        effective_for_sprint: rule.effective_for_sprint !== false,
      };
    });

    const inbound = inboundCount.get(status.name) ?? 0;
    const outbound = outboundCount.get(status.name) ?? 0;

    if (!scopeIsEmpty && inbound === 0 && !status.is_default_entry) {
      addNodeFinding(status.name, 'unreachable_status', 'warn',
        `No transition leads to "${status.label}" and it is not an entry status, so no task can reach it.`);
    }
    if (!scopeIsEmpty && outbound === 0 && !status.terminal) {
      addNodeFinding(status.name, 'dead_end_status', 'warn',
        `"${status.label}" is not terminal but has no outgoing transition, so tasks stop here permanently.`);
    }
    // A status nobody is assigned to is the most common real-world failure: work
    // lands and silently never gets picked up. Terminal statuses are expected to
    // have no owner, so they are exempt.
    if (!scopeIsEmpty && !status.terminal && statusRules.filter(isLive).length === 0) {
      addNodeFinding(status.name, 'unassigned_status', 'warn',
        `No agent is assigned to "${status.label}", so tasks that land here are never picked up.`);
    }

    return {
      id: status.name,
      label: status.label,
      color: status.color,
      terminal: status.terminal,
      stage_order: status.stage_order,
      is_default_entry: status.is_default_entry,
      layer: status.stage_order,
      assignments,
      inbound_events: inboundEventsByStatus.get(status.name) ?? [],
      inbound,
      outbound,
      lint: [],
    };
  });

  // ── Graph-level checks ──────────────────────────────────────────────────────
  if (scopeIsEmpty && statuses.length > 0) {
    lint.push({
      code: 'scope_not_configured',
      severity: 'info',
      message: 'No transitions or workflow events are defined at this scope. This project may configure routing per workflow — select a workflow to see its graph.',
    });
  }

  if (!scopeIsEmpty && statuses.length > 0 && !statuses.some((status) => status.is_default_entry)) {
    lint.push({
      code: 'no_entry_point',
      severity: 'error',
      message: 'No status is marked as the default entry, so new tasks have no defined starting point.',
    });
  }

  const usedOutcomes = new Set(liveEdges.map((edge) => edge.outcome));
  const reportedOutcomes = new Set<string>();
  for (const requirement of requirements) {
    if (!requirement.enabled || usedOutcomes.has(requirement.outcome)) continue;
    if (reportedOutcomes.has(requirement.outcome)) continue;
    reportedOutcomes.add(requirement.outcome);
    lint.push({
      code: 'gate_without_transition',
      severity: 'warn',
      message: `Gate requirements exist for outcome "${requirement.outcome}", but no active transition uses it, so they never run.`,
    });
  }

  // Attach the per-element codes collected above.
  for (const node of nodes) node.lint = nodeLint.get(node.id) ?? [];
  for (const edge of edges) {
    // Event edges share one mapping id across their fan-out, so findings recorded
    // against `e<mapping_id>` attach to every arc that mapping produced.
    edge.lint = edgeLint.get(edge.id)
      ?? (edge.mapping_id != null ? edgeLint.get(`e${edge.mapping_id}`) : undefined)
      ?? [];
  }

  return {
    scope,
    nodes: [...nodes].sort((a, b) => (a.stage_order - b.stage_order) || a.id.localeCompare(b.id)),
    edges,
    lint,
    stats: {
      node_count: nodes.length,
      edge_count: edges.length,
      error_count: lint.filter((finding) => finding.severity === 'error').length,
      warn_count: lint.filter((finding) => finding.severity === 'warn').length,
    },
  };
}

// ── Loader ────────────────────────────────────────────────────────────────────

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** status_includes/excludes are stored as JSON text; tolerate an already-parsed array. */
function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function getWorkflowGraph(
  db: Db,
  input: {
    project_id?: unknown;
    sprint_id?: unknown;
    sprint_type?: unknown;
    task_type?: unknown;
    tenant_id?: unknown;
  },
): Promise<WorkflowGraph> {
  const scope = await requireProjectSprintTypeScope(db, input);
  if (!scope.sprintType) {
    throw withStatus('workflow_type is required to build a routing graph', 400);
  }
  const taskTypeLens = asNullableString(input.task_type);

  // Reuse the same loaders the routing tables and resolvers use, so the canvas can
  // never drift from what the tables show or what dispatch actually does.
  // These six loaders are independent, so a pooled handle runs them concurrently. A
  // transaction handle CANNOT: it is pinned to one connection, and node-postgres does not
  // support overlapping queries on a single client — it warns today and will throw from
  // pg@9. The preview endpoint builds the graph inside its non-committing transaction, so
  // this path is reached in both modes.
  const loaders = [
    () => listSprintTypeTaskStatuses(db, scope.sprintType, { tenantId: scope.tenantId }),
    () => listRoutingTransitions(db, input),
    () => listRoutingRulesForSprint(db, input),
    () => listTransitionRequirements(db, input),
    () => db.all(`SELECT id, name, enabled FROM agents`) as Promise<Array<Record<string, unknown>>>,
    () => listWorkflowEventMappings(db, { ...input, tenant_id: scope.tenantId }),
  ] as const;

  let loaded: unknown[];
  if (db.inTransaction) {
    loaded = [];
    for (const load of loaders) loaded.push(await load());
  } else {
    loaded = await Promise.all(loaders.map((load) => load()));
  }
  const [statuses, transitionsResult, rulesResult, requirementsResult, agentRows, eventResult] = loaded as [
    Awaited<ReturnType<typeof listSprintTypeTaskStatuses>>,
    Awaited<ReturnType<typeof listRoutingTransitions>>,
    Awaited<ReturnType<typeof listRoutingRulesForSprint>>,
    Awaited<ReturnType<typeof listTransitionRequirements>>,
    Array<Record<string, unknown>>,
    Awaited<ReturnType<typeof listWorkflowEventMappings>>,
  ];

  const rawTransitions = (transitionsResult.transitions ?? []) as Array<Record<string, unknown>>;
  const rawRules = (rulesResult.rules ?? []) as Array<Record<string, unknown>>;
  const rawRequirements = (requirementsResult.transition_requirements ?? []) as Array<Record<string, unknown>>;

  // The task-type lens narrows to rows that can apply to that task type: the
  // type-specific rows plus the task_type=null rows that also cover it.
  const matchesLens = (value: unknown): boolean => {
    if (!taskTypeLens) return true;
    const taskType = asNullableString(value);
    return taskType === null || taskType === taskTypeLens;
  };

  return buildWorkflowGraph({
    scope: {
      project_id: scope.projectId ?? null,
      workflow_type: scope.sprintType,
      workflow_id: scope.sprintId ?? null,
      task_type: taskTypeLens,
    },
    statuses: statuses.map((status) => ({
      name: status.name,
      label: status.label,
      color: status.color,
      terminal: Boolean(status.terminal),
      stage_order: asNumber(status.stage_order),
      is_default_entry: Boolean(status.is_default_entry),
    })),
    transitions: rawTransitions.filter((row) => matchesLens(row.task_type)).map((row) => ({
      id: asNumber(row.id),
      from_status: String(row.from_status ?? ''),
      to_status: String(row.to_status ?? ''),
      outcome: String(row.outcome ?? ''),
      task_type: asNullableString(row.task_type),
      priority: asNumber(row.priority),
      enabled: asBool(row.enabled),
      is_protected: asBool(row.is_protected),
      scope_kind: asNullableString(row.scope_kind),
      is_inherited: asBool(row.is_inherited),
      is_override: asBool(row.is_override),
      effective_for_sprint: row.effective_for_sprint === undefined ? undefined : asBool(row.effective_for_sprint),
    })),
    rules: rawRules.filter((row) => matchesLens(row.task_type)).map((row) => ({
      id: asNumber(row.id),
      status: String(row.status ?? ''),
      task_type: asNullableString(row.task_type),
      agent_id: row.agent_id == null ? null : asNumber(row.agent_id),
      priority: asNumber(row.priority),
      enabled: asBool(row.enabled),
      scope_kind: asNullableString(row.scope_kind),
      is_inherited: asBool(row.is_inherited),
      is_override: asBool(row.is_override),
      effective_for_sprint: row.effective_for_sprint === undefined ? undefined : asBool(row.effective_for_sprint),
    })),
    requirements: rawRequirements.filter((row) => matchesLens(row.task_type)).map((row) => ({
      id: asNumber(row.id),
      outcome: String(row.outcome ?? ''),
      task_type: asNullableString(row.task_type),
      field_name: String(row.field_name ?? ''),
      requirement_type: String(row.requirement_type ?? 'required'),
      severity: String(row.severity ?? 'block'),
      message: String(row.message ?? ''),
      enabled: asBool(row.enabled),
      scope_kind: asNullableString(row.scope_kind),
      is_inherited: asBool(row.is_inherited),
      is_override: asBool(row.is_override),
      effective_for_sprint: row.effective_for_sprint === undefined ? undefined : asBool(row.effective_for_sprint),
    })),
    agents: agentRows.map((row) => ({
      id: asNumber(row.id),
      name: String(row.name ?? ''),
      enabled: asBool(row.enabled),
    })),
    eventMappings: ((eventResult as { mappings?: Array<Record<string, unknown>> }).mappings ?? [])
      .filter((row) => matchesLens(row.task_type))
      .map((row) => ({
        id: asNumber(row.id),
        event_name: String(row.event_name ?? ''),
        source: asNullableString(row.source),
        task_type: asNullableString(row.task_type),
        status_includes: asStringArray(row.status_includes_json ?? row.status_includes),
        status_excludes: asStringArray(row.status_excludes_json ?? row.status_excludes),
        action_kind: String(row.action_kind ?? 'ignore'),
        action_target: asNullableString(row.action_target),
        enabled: asBool(row.enabled),
        priority: asNumber(row.priority),
      })),
  });
}
