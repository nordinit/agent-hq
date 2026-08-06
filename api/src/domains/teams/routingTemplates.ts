/**
 * Stamping a team's routing template onto a workflow it owns.
 *
 * WHY MATERIALIZE RATHER THAN RESOLVE
 * Team rules expand into real `sprint_task_routing_rules` rows instead of becoming a new tier in
 * resolveRoutingRuleForSprint(). Routing precedence is consumed by scope, trace, preview, graph,
 * audit, policy and the reconciler, each with its own tests; a new tier means touching all of
 * them, and the Routing UI would still show nothing until taught about it separately.
 * Materialization leaves every one of those paths byte-identical and puts team rules in the tool
 * operators already use.
 *
 * THE COST, AND HOW IT IS PAID
 * Materialized copies can drift from the template. Drift is made visible rather than prevented:
 *
 *   - planTeamRoutingApplication() is a dry run. Nothing is written; the caller sees exactly
 *     what would change before anything does.
 *   - `source_team_applied_json` records what was written at the last apply. A rule whose
 *     current values still match that snapshot is untouched-since-apply and is safe to resync;
 *     one that has diverged was edited by an operator and is reported as a conflict and left
 *     alone. Operator edits win over the template.
 *   - A rule at a target key with no team provenance is locally authored, and is also a
 *     conflict. Applying a template never silently takes ownership of a hand-written rule.
 */

import { writeRoutingAudit, type RoutingAuditActorKind } from '../routing/audit';
import type { Db } from '../../db/adapter/types';

/**
 * The physical workflow tables. Named here rather than resolved at runtime because the whole
 * application writes `sprint_*` today; the staged rename rewrites these along with every other
 * call site in one pass.
 */
const WORKFLOW_TABLE = 'sprints';
const ROUTING_RULE_TABLE = 'sprint_task_routing_rules';

export type PlanAction = 'create' | 'update' | 'unchanged' | 'conflict' | 'skip';

export interface PlanEntry {
  action: PlanAction;
  team_rule_id: number;
  status: string;
  task_type: string | null;
  /** The agent the template resolves to, once member_role targeting is applied. */
  agent_id: number | null;
  agent_name: string | null;
  member_role: string | null;
  priority: number;
  existing_rule_id: number | null;
  /** Why a conflict or skip happened; empty for actionable entries. */
  reason: string;
}

export interface OrphanEntry {
  rule_id: number;
  status: string;
  task_type: string | null;
  reason: string;
}

export interface TeamRoutingPlan {
  workflow_id: number;
  workflow_type: string | null;
  team_id: number;
  team_name: string;
  entries: PlanEntry[];
  /** Rules this team previously materialized here whose template row no longer applies. */
  orphaned: OrphanEntry[];
  summary: Record<PlanAction, number>;
  applied: boolean;
  batch_id: string;
}

interface WorkflowRow {
  id: number;
  project_id: number;
  sprint_type: string | null;
  team_id: number | null;
  tenant_id: number | null;
}

interface TeamRuleRow {
  id: number;
  workflow_type: string | null;
  task_type: string | null;
  status: string;
  agent_id: number | null;
  member_role: string;
  priority: number;
}

interface ExistingRuleRow {
  id: number;
  task_type: string | null;
  status: string;
  agent_id: number | null;
  priority: number;
  source_team_id: number | null;
  source_team_rule_id: number | null;
  source_team_applied_json: string | null;
}

/** The fields a materialized rule takes from its template; the unit of drift detection. */
interface AppliedSnapshot {
  agent_id: number | null;
  priority: number;
}

function withStatus(message: string, status: number): Error & { status?: number } {
  const error = new Error(message) as Error & { status?: number };
  error.status = status;
  return error;
}

function parseSnapshot(value: string | null | undefined): AppliedSnapshot | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (record.agent_id === undefined && record.priority === undefined) return null;
    return {
      agent_id: record.agent_id == null ? null : Number(record.agent_id),
      priority: Number(record.priority ?? 0),
    };
  } catch {
    return null;
  }
}

function snapshotsMatch(left: AppliedSnapshot | null, right: AppliedSnapshot | null): boolean {
  if (!left || !right) return false;
  return Number(left.agent_id ?? -1) === Number(right.agent_id ?? -1)
    && Number(left.priority) === Number(right.priority);
}

/** Rules are keyed by what routing itself matches on: this workflow, task type and status. */
function ruleKey(taskType: string | null, status: string): string {
  return `${taskType ?? '*'}::${status}`;
}

async function loadWorkflow(db: Db, workflowId: number, tenantId: number | null): Promise<WorkflowRow> {
  const workflow = await db.get(`
    SELECT id, project_id, sprint_type, team_id, tenant_id
    FROM ${WORKFLOW_TABLE}
    WHERE id = ?
  `, workflowId) as WorkflowRow | undefined;
  if (!workflow) throw withStatus('Workflow not found', 404);
  if (tenantId != null && workflow.tenant_id != null && Number(workflow.tenant_id) !== tenantId) {
    throw withStatus('Workflow not found', 404);
  }
  return workflow;
}

/**
 * planTeamRoutingApplication — what applying the owning team's template would do.
 *
 * Pure with respect to the database: it reads and computes, and writes nothing. applyTeamRouting
 * calls it and then executes the plan, so the dry run and the real thing can never disagree
 * about what was intended.
 */
export async function planTeamRoutingApplication(
  db: Db,
  params: { workflowId: number; tenantId?: number | null; batchId?: string },
): Promise<TeamRoutingPlan> {
  const tenantId = params.tenantId ?? null;
  const workflow = await loadWorkflow(db, params.workflowId, tenantId);
  if (workflow.team_id == null) {
    throw withStatus('Workflow has no team assigned', 409);
  }

  const team = await db.get(`
    SELECT id, name, tenant_id
    FROM teams
    WHERE id = ? AND enabled = 1 AND deleted_at IS NULL
  `, workflow.team_id) as { id: number; name: string; tenant_id: number } | undefined;
  if (!team) throw withStatus('Assigned team not found or disabled', 409);

  // Template rows for this workflow type. A NULL workflow_type is a wildcard; a rule naming the
  // type is more specific and must win, so specific rules are ordered FIRST — the first rule to
  // claim a (task_type, status) key takes it, matching how resolveRoutingRuleForSprint orders
  // its own candidates.
  const templateRules = await db.all(`
    SELECT id, workflow_type, task_type, status, agent_id, member_role, priority
    FROM team_routing_rules
    WHERE team_id = ?
      AND enabled = 1
      AND (workflow_type IS NULL OR workflow_type = ?)
    ORDER BY CASE WHEN workflow_type IS NULL THEN 1 ELSE 0 END, priority DESC, id ASC
  `, team.id, workflow.sprint_type ?? null) as TeamRuleRow[];

  // Enabled members, used to validate agent targets and to resolve member_role targets.
  const members = await db.all(`
    SELECT tm.agent_id AS agent_id,
           tm.member_role AS member_role,
           COALESCE(NULLIF(ag.name, ''), NULLIF(ag.job_title, ''), 'Agent #' || ag.id) AS display_name
    FROM team_members tm
    JOIN agents ag ON ag.id = tm.agent_id
    WHERE tm.team_id = ?
      AND tm.enabled = 1
      AND ag.enabled = 1
      AND ag.deleted_at IS NULL
    ORDER BY tm.sort_order ASC, tm.id ASC
  `, team.id) as Array<{ agent_id: number; member_role: string; display_name: string }>;

  const membersById = new Map(members.map((member) => [Number(member.agent_id), member]));
  const membersByRole = new Map<string, typeof members>();
  for (const member of members) {
    const role = String(member.member_role ?? '').trim().toLowerCase();
    if (!role) continue;
    membersByRole.set(role, [...(membersByRole.get(role) ?? []), member]);
  }

  const existingRules = await db.all(`
    SELECT id, task_type, status, agent_id, priority,
           source_team_id, source_team_rule_id, source_team_applied_json
    FROM ${ROUTING_RULE_TABLE}
    WHERE sprint_id = ?
  `, workflow.id) as ExistingRuleRow[];
  const existingByKey = new Map(existingRules.map((rule) => [ruleKey(rule.task_type, rule.status), rule]));

  const entries: PlanEntry[] = [];
  const plannedKeys = new Set<string>();
  const resolvedTemplateRuleIds = new Set<number>();

  for (const rule of templateRules) {
    const key = ruleKey(rule.task_type, rule.status);
    const base = {
      team_rule_id: Number(rule.id),
      status: rule.status,
      task_type: rule.task_type,
      member_role: rule.member_role || null,
      priority: Number(rule.priority ?? 0),
      existing_rule_id: existingByKey.get(key)?.id ?? null,
    };

    // ── Resolve the target agent ──
    let agentId: number | null = null;
    let agentName: string | null = null;
    if (rule.agent_id != null) {
      const member = membersById.get(Number(rule.agent_id));
      if (!member) {
        entries.push({
          ...base, action: 'skip', agent_id: null, agent_name: null,
          reason: `Agent #${rule.agent_id} is no longer an enabled member of this team`,
        });
        continue;
      }
      agentId = Number(member.agent_id);
      agentName = member.display_name;
    } else {
      const role = String(rule.member_role ?? '').trim().toLowerCase();
      const holders = membersByRole.get(role) ?? [];
      if (holders.length === 0) {
        entries.push({
          ...base, action: 'skip', agent_id: null, agent_name: null,
          reason: `No enabled member holds the role "${rule.member_role}"`,
        });
        continue;
      }
      if (holders.length > 1) {
        entries.push({
          ...base, action: 'conflict', agent_id: null, agent_name: null,
          reason: `${holders.length} members hold the role "${rule.member_role}"; routing would be ambiguous`,
        });
        continue;
      }
      agentId = Number(holders[0].agent_id);
      agentName = holders[0].display_name;
    }

    resolvedTemplateRuleIds.add(Number(rule.id));
    const desired: AppliedSnapshot = { agent_id: agentId, priority: Number(rule.priority ?? 0) };
    const resolved = { ...base, agent_id: agentId, agent_name: agentName };

    // A more specific template rule already claimed this key this run.
    if (plannedKeys.has(key)) {
      entries.push({
        ...resolved, action: 'skip',
        reason: 'A more specific template rule already targets this task type and status',
      });
      continue;
    }
    plannedKeys.add(key);

    const existing = existingByKey.get(key);
    if (!existing) {
      entries.push({ ...resolved, action: 'create', reason: '' });
      continue;
    }

    if (existing.source_team_rule_id == null || Number(existing.source_team_rule_id) !== Number(rule.id)) {
      entries.push({
        ...resolved, action: 'conflict',
        reason: existing.source_team_rule_id == null
          ? 'A hand-written rule already targets this task type and status'
          : 'A rule from a different team template already targets this task type and status',
      });
      continue;
    }

    const applied = parseSnapshot(existing.source_team_applied_json);
    const current: AppliedSnapshot = {
      agent_id: existing.agent_id == null ? null : Number(existing.agent_id),
      priority: Number(existing.priority ?? 0),
    };

    if (!snapshotsMatch(current, applied)) {
      entries.push({
        ...resolved, action: 'conflict',
        reason: 'This rule was edited after it was applied; the local edit wins',
      });
      continue;
    }

    entries.push({
      ...resolved,
      action: snapshotsMatch(current, desired) ? 'unchanged' : 'update',
      reason: '',
    });
  }

  // Rules this team materialized here that no template row resolves to any more — a template
  // row deleted, disabled, or narrowed to another workflow type. Reported, never auto-removed:
  // the workflow may be mid-flight on them.
  const orphaned: OrphanEntry[] = existingRules
    .filter((rule) => (
      rule.source_team_id != null
      && Number(rule.source_team_id) === Number(team.id)
      && (rule.source_team_rule_id == null || !resolvedTemplateRuleIds.has(Number(rule.source_team_rule_id)))
    ))
    .map((rule) => ({
      rule_id: Number(rule.id),
      status: rule.status,
      task_type: rule.task_type,
      reason: 'No enabled template rule targets this task type and status any more',
    }));

  const summary: Record<PlanAction, number> = {
    create: 0, update: 0, unchanged: 0, conflict: 0, skip: 0,
  };
  for (const entry of entries) summary[entry.action] += 1;

  return {
    workflow_id: Number(workflow.id),
    workflow_type: workflow.sprint_type ?? null,
    team_id: Number(team.id),
    team_name: team.name,
    entries,
    orphaned,
    summary,
    applied: false,
    batch_id: params.batchId ?? '',
  };
}

/**
 * applyTeamRouting — execute the plan.
 *
 * Only `create` and `update` entries write. Conflicts and skips are reported and left alone, so
 * running this twice in a row is a no-op the second time.
 *
 * Every write is audited under one batch id, which is what routing_config_audit_log's batch_id
 * and affected_workflow_count columns exist for: a template application is one operator action
 * that touches many rows, and undoing it means undoing all of them together.
 */
export async function applyTeamRouting(
  db: Db,
  params: {
    workflowId: number;
    tenantId?: number | null;
    batchId: string;
    actor?: string;
    actorKind?: RoutingAuditActorKind;
  },
): Promise<TeamRoutingPlan> {
  const plan = await planTeamRoutingApplication(db, {
    workflowId: params.workflowId,
    tenantId: params.tenantId,
    batchId: params.batchId,
  });

  const workflow = await loadWorkflow(db, params.workflowId, params.tenantId ?? null);
  const tenantId = params.tenantId ?? (workflow.tenant_id != null ? Number(workflow.tenant_id) : 1);
  const actionable = plan.entries.filter((entry) => entry.action === 'create' || entry.action === 'update');

  for (const entry of actionable) {
    const snapshot = JSON.stringify({ agent_id: entry.agent_id, priority: entry.priority });

    if (entry.action === 'create') {
      const result = await db.run(`
        INSERT INTO ${ROUTING_RULE_TABLE}
          (tenant_id, sprint_id, project_id, sprint_type, task_type, status, agent_id, priority,
           enabled, is_system, source_team_id, source_team_rule_id, source_team_applied_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?)
      `,
        tenantId, workflow.id, workflow.project_id, workflow.sprint_type ?? null,
        entry.task_type, entry.status, entry.agent_id, entry.priority,
        plan.team_id, entry.team_rule_id, snapshot,
      );
      entry.existing_rule_id = result.lastInsertId as number;

      await writeRoutingAudit(db, {
        tenantId,
        projectId: workflow.project_id,
        workflowType: workflow.sprint_type ?? '',
        workflowId: workflow.id,
        entityTable: ROUTING_RULE_TABLE,
        entityId: entry.existing_rule_id,
        entityKey: ruleKey(entry.task_type, entry.status),
        action: 'created',
        actor: params.actor ?? 'unknown',
        actorKind: params.actorKind ?? 'unknown',
        before: null,
        after: {
          task_type: entry.task_type, status: entry.status,
          agent_id: entry.agent_id, priority: entry.priority,
          source_team_id: plan.team_id, source_team_rule_id: entry.team_rule_id,
        },
        batchId: params.batchId,
        affectedWorkflowCount: 1,
      });
      continue;
    }

    const before = await db.get(`
      SELECT id, task_type, status, agent_id, priority, source_team_id, source_team_rule_id
      FROM ${ROUTING_RULE_TABLE} WHERE id = ?
    `, entry.existing_rule_id) as Record<string, unknown> | undefined;

    await db.run(`
      UPDATE ${ROUTING_RULE_TABLE}
      SET agent_id = ?,
          priority = ?,
          source_team_id = ?,
          source_team_rule_id = ?,
          source_team_applied_json = ?,
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
    `, entry.agent_id, entry.priority, plan.team_id, entry.team_rule_id, snapshot, entry.existing_rule_id);

    await writeRoutingAudit(db, {
      tenantId,
      projectId: workflow.project_id,
      workflowType: workflow.sprint_type ?? '',
      workflowId: workflow.id,
      entityTable: ROUTING_RULE_TABLE,
      entityId: entry.existing_rule_id,
      entityKey: ruleKey(entry.task_type, entry.status),
      action: 'updated',
      actor: params.actor ?? 'unknown',
      actorKind: params.actorKind ?? 'unknown',
      before: before ?? null,
      after: {
        ...(before ?? {}),
        agent_id: entry.agent_id, priority: entry.priority,
        source_team_id: plan.team_id, source_team_rule_id: entry.team_rule_id,
      },
      batchId: params.batchId,
      affectedWorkflowCount: 1,
    });
  }

  return { ...plan, applied: true };
}
