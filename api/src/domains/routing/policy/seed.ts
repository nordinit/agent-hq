import type { PolicyRequirementSeed, RequirementSeedIdentity } from './types';
import {
  buildCanonicalPolicyStatuses,
  canonicalTaskStatusEmoji,
  getWorkflowSeedRow,
  isWorkflowTypeStatusSeeded,
  markWorkflowTaskPolicySeeded,
  markWorkflowTypeStatusSeeded,
  normalizeWorkflowType,
  parseJsonArray,
  parseJsonObject,
  policyTransitionsForWorkflowType,
  policyRequirementsForWorkflowType,
  starterWorkflowType,
  workflowTypeTenantPredicate,
  tableExists,
  tableHasColumn,
} from './metadata';
import { listWorkflowTypeTaskStatuses } from './statuses';
import { type Db } from "../../../db/adapter/types";

export function normalizeRequirementKeyValue(value: string | null | undefined): string {
  return typeof value === 'string' ? value : '';
}

export function requirementSeedIdentityKey(row: RequirementSeedIdentity): string {
  return [
    normalizeRequirementKeyValue(row.task_type),
    row.outcome,
    row.field_name,
    row.requirement_type,
    normalizeRequirementKeyValue(row.match_field),
  ].join('\u0000');
}

export async function loadRequirementTombstoneKeys(db: Db, workflowId: number): Promise<Set<string>> {
  if (!await tableExists(db, 'workflow_task_transition_requirement_tombstones')) return new Set<string>();
  const rows = await db.all(`
    SELECT task_type_key, outcome, field_name, requirement_type, match_field_key
    FROM workflow_task_transition_requirement_tombstones
    WHERE workflow_id = ?
  `, workflowId) as Array<{
    task_type_key: string;
    outcome: string;
    field_name: string;
    requirement_type: string;
    match_field_key: string;
  }>;
  return new Set(rows.map((row) => [
    row.task_type_key,
    row.outcome,
    row.field_name,
    row.requirement_type,
    row.match_field_key,
  ].join('\u0000')));
}

export async function isStarterRequirementSeedForWorkflow(
  db: Db,
  workflowId: number,
  row: RequirementSeedIdentity,
): Promise<boolean> {
  if (row.recurring_series_id != null) return false;
  const workflow = await getWorkflowSeedRow(db, workflowId);
  if (!workflow) return false;
  const defaultKeys = new Set(
    policyRequirementsForWorkflowType(workflow.workflow_type).map((seed) => requirementSeedIdentityKey(seed)),
  );
  return defaultKeys.has(requirementSeedIdentityKey(row));
}

export async function rememberDeletedWorkflowTaskTransitionRequirement(
  db: Db,
  workflowId: number,
  row: RequirementSeedIdentity,
): Promise<void> {
  if (!await tableExists(db, 'workflow_task_transition_requirement_tombstones')) return;
  if (!await isStarterRequirementSeedForWorkflow(db, workflowId, row)) return;

  const values = [
    workflowId,
    normalizeRequirementKeyValue(row.task_type),
    row.outcome,
    row.field_name,
    row.requirement_type,
    normalizeRequirementKeyValue(row.match_field),
  ] as const;
  await db.withTransaction(async (db) => {
    await db.run(`
      DELETE FROM workflow_task_transition_requirement_tombstones
      WHERE workflow_id = ?
        AND task_type_key = ?
        AND outcome = ?
        AND field_name = ?
        AND requirement_type = ?
        AND match_field_key = ?
    `, ...values);
    await db.run(`
      INSERT INTO workflow_task_transition_requirement_tombstones (
        workflow_id, task_type_key, outcome, field_name, requirement_type, match_field_key, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    `, ...values);
  });
}

export async function seedWorkflowTaskPolicy(
  db: Db,
  workflowId: number,
  options?: { force?: boolean },
): Promise<void> {
  if (!Number.isFinite(workflowId)) return;
  if (!await tableExists(db, 'workflow_task_statuses')) return;
  if (!await tableExists(db, 'workflow_task_transitions')) return;

  const workflow = await getWorkflowSeedRow(db, workflowId);
  if (!workflow) return;

  const force = options?.force === true;
  const policySeeded = Boolean(workflow.task_policy_seeded_at);

  // Starter policy is installation data, not a desired-state template. Once installation has
  // completed, the persisted rows belong to the operator: missing rows may have been deleted
  // intentionally and must never be reconciled by an unrelated routing write. Only an explicit
  // forced install/migration is allowed to replace the policy after this marker is set.
  if (policySeeded && !force) return;

  const statusCount = (await db.get(`SELECT COUNT(*) AS n FROM workflow_task_statuses WHERE workflow_id = ?`, workflowId) as { n: number }).n;
  const transitionCount = (await db.get(`SELECT COUNT(*) AS n FROM workflow_task_transitions WHERE workflow_id = ?`, workflowId) as { n: number }).n;
  const requirementCount = (await db.get(`SELECT COUNT(*) AS n FROM workflow_task_transition_requirements WHERE workflow_id = ?`, workflowId) as { n: number }).n;
  const shouldSeedStatuses = force || (!policySeeded && statusCount === 0);
  const shouldSeedTransitions = force || (!policySeeded && transitionCount === 0);
  const shouldSeedRequirements = force || (!policySeeded && requirementCount === 0);

  if (!shouldSeedStatuses && !shouldSeedTransitions && !shouldSeedRequirements) {
    if (!policySeeded && (statusCount > 0 || transitionCount > 0 || requirementCount > 0)) {
      await markWorkflowTaskPolicySeeded(db, workflowId);
    }
    return;
  }

  const loadPolicyStatuses = async (db: Db): Promise<Array<{
      name: string;
      label: string;
      color: string;
      terminal: number;
      is_system: number;
      allowed_transitions: string;
      metadata_json: string;
    }>> => {
    const workflowType = normalizeWorkflowType(workflow.workflow_type);
    if (workflowType && await tableExists(db, 'workflow_type_task_statuses')) {
      const tenant = await workflowTypeTenantPredicate(db, 'workflow_type_task_statuses', workflow.tenant_id);
      const rows = await db.all(`
        SELECT status_key, label, color, terminal, is_system, allowed_transitions_json, metadata_json
        FROM workflow_type_task_statuses
        WHERE workflow_type_key = ?
          ${tenant.sql}
        ORDER BY stage_order ASC, id ASC
      `, workflowType, ...tenant.params) as Array<{
        status_key: string;
        label: string;
        color: string;
        terminal: number;
        is_system: number;
        allowed_transitions_json: string;
        metadata_json: string | null;
      }>;
      if (rows.length > 0) {
        return rows.map(row => ({
          name: row.status_key,
          label: row.label,
          color: row.color,
          terminal: row.terminal,
          is_system: row.is_system,
          allowed_transitions: row.allowed_transitions_json ?? '[]',
          metadata_json: row.metadata_json ?? '{}',
        }));
      }
    }

    return buildCanonicalPolicyStatuses(workflow.workflow_type).map((row) => ({
      ...row,
      metadata_json: '{}',
    }));
  };

  const loadPolicyRequirements = (): PolicyRequirementSeed[] => policyRequirementsForWorkflowType(workflow.workflow_type);
  const loadPolicyTransitions = () => policyTransitionsForWorkflowType(workflow.workflow_type);

  await db.withTransaction(async (db) => {
    const requirementTombstones = force ? new Set<string>() : await loadRequirementTombstoneKeys(db, workflowId);
    if (force && await tableExists(db, 'workflow_task_transition_requirement_tombstones')) {
      await db.run(`DELETE FROM workflow_task_transition_requirement_tombstones WHERE workflow_id = ?`, workflowId);
    }

    if (shouldSeedStatuses) {
      await db.run(`DELETE FROM workflow_task_statuses WHERE workflow_id = ?`, workflowId);
      const insertSql = `
        INSERT INTO workflow_task_statuses (
          workflow_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      `;
      const policyStatuses = await loadPolicyStatuses(db);
      for (const [index, row] of policyStatuses.entries()) {
        await db.run(
          insertSql,
          workflowId,
          row.name,
          row.label,
          row.color,
          row.terminal ? 1 : 0,
          row.is_system ? 1 : 0,
          row.allowed_transitions ?? '[]',
          index,
          index === 0 ? 1 : 0,
          row.metadata_json ?? '{}',
        );
      }
    }

    const transitionScopeColumns = await tableHasColumn(db, 'workflow_task_transitions', 'project_id')
      && await tableHasColumn(db, 'workflow_task_transitions', 'workflow_type');
    const transitionTenantInsert = await tableHasColumn(db, 'workflow_task_transitions', 'tenant_id')
      ? { columns: 'tenant_id, ', placeholders: '?, ', params: [workflow.tenant_id ?? null] }
      : { columns: '', placeholders: '', params: [] };

    if (shouldSeedTransitions) {
      await db.run(`DELETE FROM workflow_task_transitions WHERE workflow_id = ?`, workflowId);
      const insertSql = transitionScopeColumns ? `
        INSERT INTO workflow_task_transitions (
          ${transitionTenantInsert.columns}workflow_id, project_id, workflow_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
        ) VALUES (${transitionTenantInsert.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, 0, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      ` : `
        INSERT INTO workflow_task_transitions (
          ${transitionTenantInsert.columns}workflow_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
        ) VALUES (${transitionTenantInsert.placeholders}?, ?, ?, ?, ?, ?, ?, 0, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      `;
      for (const row of loadPolicyTransitions()) {
        await db.run(
          insertSql,
          ...transitionTenantInsert.params,
          ...(transitionScopeColumns ? [workflowId, workflow.project_id, workflow.workflow_type] : [workflowId]),
          row.task_type ?? null,
          row.from_status,
          row.outcome,
          row.to_status,
          row.enabled ? 1 : 0,
          row.priority ?? 0,
        );
      }
    } else {
      const insertMissingSql = transitionScopeColumns ? `
        INSERT INTO workflow_task_transitions (
          ${transitionTenantInsert.columns}workflow_id, project_id, workflow_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
        ) VALUES (${transitionTenantInsert.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, 0, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      ` : `
        INSERT INTO workflow_task_transitions (
          ${transitionTenantInsert.columns}workflow_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
        ) VALUES (${transitionTenantInsert.placeholders}?, ?, ?, ?, ?, ?, ?, 0, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      `;
      const existingKeys = new Set(
        (await db.all(`
          SELECT COALESCE(task_type, '') AS task_type, from_status, outcome
          FROM workflow_task_transitions
          WHERE workflow_id = ?
        `, workflowId) as Array<{ task_type: string; from_status: string; outcome: string }>)
          .map((row) => `${row.task_type}\u0000${row.from_status}\u0000${row.outcome}`),
      );
      for (const row of loadPolicyTransitions()) {
        const key = `${row.task_type ?? ''}\u0000${row.from_status}\u0000${row.outcome}`;
        if (existingKeys.has(key)) continue;
        await db.run(
          insertMissingSql,
          ...transitionTenantInsert.params,
          ...(transitionScopeColumns ? [workflowId, workflow.project_id, workflow.workflow_type] : [workflowId]),
          row.task_type ?? null,
          row.from_status,
          row.outcome,
          row.to_status,
          row.enabled ? 1 : 0,
          row.priority ?? 0,
        );
        existingKeys.add(key);
      }
    }

    const requirementScopeColumns = await tableHasColumn(db, 'workflow_task_transition_requirements', 'project_id')
      && await tableHasColumn(db, 'workflow_task_transition_requirements', 'workflow_type');
    const requirementTenantInsert = await tableHasColumn(db, 'workflow_task_transition_requirements', 'tenant_id')
      ? { columns: 'tenant_id, ', placeholders: '?, ', params: [workflow.tenant_id ?? null] }
      : { columns: '', placeholders: '', params: [] };

    if (shouldSeedRequirements) {
      await db.run(`DELETE FROM workflow_task_transition_requirements WHERE workflow_id = ?`, workflowId);
      const insertSql = requirementScopeColumns ? `
        INSERT INTO workflow_task_transition_requirements (
          ${requirementTenantInsert.columns}workflow_id, project_id, workflow_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
        ) VALUES (${requirementTenantInsert.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      ` : `
        INSERT INTO workflow_task_transition_requirements (
          ${requirementTenantInsert.columns}workflow_id, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
        ) VALUES (${requirementTenantInsert.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      `;
      for (const row of loadPolicyRequirements()) {
        if (requirementTombstones.has(requirementSeedIdentityKey(row))) continue;
        await db.run(
          insertSql,
          ...requirementTenantInsert.params,
          ...(requirementScopeColumns ? [workflowId, workflow.project_id, workflow.workflow_type] : [workflowId]),
          row.task_type ?? null,
          row.outcome,
          row.field_name,
          row.requirement_type,
          row.match_field ?? null,
          row.severity,
          row.message,
          row.enabled ? 1 : 0,
          row.priority ?? 0,
        );
      }
    } else {
      const insertMissingSql = requirementScopeColumns ? `
        INSERT INTO workflow_task_transition_requirements (
          ${requirementTenantInsert.columns}workflow_id, project_id, workflow_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
        ) VALUES (${requirementTenantInsert.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      ` : `
        INSERT INTO workflow_task_transition_requirements (
          ${requirementTenantInsert.columns}workflow_id, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
        ) VALUES (${requirementTenantInsert.placeholders}?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
      `;
      const existingKeys = new Set(
        (await db.all(`
          SELECT COALESCE(task_type, '') AS task_type, outcome, field_name, requirement_type, COALESCE(match_field, '') AS match_field
          FROM workflow_task_transition_requirements
          WHERE workflow_id = ?
        `, workflowId) as Array<{ task_type: string; outcome: string; field_name: string; requirement_type: string; match_field: string }>)
          .map((row) => `${row.task_type}\u0000${row.outcome}\u0000${row.field_name}\u0000${row.requirement_type}\u0000${row.match_field}`),
      );
      for (const row of loadPolicyRequirements()) {
        const key = `${row.task_type ?? ''}\u0000${row.outcome}\u0000${row.field_name}\u0000${row.requirement_type}\u0000${row.match_field ?? ''}`;
        if (requirementTombstones.has(key)) continue;
        if (existingKeys.has(key)) continue;
        await db.run(
          insertMissingSql,
          ...requirementTenantInsert.params,
          ...(requirementScopeColumns ? [workflowId, workflow.project_id, workflow.workflow_type] : [workflowId]),
          row.task_type ?? null,
          row.outcome,
          row.field_name,
          row.requirement_type,
          row.match_field ?? null,
          row.severity,
          row.message,
          row.enabled ? 1 : 0,
          row.priority ?? 0,
        );
        existingKeys.add(key);
      }
    }

    if (force) {
      await db.run(`DELETE FROM workflow_task_routing_rules WHERE workflow_id = ?`, workflowId);
    }
  });

  await markWorkflowTaskPolicySeeded(db, workflowId);
}

export async function backfillMissingWorkflowTypeStatusEmoji(db: Db, workflowType: string): Promise<void> {
  if (!await tableExists(db, 'workflow_type_task_statuses')) return;
  const rows = await db.all(`
    SELECT id, status_key, metadata_json
    FROM workflow_type_task_statuses
    WHERE workflow_type_key = ?
  `, workflowType) as Array<{ id: number; status_key: string; metadata_json: string | null }>;
  if (rows.length === 0) return;
  const updateEmojiSql = `
    UPDATE workflow_type_task_statuses
    SET metadata_json = ?, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `;
  for (const row of rows) {
    const metadata = parseJsonObject(row.metadata_json);
    const hasEmoji = typeof metadata.emoji === 'string' && metadata.emoji.trim().length > 0;
    if (hasEmoji) continue;
    const fallbackEmoji = canonicalTaskStatusEmoji(row.status_key);
    if (!fallbackEmoji) continue;
    await db.run(updateEmojiSql, JSON.stringify({ ...metadata, emoji: fallbackEmoji }), row.id);
  }
}

export async function pruneUnexpectedStarterWorkflowTypeTaskStatuses(
  db: Db,
  workflowType: string,
  options?: { tenantId?: number | null },
): Promise<void> {
  const normalizedWorkflowType = normalizeWorkflowType(workflowType);
  if (!normalizedWorkflowType || !starterWorkflowType(normalizedWorkflowType)) return;
  if (!await tableExists(db, 'workflow_type_task_statuses')) return;

  const canonicalStatusKeys = buildCanonicalPolicyStatuses(normalizedWorkflowType).map((row) => row.name);
  if (canonicalStatusKeys.length === 0) return;
  const statusTenant = await workflowTypeTenantPredicate(db, 'workflow_type_task_statuses', options?.tenantId);
  await db.run(`
    DELETE FROM workflow_type_task_statuses
    WHERE workflow_type_key = ?
      ${statusTenant.sql}
      AND COALESCE(is_system, 0) = 1
      AND status_key NOT IN (${canonicalStatusKeys.map(() => '?').join(', ')})
  `, normalizedWorkflowType, ...statusTenant.params, ...canonicalStatusKeys);
}

async function ensureOpsIntakeStarterStatus(
  db: Db,
  options?: { tenantId?: number | null },
): Promise<void> {
  if (!await tableExists(db, 'workflow_type_task_statuses')) return;
  const statusTenant = await workflowTypeTenantPredicate(db, 'workflow_type_task_statuses', options?.tenantId);
  const existing = await db.get(`
    SELECT status_key
    FROM workflow_type_task_statuses
    WHERE workflow_type_key = 'ops'
      ${statusTenant.sql}
      AND status_key = 'intake'
    LIMIT 1
  `, ...statusTenant.params);
  if (existing) return;

  const canonical = buildCanonicalPolicyStatuses('ops').find((row) => row.name === 'intake');
  if (!canonical) return;
  const hasStatusTenantId = await tableHasColumn(db, 'workflow_type_task_statuses', 'tenant_id');
  const insertSql = hasStatusTenantId
    ? `
      INSERT INTO workflow_type_task_statuses (
        tenant_id, workflow_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
      ) VALUES (?, 'ops', ?, ?, ?, ?, ?, ?, 0, 1, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')) ON CONFLICT DO NOTHING`
    : `
      INSERT INTO workflow_type_task_statuses (
        workflow_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
      ) VALUES ('ops', ?, ?, ?, ?, ?, ?, 0, 1, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')) ON CONFLICT DO NOTHING`;
  const params = [
    canonical.name,
    canonical.label,
    canonical.color,
    canonical.terminal ? 1 : 0,
    canonical.is_system ? 1 : 0,
    canonical.allowed_transitions,
    JSON.stringify(canonical.emoji ? { emoji: canonical.emoji } : {}),
  ];
  if (hasStatusTenantId) await db.run(insertSql, options?.tenantId ?? null, ...params);
  else await db.run(insertSql, ...params);
}

export async function reconcileWorkflowTypeTaskStatusesToCanonical(db: Db, workflowType: string): Promise<void> {
  if (!await tableExists(db, 'workflow_type_task_statuses')) return;
  if (!starterWorkflowType(workflowType)) return;
  const canonicalStatuses = buildCanonicalPolicyStatuses(workflowType).map((row, index) => ({
    ...row,
    stage_order: index,
    metadata_json: JSON.stringify(row.emoji ? { emoji: row.emoji } : {}),
  }));
  const canonicalByStatus = new Map(canonicalStatuses.map((row) => [row.name, row]));

  const existingRows = await db.all(`
    SELECT id, status_key
    FROM workflow_type_task_statuses
    WHERE workflow_type_key = ?
  `, workflowType) as Array<{ id: number; status_key: string }>;

  const existingStatuses = new Set(existingRows.map((row) => row.status_key));
  const deleteSql = `DELETE FROM workflow_type_task_statuses WHERE workflow_type_key = ? AND status_key = ?`;
  const updateSql = `
    UPDATE workflow_type_task_statuses
    SET label = ?,
        color = ?,
        terminal = ?,
        is_system = ?,
        allowed_transitions_json = ?,
        stage_order = ?,
        is_default_entry = ?,
        metadata_json = ?,
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE workflow_type_key = ? AND status_key = ?
  `;
  const insertSql = `
    INSERT INTO workflow_type_task_statuses (
      workflow_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
  `;

  for (const row of existingRows) {
    if (!canonicalByStatus.has(row.status_key)) {
      await db.run(deleteSql, workflowType, row.status_key);
    }
  }

  for (const [index, status] of canonicalStatuses.entries()) {
    if (existingStatuses.has(status.name)) {
      await db.run(
        updateSql,
        status.label,
        status.color,
        status.terminal,
        status.is_system,
        status.allowed_transitions,
        status.stage_order,
        index === 0 ? 1 : 0,
        status.metadata_json,
        workflowType,
        status.name,
      );
      continue;
    }

    await db.run(
      insertSql,
      workflowType,
      status.name,
      status.label,
      status.color,
      status.terminal,
      status.is_system,
      status.allowed_transitions,
      status.stage_order,
      index === 0 ? 1 : 0,
      status.metadata_json,
    );
  }
}

export async function seedWorkflowTypeTaskStatuses(
  db: Db,
  workflowType: string | null | undefined,
  options?: { force?: boolean; sourceWorkflowType?: string | null; tenantId?: number | null },
): Promise<void> {
  const normalizedWorkflowType = normalizeWorkflowType(workflowType);
  if (!normalizedWorkflowType) return;
  if (!await tableExists(db, 'workflow_types') || !await tableExists(db, 'workflow_type_task_statuses')) return;

  const typeTenant = await workflowTypeTenantPredicate(db, 'workflow_types', options?.tenantId);
  const statusTenant = await workflowTypeTenantPredicate(db, 'workflow_type_task_statuses', options?.tenantId);
  const workflowTypeRow = await db.get(`SELECT key FROM workflow_types WHERE key = ?${typeTenant.sql} LIMIT 1`, normalizedWorkflowType, ...typeTenant.params);
  if (!workflowTypeRow) return;

  const existingCount = (await db.get(`
    SELECT COUNT(*) AS n
    FROM workflow_type_task_statuses
    WHERE workflow_type_key = ?
      ${statusTenant.sql}
  `, normalizedWorkflowType, ...statusTenant.params) as { n: number }).n;
  const force = options?.force === true;
  if (!starterWorkflowType(normalizedWorkflowType)) {
    if (existingCount > 0) {
      await backfillMissingWorkflowTypeStatusEmoji(db, normalizedWorkflowType);
    }
    return;
  }
  const statusSeeded = await isWorkflowTypeStatusSeeded(db, normalizedWorkflowType, options?.tenantId);
  if (!force) {
    if (statusSeeded) {
      await pruneUnexpectedStarterWorkflowTypeTaskStatuses(db, normalizedWorkflowType, { tenantId: options?.tenantId });
      if (normalizedWorkflowType === 'ops') await ensureOpsIntakeStarterStatus(db, { tenantId: options?.tenantId });
      await backfillMissingWorkflowTypeStatusEmoji(db, normalizedWorkflowType);
      return;
    }
    if (existingCount > 0) {
      await pruneUnexpectedStarterWorkflowTypeTaskStatuses(db, normalizedWorkflowType, { tenantId: options?.tenantId });
      if (normalizedWorkflowType === 'ops') await ensureOpsIntakeStarterStatus(db, { tenantId: options?.tenantId });
      await backfillMissingWorkflowTypeStatusEmoji(db, normalizedWorkflowType);
      await markWorkflowTypeStatusSeeded(db, normalizedWorkflowType, options?.tenantId);
      return;
    }
  }

  const sourceWorkflowType = normalizeWorkflowType(options?.sourceWorkflowType) ?? (normalizedWorkflowType === 'generic' ? null : 'generic');
  const sourceStatuses = buildCanonicalPolicyStatuses(normalizedWorkflowType).map((row, index) => ({
    name: row.name,
    label: row.label,
    color: row.color,
    terminal: Boolean(row.terminal),
    is_system: Boolean(row.is_system),
    allowed_transitions: parseJsonArray(row.allowed_transitions),
    emoji: row.emoji,
    metadata: row.emoji ? { emoji: row.emoji } : {},
    stage_order: index,
    is_default_entry: index === 0,
  }));
  const fallbackStatuses = sourceWorkflowType ? await listWorkflowTypeTaskStatuses(db, sourceWorkflowType, { tenantId: options?.tenantId }) : [];
  const statusesToSeed = sourceStatuses.length > 0 ? sourceStatuses : fallbackStatuses;
  await db.withTransaction(async (db) => {
    if (force) {
      await db.run(`DELETE FROM workflow_type_task_statuses WHERE workflow_type_key = ?${statusTenant.sql}`, normalizedWorkflowType, ...statusTenant.params);
    }
    const hasStatusTenantId = await tableHasColumn(db, 'workflow_type_task_statuses', 'tenant_id');
    const insertSql = hasStatusTenantId
      ? `
        INSERT INTO workflow_type_task_statuses (
          tenant_id, workflow_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')) ON CONFLICT DO NOTHING`
      : `
        INSERT INTO workflow_type_task_statuses (
          workflow_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'), to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')) ON CONFLICT DO NOTHING`;
    for (const [index, status] of statusesToSeed.entries()) {
      await db.run(
        insertSql,
        ...(hasStatusTenantId ? [options?.tenantId ?? null] : []),
        normalizedWorkflowType,
        status.name,
        status.label,
        status.color,
        status.terminal ? 1 : 0,
        status.is_system ? 1 : 0,
        JSON.stringify(status.allowed_transitions ?? []),
        Number.isFinite(Number(status.stage_order)) ? Number(status.stage_order) : index,
        status.is_default_entry ? 1 : 0,
        JSON.stringify(status.metadata ?? (status.emoji ? { emoji: status.emoji } : {})),
      );
    }

    await backfillMissingWorkflowTypeStatusEmoji(db, normalizedWorkflowType);
  });
  await markWorkflowTypeStatusSeeded(db, normalizedWorkflowType, options?.tenantId);
}
