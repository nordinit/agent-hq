/**
 * Publish a page's worth of staged context edits as one change.
 *
 * Every change names the hash of the source it was staged against. All sources are locked and
 * compared first; if any changed since it was read, nothing is written and the caller gets the
 * list of conflicts. Otherwise every edit is applied, and each agent whose execution profile
 * covers an edited field (job instructions, skill assignments) gets a new runtime revision that
 * is published and bound in the same transaction, so the next run is allowed to launch with it.
 */

import { z } from 'zod';
import type { Db } from '../../db/adapter/types';
import { isSafeSkillName } from '../../lib/skillNames';
import { TOOL_ALLOWLIST_FIELDS, assignmentToolNames } from '../../services/runtimeBoundaryAssignments';
import { bindExecutable, createExecutableDraft, publishExecutable } from '../execution/authority';
import { contextSourceHash, parseOverrides } from './workspace';

const id = z.number().int().positive();
const hash = z.string().regex(/^[a-f0-9]{64}$/);

const contextChange = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('job_instructions'), agent_id: id, base_hash: hash, value: z.string().max(200_000) }).strict(),
  z.object({
    kind: z.literal('agent_skills'),
    agent_id: id,
    base_hash: hash,
    value: z.array(z.string().min(1).max(200)).max(100),
  }).strict(),
  z.object({
    kind: z.literal('mcp_allowlist'),
    agent_id: id,
    mcp_server_id: id,
    base_hash: hash,
    value: z.array(z.string().min(1).max(256)).max(1000),
  }).strict(),
  z.object({ kind: z.literal('workflow_goal'), workflow_id: id, base_hash: hash, value: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('project_context'), project_id: id, base_hash: hash, value: z.string().max(200_000) }).strict(),
  z.object({ kind: z.literal('task_description'), task_id: id, base_hash: hash, value: z.string().max(100_000) }).strict(),
  z.object({ kind: z.literal('series_template'), series_id: id, base_hash: hash, value: z.string().max(100_000) }).strict(),
]);

export const contextPublishRequest = z.object({
  changes: z.array(contextChange).min(1).max(50),
}).strict();

export type ContextChange = z.infer<typeof contextChange>;

export class ContextPublishError extends Error {
  constructor(public status: number, public code: string, message: string, public detail?: unknown) {
    super(message);
  }
}

function target(change: ContextChange): string {
  switch (change.kind) {
    case 'job_instructions':
    case 'agent_skills':
      return `${change.kind}:agent:${change.agent_id}`;
    case 'mcp_allowlist':
      return `${change.kind}:agent:${change.agent_id}:server:${change.mcp_server_id}`;
    case 'workflow_goal':
      return `${change.kind}:workflow:${change.workflow_id}`;
    case 'project_context':
      return `${change.kind}:project:${change.project_id}`;
    case 'task_description':
      return `${change.kind}:task:${change.task_id}`;
    case 'series_template':
      return `${change.kind}:series:${change.series_id}`;
  }
}

function parseList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Overrides with a new tool allowlist, written to the field launch reads (the first allowlist
 * field present, else `toolFilter.include`, else `tool_allowlist`). An empty list removes every
 * allowlist field, which is how an unrestricted assignment is stored.
 */
export function withToolAllowlist(overrides: Record<string, unknown>, tools: readonly string[]): Record<string, unknown> {
  const next: Record<string, unknown> = { ...overrides };
  const cleaned = [...new Set(tools.map((tool) => tool.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const filter = next.toolFilter && typeof next.toolFilter === 'object' && !Array.isArray(next.toolFilter)
    ? { ...(next.toolFilter as Record<string, unknown>) }
    : null;
  if (cleaned.length === 0) {
    for (const field of TOOL_ALLOWLIST_FIELDS) delete next[field];
    if (filter && 'include' in filter) {
      delete filter.include;
      next.toolFilter = filter;
    }
    return next;
  }
  const field = TOOL_ALLOWLIST_FIELDS.find((name) => Object.prototype.hasOwnProperty.call(next, name));
  if (field) next[field] = cleaned;
  else if (filter && 'include' in filter) next.toolFilter = { ...filter, include: cleaned };
  else next.tool_allowlist = cleaned;
  return next;
}

const NOW_TEXT = `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`;

/** Lock the source a change edits and return its current value, as the read model hashed it. */
async function lockCurrent(tx: Db, tenantId: number, change: ContextChange): Promise<unknown> {
  const missing = (what: string) => new ContextPublishError(404, 'context_source_not_found', `${what} not found`, { target: target(change) });
  switch (change.kind) {
    case 'job_instructions': {
      const row = await tx.get<Record<string, any>>(
        'SELECT job_instructions FROM agents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL FOR UPDATE',
        change.agent_id, tenantId,
      );
      if (!row) throw missing('Agent');
      return row.job_instructions ?? '';
    }
    case 'agent_skills': {
      const row = await tx.get<Record<string, any>>(
        'SELECT skill_names FROM agents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL FOR UPDATE',
        change.agent_id, tenantId,
      );
      if (!row) throw missing('Agent');
      return parseList(row.skill_names).filter((name) => typeof name === 'string');
    }
    case 'mcp_allowlist': {
      const row = await tx.get<Record<string, any>>(
        `SELECT ama.overrides FROM agent_mcp_assignments ama
         JOIN agents a ON a.id = ama.agent_id AND a.tenant_id = ?
         WHERE ama.agent_id = ? AND ama.mcp_server_id = ? FOR UPDATE OF ama`,
        tenantId, change.agent_id, change.mcp_server_id,
      );
      if (!row) throw missing("The agent's own assignment of this MCP server");
      return assignmentToolNames(parseOverrides(row.overrides)) ?? [];
    }
    case 'workflow_goal': {
      const row = await tx.get<Record<string, any>>('SELECT goal FROM workflows WHERE id = ? AND tenant_id = ? FOR UPDATE', change.workflow_id, tenantId);
      if (!row) throw missing('Workflow');
      return row.goal ?? '';
    }
    case 'project_context': {
      const row = await tx.get<Record<string, any>>('SELECT context_md FROM projects WHERE id = ? AND tenant_id = ? FOR UPDATE', change.project_id, tenantId);
      if (!row) throw missing('Project');
      return row.context_md ?? '';
    }
    case 'task_description': {
      const row = await tx.get<Record<string, any>>('SELECT description FROM tasks WHERE id = ? AND tenant_id = ? FOR UPDATE', change.task_id, tenantId);
      if (!row) throw missing('Task');
      return row.description ?? '';
    }
    case 'series_template': {
      const row = await tx.get<Record<string, any>>(
        'SELECT description_template FROM recurring_task_series WHERE id = ? AND tenant_id = ? FOR UPDATE',
        change.series_id, tenantId,
      );
      if (!row) throw missing('Recurring series');
      return row.description_template ?? '';
    }
  }
}

async function apply(tx: Db, tenantId: number, change: ContextChange, actor: string): Promise<void> {
  switch (change.kind) {
    case 'job_instructions':
      await tx.run(
        `UPDATE agents SET job_instructions = ?, job_instructions_updated_at = ${NOW_TEXT},
                instructions_version = COALESCE(instructions_version, 0) + 1
         WHERE id = ? AND tenant_id = ?`,
        change.value, change.agent_id, tenantId,
      );
      return;
    case 'agent_skills': {
      const names = [...new Set(change.value)];
      const unsafe = names.filter((name) => !isSafeSkillName(name));
      if (unsafe.length) throw new ContextPublishError(400, 'invalid_skill_name', `Invalid skill name: ${unsafe.join(', ')}`);
      const known = await tx.all<{ name: string }>('SELECT name FROM skills WHERE tenant_id = ? AND name = ANY(?::text[])', tenantId, names);
      const unknown = names.filter((name) => !known.some((row) => row.name === name));
      if (unknown.length) throw new ContextPublishError(400, 'unknown_skill', `Unknown skill: ${unknown.join(', ')}`);
      await tx.run('UPDATE agents SET skill_names = ? WHERE id = ? AND tenant_id = ?',
        JSON.stringify(names.sort((a, b) => a.localeCompare(b))), change.agent_id, tenantId);
      return;
    }
    case 'mcp_allowlist': {
      const row = await tx.get<Record<string, any>>(
        'SELECT overrides FROM agent_mcp_assignments WHERE agent_id = ? AND mcp_server_id = ?',
        change.agent_id, change.mcp_server_id,
      );
      await tx.run('UPDATE agent_mcp_assignments SET overrides = ? WHERE agent_id = ? AND mcp_server_id = ?',
        JSON.stringify(withToolAllowlist(parseOverrides(row?.overrides), change.value)), change.agent_id, change.mcp_server_id);
      return;
    }
    case 'workflow_goal':
      await tx.run('UPDATE workflows SET goal = ? WHERE id = ? AND tenant_id = ?', change.value, change.workflow_id, tenantId);
      return;
    case 'project_context':
      await tx.run('UPDATE projects SET context_md = ? WHERE id = ? AND tenant_id = ?', change.value, change.project_id, tenantId);
      return;
    case 'task_description':
      await tx.run(`UPDATE tasks SET description = ?, updated_at = ${NOW_TEXT} WHERE id = ? AND tenant_id = ?`,
        change.value, change.task_id, tenantId);
      return;
    case 'series_template':
      await tx.run(
        `UPDATE recurring_task_series SET description_template = ?, updated_by = ?, updated_at = ${NOW_TEXT}
         WHERE id = ? AND tenant_id = ?`,
        change.value, actor, change.series_id, tenantId,
      );
  }
}

export interface ContextPublishResult {
  applied: Array<{ kind: ContextChange['kind']; target: string; hash: string }>;
  republished: Array<{ agentId: number; revisionId: string; digest: string }>;
}

export async function publishContextChanges(
  db: Db,
  tenantId: number,
  changes: ContextChange[],
  actor: string,
): Promise<ContextPublishResult> {
  const seen = new Set<string>();
  for (const change of changes) {
    const key = target(change);
    if (seen.has(key)) throw new ContextPublishError(400, 'duplicate_change', `More than one change edits ${key}`);
    seen.add(key);
  }

  return db.withTransaction(async (tx) => {
    const conflicts: Array<{ target: string; kind: string; currentHash: string }> = [];
    for (const change of changes) {
      const current = await lockCurrent(tx, tenantId, change);
      const currentHash = contextSourceHash(current);
      if (currentHash !== change.base_hash) conflicts.push({ target: target(change), kind: change.kind, currentHash });
    }
    if (conflicts.length > 0) {
      throw new ContextPublishError(409, 'context_conflict', 'Some sources changed since this page loaded. Reload them and publish again.', { conflicts });
    }

    const applied: ContextPublishResult['applied'] = [];
    for (const change of changes) {
      await apply(tx, tenantId, change, actor);
      applied.push({ kind: change.kind, target: target(change), hash: contextSourceHash(await lockCurrent(tx, tenantId, change)) });
    }

    // Job instructions and skill assignments are part of an agent's approved execution profile:
    // without a new published, bound revision the agent's next launch would be refused.
    const agentIds = [...new Set(changes
      .filter((change) => change.kind === 'job_instructions' || change.kind === 'agent_skills')
      .map((change) => (change as { agent_id: number }).agent_id))];
    const republished: ContextPublishResult['republished'] = [];
    for (const agentId of agentIds) {
      const draft = await createExecutableDraft(tx, tenantId, 'agent_runtime', agentId, actor);
      if (!draft) throw new ContextPublishError(500, 'revision_failed', `Could not create a runtime revision for agent ${agentId}`);
      const revisionId = String(draft.id);
      const digest = String(draft.digest);
      if (!draft.published_at) await publishExecutable(tx, tenantId, revisionId, digest, actor);
      await bindExecutable(tx, tenantId, 'agent', agentId, revisionId, actor);
      republished.push({ agentId, revisionId, digest });
    }
    return { applied, republished };
  });
}
