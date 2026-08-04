'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type WorkflowGraph, type WorkflowGraphEdge, type WorkflowGraphNode } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { SectionHeader, COLOR_BADGE_CLASSES } from '@/components/workflowConfig';
import { getTaskTypeLabel } from '@/lib/taskTypes';
import {
  arcPath,
  computeGraphLayout,
  LANE_WIDTH,
  NODE_HEIGHT,
  NODE_WIDTH,
  type LayoutArc,
} from '@/lib/workflowGraphLayout';
import {
  AlertTriangle,
  CircleDot,
  Flag,
  Info,
  Lock,
  RefreshCw,
  Bot,
  Ban,
} from 'lucide-react';

const LINT_LABELS: Record<string, string> = {
  unreachable_status: 'Unreachable',
  dead_end_status: 'Dead end',
  unassigned_status: 'No agent assigned',
  shadowed_transition: 'Never fires',
  gate_without_transition: 'Gate never runs',
  transition_to_unknown_status: 'Unknown target status',
  transition_from_unknown_status: 'Unknown source status',
  rule_targets_disabled_agent: 'Disabled agent',
  no_entry_point: 'No entry point',
  scope_not_configured: 'Scope not configured',
};

const SEVERITY_STYLES: Record<string, { chip: string; dot: string }> = {
  error: { chip: 'border-red-500/40 bg-red-950/40 text-red-300', dot: 'bg-red-400' },
  warn: { chip: 'border-amber-500/40 bg-amber-950/40 text-amber-300', dot: 'bg-amber-400' },
  info: { chip: 'border-sky-500/40 bg-sky-950/40 text-sky-300', dot: 'bg-sky-400' },
};

type Selection =
  | { kind: 'node'; id: string }
  | { kind: 'arc'; key: string }
  | null;

export default function WorkflowGraphSection({
  projectId,
  sprintId,
  sprintType,
  sprintName,
}: {
  projectId: number | null;
  sprintId: number | null;
  sprintType: string | null;
  sprintName: string | null;
}) {
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taskTypeLens, setTaskTypeLens] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [showOnlyProblems, setShowOnlyProblems] = useState(false);

  const load = useCallback(() => {
    if (!sprintType) {
      setGraph(null);
      return;
    }
    setLoading(true);
    setError(null);
    api.getRoutingGraph(projectId, sprintType, sprintId, taskTypeLens)
      .then(setGraph)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [projectId, sprintId, sprintType, taskTypeLens]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setSelection(null); }, [projectId, sprintId, sprintType, taskTypeLens]);

  const layout = useMemo(
    () => computeGraphLayout(graph?.nodes ?? [], graph?.edges ?? []),
    [graph],
  );

  const edgesById = useMemo(
    () => new Map((graph?.edges ?? []).map(edge => [edge.transition_id, edge])),
    [graph],
  );
  const nodesById = useMemo(
    () => new Map((graph?.nodes ?? []).map(node => [node.id, node])),
    [graph],
  );

  const taskTypes = useMemo(() => {
    const set = new Set<string>();
    for (const edge of graph?.edges ?? []) if (edge.task_type) set.add(edge.task_type);
    for (const node of graph?.nodes ?? []) {
      for (const assignment of node.assignments) if (assignment.task_type) set.add(assignment.task_type);
    }
    return [...set].sort();
  }, [graph]);

  const arcEdges = useCallback(
    (arc: LayoutArc): WorkflowGraphEdge[] =>
      arc.edgeIds.map(id => edgesById.get(id)).filter((e): e is WorkflowGraphEdge => Boolean(e)),
    [edgesById],
  );

  const arcHasProblem = useCallback(
    (arc: LayoutArc): boolean => arcEdges(arc).some(edge => edge.lint.length > 0),
    [arcEdges],
  );

  if (!sprintType) {
    return (
      <Card className="p-10 text-center text-sm text-slate-400">
        Select a workflow type above to see its routing graph.
      </Card>
    );
  }

  if (loading && !graph) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
      </div>
    );
  }

  if (error) {
    return <Card className="border-red-700 bg-red-900/30 p-6 text-sm text-red-300">{error}</Card>;
  }

  if (!graph) return null;

  // Outcome labels hang off the outermost lane, so the gutter has to reserve room for
  // one label width or they clip against the edge of the scroll container.
  const LABEL_ALLOWANCE = 158;
  const gutterLeft = layout.leftLanes * LANE_WIDTH + (layout.leftLanes > 0 ? LABEL_ALLOWANCE : 24);
  const gutterRight = layout.rightLanes * LANE_WIDTH + (layout.rightLanes > 0 ? LABEL_ALLOWANCE : 24);
  const canvasWidth = gutterLeft + NODE_WIDTH + gutterRight;
  const nodeX = gutterLeft;
  const anchorLeft = nodeX;
  const anchorRight = nodeX + NODE_WIDTH;

  const selectedNode: WorkflowGraphNode | null =
    selection?.kind === 'node' ? nodesById.get(selection.id) ?? null : null;
  const selectedArc = selection?.kind === 'arc'
    ? layout.arcs.find(arc => arc.key === selection.key) ?? null
    : null;

  return (
    <div className="space-y-4">
      <SectionHeader
        label="Workflow Graph"
        help="The routing configuration as a state machine: statuses are nodes, transitions are arcs labelled by the outcome that triggers them, agent chips show who picks work up, and locks mark outcomes with gate requirements. Read-only — use the other tabs to edit."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {taskTypes.length > 0 && (
              <div className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 p-1">
                <button
                  onClick={() => setTaskTypeLens(null)}
                  className={`rounded px-2 py-1 text-xs transition-colors ${
                    taskTypeLens === null ? 'bg-amber-500/20 text-amber-300' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  All types
                </button>
                {taskTypes.map(type => (
                  <button
                    key={type}
                    onClick={() => setTaskTypeLens(type)}
                    className={`rounded px-2 py-1 text-xs transition-colors ${
                      taskTypeLens === type ? 'bg-amber-500/20 text-amber-300' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {getTaskTypeLabel(type)}
                  </button>
                ))}
              </div>
            )}
            <button
              onClick={() => setShowOnlyProblems(v => !v)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                showOnlyProblems
                  ? 'border-amber-500/40 bg-amber-950/40 text-amber-300'
                  : 'border-slate-700 bg-slate-900 text-slate-400 hover:text-slate-200'
              }`}
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Problems only
            </button>
            <button
              onClick={load}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-400 transition-colors hover:text-slate-200"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
          </div>
        }
      />

      {/* Health summary */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-slate-400">
          {graph.stats.node_count} statuses · {graph.stats.edge_count} transitions
          {sprintName ? ` · ${sprintName}` : ' · workflow-type defaults'}
        </span>
        {graph.stats.error_count > 0 && (
          <span className={`rounded-md border px-2 py-1 ${SEVERITY_STYLES.error.chip}`}>
            {graph.stats.error_count} error{graph.stats.error_count === 1 ? '' : 's'}
          </span>
        )}
        {graph.stats.warn_count > 0 && (
          <span className={`rounded-md border px-2 py-1 ${SEVERITY_STYLES.warn.chip}`}>
            {graph.stats.warn_count} warning{graph.stats.warn_count === 1 ? '' : 's'}
          </span>
        )}
        {graph.stats.error_count === 0 && graph.stats.warn_count === 0 && graph.stats.edge_count > 0 && (
          <span className="rounded-md border border-emerald-500/40 bg-emerald-950/40 px-2 py-1 text-emerald-300">
            No problems found
          </span>
        )}
      </div>

      {/* Graph-level findings that are not anchored to a node or arc */}
      {graph.lint.filter(f => !f.node && f.edge === undefined).map((finding, index) => (
        <div
          key={`${finding.code}-${index}`}
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${SEVERITY_STYLES[finding.severity]?.chip ?? SEVERITY_STYLES.info.chip}`}
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{finding.message}</span>
        </div>
      ))}

      {/* The canvas keeps the full width until there is genuinely room for a side
          panel, otherwise the gutters get squeezed and the graph clips. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── Canvas ─────────────────────────────────────────────── */}
        <Card className="overflow-x-auto p-6">
          {graph.nodes.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">
              This workflow type has no statuses defined yet.
            </p>
          ) : (
            <div className="relative" style={{ width: canvasWidth, height: layout.height, minWidth: canvasWidth }}>
              {/* Arcs sit behind the node boxes. */}
              <svg
                className="absolute inset-0 overflow-visible"
                width={canvasWidth}
                height={layout.height}
                aria-hidden="true"
              >
                <defs>
                  <marker id="wf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                    <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
                  </marker>
                </defs>
                {layout.arcs.map(arc => {
                  const edges = arcEdges(arc);
                  const problem = arcHasProblem(arc);
                  const allShadowed = edges.length > 0 && edges.every(e => e.shadowed_by !== null);
                  const dimmed = showOnlyProblems && !problem;
                  const isSelected = selection?.kind === 'arc' && selection.key === arc.key;
                  const color = problem
                    ? 'text-red-400'
                    : arc.adjacent
                      ? 'text-emerald-500'
                      : arc.side === 'left'
                        ? 'text-purple-400'
                        : 'text-slate-500';
                  // Adjacent hops run down the middle of the node column; gutter arcs
                  // anchor to whichever edge of the box they bulge out from.
                  const anchor = arc.adjacent
                    ? nodeX + NODE_WIDTH / 2
                    : arc.side === 'right' ? anchorRight : anchorLeft;
                  return (
                    <g
                      key={arc.key}
                      className={`${color} cursor-pointer transition-opacity ${dimmed ? 'opacity-15' : isSelected ? 'opacity-100' : 'opacity-70 hover:opacity-100'}`}
                      onClick={() => setSelection({ kind: 'arc', key: arc.key })}
                    >
                      <path
                        d={arcPath(arc, anchor)}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={isSelected ? 2.5 : 1.5}
                        strokeDasharray={allShadowed ? '4 3' : undefined}
                        markerEnd="url(#wf-arrow)"
                      />
                      {/* Widen the hit target without thickening the visible stroke. */}
                      <path
                        d={arcPath(arc, anchor)}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={12}
                      />
                    </g>
                  );
                })}
              </svg>

              {/* Nodes */}
              {layout.nodes.map(layoutNode => {
                const node = nodesById.get(layoutNode.id);
                if (!node) return null;
                const hasProblem = node.lint.length > 0;
                const dimmed = showOnlyProblems && !hasProblem;
                const isSelected = selection?.kind === 'node' && selection.id === node.id;
                const badgeClass = COLOR_BADGE_CLASSES[node.color] ?? COLOR_BADGE_CLASSES.slate;
                return (
                  <button
                    key={node.id}
                    onClick={() => setSelection({ kind: 'node', id: node.id })}
                    className={`absolute flex flex-col justify-center rounded-xl border px-3 py-2 text-left transition-all ${
                      isSelected
                        ? 'border-amber-400 bg-slate-800 shadow-lg shadow-amber-950/30'
                        : hasProblem
                          ? 'border-red-500/50 bg-slate-900 hover:border-red-400'
                          : 'border-slate-700 bg-slate-900 hover:border-slate-500'
                    } ${dimmed ? 'opacity-25' : ''}`}
                    style={{
                      left: nodeX,
                      top: layoutNode.y - NODE_HEIGHT / 2,
                      width: NODE_WIDTH,
                      height: NODE_HEIGHT,
                    }}
                  >
                    <div className="flex items-center gap-2">
                      {node.is_default_entry && <Flag className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
                      {node.terminal && <CircleDot className="h-3.5 w-3.5 shrink-0 text-slate-500" />}
                      <span className={`truncate rounded px-1.5 py-0.5 text-xs font-medium ${badgeClass}`}>
                        {node.label}
                      </span>
                      {hasProblem && <AlertTriangle className="ml-auto h-3.5 w-3.5 shrink-0 text-red-400" />}
                    </div>
                    <div className="mt-1 flex items-center gap-1 overflow-hidden">
                      {node.assignments.length === 0 ? (
                        <span className="text-[11px] text-slate-600">
                          {node.terminal ? '—' : 'no agent'}
                        </span>
                      ) : (
                        node.assignments.slice(0, 2).map(assignment => (
                          <span
                            key={assignment.rule_id}
                            className={`inline-flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] ${
                              assignment.agent_enabled
                                ? 'bg-slate-800 text-slate-300'
                                : 'bg-red-950/60 text-red-300'
                            }`}
                          >
                            {assignment.agent_enabled ? <Bot className="h-3 w-3" /> : <Ban className="h-3 w-3" />}
                            {assignment.agent_name ?? `agent ${assignment.agent_id ?? '?'}`}
                          </span>
                        ))
                      )}
                      {node.assignments.length > 2 && (
                        <span className="text-[11px] text-slate-500">+{node.assignments.length - 2}</span>
                      )}
                    </div>
                  </button>
                );
              })}

              {/* Arc labels sit above the boxes so they stay readable. */}
              {layout.arcs.map(arc => {
                const edges = arcEdges(arc);
                if (edges.length === 0) return null;
                const dimmed = showOnlyProblems && !arcHasProblem(arc);
                const gated = edges.some(edge => edge.gates.length > 0);
                // Stagger gutter labels by lane so arcs sharing a midpoint band do not
                // stack their labels on top of each other.
                const stagger = arc.adjacent ? 0 : (arc.lane % 3) * 13 - 13;
                const midY = (arc.fromY + arc.toY) / 2 + stagger;
                const label = edges.length === 1 ? edges[0].outcome : `${edges.length} outcomes`;
                const position = arc.adjacent
                  ? { left: nodeX + NODE_WIDTH / 2, transform: 'translateX(-50%)' }
                  : arc.side === 'right'
                    ? { left: anchorRight + (arc.lane + 1) * LANE_WIDTH, transform: 'translateX(4px)' }
                    : { right: canvasWidth - (anchorLeft - (arc.lane + 1) * LANE_WIDTH), transform: 'translateX(-4px)' };
                return (
                  <button
                    key={`label-${arc.key}`}
                    onClick={() => setSelection({ kind: 'arc', key: arc.key })}
                    className={`absolute z-10 flex max-w-[150px] items-center gap-1 truncate rounded border px-1.5 py-0.5 text-[10px] transition-opacity ${
                      arcHasProblem(arc)
                        ? 'border-red-500/40 bg-slate-950/95 text-red-300'
                        : arc.adjacent
                          ? 'border-emerald-500/30 bg-slate-950/95 text-emerald-300/90'
                          : 'border-slate-700 bg-slate-950/95 text-slate-400'
                    } ${dimmed ? 'opacity-15' : 'hover:border-slate-500 hover:text-slate-200'}`}
                    style={{ ...position, top: midY - 9 }}
                  >
                    {gated && <Lock className="h-2.5 w-2.5 shrink-0 text-amber-400" />}
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Legend */}
          <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-800 pt-4 text-[11px] text-slate-500">
            <span className="flex items-center gap-1"><Flag className="h-3 w-3 text-emerald-400" /> entry status</span>
            <span className="flex items-center gap-1"><CircleDot className="h-3 w-3 text-slate-500" /> terminal</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-emerald-500" /> next stage</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-slate-500" /> forward skip</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-purple-400" /> rework loop</span>
            <span className="flex items-center gap-1"><Lock className="h-3 w-3 text-amber-400" /> gated outcome</span>
            <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 border-t border-dashed border-slate-500" /> never fires</span>
          </div>
        </Card>

        {/* ── Inspector ──────────────────────────────────────────── */}
        <Card className="h-fit p-5">
          {selectedNode ? (
            <NodeInspector node={selectedNode} findings={graph.lint.filter(f => f.node === selectedNode.id)} />
          ) : selectedArc ? (
            <ArcInspector arc={selectedArc} edges={arcEdges(selectedArc)} graph={graph} />
          ) : (
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Findings</p>
              {graph.lint.length === 0 ? (
                <p className="text-sm text-slate-500">
                  Nothing to report. Select a status or transition to inspect it.
                </p>
              ) : (
                <ul className="space-y-2">
                  {graph.lint.map((finding, index) => (
                    <li
                      key={`${finding.code}-${index}`}
                      className="cursor-pointer rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 transition-colors hover:border-slate-600"
                      onClick={() => {
                        if (finding.node) setSelection({ kind: 'node', id: finding.node });
                        else if (finding.edge !== undefined) {
                          const edge = edgesById.get(finding.edge);
                          if (edge) setSelection({ kind: 'arc', key: edge.parallel_group });
                        }
                      }}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${SEVERITY_STYLES[finding.severity]?.dot ?? ''}`} />
                        <span className="text-[11px] font-medium uppercase tracking-wide text-slate-400">
                          {LINT_LABELS[finding.code] ?? finding.code}
                        </span>
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-400">{finding.message}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  findings,
}: {
  node: WorkflowGraphNode;
  findings: WorkflowGraph['lint'];
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Status</p>
        <p className="mt-1 text-base font-semibold text-white">{node.label}</p>
        <p className="text-xs text-slate-500">
          <code>{node.id}</code> · stage {node.stage_order}
          {node.is_default_entry && ' · entry'}
          {node.terminal && ' · terminal'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
          <p className="text-slate-500">Inbound</p>
          <p className="text-lg font-semibold text-slate-200">{node.inbound}</p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2">
          <p className="text-slate-500">Outbound</p>
          <p className="text-lg font-semibold text-slate-200">{node.outbound}</p>
        </div>
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
          Assigned agents
        </p>
        {node.assignments.length === 0 ? (
          <p className="text-xs text-slate-500">
            {node.terminal ? 'Terminal status — no agent expected.' : 'No assignment rule matches this status.'}
          </p>
        ) : (
          <ul className="space-y-1.5">
            {node.assignments.map(assignment => (
              <li
                key={assignment.rule_id}
                className="flex items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-2.5 py-1.5 text-xs"
              >
                <span className={assignment.agent_enabled ? 'text-slate-300' : 'text-red-300 line-through'}>
                  {assignment.agent_name ?? `agent ${assignment.agent_id ?? '?'}`}
                </span>
                <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  {assignment.task_type ? getTaskTypeLabel(assignment.task_type) : 'all types'}
                  <span className="text-slate-600">·</span>
                  p{assignment.priority}
                  {assignment.is_inherited && <span className="text-slate-600">· inherited</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {findings.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Findings</p>
          <ul className="space-y-2">
            {findings.map((finding, index) => (
              <li
                key={index}
                className={`rounded-lg border p-2.5 text-xs ${SEVERITY_STYLES[finding.severity]?.chip ?? ''}`}
              >
                {finding.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ArcInspector({
  arc,
  edges,
  graph,
}: {
  arc: LayoutArc;
  edges: WorkflowGraphEdge[];
  graph: WorkflowGraph;
}) {
  const fromLabel = graph.nodes.find(n => n.id === arc.from)?.label ?? arc.from;
  const toLabel = graph.nodes.find(n => n.id === arc.to)?.label ?? arc.to;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-slate-500">Transition</p>
        <p className="mt-1 text-sm font-semibold text-white">
          {fromLabel} <span className="text-slate-500">→</span> {toLabel}
        </p>
        {arc.side === 'left' && !arc.selfLoop && (
          <p className="text-xs text-purple-400">Rework loop — moves tasks back up the pipeline.</p>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-xs font-medium uppercase tracking-[0.2em] text-slate-500">
          {edges.length} transition{edges.length === 1 ? '' : 's'} on this path
        </p>
        <ul className="space-y-2">
          {edges.map(edge => (
            <li
              key={edge.transition_id}
              className={`rounded-lg border p-2.5 text-xs ${
                edge.shadowed_by !== null
                  ? 'border-red-500/40 bg-red-950/20'
                  : 'border-slate-800 bg-slate-900/60'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <code className="text-slate-200">{edge.outcome}</code>
                <span className="text-[11px] text-slate-500">#{edge.transition_id} · p{edge.priority}</span>
              </div>
              <p className="mt-1 text-[11px] text-slate-500">
                {edge.task_type ? getTaskTypeLabel(edge.task_type) : 'all task types'}
                {edge.is_inherited && ' · inherited'}
                {!edge.enabled && ' · disabled'}
              </p>
              {edge.shadowed_by !== null && (
                <p className="mt-1.5 text-[11px] text-red-300">
                  Never fires — transition #{edge.shadowed_by} always wins.
                </p>
              )}
              {edge.gates.length > 0 && (
                <div className="mt-2 border-t border-slate-800 pt-2">
                  <p className="mb-1 flex items-center gap-1 text-[11px] text-amber-300">
                    <Lock className="h-3 w-3" /> {edge.gates.length} gate{edge.gates.length === 1 ? '' : 's'}
                  </p>
                  <ul className="space-y-0.5">
                    {edge.gates.map(gate => (
                      <li key={gate.requirement_id} className="text-[11px] text-slate-400">
                        <code>{gate.field_name}</code> · {gate.requirement_type}
                        <span className={gate.severity === 'block' ? 'text-red-400' : 'text-amber-400'}>
                          {' '}({gate.severity})
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
