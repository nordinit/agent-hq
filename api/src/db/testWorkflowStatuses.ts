import type { Db } from './adapter/types';
import { buildCanonicalPolicyStatuses } from '../domains/routing/policy/metadata';
import { DEFAULT_TERMINAL_TASK_STATUS_SEEDS } from '../lib/taskStatuses';

/**
 * Test-only: the release/dev statuses older fixtures used on any workflow, back when a global list was
 * implicitly allowed everywhere. Tests that exercise those statuses now configure them explicitly with
 * `configureTestWorkflowStatuses(db, id, { extra: RELEASE_STATUSES_FOR_TESTS })`.
 */
export const RELEASE_STATUSES_FOR_TESTS = [
  'todo', 'ready', 'in_progress', 'dev_deploy_queued', 'dev_deploying', 'review', 'qa_pass', 'ready_to_merge',
  'deployed', 'done', 'needs_attention', 'cancelled', 'stalled', 'failed', 'blocked',
];

/**
 * Test helper: configure the task statuses a workflow uses, which are its workflow type's.
 *
 * Task statuses are configuration only and live only on the workflow type; there is no global
 * fallback list. A test that inserts a workflow row directly (bypassing the product's workflow
 * creation, which seeds the type's statuses in domains/routing/policy/seed.ts) must therefore
 * configure the statuses it uses. They are written to the workflow's type for its tenant, so
 * every workflow of that type in the test sees them.
 *
 * By default this writes the workflow type's starter template. `extra` appends further statuses
 * (non-terminal unless listed in DEFAULT_TERMINAL_TASK_STATUS_SEEDS or `terminal`); `only` replaces
 * the template entirely.
 */
export async function configureTestWorkflowStatuses(
  db: Db,
  workflowId: number,
  options: { workflowType?: string | null; extra?: string[]; only?: string[]; terminal?: string[] } = {},
): Promise<void> {
  const terminalNames = new Set<string>([...(options.terminal ?? []), ...DEFAULT_TERMINAL_TASK_STATUS_SEEDS]);
  const row = await db.get('SELECT workflow_type, tenant_id FROM workflows WHERE id = ?', workflowId) as { workflow_type: string | null; tenant_id: number | null } | undefined;
  const workflowType = (options.workflowType === undefined ? row?.workflow_type : options.workflowType) ?? 'generic';
  const tenantId = row?.tenant_id ?? 1;
  const template = options.only
    ? []
    : buildCanonicalPolicyStatuses(workflowType).map((status) => ({
      name: status.name, label: status.label, color: status.color, terminal: status.terminal ? 1 : 0,
      allowed: status.allowed_transitions || '[]', emoji: status.emoji,
    }));
  const names = new Set(template.map((status) => status.name));
  for (const name of [...(options.only ?? []), ...(options.extra ?? [])]) {
    if (names.has(name)) continue;
    names.add(name);
    template.push({ name, label: name, color: 'slate', terminal: terminalNames.has(name) ? 1 : 0, allowed: '[]', emoji: null });
  }
  const existingRows = await db.all(
    'SELECT status_key, stage_order FROM workflow_type_task_statuses WHERE tenant_id = ? AND workflow_type_key = ?',
    tenantId, workflowType,
  ) as Array<{ status_key: string; stage_order: number | string }>;
  const existing = new Set(existingRows.map((status) => status.status_key));
  let nextOrder = existingRows.reduce((max, status) => Math.max(max, Number(status.stage_order) + 1), 0);
  for (const status of template) {
    if (existing.has(status.name)) continue;
    const order = nextOrder++;
    await db.run(
      `INSERT INTO workflow_type_task_statuses
         (tenant_id, workflow_type_key, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
       ON CONFLICT DO NOTHING`,
      tenantId, workflowType, status.name, status.label, status.color, status.terminal, status.allowed, order, order === 0 ? 1 : 0,
      status.emoji ? JSON.stringify({ emoji: status.emoji }) : '{}',
    );
  }
}
