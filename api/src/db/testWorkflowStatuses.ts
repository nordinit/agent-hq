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
 * Test helper: configure a workflow's task statuses explicitly.
 *
 * Task statuses are configuration only; there is no global fallback list. A test that inserts a
 * workflow row directly (bypassing the product's workflow creation, which seeds statuses in
 * domains/routing/policy/seed.ts) must therefore configure the statuses it uses.
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
  const row = options.workflowType === undefined
    ? await db.get('SELECT workflow_type FROM workflows WHERE id = ?', workflowId) as { workflow_type: string | null } | undefined
    : { workflow_type: options.workflowType };
  const template = options.only
    ? []
    : buildCanonicalPolicyStatuses(row?.workflow_type ?? null).map((status) => ({
      name: status.name, label: status.label, color: status.color, terminal: status.terminal ? 1 : 0,
      allowed: status.allowed_transitions || '[]', emoji: status.emoji,
    }));
  const names = new Set(template.map((status) => status.name));
  for (const name of [...(options.only ?? []), ...(options.extra ?? [])]) {
    if (names.has(name)) continue;
    names.add(name);
    template.push({ name, label: name, color: 'slate', terminal: terminalNames.has(name) ? 1 : 0, allowed: '[]', emoji: null });
  }
  const existing = new Set(((await db.all('SELECT status_key FROM workflow_task_statuses WHERE workflow_id = ?', workflowId)) as Array<{ status_key: string }>)
    .map((status) => status.status_key));
  for (const [index, status] of template.entries()) {
    if (existing.has(status.name)) continue;
    await db.run(
      `INSERT INTO workflow_task_statuses
         (workflow_id, status_key, label, color, terminal, is_system, allowed_transitions_json, stage_order, is_default_entry, metadata_json)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      workflowId, status.name, status.label, status.color, status.terminal, status.allowed, index, index === 0 ? 1 : 0,
      status.emoji ? JSON.stringify({ emoji: status.emoji }) : '{}',
    );
  }
}
