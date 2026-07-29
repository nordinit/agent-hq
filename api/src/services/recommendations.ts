/**
 * Telemetry Recommendation Engine v1
 *
 * Rules-based engine that analyzes telemetry patterns and produces
 * actionable improvement recommendations for task quality.
 *
 * Failure taxonomy (standard reasons):
 *   misrouted           — task was assigned to the wrong job/agent
 *   underspecified      — task description lacked enough detail to execute
 *   too_large           — task scope was too big for a single unit of work
 *   hidden_dependency   — task had an undeclared dependency that blocked progress
 *   wrong_priority      — task priority didn't match actual urgency/importance
 *   wrong_sprint        — task was placed in the wrong sprint
 *   env_issue           — environment/infra problem prevented completion
 *   execution_issue     — agent made errors during implementation
 */

import type Database from 'better-sqlite3';

// ── Types ────────────────────────────────────────────────────────────────────

export interface Recommendation {
  id: string;
  severity: 'info' | 'warning' | 'critical';
  category: 'quality' | 'routing' | 'scoping' | 'process' | 'velocity';
  title: string;
  description: string;
  metric: string;
  value: number | string;
  threshold: number | string;
  affected_entities?: { type: string; id: number; name: string }[];
  action: string;
}

export interface FailureTaxonomyEntry {
  reason: string;
  label: string;
  description: string;
  category: 'routing' | 'scoping' | 'process' | 'environment';
  suggested_action: string;
}

export interface RecommendationResult {
  generated_at: string;
  scope: { project_id?: number; sprint_id?: number; job_id?: number };
  task_count: number;
  outcome_count: number;
  recommendations: Recommendation[];
  failure_summary: { reason: string; count: number; pct: number }[];
}

// ── Failure Taxonomy ─────────────────────────────────────────────────────────

export const FAILURE_TAXONOMY: FailureTaxonomyEntry[] = [
  {
    reason: 'misrouted',
    label: 'Misrouted',
    description: 'Task was assigned to the wrong job or agent role.',
    category: 'routing',
    suggested_action: 'Review routing rules and job descriptions. Consider adding clearer project/sprint → job mappings.',
  },
  {
    reason: 'underspecified',
    label: 'Underspecified',
    description: 'Task lacked sufficient detail for the assigned agent to complete without clarification.',
    category: 'scoping',
    suggested_action: 'Add acceptance criteria, expected artifacts, and success modes to task templates. Use the create-task skill for structured creation.',
  },
  {
    reason: 'too_large',
    label: 'Too Large',
    description: 'Task scope exceeded what a single agent run can handle effectively.',
    category: 'scoping',
    suggested_action: 'Break tasks into smaller units (ideally ≤ 2 hours of agent work). Flag tasks with scope_size "large" or "xl" for review before dispatch.',
  },
  {
    reason: 'hidden_dependency',
    label: 'Hidden Dependency',
    description: 'Task had an undeclared blocker that wasn\'t discovered until execution.',
    category: 'process',
    suggested_action: 'Run a dependency check before dispatching. Require explicit blocker declarations for tasks in active sprints.',
  },
  {
    reason: 'wrong_priority',
    label: 'Wrong Priority',
    description: 'Task priority didn\'t match actual urgency, causing either delay or wasted preemption.',
    category: 'process',
    suggested_action: 'Review priority assignment criteria. Consider using confidence levels to gate high-priority dispatch.',
  },
  {
    reason: 'wrong_sprint',
    label: 'Wrong Sprint',
    description: 'Task was placed in the wrong sprint, causing context mismatch or premature execution.',
    category: 'routing',
    suggested_action: 'Validate sprint assignment against task dependencies and project phase.',
  },
  {
    reason: 'env_issue',
    label: 'Environment Issue',
    description: 'Infrastructure or environment problem prevented task completion.',
    category: 'environment',
    suggested_action: 'Add environment pre-checks to task templates. Consider a health check dependency for infra-sensitive tasks.',
  },
  {
    reason: 'execution_issue',
    label: 'Execution Issue',
    description: 'Agent made errors during implementation despite adequate specification.',
    category: 'process',
    suggested_action: 'Review agent capabilities vs task complexity. Consider adding test requirements or verification steps to acceptance criteria.',
  },
];

// ── Rule Engine ──────────────────────────────────────────────────────────────

interface QueryFilters {
  project_id?: number;
  sprint_id?: number;
  job_id?: number;
  from?: string;
  to?: string;
}

function buildWhere(
  alias: string,
  filters: QueryFilters,
  conditions: string[],
  params: unknown[]
): void {
  if (filters.project_id) { conditions.push(`${alias}.project_id = ?`); params.push(filters.project_id); }
  if (filters.sprint_id)  { conditions.push(`${alias}.sprint_id = ?`);  params.push(filters.sprint_id);  }
  if (filters.job_id)     { conditions.push(`${alias}.job_id = ?`);     params.push(filters.job_id);     }
  if (filters.from)       { conditions.push(`${alias}.recorded_at >= ?`); params.push(filters.from); }
  if (filters.to)         { conditions.push(`${alias}.recorded_at <= ?`); params.push(filters.to);   }
}

export function generateRecommendations(db: Database.Database, filters: QueryFilters = {}): RecommendationResult {
  const recommendations: Recommendation[] = [];

  // Build filter clauses
  const omConds: string[] = [];
  const omParams: unknown[] = [];
  buildWhere('tom', filters, omConds, omParams);
  const omWhere = omConds.length ? `WHERE ${omConds.join(' AND ')}` : '';

  const ceConds: string[] = [];
  const ceParams: unknown[] = [];
  if (filters.project_id) { ceConds.push('tce.project_id = ?'); ceParams.push(filters.project_id); }
  if (filters.sprint_id)  { ceConds.push('tce.sprint_id = ?');  ceParams.push(filters.sprint_id);  }
  if (filters.job_id)     { ceConds.push('tce.job_id = ?');     ceParams.push(filters.job_id);     }
  if (filters.from)       { ceConds.push('tce.created_at >= ?'); ceParams.push(filters.from); }
  if (filters.to)         { ceConds.push('tce.created_at <= ?'); ceParams.push(filters.to);   }
  const ceWhere = ceConds.length ? `WHERE ${ceConds.join(' AND ')}` : '';

  // Task filter for counting
  const tConds: string[] = [];
  const tParams: unknown[] = [];
  if (filters.project_id) { tConds.push('t.project_id = ?'); tParams.push(filters.project_id); }
  if (filters.sprint_id)  { tConds.push('t.sprint_id = ?');  tParams.push(filters.sprint_id);  }
  if (filters.job_id)     { tConds.push('t.assigned_agent_id = ?');    tParams.push(filters.job_id);     }
  const tWhere = tConds.length ? `WHERE ${tConds.join(' AND ')}` : '';

  // ── Gather base metrics ─────────────────────────────────────────────────

  const taskCount = (db.prepare(
    `SELECT COUNT(*) as n FROM tasks t ${tWhere}`
  ).get(...tParams) as { n: number }).n;

  const outcomeCount = (db.prepare(
    `SELECT COUNT(*) as n FROM task_outcome_metrics tom ${omWhere}`
  ).get(...omParams) as { n: number }).n;

  // Bail early if no outcome data
  if (outcomeCount === 0) {
    return {
      generated_at: new Date().toISOString(),
      scope: filters,
      task_count: taskCount,
      outcome_count: 0,
      recommendations: [{
        id: 'no-data',
        severity: 'info',
        category: 'process',
        title: 'No telemetry data yet',
        description: 'Start recording task outcomes to get improvement recommendations.',
        metric: 'outcome_count',
        value: 0,
        threshold: 1,
        action: 'Record outcome metrics when tasks complete (POST /api/v1/telemetry/outcome-metrics).',
      }],
      failure_summary: [],
    };
  }

  // ── Rule 1: Low first-pass QA rate ───────────────────────────────────────

  const firstPassData = db.prepare(
    `SELECT
       COUNT(*) as total,
       SUM(first_pass_qa) as passed
     FROM task_outcome_metrics tom ${omWhere}`
  ).get(...omParams) as { total: number; passed: number };

  const firstPassRate = firstPassData.total > 0 ? (firstPassData.passed / firstPassData.total) * 100 : 100;

  if (firstPassData.total >= 3 && firstPassRate < 70) {
    // Find which jobs have worst first-pass rates
    const worstJobs = db.prepare(`
      SELECT tom.job_id, a.name as agent_name,
             COUNT(*) as total, SUM(tom.first_pass_qa) as passed
      FROM task_outcome_metrics tom
      LEFT JOIN agents a ON a.id = tom.job_id
      ${omWhere}
      GROUP BY tom.job_id, a.name
      HAVING COUNT(*) >= 2 AND (CAST(SUM(tom.first_pass_qa) AS REAL) / COUNT(*)) < 0.7
      ORDER BY (CAST(SUM(tom.first_pass_qa) AS REAL) / COUNT(*)) ASC
    `).all(...omParams) as { job_id: number; agent_name: string | null; total: number; passed: number }[];

    recommendations.push({
      id: 'low-first-pass-rate',
      severity: firstPassRate < 50 ? 'critical' : 'warning',
      category: 'quality',
      title: 'Low first-pass QA rate',
      description: `Only ${firstPassRate.toFixed(1)}% of tasks pass QA on first submission. Target: ≥70%.`,
      metric: 'first_pass_rate_pct',
      value: Number(firstPassRate.toFixed(1)),
      threshold: 70,
      affected_entities: worstJobs.map(j => ({
        type: 'job', id: j.job_id, name: `${j.agent_name ?? `Agent #${j.job_id}`} — ${((j.passed / j.total) * 100).toFixed(0)}% pass rate`,
      })),
      action: 'Review task specifications for affected jobs. Consider adding acceptance criteria, test requirements, or reducing task scope.',
    });
  }

  // ── Rule 2: High reopened/rerouted counts ────────────────────────────────

  const avgReopened = (db.prepare(
    `SELECT AVG(reopened_count) as avg_r FROM task_outcome_metrics tom ${omWhere}`
  ).get(...omParams) as { avg_r: number | null }).avg_r ?? 0;

  if (outcomeCount >= 3 && avgReopened > 1.0) {
    recommendations.push({
      id: 'high-reopen-rate',
      severity: avgReopened > 2.0 ? 'critical' : 'warning',
      category: 'quality',
      title: 'High task reopen rate',
      description: `Tasks are reopened an average of ${avgReopened.toFixed(1)} times. Target: ≤1.0.`,
      metric: 'avg_reopened_count',
      value: Number(avgReopened.toFixed(1)),
      threshold: 1.0,
      action: 'Strengthen acceptance criteria and add verification steps. Consider mandatory test coverage before review submission.',
    });
  }

  const avgRerouted = (db.prepare(
    `SELECT AVG(rerouted_count) as avg_r FROM task_outcome_metrics tom ${omWhere}`
  ).get(...omParams) as { avg_r: number | null }).avg_r ?? 0;

  if (outcomeCount >= 3 && avgRerouted > 0.5) {
    recommendations.push({
      id: 'high-reroute-rate',
      severity: avgRerouted > 1.0 ? 'critical' : 'warning',
      category: 'routing',
      title: 'High task reroute rate',
      description: `Tasks are rerouted an average of ${avgRerouted.toFixed(1)} times. Target: ≤0.5.`,
      metric: 'avg_rerouted_count',
      value: Number(avgRerouted.toFixed(1)),
      threshold: 0.5,
      action: 'Review job descriptions and routing rules. Ensure tasks are matched to the right agent role at creation time.',
    });
  }

  // ── Rule 3: Slow cycle time ──────────────────────────────────────────────

  const cycleData = db.prepare(
    `SELECT AVG(cycle_time_hours) as avg_h, COUNT(*) as n
     FROM task_outcome_metrics tom
     ${omWhere ? omWhere + ' AND' : 'WHERE'} tom.cycle_time_hours IS NOT NULL`
  ).get(...omParams) as { avg_h: number | null; n: number };

  if (cycleData.n >= 3 && cycleData.avg_h !== null && cycleData.avg_h > 8) {
    // Find slowest jobs
    const slowJobs = db.prepare(`
      SELECT tom.job_id, a.name as agent_name,
             AVG(tom.cycle_time_hours) as avg_h, COUNT(*) as n
      FROM task_outcome_metrics tom
      LEFT JOIN agents a ON a.id = tom.job_id
      ${omWhere ? omWhere + ' AND' : 'WHERE'} tom.cycle_time_hours IS NOT NULL
      GROUP BY tom.job_id, a.name
      HAVING COUNT(*) >= 2 AND AVG(tom.cycle_time_hours) > 8
      ORDER BY avg_h DESC
    `).all(...omParams) as { job_id: number; agent_name: string | null; avg_h: number; n: number }[];

    recommendations.push({
      id: 'slow-cycle-time',
      severity: cycleData.avg_h > 24 ? 'critical' : 'warning',
      category: 'velocity',
      title: 'Slow average cycle time',
      description: `Average cycle time is ${cycleData.avg_h.toFixed(1)} hours. Target: ≤8 hours.`,
      metric: 'avg_cycle_time_hours',
      value: Number(cycleData.avg_h.toFixed(1)),
      threshold: 8,
      affected_entities: slowJobs.map(j => ({
        type: 'job', id: j.job_id, name: `${j.agent_name ?? `Agent #${j.job_id}`} — ${j.avg_h.toFixed(1)}h avg`,
      })),
      action: 'Break large tasks into smaller units. Check for hidden blockers or environment issues slowing agents.',
    });
  }

  // ── Rule 4: Frequent need-to-split ───────────────────────────────────────

  const creationCount = (db.prepare(
    `SELECT COUNT(*) as n FROM task_creation_events tce ${ceWhere}`
  ).get(...ceParams) as { n: number }).n;

  const splitCount = (db.prepare(
    `SELECT COUNT(*) as n FROM task_creation_events tce ${ceWhere ? ceWhere + ' AND' : 'WHERE'} tce.needs_split = 1`
  ).get(...ceParams) as { n: number }).n;

  const splitPct = creationCount > 0 ? (splitCount / creationCount) * 100 : 0;

  if (creationCount >= 5 && splitPct > 20) {
    recommendations.push({
      id: 'high-split-rate',
      severity: splitPct > 40 ? 'critical' : 'warning',
      category: 'scoping',
      title: 'High needs-split rate at creation',
      description: `${splitPct.toFixed(0)}% of tasks are flagged as needing split at creation. Target: ≤20%.`,
      metric: 'needs_split_pct',
      value: Number(splitPct.toFixed(1)),
      threshold: 20,
      action: 'Improve task scoping during creation. Use scope_size estimation and enforce splits before dispatch for "large" or "xl" tasks.',
    });
  }

  // ── Rule 5: Blocked-after-creation pattern ───────────────────────────────

  const blockedAfter = (db.prepare(
    `SELECT SUM(blocked_after_creation) as n FROM task_outcome_metrics tom ${omWhere}`
  ).get(...omParams) as { n: number | null }).n ?? 0;

  const blockedPct = outcomeCount > 0 ? (blockedAfter / outcomeCount) * 100 : 0;

  if (outcomeCount >= 5 && blockedPct > 25) {
    recommendations.push({
      id: 'high-blocked-after-creation',
      severity: blockedPct > 50 ? 'critical' : 'warning',
      category: 'process',
      title: 'Tasks frequently blocked after creation',
      description: `${blockedPct.toFixed(0)}% of completed tasks were blocked after work started. Target: ≤25%.`,
      metric: 'blocked_after_creation_pct',
      value: Number(blockedPct.toFixed(1)),
      threshold: 25,
      action: 'Mandate explicit blocker declarations at creation. Run dependency analysis before moving tasks to ready status.',
    });
  }

  // ── Rule 6: Failure reason concentration ─────────────────────────────────

  const failureRows = db.prepare(
    `SELECT failure_reasons FROM task_outcome_metrics tom
     ${omWhere ? omWhere + ' AND' : 'WHERE'} tom.failure_reasons != '[]' AND tom.failure_reasons != ''`
  ).all(...omParams) as { failure_reasons: string }[];

  const failureCounts: Record<string, number> = {};
  let totalFailures = 0;
  for (const row of failureRows) {
    try {
      const reasons: string[] = JSON.parse(row.failure_reasons);
      for (const r of reasons) {
        failureCounts[r] = (failureCounts[r] ?? 0) + 1;
        totalFailures++;
      }
    } catch { /* skip malformed */ }
  }

  const failureSummary = Object.entries(failureCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({
      reason,
      count,
      pct: totalFailures > 0 ? Number(((count / totalFailures) * 100).toFixed(1)) : 0,
    }));

  // Flag dominant failure reasons
  for (const fs of failureSummary) {
    if (fs.count >= 3 && fs.pct >= 30) {
      const taxonomy = FAILURE_TAXONOMY.find(t => t.reason === fs.reason);
      recommendations.push({
        id: `dominant-failure-${fs.reason}`,
        severity: fs.pct >= 50 ? 'critical' : 'warning',
        category: taxonomy?.category === 'routing' ? 'routing'
                : taxonomy?.category === 'scoping' ? 'scoping'
                : 'process',
        title: `Dominant failure: ${taxonomy?.label ?? fs.reason}`,
        description: `"${taxonomy?.label ?? fs.reason}" accounts for ${fs.pct}% of all failure reasons (${fs.count} occurrences). ${taxonomy?.description ?? ''}`,
        metric: `failure_reason_${fs.reason}_pct`,
        value: fs.pct,
        threshold: 30,
        action: taxonomy?.suggested_action ?? 'Investigate root cause and implement targeted fix.',
      });
    }
  }

  // ── Rule 7: Poor outcome quality concentration ───────────────────────────

  const poorCount = (db.prepare(
    `SELECT COUNT(*) as n FROM task_outcome_metrics tom
     ${omWhere ? omWhere + ' AND' : 'WHERE'} tom.outcome_quality = 'poor'`
  ).get(...omParams) as { n: number }).n;

  const poorPct = outcomeCount > 0 ? (poorCount / outcomeCount) * 100 : 0;

  if (outcomeCount >= 5 && poorPct > 20) {
    recommendations.push({
      id: 'high-poor-quality-rate',
      severity: poorPct > 40 ? 'critical' : 'warning',
      category: 'quality',
      title: 'High poor-quality outcome rate',
      description: `${poorPct.toFixed(0)}% of completed tasks have "poor" quality rating. Target: ≤20%.`,
      metric: 'poor_quality_pct',
      value: Number(poorPct.toFixed(1)),
      threshold: 20,
      action: 'Review task specifications, agent capabilities, and QA criteria. Consider adding mandatory test coverage.',
    });
  }

  // ── Rule 8: High clarification count ─────────────────────────────────────

  const avgClarification = (db.prepare(
    `SELECT AVG(clarification_count) as avg_c FROM task_outcome_metrics tom ${omWhere}`
  ).get(...omParams) as { avg_c: number | null }).avg_c ?? 0;

  if (outcomeCount >= 3 && avgClarification > 2.0) {
    recommendations.push({
      id: 'high-clarification-rate',
      severity: avgClarification > 4.0 ? 'critical' : 'warning',
      category: 'scoping',
      title: 'High clarification count',
      description: `Tasks require an average of ${avgClarification.toFixed(1)} clarification exchanges. Target: ≤2.0.`,
      metric: 'avg_clarification_count',
      value: Number(avgClarification.toFixed(1)),
      threshold: 2.0,
      action: 'Improve task descriptions with acceptance criteria, expected artifacts, and constraints. Pre-answer common questions in task templates.',
    });
  }

  // ── Rule 9: Low-confidence tasks with poor outcomes ──────────────────────

  if (creationCount >= 3) {
    const lowConfPoor = db.prepare(`
      SELECT COUNT(*) as n FROM task_creation_events tce
      JOIN task_outcome_metrics tom ON tom.task_id = tce.task_id
      ${ceWhere ? ceWhere + ' AND' : 'WHERE'} tce.confidence = 'low'
        AND (tom.outcome_quality = 'poor' OR tom.first_pass_qa = 0)
    `).get(...ceParams) as { n: number };

    const totalLowConf = (db.prepare(
      `SELECT COUNT(*) as n FROM task_creation_events tce ${ceWhere ? ceWhere + ' AND' : 'WHERE'} tce.confidence = 'low'`
    ).get(...ceParams) as { n: number }).n;

    if (totalLowConf >= 3 && lowConfPoor.n / totalLowConf > 0.5) {
      recommendations.push({
        id: 'low-confidence-poor-outcomes',
        severity: 'warning',
        category: 'process',
        title: 'Low-confidence tasks correlate with poor outcomes',
        description: `${((lowConfPoor.n / totalLowConf) * 100).toFixed(0)}% of low-confidence tasks result in poor outcomes or QA failure. Consider gating dispatch for low-confidence tasks.`,
        metric: 'low_conf_poor_outcome_pct',
        value: Number(((lowConfPoor.n / totalLowConf) * 100).toFixed(1)),
        threshold: 50,
        action: 'Hold low-confidence tasks for human review before dispatching. Require clarification or scope refinement before marking as ready.',
      });
    }
  }

  // ── Sort by severity ───────────────────────────────────────────────────

  const severityOrder = { critical: 0, warning: 1, info: 2 };
  recommendations.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  return {
    generated_at: new Date().toISOString(),
    scope: filters,
    task_count: taskCount,
    outcome_count: outcomeCount,
    recommendations,
    failure_summary: failureSummary,
  };
}
