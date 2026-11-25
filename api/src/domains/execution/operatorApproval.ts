/**
 * Edits made with the operator token approve what they change.
 *
 * Agent HQ launches an agent only when its runtime profile, the setup of the task's workflow, and
 * every tool and MCP server it uses are published revisions bound to it (see `authority.ts`).
 * Changing any of them leaves the agent unable to launch until someone publishes and binds the new
 * revision. A change made with the operator token, from the UI or the CLI, is the operator's own
 * decision, so the request that makes it also publishes and binds the result. A change made with an
 * agent's MCP key is never approved here and waits for review.
 *
 * An edit re-approves only profiles that were approved before it. If something else changed a
 * profile since its last approval, the operator's edit leaves it waiting for review, so an edit
 * never approves a change the operator did not make.
 *
 * Usage, around the write:
 *
 *   const approval = await OperatorApproval.begin(req, db, tenantId, { agents: [agentId] });
 *   ...write...
 *   await approval.finish();
 */

import type { Request } from 'express';
import type { Db } from '../../db/adapter/types';
import { OPERATOR_ACTOR } from '../../lib/operatorActor';
import {
  bindExecutable,
  createExecutableDraft,
  executableDigest,
  publishExecutable,
  resourceSnapshot,
  type ExecutableKind,
} from './authority';

export type ApprovalSubject = { kind: 'agent' | 'team'; id: number };

export interface ApprovalScope {
  agents?: Iterable<number>;
  workflows?: Iterable<number>;
  tools?: Iterable<number>;
  mcpServers?: Iterable<number>;
  /** Agents that use these skills, directly or through a team. */
  skills?: Iterable<string>;
  /** Agents that are enabled members of these teams. */
  teams?: Iterable<number>;
  /** Agents that launch with these provider connections. */
  providerConnections?: Iterable<number>;
  /** Agents that launch with these GitHub identities. */
  githubIdentities?: Iterable<number>;
}

export interface ApprovalResult {
  approved: Array<{ kind: ExecutableKind; id: number; revision_id: string; digest: string; bound_to: ApprovalSubject[] }>;
  /** Profiles the edit touched but could not approve, because they were waiting for review. */
  pending: Array<{ kind: ExecutableKind; id: number; reason: string }>;
}

type Key = string;
type BeforeState = { kind: ExecutableKind; id: number; digest: string | null; approved: boolean; inSync: Binding[] };
type Binding = { subject: ApprovalSubject; expiresAt: string | null };

const key = (kind: ExecutableKind, id: number): Key => `${kind}:${id}`;
const subjectKey = (subject: ApprovalSubject) => `${subject.kind}:${subject.id}`;

function ids(values: Iterable<number> | undefined): number[] {
  return [...new Set([...(values ?? [])].map(Number).filter((value) => Number.isInteger(value) && value > 0))];
}

function parseNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((name): name is string => typeof name === 'string');
  if (typeof value !== 'string') return [];
  try {
    return parseNames(JSON.parse(value));
  } catch {
    return [];
  }
}

/** The approval actor for a request, or null when it did not use the operator token. */
export function operatorApprover(req: Request): string | null {
  return req.apiCredential === 'operator' ? OPERATOR_ACTOR : null;
}

/** Agents whose runtime profile includes any of the given skills, teams or credentials. */
export async function agentsInScope(db: Db, tenantId: number, scope: ApprovalScope): Promise<number[]> {
  const found = new Set(ids(scope.agents));
  const teamIds = new Set(ids(scope.teams));
  const skills = new Set([...(scope.skills ?? [])].filter(Boolean));
  if (skills.size > 0) {
    const agents = await db.all<{ id: number; skill_names: unknown }>('SELECT id, skill_names FROM agents WHERE tenant_id = ?', tenantId);
    for (const agent of agents) if (parseNames(agent.skill_names).some((name) => skills.has(name))) found.add(Number(agent.id));
    const teams = await db.all<{ id: number; skill_names: unknown }>('SELECT id, skill_names FROM teams WHERE tenant_id = ? AND deleted_at IS NULL', tenantId);
    for (const team of teams) if (parseNames(team.skill_names).some((name) => skills.has(name))) teamIds.add(Number(team.id));
  }
  if (teamIds.size > 0) {
    const members = await db.all<{ agent_id: number }>(
      `SELECT tm.agent_id FROM team_members tm JOIN teams te ON te.id = tm.team_id
       WHERE te.tenant_id = ? AND tm.team_id = ANY(?::bigint[]) AND tm.enabled = 1`,
      tenantId, [...teamIds],
    );
    for (const member of members) found.add(Number(member.agent_id));
  }
  for (const [column, values] of [['provider_connection_id', scope.providerConnections], ['github_identity_id', scope.githubIdentities]] as const) {
    const wanted = ids(values);
    if (wanted.length === 0) continue;
    const agents = await db.all<{ id: number }>(`SELECT id FROM agents WHERE tenant_id = ? AND ${column} = ANY(?::bigint[])`, tenantId, wanted);
    for (const agent of agents) found.add(Number(agent.id));
  }
  return [...found];
}

async function resolveScope(db: Db, tenantId: number, scope: ApprovalScope): Promise<Array<[ExecutableKind, number]>> {
  return [
    ...(await agentsInScope(db, tenantId, scope)).map((id) => ['agent_runtime', id] as [ExecutableKind, number]),
    ...ids(scope.workflows).map((id) => ['workflow_setup', id] as [ExecutableKind, number]),
    ...ids(scope.tools).map((id) => ['tool', id] as [ExecutableKind, number]),
    ...ids(scope.mcpServers).map((id) => ['mcp_server', id] as [ExecutableKind, number]),
  ];
}

/** The resource's current digest, or null when it no longer exists or cannot be published. */
async function currentDigest(db: Db, tenantId: number, kind: ExecutableKind, id: number): Promise<string | null> {
  try {
    return executableDigest(await resourceSnapshot(db, tenantId, kind, id));
  } catch (error) {
    if ((error as { status?: number }).status === 404 || (error as { code?: string }).code === 'execution_denied') return null;
    throw error;
  }
}

async function publishedRevision(db: Db, tenantId: number, kind: ExecutableKind, id: number, digest: string) {
  return db.get<{ id: string }>(
    `SELECT id FROM executable_revisions
     WHERE tenant_id = ? AND resource_kind = ? AND resource_id = ? AND digest = ? AND published_at IS NOT NULL AND revoked_at IS NULL
     LIMIT 1`,
    tenantId, kind, id, digest,
  );
}

/** Active bindings for the resource, with the digest each one approves. */
async function activeBindings(db: Db, tenantId: number, kind: ExecutableKind, id: number) {
  const rows = await db.all<{ subject_kind: 'agent' | 'team'; subject_id: number; expires_at: string | Date | null; digest: string }>(
    `SELECT b.subject_kind, b.subject_id, b.expires_at, r.digest
     FROM execution_bindings b JOIN executable_revisions r ON r.id = b.revision_id AND r.tenant_id = b.tenant_id
     WHERE b.tenant_id = ? AND b.resource_kind = ? AND b.resource_id = ? AND b.enabled = 1
       AND (b.expires_at IS NULL OR b.expires_at > now()) AND r.published_at IS NOT NULL AND r.revoked_at IS NULL`,
    tenantId, kind, id,
  );
  return rows.map((row) => ({
    subject: { kind: row.subject_kind, id: Number(row.subject_id) } as ApprovalSubject,
    expiresAt: row.expires_at == null ? null : new Date(row.expires_at).toISOString(),
    digest: row.digest,
  }));
}

export class OperatorApproval {
  private readonly created = new Set<Key>();
  private readonly assignments = new Map<Key, Map<string, ApprovalSubject>>();

  private constructor(
    private readonly db: Db,
    private readonly tenantId: number,
    private readonly actor: string | null,
    private readonly before: Map<Key, BeforeState>,
  ) {}

  /** Record what is approved before an edit. Does nothing unless the request used the operator token. */
  static async begin(req: Request, db: Db, tenantId: number, scope: ApprovalScope = {}): Promise<OperatorApproval> {
    return OperatorApproval.forActor(operatorApprover(req), db, tenantId, scope);
  }

  /** As `begin`, for code that already knows the approving actor (null approves nothing). */
  static async forActor(actor: string | null, db: Db, tenantId: number, scope: ApprovalScope = {}): Promise<OperatorApproval> {
    const before = new Map<Key, BeforeState>();
    if (actor) {
      for (const [kind, id] of await resolveScope(db, tenantId, scope)) {
        const digest = await currentDigest(db, tenantId, kind, id);
        const approved = digest != null && Boolean(await publishedRevision(db, tenantId, kind, id, digest));
        const inSync = digest == null ? [] : (await activeBindings(db, tenantId, kind, id))
          .filter((binding) => binding.digest === digest)
          .map(({ subject, expiresAt }) => ({ subject, expiresAt }));
        before.set(key(kind, id), { kind, id, digest, approved, inSync });
      }
    }
    return new OperatorApproval(db, tenantId, actor, before);
  }

  get active(): boolean {
    return this.actor != null;
  }

  /** Resources this edit created. They are approved as created, and a new agent is bound to its own runtime. */
  markCreated(scope: Pick<ApprovalScope, 'agents' | 'workflows' | 'tools' | 'mcpServers'>): this {
    for (const id of ids(scope.agents)) {
      this.created.add(key('agent_runtime', id));
      this.assign({ kind: 'agent', id }, 'agent_runtime', id);
    }
    for (const id of ids(scope.workflows)) this.created.add(key('workflow_setup', id));
    for (const id of ids(scope.tools)) this.created.add(key('tool', id));
    for (const id of ids(scope.mcpServers)) this.created.add(key('mcp_server', id));
    return this;
  }

  /**
   * A subject this edit started using a resource with: an agent routed to a workflow, or an agent or
   * team given a tool or MCP server. It is bound to the resource's approved revision, if there is one.
   */
  assign(subject: ApprovalSubject, kind: ExecutableKind, id: number): this {
    if (!(Number.isInteger(subject.id) && subject.id > 0 && Number.isInteger(id) && id > 0)) return this;
    const subjects = this.assignments.get(key(kind, id)) ?? new Map<string, ApprovalSubject>();
    subjects.set(subjectKey(subject), subject);
    this.assignments.set(key(kind, id), subjects);
    return this;
  }

  /**
   * Routing rules this edit created or changed: each enabled rule's agent is bound to the setup of
   * the workflow it routes. A rule without a workflow covers the project's workflows of its type.
   */
  async assignRoutes(rules: Array<Record<string, unknown> | null | undefined>): Promise<this> {
    if (!this.actor) return this;
    for (const rule of rules) {
      const agentId = Number(rule?.agent_id);
      if (!rule || Number(rule.enabled ?? 1) !== 1 || !Number.isInteger(agentId) || agentId <= 0) continue;
      const workflowIds = rule.workflow_id != null
        ? [Number(rule.workflow_id)]
        : rule.project_id != null && typeof rule.workflow_type === 'string'
          ? (await this.db.all<{ id: number }>(
            'SELECT id FROM workflows WHERE tenant_id = ? AND project_id = ? AND workflow_type = ?',
            this.tenantId, Number(rule.project_id), rule.workflow_type,
          )).map((row) => Number(row.id))
          : [];
      for (const workflowId of workflowIds) this.assign({ kind: 'agent', id: agentId }, 'workflow_setup', workflowId);
    }
    return this;
  }

  /** Publish and bind what the edit changed. Failures are logged, never thrown: the edit itself succeeded. */
  async finish(): Promise<ApprovalResult> {
    const result: ApprovalResult = { approved: [], pending: [] };
    if (!this.actor) return result;
    const targets = new Map<Key, [ExecutableKind, number]>();
    for (const state of this.before.values()) targets.set(key(state.kind, state.id), [state.kind, state.id]);
    for (const k of [...this.created, ...this.assignments.keys()]) {
      const [kind, id] = k.split(':');
      targets.set(k, [kind as ExecutableKind, Number(id)]);
    }
    for (const [k, [kind, id]] of targets) {
      try {
        // Each resource is approved atomically. Inside a caller's transaction this is a savepoint,
        // so a failure here never aborts the edit it follows.
        await this.db.withTransaction((tx) => this.approveOne(tx, k, kind, id, result));
      } catch (error) {
        // A refusal (an unsupported tool type, a missing dependency) is the publication rules
        // working, not a fault: report it and leave the resource for review.
        const refused = (error as { code?: string }).code === 'execution_denied';
        if (!refused) console.warn(`[operator-approval] could not approve ${k}: ${error instanceof Error ? error.message : String(error)}`);
        result.pending.push({ kind, id, reason: refused ? 'not_publishable' : 'approval_failed' });
      }
    }
    return result;
  }

  private async approveOne(db: Db, k: Key, kind: ExecutableKind, id: number, result: ApprovalResult): Promise<void> {
    const { tenantId } = this;
    const actor = this.actor!;
    const before = this.before.get(k);
    const digest = await currentDigest(db, tenantId, kind, id);
    if (digest == null) return;
    const alreadyApproved = Boolean(await publishedRevision(db, tenantId, kind, id, digest));
    // Untracked resources (only assigned here) are trusted when their current definition is approved.
    const trusted = this.created.has(k) || (before ? before.approved : alreadyApproved);
    if (!trusted) {
      result.pending.push({ kind, id, reason: 'changed_since_last_approval' });
      return;
    }

    const wanted = new Map<string, Binding>();
    for (const binding of before?.inSync ?? []) wanted.set(subjectKey(binding.subject), binding);
    for (const [sk, subject] of this.assignments.get(k) ?? []) if (!wanted.has(sk)) wanted.set(sk, { subject, expiresAt: null });
    const current = new Map((await activeBindings(db, tenantId, kind, id)).map((binding) => [subjectKey(binding.subject), binding]));
    const toBind = [...wanted.entries()].filter(([sk]) => current.get(sk)?.digest !== digest);
    if (alreadyApproved && toBind.length === 0) return;

    const draft = await createExecutableDraft(db, tenantId, kind, id, actor);
    if (!draft || draft.digest !== digest) {
      // Something changed the resource while this edit was being approved; leave it for review.
      result.pending.push({ kind, id, reason: 'changed_during_edit' });
      return;
    }
    const revisionId = String(draft.id);
    if (!draft.published_at) await publishExecutable(db, tenantId, revisionId, digest, actor);
    const boundTo: ApprovalSubject[] = [];
    for (const [sk, binding] of toBind) {
      // Keep an expiry the operator set on the binding being replaced.
      const expiresAt = current.get(sk)?.expiresAt ?? binding.expiresAt;
      await bindExecutable(db, tenantId, binding.subject.kind, binding.subject.id, revisionId, actor, expiresAt);
      boundTo.push(binding.subject);
    }
    result.approved.push({ kind, id, revision_id: revisionId, digest, bound_to: boundTo });
  }
}
