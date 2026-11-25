import type { Db } from '../../db/adapter/types';
import { grantAgentMcpCapabilities } from '../../lib/mcpApiAuth';
import {
  ExecutionDenied,
  bindExecutable,
  createExecutableDraft,
  executableDigest,
  findBoundRevision,
  publishExecutable,
  resourceSnapshot,
  stable,
} from './authority';
import { clearAgentLaunchHolds, listAgentLaunchHolds } from './launchHolds';
import { reviewSnapshot } from './review';

type ProfileKind = 'agent_runtime' | 'workflow_setup';
type Row = Record<string, any>;

/** One difference between the approved setup and the current one. Secrets show only that they changed. */
export interface ProfileChange {
  path: string;
  label: string;
  change: 'added' | 'removed' | 'changed';
  before: string | null;
  after: string | null;
  note?: string;
}

export interface PendingProfile {
  resource_kind: ProfileKind;
  resource_id: number;
  resource_name: string;
  state: 'not_approved' | 'changed_since_approval';
  /** The setup Approve approves. Approving fails if the setup changes again before then. */
  digest: string | null;
  approved_revision_id: string | null;
  changes: ProfileChange[];
  /** Set when the current setup cannot be approved, for example a missing dependency file. */
  error: string | null;
}

export interface PendingAgent {
  agent: { id: number; name: string; project_id: number | null; runtime_type: string | null };
  host_execute: boolean;
  /** An enabled routing rule sends tasks to this agent. */
  routed: boolean;
  holds: Array<{ task_id: number; task_title: string; reason_code: string; reason: string; last_refused_at: string }>;
  profiles: PendingProfile[];
}

const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  role: 'Role',
  model: 'Model',
  preferred_provider: 'Model provider',
  runtime_type: 'Runtime',
  runtime_config: 'Runtime settings',
  workspace_path: 'Workspace path',
  hooks_url: 'Webhook URL',
  hooks_auth_header: 'Webhook auth header',
  os_user: 'OS user',
  github_identity_id: 'GitHub identity',
  provider_connection_id: 'Provider connection',
  job_instructions: 'Job instructions',
  skill_names: 'Skills',
  repo_path: 'Repository path',
  repo_url: 'Repository URL',
  repo_access_mode: 'Repository access',
  environment_setup: 'Environment setup',
};

const PROFILE_FIELDS: Record<ProfileKind, string[]> = {
  agent_runtime: ['name', 'role', 'model', 'preferred_provider', 'runtime_type', 'runtime_config', 'workspace_path', 'hooks_url', 'hooks_auth_header', 'os_user', 'github_identity_id', 'provider_connection_id', 'job_instructions', 'skill_names'],
  workflow_setup: ['repo_path', 'repo_url', 'repo_access_mode', 'environment_setup'],
};

const SHOWN_CHARS = 6000;

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
}

function shown(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > SHOWN_CHARS ? `${text.slice(0, SHOWN_CHARS)}…` : text;
}

function compare(changes: ProfileChange[], path: string, label: string, before: unknown, after: unknown, note?: string): void {
  const empty = (value: unknown) => value === null || value === undefined || value === '';
  if (stable(before ?? null) === stable(after ?? null)) return;
  const change = empty(before) ? 'added' : empty(after) ? 'removed' : 'changed';
  changes.push({ path, label, change, before: note ? null : shown(before), after: note ? null : shown(after), ...(note ? { note } : {}) });
}

function byKey<T extends Row>(rows: unknown, key: (row: T) => string): Map<string, T> {
  return new Map((Array.isArray(rows) ? rows as T[] : []).map((row) => [key(row), row]));
}

function compareSets<T extends Row>(
  changes: ProfileChange[],
  before: unknown,
  after: unknown,
  key: (row: T) => string,
  describe: (row: T, key: string) => { path: string; label: string; value: unknown; note?: string },
): void {
  const b = byKey<T>(before, key), a = byKey<T>(after, key);
  for (const k of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const from = b.get(k), to = a.get(k);
    const d = describe((to ?? from)!, k);
    compare(changes, d.path, d.label, from ? describe(from, k).value : null, to ? describe(to, k).value : null, d.note);
  }
}

/** What differs between an approved snapshot and the current one, in reviewable terms. */
export function profileChanges(kind: ProfileKind, approved: Row | null, current: Row): ProfileChange[] {
  const before = approved ?? {};
  const changes: ProfileChange[] = [];
  const b = reviewSnapshot(before) as Row, a = reviewSnapshot(current) as Row;
  for (const field of PROFILE_FIELDS[kind]) {
    const secret = field === 'hooks_auth_header';
    compare(changes, field, FIELD_LABELS[field] ?? field, secret ? before[field] : b[field], secret ? current[field] : a[field],
      secret ? 'The value is secret; only the change is shown.' : undefined);
  }
  if (kind === 'agent_runtime') {
    const bc = (before.referenced_content ?? {}) as Row, ac = (current.referenced_content ?? {}) as Row;
    compareSets<Row>(changes, bc.teams, ac.teams, (row) => String(row.id), (row) => ({
      path: `teams.${row.id}`, label: `Team "${row.name}"`,
      value: { goal: row.goal, charter: row.charter, skill_names: decode(row.skill_names), context_version: row.context_version },
    }));
    compareSets<Row>(changes, bc.skills, ac.skills, (row) => String(row.name), (row) => ({
      path: `skills.${row.name}`, label: `Skill "${row.name}"`, value: row.content,
    }));
    compareSets<Row>(changes, bc.skill_files, ac.skill_files, (row) => `${row.name}/${row.path}`, (row, k) => ({
      path: `skill_files.${k}`, label: `Skill file ${k}`, value: row.content,
    }));
    compareSets<Row>(changes, bc.credential_references, ac.credential_references, (row) => `${row.kind}:${row.id}`, (row) => ({
      path: `credentials.${row.kind}.${row.id}`,
      label: row.kind === 'github_identities' ? `GitHub identity #${row.id}` : `Provider connection #${row.id}`,
      value: row.version,
      note: 'Its saved record changed, for example when it was validated again. Credentials are never shown.',
    }));
  }
  compareSets<Row>(changes, before.dependency_pins, current.dependency_pins, (row) => String(row.path), (row) => ({
    path: `files.${row.path}`, label: `File ${row.path}`, value: row.sha256,
    note: 'A file this setup runs from or locks its dependencies with. Only its fingerprint is compared.',
  }));
  return changes;
}

async function pendingProfile(db: Db, tenantId: number, agentId: number, kind: ProfileKind, resourceId: number, name: string): Promise<PendingProfile | null> {
  const bound = await findBoundRevision(db, tenantId, agentId, kind, resourceId);
  let current: Row;
  try {
    current = await resourceSnapshot(db, tenantId, kind, resourceId);
  } catch (error) {
    return {
      resource_kind: kind, resource_id: resourceId, resource_name: name,
      state: bound ? 'changed_since_approval' : 'not_approved', digest: null,
      approved_revision_id: bound?.id == null ? null : String(bound.id), changes: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const digest = executableDigest(current);
  if (bound && bound.digest === digest) return null;
  return {
    resource_kind: kind,
    resource_id: resourceId,
    resource_name: name,
    state: bound ? 'changed_since_approval' : 'not_approved',
    digest,
    approved_revision_id: bound?.id == null ? null : String(bound.id),
    changes: profileChanges(kind, bound ? decode(bound.snapshot) as Row : null, current),
    error: null,
  };
}

/**
 * Agents that cannot start, or whose setup changed since it was approved, with what changed.
 * An agent is listed when a task could not start on it, when its approved setup changed, or when
 * tasks are routed to it but it may not run yet.
 */
export async function listPendingApprovals(db: Db, tenantId: number, options: { agentId?: number } = {}): Promise<PendingAgent[]> {
  const agents = await db.all<{ id: number; name: string; project_id: number | null; runtime_type: string | null; host_execute: number | boolean }>(`
    SELECT a.id, a.name, a.project_id, a.runtime_type,
      EXISTS(SELECT 1 FROM agent_mcp_capability_policies p WHERE p.agent_id = a.id AND p.capability_key = 'host.execute' AND p.enabled = 1) AS host_execute
    FROM agents a
    LEFT JOIN projects p ON p.id = a.project_id
    WHERE a.tenant_id = ? AND a.enabled = 1 AND a.deleted_at IS NULL AND p.archived_at IS NULL
      AND (?::bigint IS NULL OR a.id = ?)
    ORDER BY lower(a.name), a.id
  `, tenantId, options.agentId ?? null, options.agentId ?? null);
  if (agents.length === 0) return [];

  // The workflows each agent is routed to: a rule names its workflow, or covers every workflow of
  // its type in its project.
  const routes = await db.all<{ agent_id: number; workflow_id: number; workflow_name: string }>(`
    SELECT DISTINCT r.agent_id, w.id AS workflow_id, w.name AS workflow_name
    FROM workflow_task_routing_rules r
    JOIN workflows w ON w.tenant_id = r.tenant_id
      AND (w.id = r.workflow_id OR (r.workflow_id IS NULL AND w.project_id = r.project_id AND w.workflow_type = r.workflow_type))
    LEFT JOIN projects p ON p.id = w.project_id
    WHERE r.tenant_id = ? AND r.enabled = 1 AND r.agent_id = ANY(?::bigint[]) AND p.archived_at IS NULL
    ORDER BY w.id
  `, tenantId, agents.map((agent) => agent.id));
  const workflowsByAgent = new Map<number, Array<{ id: number; name: string }>>();
  for (const route of routes) {
    const list = workflowsByAgent.get(Number(route.agent_id)) ?? [];
    list.push({ id: Number(route.workflow_id), name: String(route.workflow_name) });
    workflowsByAgent.set(Number(route.agent_id), list);
  }
  const holds = await listAgentLaunchHolds(db, tenantId, options.agentId);

  const result: PendingAgent[] = [];
  for (const agent of agents) {
    const id = Number(agent.id);
    const profiles: PendingProfile[] = [];
    const runtime = await pendingProfile(db, tenantId, id, 'agent_runtime', id, `${agent.name}'s setup`);
    if (runtime) profiles.push(runtime);
    for (const workflow of workflowsByAgent.get(id) ?? []) {
      const setup = await pendingProfile(db, tenantId, id, 'workflow_setup', workflow.id, `Workflow "${workflow.name}" setup`);
      if (setup) profiles.push(setup);
    }
    const agentHolds = holds.filter((hold) => hold.agent_id === id).map((hold) => ({
      task_id: hold.task_id, task_title: hold.task_title, reason_code: hold.reason_code, reason: hold.reason, last_refused_at: hold.last_refused_at,
    }));
    const hostExecute = agent.host_execute === true || Number(agent.host_execute) === 1;
    const routed = (workflowsByAgent.get(id) ?? []).length > 0;
    const changed = profiles.some((profile) => profile.state === 'changed_since_approval');
    if (agentHolds.length === 0 && !changed && !(routed && (!hostExecute || profiles.length > 0)) && options.agentId == null) continue;
    if (options.agentId != null && agentHolds.length === 0 && profiles.length === 0 && hostExecute) continue;
    result.push({
      agent: { id, name: String(agent.name), project_id: agent.project_id == null ? null : Number(agent.project_id), runtime_type: agent.runtime_type },
      host_execute: hostExecute,
      routed,
      holds: agentHolds,
      profiles,
    });
  }
  return result;
}

export interface ApprovalRequest {
  agentId: number;
  grantHostExecute: boolean;
  profiles: Array<{ resource_kind: ProfileKind; resource_id: number; digest: string }>;
}

/**
 * Approves what the operator reviewed: each setup is published and bound to the agent only if it
 * still has the digest the operator saw, and host.execute is added to the agent's current
 * permissions when asked. All of it happens or none of it does.
 */
export async function approveReviewed(db: Db, tenantId: number, actor: string, request: ApprovalRequest) {
  const agent = await db.get<{ id: number }>('SELECT id FROM agents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', request.agentId, tenantId);
  if (!agent) throw Object.assign(new Error('Agent not found.'), { status: 404 });
  return db.withTransaction(async (tx) => {
    const approved: Array<{ resource_kind: ProfileKind; resource_id: number; revision_id: string; digest: string }> = [];
    for (const profile of request.profiles) {
      const draft = await createExecutableDraft(tx, tenantId, profile.resource_kind, profile.resource_id, actor);
      if (!draft || draft.digest !== profile.digest) {
        throw Object.assign(new Error('This setup changed again after you reviewed it. Reload the list and review the new changes.'), { status: 409, code: 'execution_profile_changed' });
      }
      if (!draft.published_at) await publishExecutable(tx, tenantId, String(draft.id), profile.digest, actor);
      // Keep an existing direct binding's expiry if it has not passed.
      const existing = await tx.get<{ expires_at: string | Date | null }>(`
        SELECT expires_at FROM execution_bindings
        WHERE tenant_id = ? AND subject_kind = 'agent' AND subject_id = ? AND resource_kind = ? AND resource_id = ?
      `, tenantId, request.agentId, profile.resource_kind, profile.resource_id);
      const expiry = existing?.expires_at == null ? null : new Date(existing.expires_at);
      await bindExecutable(tx, tenantId, 'agent', request.agentId, String(draft.id), actor,
        expiry && expiry.getTime() > Date.now() ? expiry.toISOString() : null);
      approved.push({ resource_kind: profile.resource_kind, resource_id: profile.resource_id, revision_id: String(draft.id), digest: profile.digest });
    }
    if (request.grantHostExecute) await grantAgentMcpCapabilities(tx, request.agentId, ['host.execute'], actor);
    await clearAgentLaunchHolds(tx, tenantId, request.agentId);
    return { agent_id: request.agentId, approved, host_execute_granted: request.grantHostExecute };
  }).catch((error: unknown) => {
    if (error instanceof ExecutionDenied) throw Object.assign(new Error(error.message), { status: 409, code: 'execution_denied' });
    throw error;
  });
}
