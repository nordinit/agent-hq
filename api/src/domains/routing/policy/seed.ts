import type Database from 'better-sqlite3';
import type { PolicyRequirementSeed, RequirementSeedIdentity } from './types';
import {
  buildCanonicalPolicyStatuses,
  canonicalTaskStatusEmoji,
  getSprintSeedRow,
  isSprintTypeStatusSeeded,
  markSprintTaskPolicySeeded,
  markSprintTypeStatusSeeded,
  normalizeSprintType,
  parseJsonArray,
  parseJsonObject,
  policyTransitionsForSprintType,
  policyRequirementsForSprintType,
  starterSprintType,
  sprintTypeTenantPredicate,
  tableExists,
  tableHasColumn,
} from './metadata';
import { listSprintTypeTaskStatuses } from './statuses';

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

export function loadRequirementTombstoneKeys(db: Database.Database, sprintId: number): Set<string> {
  if (!tableExists(db, 'sprint_task_transition_requirement_tombstones')) return new Set<string>();
  const rows = db.prepare(`
    SELECT task_type_key, outcome, field_name, requirement_type, match_field_key
    FROM sprint_task_transition_requirement_tombstones
    WHERE sprint_id = ?
  `).all(sprintId) as Array<{
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

export function isStarterRequirementSeedForSprint(
  db: Database.Database,
  sprintId: number,
  row: RequirementSeedIdentity,
): boolean {
  const sprint = getSprintSeedRow(db, sprintId);
  if (!sprint) return false;
  const defaultKeys = new Set(
    policyRequirementsForSprintType(sprint.sprint_type).map((seed) => requirementSeedIdentityKey(seed)),
  );
  return defaultKeys.has(requirementSeedIdentityKey(row));
}

export function rememberDeletedSprintTaskTransitionRequirement(
  db: Database.Database,
  sprintId: number,
  row: RequirementSeedIdentity,
): void {
  if (!tableExists(db, 'sprint_task_transition_requirement_tombstones')) return;
  if (!isStarterRequirementSeedForSprint(db, sprintId, row)) return;

  const values = [
    sprintId,
    normalizeRequirementKeyValue(row.task_type),
    row.outcome,
    row.field_name,
    row.requirement_type,
    normalizeRequirementKeyValue(row.match_field),
  ] as const;
  const tx = db.transaction(() => {
    db.prepare(`
      DELETE FROM sprint_task_transition_requirement_tombstones
      WHERE sprint_id = ?
        AND task_type_key = ?
        AND outcome = ?
        AND field_name = ?
        AND requirement_type = ?
        AND match_field_key = ?
    `).run(...values);
    db.prepare(`
      INSERT INTO sprint_task_transition_requirement_tombstones (
        sprint_id, task_type_key, outcome, field_name, requirement_type, match_field_key, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(...values);
  });
  tx();
}

export function seedSprintTaskPolicy(
  db: Database.Database,
  sprintId: number,
  options?: { force?: boolean },
): void {
  if (!Number.isFinite(sprintId)) return;
  if (!tableExists(db, 'sprint_task_statuses')) return;
  if (!tableExists(db, 'sprint_task_transitions')) return;

  const sprint = getSprintSeedRow(db, sprintId);
  if (!sprint) return;

  const force = options?.force === true;
  const statusCount = (db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_statuses WHERE sprint_id = ?`).get(sprintId) as { n: number }).n;
  const transitionCount = (db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_transitions WHERE sprint_id = ?`).get(sprintId) as { n: number }).n;
  const requirementCount = (db.prepare(`SELECT COUNT(*) AS n FROM sprint_task_transition_requirements WHERE sprint_id = ?`).get(sprintId) as { n: number }).n;
  const policySeeded = Boolean(sprint.task_policy_seeded_at);
  const shouldSeedStatuses = force || (!policySeeded && statusCount === 0);
  const shouldSeedTransitions = force || (!policySeeded && transitionCount === 0);
  const shouldSeedRequirements = force || (!policySeeded && requirementCount === 0);

  if (!shouldSeedStatuses && !shouldSeedTransitions && !shouldSeedRequirements) {
    if (!policySeeded && (statusCount > 0 || transitionCount > 0 || requirementCount > 0)) {
      markSprintTaskPolicySeeded(db, sprintId);
    }
    return;
  }

  const loadPolicyStatuses = (): Array<{
    name: string;
    label: string;
    color: string;
    terminal: number;
    is_system: number;
    allowed_transitions: string;
    metadata_json: string;
  }> => {
    const sprintType = normalizeSprintType(sprint.sprint_type);
    if (sprintType && tableExists(db, 'sprint_type_task_statuses')) {
      const tenant = sprintTypeTenantPredicate(db, 'sprint_type_task_statuses', sprint.tenant_id);
      const rows = db.prepare(`
        SELECT status_key, label, color, terminal, is_system, allowed_transitions_json, metadata_json
        FROM sprint_type_task_statuses
        WHERE sprint_type_key = ?
          ${tenant.sql}
        ORDER BY stage_order ASC, id ASC
      `).all(sprintType, ...tenant.params) as Array<{
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

    return buildCanonicalPolicyStatuses(sprint.sprint_type).map((row) => ({
      ...row,
      metadata_json: '{}',
    }));
  };

  const loadPolicyRequirements = (): PolicyRequirementSeed[] => policyRequirementsForSprintType(sprint.sprint_type);
  const loadPolicyTransitions = () => policyTransitionsForSprintType(sprint.sprint_type);

  const tx = db.transaction(() => {
    const requirementTombstones = force ? new Set<string>() : loadRequirementTombstoneKeys(db, sprintId);
    if (force && tableExists(db, 'sprint_task_transition_requirement_tombstones')) {
      db.prepare(`DELETE FROM sprint_task_transition_requirement_tombstones WHERE sprint_id = ?`).run(sprintId);
    }

    if (shouldSeedStatuses) {
      db.prepare(`DELETE FROM sprint_task_statuses WHERE sprint_id = ?`).run(sprintId);
      const insert = db.prepare(`
        INSERT INTO sprint_task_statuses (
          sprint_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);
      const policyStatuses = loadPolicyStatuses();
      policyStatuses.forEach((row, index) => {
        insert.run(
          sprintId,
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
      });
    }

    const transitionScopeColumns = tableHasColumn(db, 'sprint_task_transitions', 'project_id')
      && tableHasColumn(db, 'sprint_task_transitions', 'sprint_type');

    if (shouldSeedTransitions) {
      db.prepare(`DELETE FROM sprint_task_transitions WHERE sprint_id = ?`).run(sprintId);
      const insert = db.prepare(transitionScopeColumns ? `
        INSERT INTO sprint_task_transitions (
          sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      ` : `
        INSERT INTO sprint_task_transitions (
          sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      `);
      for (const row of loadPolicyTransitions()) {
        insert.run(
          ...(transitionScopeColumns ? [sprintId, sprint.project_id, sprint.sprint_type] : [sprintId]),
          row.task_type ?? null,
          row.from_status,
          row.outcome,
          row.to_status,
          row.enabled ? 1 : 0,
          row.priority ?? 0,
        );
      }
    } else {
      const insertMissing = db.prepare(transitionScopeColumns ? `
        INSERT INTO sprint_task_transitions (
          sprint_id, project_id, sprint_type, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      ` : `
        INSERT INTO sprint_task_transitions (
          sprint_id, task_type, from_status, outcome, to_status, enabled, priority, is_protected, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
      `);
      const existingKeys = new Set(
        (db.prepare(`
          SELECT COALESCE(task_type, '') AS task_type, from_status, outcome
          FROM sprint_task_transitions
          WHERE sprint_id = ?
        `).all(sprintId) as Array<{ task_type: string; from_status: string; outcome: string }>)
          .map((row) => `${row.task_type}\u0000${row.from_status}\u0000${row.outcome}`),
      );
      for (const row of loadPolicyTransitions()) {
        const key = `${row.task_type ?? ''}\u0000${row.from_status}\u0000${row.outcome}`;
        if (existingKeys.has(key)) continue;
        insertMissing.run(
          ...(transitionScopeColumns ? [sprintId, sprint.project_id, sprint.sprint_type] : [sprintId]),
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

    const requirementScopeColumns = tableHasColumn(db, 'sprint_task_transition_requirements', 'project_id')
      && tableHasColumn(db, 'sprint_task_transition_requirements', 'sprint_type');

    if (shouldSeedRequirements) {
      db.prepare(`DELETE FROM sprint_task_transition_requirements WHERE sprint_id = ?`).run(sprintId);
      const insert = db.prepare(requirementScopeColumns ? `
        INSERT INTO sprint_task_transition_requirements (
          sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ` : `
        INSERT INTO sprint_task_transition_requirements (
          sprint_id, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);
      for (const row of loadPolicyRequirements()) {
        if (requirementTombstones.has(requirementSeedIdentityKey(row))) continue;
        insert.run(
          ...(requirementScopeColumns ? [sprintId, sprint.project_id, sprint.sprint_type] : [sprintId]),
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
      const insertMissing = db.prepare(requirementScopeColumns ? `
        INSERT INTO sprint_task_transition_requirements (
          sprint_id, project_id, sprint_type, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ` : `
        INSERT INTO sprint_task_transition_requirements (
          sprint_id, task_type, outcome, field_name, requirement_type, match_field, severity, message, enabled, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);
      const existingKeys = new Set(
        (db.prepare(`
          SELECT COALESCE(task_type, '') AS task_type, outcome, field_name, requirement_type, COALESCE(match_field, '') AS match_field
          FROM sprint_task_transition_requirements
          WHERE sprint_id = ?
        `).all(sprintId) as Array<{ task_type: string; outcome: string; field_name: string; requirement_type: string; match_field: string }>)
          .map((row) => `${row.task_type}\u0000${row.outcome}\u0000${row.field_name}\u0000${row.requirement_type}\u0000${row.match_field}`),
      );
      for (const row of loadPolicyRequirements()) {
        const key = `${row.task_type ?? ''}\u0000${row.outcome}\u0000${row.field_name}\u0000${row.requirement_type}\u0000${row.match_field ?? ''}`;
        if (requirementTombstones.has(key)) continue;
        if (existingKeys.has(key)) continue;
        insertMissing.run(
          ...(requirementScopeColumns ? [sprintId, sprint.project_id, sprint.sprint_type] : [sprintId]),
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
      db.prepare(`DELETE FROM sprint_task_routing_rules WHERE sprint_id = ?`).run(sprintId);
    }
  });

  tx();
  markSprintTaskPolicySeeded(db, sprintId);
}

export function backfillMissingSprintTypeStatusEmoji(db: Database.Database, sprintType: string): void {
  if (!tableExists(db, 'sprint_type_task_statuses')) return;
  const rows = db.prepare(`
    SELECT id, status_key, metadata_json
    FROM sprint_type_task_statuses
    WHERE sprint_type_key = ?
  `).all(sprintType) as Array<{ id: number; status_key: string; metadata_json: string | null }>;
  if (rows.length === 0) return;
  const updateEmoji = db.prepare(`
    UPDATE sprint_type_task_statuses
    SET metadata_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  for (const row of rows) {
    const metadata = parseJsonObject(row.metadata_json);
    const hasEmoji = typeof metadata.emoji === 'string' && metadata.emoji.trim().length > 0;
    if (hasEmoji) continue;
    const fallbackEmoji = canonicalTaskStatusEmoji(row.status_key);
    if (!fallbackEmoji) continue;
    updateEmoji.run(JSON.stringify({ ...metadata, emoji: fallbackEmoji }), row.id);
  }
}

export function pruneUnexpectedStarterSprintTypeTaskStatuses(
  db: Database.Database,
  sprintType: string,
  options?: { tenantId?: number | null },
): void {
  const normalizedSprintType = normalizeSprintType(sprintType);
  if (!normalizedSprintType || !starterSprintType(normalizedSprintType)) return;
  if (!tableExists(db, 'sprint_type_task_statuses')) return;

  const canonicalStatusKeys = buildCanonicalPolicyStatuses(normalizedSprintType).map((row) => row.name);
  if (canonicalStatusKeys.length === 0) return;
  const statusTenant = sprintTypeTenantPredicate(db, 'sprint_type_task_statuses', options?.tenantId);
  db.prepare(`
    DELETE FROM sprint_type_task_statuses
    WHERE sprint_type_key = ?
      ${statusTenant.sql}
      AND COALESCE(is_system, 0) = 1
      AND status_key NOT IN (${canonicalStatusKeys.map(() => '?').join(', ')})
  `).run(normalizedSprintType, ...statusTenant.params, ...canonicalStatusKeys);
}

function ensureOpsIntakeStarterStatus(
  db: Database.Database,
  options?: { tenantId?: number | null },
): void {
  if (!tableExists(db, 'sprint_type_task_statuses')) return;
  const statusTenant = sprintTypeTenantPredicate(db, 'sprint_type_task_statuses', options?.tenantId);
  const existing = db.prepare(`
    SELECT status_key
    FROM sprint_type_task_statuses
    WHERE sprint_type_key = 'ops'
      ${statusTenant.sql}
      AND status_key = 'intake'
    LIMIT 1
  `).get(...statusTenant.params);
  if (existing) return;

  const canonical = buildCanonicalPolicyStatuses('ops').find((row) => row.name === 'intake');
  if (!canonical) return;
  const hasStatusTenantId = tableHasColumn(db, 'sprint_type_task_statuses', 'tenant_id');
  const insert = hasStatusTenantId
    ? db.prepare(`
      INSERT OR IGNORE INTO sprint_type_task_statuses (
        tenant_id, sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
      ) VALUES (?, 'ops', ?, ?, ?, ?, ?, ?, 0, 1, ?, datetime('now'), datetime('now'))
    `)
    : db.prepare(`
      INSERT OR IGNORE INTO sprint_type_task_statuses (
        sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
      ) VALUES ('ops', ?, ?, ?, ?, ?, ?, 0, 1, ?, datetime('now'), datetime('now'))
    `);
  const params = [
    canonical.name,
    canonical.label,
    canonical.color,
    canonical.terminal ? 1 : 0,
    canonical.is_system ? 1 : 0,
    canonical.allowed_transitions,
    JSON.stringify(canonical.emoji ? { emoji: canonical.emoji } : {}),
  ];
  if (hasStatusTenantId) insert.run(options?.tenantId ?? null, ...params);
  else insert.run(...params);
}

export function reconcileSprintTypeTaskStatusesToCanonical(db: Database.Database, sprintType: string): void {
  if (!tableExists(db, 'sprint_type_task_statuses')) return;
  if (!starterSprintType(sprintType)) return;
  const canonicalStatuses = buildCanonicalPolicyStatuses(sprintType).map((row, index) => ({
    ...row,
    stage_order: index,
    metadata_json: JSON.stringify(row.emoji ? { emoji: row.emoji } : {}),
  }));
  const canonicalByStatus = new Map(canonicalStatuses.map((row) => [row.name, row]));

  const existingRows = db.prepare(`
    SELECT id, status_key
    FROM sprint_type_task_statuses
    WHERE sprint_type_key = ?
  `).all(sprintType) as Array<{ id: number; status_key: string }>;

  const existingStatuses = new Set(existingRows.map((row) => row.status_key));
  const deleteStmt = db.prepare(`DELETE FROM sprint_type_task_statuses WHERE sprint_type_key = ? AND status_key = ?`);
  const updateStmt = db.prepare(`
    UPDATE sprint_type_task_statuses
    SET label = ?,
        color = ?,
        terminal = ?,
        is_system = ?,
        allowed_transitions_json = ?,
        stage_order = ?,
        is_default_entry = ?,
        metadata_json = ?,
        updated_at = datetime('now')
    WHERE sprint_type_key = ? AND status_key = ?
  `);
  const insertStmt = db.prepare(`
    INSERT INTO sprint_type_task_statuses (
      sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `);

  for (const row of existingRows) {
    if (!canonicalByStatus.has(row.status_key)) {
      deleteStmt.run(sprintType, row.status_key);
    }
  }

  canonicalStatuses.forEach((status, index) => {
    if (existingStatuses.has(status.name)) {
      updateStmt.run(
        status.label,
        status.color,
        status.terminal,
        status.is_system,
        status.allowed_transitions,
        status.stage_order,
        index === 0 ? 1 : 0,
        status.metadata_json,
        sprintType,
        status.name,
      );
      return;
    }

    insertStmt.run(
      sprintType,
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
  });
}

export function seedSprintTypeTaskStatuses(
  db: Database.Database,
  sprintType: string | null | undefined,
  options?: { force?: boolean; sourceSprintType?: string | null; tenantId?: number | null },
): void {
  const normalizedSprintType = normalizeSprintType(sprintType);
  if (!normalizedSprintType) return;
  if (!tableExists(db, 'sprint_types') || !tableExists(db, 'sprint_type_task_statuses')) return;

  const typeTenant = sprintTypeTenantPredicate(db, 'sprint_types', options?.tenantId);
  const statusTenant = sprintTypeTenantPredicate(db, 'sprint_type_task_statuses', options?.tenantId);
  const sprintTypeRow = db.prepare(`SELECT key FROM sprint_types WHERE key = ?${typeTenant.sql} LIMIT 1`).get(normalizedSprintType, ...typeTenant.params);
  if (!sprintTypeRow) return;

  const existingCount = (db.prepare(`
    SELECT COUNT(*) AS n
    FROM sprint_type_task_statuses
    WHERE sprint_type_key = ?
      ${statusTenant.sql}
  `).get(normalizedSprintType, ...statusTenant.params) as { n: number }).n;
  const force = options?.force === true;
  if (!starterSprintType(normalizedSprintType)) {
    if (existingCount > 0) {
      backfillMissingSprintTypeStatusEmoji(db, normalizedSprintType);
    }
    return;
  }
  const statusSeeded = isSprintTypeStatusSeeded(db, normalizedSprintType, options?.tenantId);
  if (!force) {
    if (statusSeeded) {
      pruneUnexpectedStarterSprintTypeTaskStatuses(db, normalizedSprintType, { tenantId: options?.tenantId });
      if (normalizedSprintType === 'ops') ensureOpsIntakeStarterStatus(db, { tenantId: options?.tenantId });
      backfillMissingSprintTypeStatusEmoji(db, normalizedSprintType);
      return;
    }
    if (existingCount > 0) {
      pruneUnexpectedStarterSprintTypeTaskStatuses(db, normalizedSprintType, { tenantId: options?.tenantId });
      if (normalizedSprintType === 'ops') ensureOpsIntakeStarterStatus(db, { tenantId: options?.tenantId });
      backfillMissingSprintTypeStatusEmoji(db, normalizedSprintType);
      markSprintTypeStatusSeeded(db, normalizedSprintType, options?.tenantId);
      return;
    }
  }

  const sourceSprintType = normalizeSprintType(options?.sourceSprintType) ?? (normalizedSprintType === 'generic' ? null : 'generic');
  const sourceStatuses = buildCanonicalPolicyStatuses(normalizedSprintType).map((row, index) => ({
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
  const fallbackStatuses = sourceSprintType ? listSprintTypeTaskStatuses(db, sourceSprintType, { tenantId: options?.tenantId }) : [];
  const statusesToSeed = sourceStatuses.length > 0 ? sourceStatuses : fallbackStatuses;
  const tx = db.transaction(() => {
    if (force) {
      db.prepare(`DELETE FROM sprint_type_task_statuses WHERE sprint_type_key = ?${statusTenant.sql}`).run(normalizedSprintType, ...statusTenant.params);
    }
    const hasStatusTenantId = tableHasColumn(db, 'sprint_type_task_statuses', 'tenant_id');
    const insert = hasStatusTenantId
      ? db.prepare(`
        INSERT OR IGNORE INTO sprint_type_task_statuses (
          tenant_id, sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `)
      : db.prepare(`
        INSERT OR IGNORE INTO sprint_type_task_statuses (
          sprint_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      `);
    statusesToSeed.forEach((status, index) => {
      insert.run(
        ...(hasStatusTenantId ? [options?.tenantId ?? null] : []),
        normalizedSprintType,
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
    });

    backfillMissingSprintTypeStatusEmoji(db, normalizedSprintType);
  });
  tx();
  markSprintTypeStatusSeeded(db, normalizedSprintType, options?.tenantId);
}
