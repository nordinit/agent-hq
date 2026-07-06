import type Database from 'better-sqlite3';
import { RELEASE_TASK_STATUSES, TERMINAL_TASK_STATUSES } from '../../../lib/taskStatuses';
import type { PolicyRequirementSeed, PolicyTransitionSeed, SprintSeedRow, StarterSprintType } from './types';

const DEV_WORKFLOW_STATUSES = RELEASE_TASK_STATUSES.filter(status => status !== 'qa_pass');
const GENERIC_WORKFLOW_STATUSES = ['todo', 'ready', 'in_progress', 'review', 'done'] as const;
const OPS_WORKFLOW_STATUSES = ['todo', 'intake', 'triage', 'risk_review', 'impact_review', 'action_plan', 'stakeholder_update', 'human_approval', 'blocked', 'stalled', 'done'] as const;
const LEAD_GENERATION_WORKFLOW_STATUSES = ['intake', 'qualification', 'research', 'outreach_draft', 'human_approval', 'sent', 'follow_up', 'done'] as const;

export const DEFAULT_TASK_STATUS_EMOJI: Record<string, string> = {
  todo: '📋',
  ready: '🔵',
  in_progress: '🔨',
  dev_deploy_queued: '🕒',
  dev_deploying: '🛠️',
  review: '🔍',
  qa_pass: '✅',
  ready_to_merge: '🔀',
  deployed: '🚀',
  done: '🟢',
  needs_attention: '⚠️',
  cancelled: '🚫',
  stalled: '⏸️',
  failed: '❌',
  blocked: '🧱',
  intake: '📥',
  triage: '🧭',
  risk_review: '⚖️',
  impact_review: '📊',
  action_plan: '📝',
  stakeholder_update: '📣',
  human_approval: '✋',
  qualification: '🎯',
  research: '🔎',
  outreach_draft: '✉️',
  sent: '📤',
  follow_up: '🔁',
};

export function canonicalTaskStatusEmoji(status: string): string | null {
  const emoji = DEFAULT_TASK_STATUS_EMOJI[status];
  return typeof emoji === 'string' && emoji.trim().length > 0 ? emoji : null;
}

export function ensureRoutingMetadata(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_statuses (
      name                TEXT PRIMARY KEY,
      label               TEXT NOT NULL,
      color               TEXT NOT NULL DEFAULT 'slate',
      terminal            INTEGER NOT NULL DEFAULT 0,
      is_system           INTEGER NOT NULL DEFAULT 0,
      allowed_transitions TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS routing_transitions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      from_status  TEXT NOT NULL,
      outcome      TEXT NOT NULL,
      to_status    TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_routing_transitions_project ON routing_transitions(project_id);
    CREATE INDEX IF NOT EXISTS idx_routing_transitions_from ON routing_transitions(from_status, outcome);

    CREATE TABLE IF NOT EXISTS sprint_task_transition_requirement_tombstones (
      sprint_id          INTEGER NOT NULL REFERENCES sprints(id) ON DELETE CASCADE,
      task_type_key      TEXT NOT NULL DEFAULT '',
      outcome            TEXT NOT NULL,
      field_name         TEXT NOT NULL,
      requirement_type   TEXT NOT NULL,
      match_field_key    TEXT NOT NULL DEFAULT '',
      deleted_at         TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (sprint_id, task_type_key, outcome, field_name, requirement_type, match_field_key)
    );
    CREATE INDEX IF NOT EXISTS idx_sprint_requirement_tombstones_sprint
      ON sprint_task_transition_requirement_tombstones(sprint_id);
  `);

  const statuses: Array<{ name: string; label: string; color: string; terminal: number; is_system: number; allowed_transitions: string[] }> = [
    { name: 'todo', label: 'To Do', color: 'slate', terminal: 0, is_system: 1, allowed_transitions: ['ready', 'cancelled'] },
    { name: 'ready', label: 'Ready', color: 'blue', terminal: 0, is_system: 1, allowed_transitions: ['in_progress', 'cancelled'] },
    { name: 'in_progress', label: 'In Progress', color: 'yellow', terminal: 0, is_system: 1, allowed_transitions: ['dev_deploy_queued', 'review', 'stalled', 'cancelled'] },
    { name: 'dev_deploy_queued', label: 'Dev Deploy Queued', color: 'amber', terminal: 0, is_system: 1, allowed_transitions: ['dev_deploying', 'review', 'blocked', 'failed', 'cancelled'] },
    { name: 'dev_deploying', label: 'Dev Deploying', color: 'cyan', terminal: 0, is_system: 1, allowed_transitions: ['review', 'dev_deploy_queued', 'blocked', 'failed', 'cancelled'] },
    { name: 'blocked', label: 'Blocked', color: 'rose', terminal: 0, is_system: 1, allowed_transitions: ['ready', 'in_progress', 'dev_deploy_queued', 'review', 'cancelled', 'failed'] },
    { name: 'review', label: 'Review', color: 'purple', terminal: 0, is_system: 1, allowed_transitions: ['ready_to_merge', 'ready', 'stalled', 'failed', 'cancelled'] },
    { name: 'ready_to_merge', label: 'Ready to Merge', color: 'cyan', terminal: 0, is_system: 1, allowed_transitions: ['deployed', 'ready', 'failed'] },
    { name: 'deployed', label: 'Deployed', color: 'green', terminal: 0, is_system: 1, allowed_transitions: ['done', 'ready', 'failed'] },
    { name: 'stalled', label: 'Stalled', color: 'orange', terminal: 0, is_system: 1, allowed_transitions: ['ready', 'cancelled'] },
    { name: 'needs_attention', label: 'Needs Attention', color: 'amber', terminal: 0, is_system: 1, allowed_transitions: ['todo', 'ready', 'in_progress', 'dev_deploy_queued', 'dev_deploying', 'review', 'ready_to_merge', 'deployed', 'done', 'cancelled', 'failed', 'stalled', 'blocked'] },
    { name: 'done', label: 'Done', color: 'green', terminal: 1, is_system: 1, allowed_transitions: ['todo'] },
    { name: 'cancelled', label: 'Cancelled', color: 'red', terminal: 1, is_system: 1, allowed_transitions: ['todo'] },
    { name: 'failed', label: 'Failed', color: 'red', terminal: 1, is_system: 1, allowed_transitions: ['todo', 'ready'] },
  ];

  const seedTx = db.transaction(() => {
    for (const status of statuses) {
      db.prepare(`
        INSERT INTO task_statuses (name, label, color, terminal, is_system, allowed_transitions)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          label = excluded.label,
          color = excluded.color,
          terminal = excluded.terminal,
          is_system = excluded.is_system,
          allowed_transitions = excluded.allowed_transitions
      `).run(
        status.name,
        status.label,
        status.color,
        status.terminal,
        status.is_system,
        JSON.stringify(status.allowed_transitions),
      );
    }

    db.prepare(`
      DELETE FROM task_statuses
      WHERE name = 'qa_pass'
    `).run();

    db.prepare(`
      UPDATE routing_transitions
      SET enabled = 0
      WHERE project_id IS NULL
    `).run();
  });

  seedTx();
  removeQaPassFromDevelopmentStatusMetadata(db);
  normalizeQaPassDevelopmentTransitions(db);

  try { db.exec(`ALTER TABLE routing_transitions ADD COLUMN task_type TEXT`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE routing_transitions ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
  try {
    db.exec(`ALTER TABLE routing_transitions ADD COLUMN is_protected INTEGER NOT NULL DEFAULT 0`);
  } catch { /* exists */ }
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_routing_transitions_type
        ON routing_transitions(task_type, from_status, outcome);
    `);
  } catch { /* exists */ }

  db.prepare(`
    UPDATE routing_transitions
    SET is_protected = 0
    WHERE COALESCE(is_protected, 0) != 0
  `).run();
  try {
    db.prepare(`
      UPDATE sprint_task_transitions
      SET is_protected = 0
      WHERE COALESCE(is_protected, 0) != 0
    `).run();
  } catch { /* table or column may not exist yet */ }
}

export function tableExists(db: Database.Database, tableName: string): boolean {
  try {
    const row = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(tableName) as { name?: string } | undefined;
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

export function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) return false;
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

export function tenantPredicate(db: Database.Database, tableName: string, alias: string, tenantId?: number | null): { sql: string; params: unknown[] } {
  if (tenantId == null || !tableHasColumn(db, tableName, 'tenant_id')) return { sql: '', params: [] };
  return { sql: ` AND ${alias}.tenant_id = ?`, params: [tenantId] };
}

export function sprintTypeTenantPredicate(db: Database.Database, tableName: string, tenantId?: number | null): { sql: string; params: unknown[] } {
  if (tenantId == null || !tableHasColumn(db, tableName, 'tenant_id')) return { sql: '', params: [] };
  return { sql: ` AND tenant_id = ?`, params: [tenantId] };
}

export function parseJsonArray(value: string | null | undefined): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (typeof value !== 'string' || value.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function buildCanonicalPolicyStatuses(sprintType: string | null | undefined): Array<{
  name: string;
  label: string;
  color: string;
  terminal: number;
  is_system: number;
  allowed_transitions: string;
  emoji: string | null;
}> {
  const visibleStatuses = visibleWorkflowStatusesForSprintType(sprintType);
  const allowedByStatus = new Map<string, Set<string>>();
  for (const row of policyTransitionsForSprintType(sprintType)) {
    if (!row.enabled) continue;
    if (!allowedByStatus.has(row.from_status)) allowedByStatus.set(row.from_status, new Set());
    allowedByStatus.get(row.from_status)!.add(row.to_status);
  }

  return visibleStatuses.map((status) => ({
    name: status,
    label: labelFromKey(status),
    color: colorForStatus(status),
    terminal: TERMINAL_TASK_STATUSES.includes(status as typeof TERMINAL_TASK_STATUSES[number]) ? 1 : 0,
    is_system: 1,
    allowed_transitions: JSON.stringify([...(allowedByStatus.get(status) ?? new Set<string>())]),
    emoji: canonicalTaskStatusEmoji(status),
  }));
}

export function visibleWorkflowStatusesForSprintType(sprintType: string | null | undefined): string[] {
  const type = starterSprintType(sprintType);
  if (type === 'generic') return [...GENERIC_WORKFLOW_STATUSES];
  if (type === 'ops') return [...OPS_WORKFLOW_STATUSES];
  if (type === 'lead_generation') return [...LEAD_GENERATION_WORKFLOW_STATUSES];
  return [...DEV_WORKFLOW_STATUSES];
}

export function labelFromKey(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase());
}

export function colorForStatus(status: string): string {
  if (status === 'done') return 'green';
  if (status === 'failed' || status === 'cancelled') return 'red';
  if (status === 'blocked' || status === 'stalled') return 'amber';
  if (status === 'review' || status === 'qa_pass') return 'blue';
  if (status === 'ready_to_merge') return 'fuchsia';
  if (status === 'deployed') return 'teal';
  if (status === 'dev_deploy_queued') return 'yellow';
  if (status === 'dev_deploying') return 'cyan';
  if (status === 'in_progress') return 'orange';
  if (status === 'ready') return 'cyan';
  return 'slate';
}

export function normalizeSprintType(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized.length > 0 ? normalized : null;
}

export function starterSprintType(value: string | null | undefined): StarterSprintType | null {
  const normalized = normalizeSprintType(value);
  return normalized === 'dev' || normalized === 'generic' || normalized === 'ops' || normalized === 'lead_generation' ? normalized : null;
}

export function isStarterPolicySprintType(value: string | null | undefined): boolean {
  return starterSprintType(value) != null;
}

export function genericWorkflowTransitions(): PolicyTransitionSeed[] {
  return [
    { task_type: null, from_status: 'in_progress', outcome: 'completed', to_status: 'done', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'in_progress', outcome: 'blocked', to_status: 'review', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'in_progress', outcome: 'env_blocked', to_status: 'review', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'in_progress', outcome: 'approval_blocked', to_status: 'review', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'in_progress', outcome: 'failed', to_status: 'review', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'in_progress', outcome: 'infra_failed', to_status: 'review', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'review', outcome: 'completed', to_status: 'done', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'review', outcome: 'blocked', to_status: 'ready', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'review', outcome: 'env_blocked', to_status: 'ready', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'review', outcome: 'approval_blocked', to_status: 'ready', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'review', outcome: 'failed', to_status: 'ready', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'review', outcome: 'infra_failed', to_status: 'ready', enabled: 1, priority: 0 },
  ];
}

export function opsWorkflowTransitions(): PolicyTransitionSeed[] {
  return [
    { task_type: null, from_status: 'action_plan', outcome: 'completed', to_status: 'stakeholder_update', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'stakeholder_update', outcome: 'completed', to_status: 'human_approval', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'human_approval', outcome: 'completed', to_status: 'done', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'action_plan', outcome: 'blocked', to_status: 'blocked', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'stakeholder_update', outcome: 'blocked', to_status: 'blocked', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'human_approval', outcome: 'approval_blocked', to_status: 'stalled', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'blocked', outcome: 'completed', to_status: 'triage', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'stalled', outcome: 'completed', to_status: 'human_approval', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'action_plan', outcome: 'failed', to_status: 'stalled', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'stakeholder_update', outcome: 'failed', to_status: 'stalled', enabled: 1, priority: 0 },
  ];
}

export function leadGenerationWorkflowTransitions(): PolicyTransitionSeed[] {
  return [
    { task_type: null, from_status: 'outreach_draft', outcome: 'completed', to_status: 'human_approval', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'human_approval', outcome: 'completed', to_status: 'sent', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'sent', outcome: 'completed', to_status: 'follow_up', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'follow_up', outcome: 'completed', to_status: 'done', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'research', outcome: 'blocked', to_status: 'qualification', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'outreach_draft', outcome: 'approval_blocked', to_status: 'human_approval', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'human_approval', outcome: 'approval_blocked', to_status: 'human_approval', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'research', outcome: 'failed', to_status: 'qualification', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'outreach_draft', outcome: 'failed', to_status: 'qualification', enabled: 1, priority: 0 },
  ];
}

export function devWorkflowTransitions(): PolicyTransitionSeed[] {
  const failureOutcomes: Array<[string, string]> = [
    ['failed', 'failed'],
    ['infra_failed', 'failed'],
  ];
  const blockedOutcomes: Array<[string, string]> = [
    ['blocked', 'blocked'],
    ['env_blocked', 'blocked'],
    ['approval_blocked', 'blocked'],
  ];
  const rows: PolicyTransitionSeed[] = [
    { task_type: null, from_status: 'in_progress', outcome: 'completed_for_review', to_status: 'review', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'in_progress', outcome: 'dev_deploy_queued', to_status: 'dev_deploy_queued', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'dev_deploy_queued', outcome: 'dev_deploy_queued', to_status: 'dev_deploy_queued', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'dev_deploy_queued', outcome: 'completed_for_review', to_status: 'review', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'dev_deploying', outcome: 'dev_deploy_queued', to_status: 'dev_deploying', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'dev_deploying', outcome: 'completed_for_review', to_status: 'review', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'review', outcome: 'qa_pass', to_status: 'ready_to_merge', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'review', outcome: 'qa_fail', to_status: 'ready', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'ready_to_merge', outcome: 'deployed_live', to_status: 'deployed', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'ready_to_merge', outcome: 'qa_fail', to_status: 'ready', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'ready_to_merge', outcome: 'release_failed', to_status: 'failed', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'deployed', outcome: 'live_verified', to_status: 'done', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'deployed', outcome: 'release_failed', to_status: 'failed', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'deployed', outcome: 'qa_fail', to_status: 'ready', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'stalled', outcome: 'retry', to_status: 'ready', enabled: 1, priority: 0 },
    { task_type: null, from_status: 'failed', outcome: 'retry', to_status: 'ready', enabled: 1, priority: 0 },
  ];

  for (const fromStatus of ['in_progress', 'dev_deploy_queued', 'dev_deploying', 'review', 'ready_to_merge'] as const) {
    for (const [outcome, toStatus] of blockedOutcomes) {
      rows.push({ task_type: null, from_status: fromStatus, outcome, to_status: toStatus, enabled: 1, priority: 0 });
    }
    for (const [outcome, toStatus] of failureOutcomes) {
      rows.push({ task_type: null, from_status: fromStatus, outcome, to_status: toStatus, enabled: 1, priority: 0 });
    }
  }
  for (const fromStatus of ['ready_to_merge', 'deployed'] as const) {
    for (const [outcome, toStatus] of failureOutcomes) {
      rows.push({ task_type: null, from_status: fromStatus, outcome, to_status: toStatus, enabled: 1, priority: 0 });
    }
  }
  return rows;
}

function removeQaPassFromDevelopmentStatusMetadata(db: Database.Database): void {
  try {
    if (tableExists(db, 'sprint_type_task_statuses')) {
      db.prepare(`
        DELETE FROM sprint_type_task_statuses
        WHERE sprint_type_key = 'dev'
          AND status_key = 'qa_pass'
      `).run();
      const rows = db.prepare(`
        SELECT id, allowed_transitions_json
        FROM sprint_type_task_statuses
        WHERE sprint_type_key = 'dev'
      `).all() as Array<{ id: number; allowed_transitions_json: string | null }>;
      const update = db.prepare(`
        UPDATE sprint_type_task_statuses
        SET allowed_transitions_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      for (const row of rows) {
        const next = parseJsonArray(row.allowed_transitions_json)
          .map(status => status === 'qa_pass' ? 'ready_to_merge' : status);
        update.run(JSON.stringify([...new Set(next)]), row.id);
      }
    }

    if (tableExists(db, 'sprint_task_statuses') && tableExists(db, 'sprints')) {
      db.prepare(`
        DELETE FROM sprint_task_statuses
        WHERE status_key = 'qa_pass'
          AND sprint_id IN (SELECT id FROM sprints WHERE sprint_type = 'dev')
      `).run();
      const rows = db.prepare(`
        SELECT sts.id, sts.allowed_transitions_json
        FROM sprint_task_statuses sts
        JOIN sprints s ON s.id = sts.sprint_id
        WHERE s.sprint_type = 'dev'
      `).all() as Array<{ id: number; allowed_transitions_json: string | null }>;
      const update = db.prepare(`
        UPDATE sprint_task_statuses
        SET allowed_transitions_json = ?, updated_at = datetime('now')
        WHERE id = ?
      `);
      for (const row of rows) {
        const next = parseJsonArray(row.allowed_transitions_json)
          .map(status => status === 'qa_pass' ? 'ready_to_merge' : status)
          .filter(status => status !== 'qa_pass');
        update.run(JSON.stringify([...new Set(next)]), row.id);
      }
    }
  } catch {
    // Metadata cleanup is best-effort during startup across historical schemas.
  }
}

function normalizeQaPassDevelopmentTransitions(db: Database.Database): void {
  try {
    if (tableExists(db, 'routing_config')) {
      db.prepare(`
        UPDATE routing_config
        SET to_status = 'ready_to_merge'
        WHERE from_status = 'review'
          AND outcome = 'qa_pass'
          AND to_status = 'qa_pass'
      `).run();
      db.prepare(`
        UPDATE routing_config
        SET enabled = 0
        WHERE from_status = 'qa_pass'
      `).run();
    }
    if (tableExists(db, 'lifecycle_rules')) {
      db.prepare(`
        UPDATE lifecycle_rules
        SET to_status = 'ready_to_merge'
        WHERE from_status = 'review'
          AND outcome = 'qa_pass'
          AND to_status = 'qa_pass'
      `).run();
      db.prepare(`
        UPDATE lifecycle_rules
        SET enabled = 0
        WHERE from_status = 'qa_pass'
      `).run();
    }
    if (tableExists(db, 'sprint_task_transitions')) {
      const hasSprintType = tableHasColumn(db, 'sprint_task_transitions', 'sprint_type');
      const hasSprintId = tableHasColumn(db, 'sprint_task_transitions', 'sprint_id');
      const scopeSql = hasSprintType
        ? `sprint_type = 'dev'`
        : hasSprintId && tableExists(db, 'sprints')
          ? `sprint_id IN (SELECT id FROM sprints WHERE sprint_type = 'dev')`
          : `0`;
      db.prepare(`
        UPDATE sprint_task_transitions
        SET to_status = 'ready_to_merge', updated_at = datetime('now')
        WHERE from_status = 'review'
          AND outcome = 'qa_pass'
          AND to_status = 'qa_pass'
          AND (${scopeSql})
      `).run();
      db.prepare(`
        UPDATE sprint_task_transitions
        SET enabled = 0, updated_at = datetime('now')
        WHERE from_status = 'qa_pass'
          AND (${scopeSql})
      `).run();
    }
  } catch {
    // Transition cleanup is best-effort during startup across historical schemas.
  }
}

export function policyTransitionsForSprintType(sprintType: string | null | undefined): PolicyTransitionSeed[] {
  const type = starterSprintType(sprintType);
  if (type === 'dev') return devWorkflowTransitions();
  if (type === 'generic') return genericWorkflowTransitions();
  if (type === 'ops') return opsWorkflowTransitions();
  if (type === 'lead_generation') return leadGenerationWorkflowTransitions();
  return [];
}

export function devWorkflowRequirements(): PolicyRequirementSeed[] {
  const rows: PolicyRequirementSeed[] = [
    { task_type: null, outcome: 'completed_for_review', field_name: 'review_branch', requirement_type: 'required', match_field: null, severity: 'block', message: 'completed_for_review requires review_branch', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'completed_for_review', field_name: 'review_commit', requirement_type: 'required', match_field: null, severity: 'block', message: 'completed_for_review requires review_commit', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'qa_pass', field_name: 'status', requirement_type: 'from_status', match_field: 'review', severity: 'block', message: 'qa_pass requires task status review', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'qa_pass', field_name: 'qa_verified_commit', requirement_type: 'required', match_field: null, severity: 'block', message: 'qa_pass requires qa_verified_commit', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'qa_pass', field_name: 'review_commit', requirement_type: 'required', match_field: null, severity: 'block', message: 'qa_pass requires review_commit', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'qa_pass', field_name: 'qa_verified_commit', requirement_type: 'match', match_field: 'review_commit', severity: 'block', message: 'qa_pass requires qa_verified_commit to match review_commit', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'deployed_live', field_name: 'status', requirement_type: 'from_status', match_field: 'ready_to_merge', severity: 'block', message: 'deployed_live requires task status ready_to_merge', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'deployed_live', field_name: 'merged_commit|deployed_commit', requirement_type: 'required', match_field: null, severity: 'block', message: 'deployed_live requires merged_commit or deployed_commit', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'deployed_live', field_name: 'deploy_target', requirement_type: 'required', match_field: null, severity: 'block', message: 'deployed_live requires deploy_target', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'deployed_live', field_name: 'deployed_at', requirement_type: 'required', match_field: null, severity: 'block', message: 'deployed_live requires deployed_at', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'live_verified', field_name: 'status', requirement_type: 'from_status', match_field: 'deployed', severity: 'block', message: 'live_verified requires task status deployed', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'live_verified', field_name: 'deployed_commit', requirement_type: 'required', match_field: null, severity: 'block', message: 'live_verified requires deployed_commit', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'live_verified', field_name: 'live_verified_by', requirement_type: 'required', match_field: null, severity: 'block', message: 'live_verified requires live_verified_by', enabled: 1, priority: 0 },
    { task_type: null, outcome: 'live_verified', field_name: 'live_verified_at', requirement_type: 'required', match_field: null, severity: 'block', message: 'live_verified requires live_verified_at', enabled: 1, priority: 0 },
  ];
  return rows;
}

export function policyRequirementsForSprintType(sprintType: string | null | undefined): PolicyRequirementSeed[] {
  return starterSprintType(sprintType) === 'dev' ? devWorkflowRequirements() : [];
}

export function getSprintSeedRow(db: Database.Database, sprintId: number): SprintSeedRow | null {
  try {
    const selectSeededAt = tableHasColumn(db, 'sprints', 'task_policy_seeded_at') ? ', task_policy_seeded_at' : '';
    const selectTenantId = tableHasColumn(db, 'sprints', 'tenant_id') ? ', tenant_id' : '';
    return db.prepare(`
      SELECT id, project_id, sprint_type${selectTenantId}${selectSeededAt}
      FROM sprints
      WHERE id = ?
      LIMIT 1
    `).get(sprintId) as SprintSeedRow | undefined ?? null;
  } catch {
    return null;
  }
}

export function isSprintTaskPolicySeeded(db: Database.Database, sprintId: number): boolean {
  if (!tableHasColumn(db, 'sprints', 'task_policy_seeded_at')) return false;
  const sprint = getSprintSeedRow(db, sprintId);
  return Boolean(sprint?.task_policy_seeded_at);
}

export function markSprintTaskPolicySeeded(db: Database.Database, sprintId: number): void {
  if (!tableHasColumn(db, 'sprints', 'task_policy_seeded_at')) return;
  db.prepare(`
    UPDATE sprints
    SET task_policy_seeded_at = COALESCE(task_policy_seeded_at, datetime('now'))
    WHERE id = ?
  `).run(sprintId);
}

export function isSprintTypeStatusSeeded(db: Database.Database, sprintType: string, tenantId?: number | null): boolean {
  if (!tableHasColumn(db, 'sprint_types', 'status_seeded_at')) return false;
  const tenant = sprintTypeTenantPredicate(db, 'sprint_types', tenantId);
  const row = db.prepare(`
    SELECT status_seeded_at
    FROM sprint_types
    WHERE key = ?
      ${tenant.sql}
    LIMIT 1
  `).get(sprintType, ...tenant.params) as { status_seeded_at?: string | null } | undefined;
  return Boolean(row?.status_seeded_at);
}

export function markSprintTypeStatusSeeded(db: Database.Database, sprintType: string, tenantId?: number | null): void {
  if (!tableHasColumn(db, 'sprint_types', 'status_seeded_at')) return;
  const tenant = sprintTypeTenantPredicate(db, 'sprint_types', tenantId);
  db.prepare(`
    UPDATE sprint_types
    SET status_seeded_at = COALESCE(status_seeded_at, datetime('now'))
    WHERE key = ?
      ${tenant.sql}
  `).run(sprintType, ...tenant.params);
}
