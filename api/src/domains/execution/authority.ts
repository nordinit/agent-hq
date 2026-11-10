import { createHash, randomUUID } from 'crypto';
import type { Db } from '../../db/adapter/types';
import { dependencyPins, checkDependencyPins } from './dependencies';
import { fetchEffectiveAgentToolRows, fetchEffectiveAgentMcpRows } from '../teams/effectiveCapabilities';
import { sealExecutableSecrets, resolveExecutableSecrets } from './secrets';
export type ExecutableKind = 'tool' | 'mcp_server' | 'agent_runtime' | 'workflow_setup';
type Row = Record<string, unknown>;
export class ExecutionDenied extends Error {
    status = 403;
    code = 'execution_denied';
}
export function stable(value: unknown): string {
    if (Array.isArray(value))
        return '[' + value.map(stable).join(',') + ']';
    if (value && typeof value === 'object')
        return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
    return JSON.stringify(value) ?? 'null';
}
export const executableDigest = (snapshot: unknown) => createHash('sha256').update(stable(snapshot)).digest('hex');
function decode(v: unknown): unknown { if (typeof v === 'string') {
    try {
        return JSON.parse(v);
    }
    catch {
        return v;
    }
} return v; }
export async function resourceSnapshot(db: Db, tenantId: number, kind: ExecutableKind, id: number): Promise<Row> {
    const table = { tool: 'tools', mcp_server: 'mcp_servers', agent_runtime: 'agents', workflow_setup: 'workflows' }[kind];
    const row = await db.get<Row>(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`, id, tenantId);
    if (!row)
        throw Object.assign(new Error('Resource not found'), { status: 404 });
    const fields: Record<ExecutableKind, string[]> = { tool: ['name', 'slug', 'description', 'implementation_type', 'implementation_body', 'input_schema', 'permissions', 'tags'], mcp_server: ['name', 'slug', 'transport', 'command', 'args', 'env', 'cwd'], agent_runtime: ['name', 'role', 'model', 'preferred_provider', 'runtime_type', 'runtime_config', 'workspace_path', 'hooks_url', 'hooks_auth_header', 'os_user', 'github_identity_id', 'provider_connection_id', 'job_instructions', 'skill_names'], workflow_setup: ['repo_path', 'repo_url', 'repo_access_mode', 'environment_setup'] };
    const jsonFields = new Set(['args', 'env', 'input_schema', 'tags', 'runtime_config', 'skill_names', 'environment_setup']);
    const snapshot = Object.fromEntries(fields[kind].map(k => [k, jsonFields.has(k) ? decode(row[k] ?? null) : row[k] ?? null]));
    if (kind === 'agent_runtime') {
        const teams = await db.all<Record<string, any>>(`SELECT te.id,te.name,te.goal,te.charter,te.context_version,te.skill_names FROM teams te JOIN team_members tm ON tm.team_id=te.id WHERE tm.agent_id=? AND tm.enabled=1 AND te.enabled=1 AND te.deleted_at IS NULL AND te.tenant_id=? ORDER BY te.id`, id, tenantId);
        const own = decode(row.skill_names) as string[] | null;
        const skillNames = [...new Set([...(Array.isArray(own) ? own : []), ...teams.flatMap(team => { const names = decode(team.skill_names); return Array.isArray(names) ? names : []; })])].sort();
        const skills = skillNames.length ? await db.all(`SELECT id,name,content FROM skills WHERE tenant_id=? AND name=ANY(?::text[]) ORDER BY name`, tenantId, skillNames) : [];
        const files = skillNames.length ? await db.all(`SELECT s.name,f.path,f.content FROM skill_files f JOIN skills s ON s.id=f.skill_id AND s.tenant_id=f.tenant_id WHERE s.tenant_id=? AND s.name=ANY(?::text[]) ORDER BY s.name,f.path`, tenantId, skillNames) : [];
        const credentialReferences = [];
        for (const [field, table] of [['provider_connection_id', 'provider_connections'], ['github_identity_id', 'github_identities']] as const)
            if (row[field]) {
                const reference = await db.get<Record<string, any>>(`SELECT * FROM ${table} WHERE id=? AND tenant_id=?`, row[field], tenantId);
                if (!reference)
                    throw new ExecutionDenied('Execution credential reference is outside this tenant or missing.');
                credentialReferences.push({ kind: table, id: row[field], version: executableDigest(reference) });
            }
        snapshot.referenced_content = { teams, skills, skill_files: files, credential_references: credentialReferences };
        if (JSON.stringify(snapshot).length > 2 * 1024 * 1024)
            throw new ExecutionDenied('Execution profile exceeds the 2 MiB review budget.');
    }
    return sealExecutableSecrets(db, tenantId, { ...snapshot, dependency_pins: dependencyPins(snapshot) });
}
export async function createExecutableDraft(db: Db, tenantId: number, kind: ExecutableKind, id: number, actor: string) {
    const snapshot = await resourceSnapshot(db, tenantId, kind, id), digest = executableDigest(snapshot);
    await db.run(`INSERT INTO executable_revisions(id,tenant_id,resource_kind,resource_id,digest,snapshot,created_by)
    VALUES(?,?,?,?,?,?::jsonb,?) ON CONFLICT(tenant_id,resource_kind,resource_id,digest) DO NOTHING`, randomUUID(), tenantId, kind, id, digest, JSON.stringify(snapshot), actor);
    return await db.get<Row>('SELECT id,resource_kind,resource_id,digest,created_by,created_at,published_by,published_at,revoked_at FROM executable_revisions WHERE tenant_id=? AND resource_kind=? AND resource_id=? AND digest=?', tenantId, kind, id, digest);
}
export async function publishExecutable(db: Db, tenantId: number, id: string, digest: string, actor: string) {
    return db.withTransaction(async (tx) => {
        const row = await tx.get<Row>('SELECT * FROM executable_revisions WHERE id=? AND tenant_id=? FOR UPDATE', id, tenantId);
        if (!row)
            throw Object.assign(new Error('Revision not found'), { status: 404 });
        if (row.revoked_at || row.digest !== digest || executableDigest(decode(row.snapshot)) !== digest)
            throw new ExecutionDenied('Revision is revoked or its digest does not match.');
        if (row.resource_kind === 'tool' && !['bash', 'shell', 'script', 'http'].includes((decode(row.snapshot) as any).implementation_type))
            throw new ExecutionDenied('This tool implementation type has no supported broker executor.');
        try {
            checkDependencyPins((decode(row.snapshot) as any).dependency_pins);
        }
        catch {
            throw new ExecutionDenied('Executable dependencies are missing or changed. Create a new draft after correcting them.');
        }
        await tx.run('UPDATE executable_revisions SET published_at=COALESCE(published_at,now()),published_by=COALESCE(published_by,?) WHERE id=?', actor, id);
        await tx.run("INSERT INTO execution_audit(tenant_id,actor,action,revision_id,decision) VALUES(?,?,'publish',?,'allowed')", tenantId, actor, id);
        return { id, digest, published: true };
    });
}
export async function bindExecutable(db: Db, tenantId: number, subjectKind: 'agent' | 'team', subjectId: number, revisionId: string, actor: string, expiresAt: string | null = null) {
    if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()))
        throw new ExecutionDenied('Binding expiry must be in the future.');
    return db.withTransaction(async (tx) => {
        const subject = await tx.get(`SELECT id FROM ${subjectKind === 'agent' ? 'agents' : 'teams'} WHERE id=? AND tenant_id=?`, subjectId, tenantId);
        const row = await tx.get<Row>('SELECT * FROM executable_revisions WHERE id=? AND tenant_id=? AND published_at IS NOT NULL AND revoked_at IS NULL FOR UPDATE', revisionId, tenantId);
        if (!subject || !row)
            throw new ExecutionDenied('Subject and published revision must belong to this tenant.');
        await tx.run(`INSERT INTO execution_bindings(tenant_id,subject_kind,subject_id,resource_kind,resource_id,revision_id,changed_by,expires_at)
      VALUES(?,?,?,?,?,?,?,?::timestamptz) ON CONFLICT(tenant_id,subject_kind,subject_id,resource_kind,resource_id)
      DO UPDATE SET revision_id=EXCLUDED.revision_id,enabled=1,expires_at=EXCLUDED.expires_at,changed_by=EXCLUDED.changed_by,updated_at=now()`, tenantId, subjectKind, subjectId, row.resource_kind, row.resource_id, revisionId, actor, expiresAt);
        await tx.run("INSERT INTO execution_audit(tenant_id,actor,action,revision_id,decision) VALUES(?,?,'bind',?,'allowed')", tenantId, actor, revisionId);
        if (row.resource_kind === 'tool' || row.resource_kind === 'mcp_server') {
            const table = subjectKind === 'agent' ? (row.resource_kind === 'tool' ? 'agent_tool_assignments' : 'agent_mcp_assignments') : (row.resource_kind === 'tool' ? 'team_tool_assignments' : 'team_mcp_assignments');
            const subjectColumn = subjectKind === 'agent' ? 'agent_id' : 'team_id', resourceColumn = row.resource_kind === 'tool' ? 'tool_id' : 'mcp_server_id';
            await tx.run(`INSERT INTO ${table}(${subjectColumn},${resourceColumn},enabled) VALUES(?,?,1) ON CONFLICT(${subjectColumn},${resourceColumn}) DO UPDATE SET enabled=1`, subjectId, row.resource_id);
        }
        return { revision_id: revisionId, subject_kind: subjectKind, subject_id: subjectId };
    });
}
export async function requireAgentExecutionCapability(db: Db, agentId: number, capability: 'tools.execute' | 'host.execute'): Promise<void> {
    const row = await db.get<{
        enabled: number;
    }>('SELECT enabled FROM agent_mcp_capability_policies WHERE agent_id=? AND capability_key=?', agentId, capability);
    if (Number(row?.enabled) !== 1)
        throw new ExecutionDenied(`Agent #${agentId} requires explicit ${capability}.`);
}
/** Always reload publication/binding state; no cached authorization survives revocation. */
export async function approvedExecutable(db: Db, tenantId: number, agentId: number, kind: ExecutableKind, resourceId: number, revisionId?: string): Promise<Row> {
    const capability = kind === 'tool' ? 'tools.execute' : 'host.execute';
    await requireAgentExecutionCapability(db, agentId, capability);
    if (kind === 'tool')
        await requireAgentExecutionCapability(db, agentId, 'host.execute');
    if (kind === 'tool' || kind === 'mcp_server') {
        const candidates = kind === 'tool' ? await fetchEffectiveAgentToolRows(db, agentId) : await fetchEffectiveAgentMcpRows(db, agentId);
        const candidate = candidates.find(row => Number(kind === 'tool' ? row.id : row.mcp_server_id) === resourceId);
        if (!candidate)
            throw new ExecutionDenied('Executable or effective assignment is disabled or removed.');
        const overrides = decode(candidate.overrides) as Row | null;
        const filters = ['tool_allowlist', 'enforce_tool_allowlist', 'allowed_tools', 'allowedTools', 'allowed_tool_names', 'allowedToolNames', 'toolAllowlist', 'mcp_tool_allowlist', 'mcpToolAllowlist', 'include_tools', 'includeTools'];
        if (overrides && typeof overrides === 'object' && Object.keys(overrides).some(key => !filters.includes(key)))
            throw new ExecutionDenied('Executable overrides must be published as a new revision.');
    }
    const row = await db.get<Row>(`SELECT r.* FROM executable_revisions r JOIN execution_bindings b ON b.revision_id=r.id AND b.tenant_id=r.tenant_id
    JOIN agents a ON a.id=? AND a.tenant_id=r.tenant_id AND a.enabled=1
    WHERE r.tenant_id=? AND r.resource_kind=? AND r.resource_id=? AND r.published_at IS NOT NULL AND r.revoked_at IS NULL
      AND b.enabled=1 AND (b.expires_at IS NULL OR b.expires_at>now()) AND (?::text IS NULL OR r.id=?)
      AND ((b.subject_kind='agent' AND b.subject_id=a.id) OR (b.subject_kind='team' AND EXISTS(
        SELECT 1 FROM team_members tm JOIN teams te ON te.id=tm.team_id AND te.tenant_id=r.tenant_id
        WHERE tm.agent_id=a.id AND tm.team_id=b.subject_id AND tm.enabled=1 AND te.enabled=1 AND te.deleted_at IS NULL)))
    ORDER BY CASE WHEN b.subject_kind='agent' THEN 0 ELSE 1 END,b.id LIMIT 1`, agentId, tenantId, kind, resourceId, revisionId ?? null, revisionId ?? null);
    if (!row)
        throw new ExecutionDenied('No active grant for this published executable revision.');
    if (executableDigest(decode(row.snapshot)) !== row.digest)
        throw new ExecutionDenied('Published executable integrity check failed.');
    try {
        checkDependencyPins((decode(row.snapshot) as any).dependency_pins);
    }
    catch {
        throw new ExecutionDenied('Published executable dependency changed or is unavailable.');
    }
    return { ...row, snapshot: decode(row.snapshot) };
}
export async function resolvePublishedRows(db: Db, agentId: number, kind: 'tool' | 'mcp_server', rows: Row[]): Promise<Row[]> {
    if (!rows.length)
        return [];
    const agent = await db.get<{
        tenant_id: number;
    }>('SELECT tenant_id FROM agents WHERE id=?', agentId);
    if (!agent)
        throw new ExecutionDenied('Agent not found.');
    const result: Row[] = [];
    for (const row of rows) {
        const overrides = decode(row.overrides) as Row | null;
        if (overrides && typeof overrides === 'object' && Object.keys(overrides).some(k => !['tool_allowlist', 'enforce_tool_allowlist', 'allowed_tools', 'allowedTools', 'allowed_tool_names', 'allowedToolNames', 'toolAllowlist', 'mcp_tool_allowlist', 'mcpToolAllowlist', 'include_tools', 'includeTools'].includes(k)))
            throw new ExecutionDenied('Executable assignment overrides must be published as a new revision.');
        const resourceId = Number(kind === 'tool' ? row.id : row.mcp_server_id);
        const revision = await approvedExecutable(db, Number(agent.tenant_id), agentId, kind, resourceId);
        const snapshot = await resolveExecutableSecrets(db, Number(agent.tenant_id), revision.snapshot) as Row;
        result.push({ ...row, ...snapshot, args: typeof snapshot.args === 'object' ? JSON.stringify(snapshot.args) : snapshot.args, env: typeof snapshot.env === 'object' ? JSON.stringify(snapshot.env) : snapshot.env, input_schema: typeof snapshot.input_schema === 'object' ? JSON.stringify(snapshot.input_schema) : snapshot.input_schema, tags: typeof snapshot.tags === 'object' ? JSON.stringify(snapshot.tags) : snapshot.tags, execution_revision_id: revision.id, execution_digest: revision.digest });
    }
    return result;
}
export async function requirePublishedProfile(db: Db, agentId: number, kind: 'agent_runtime' | 'workflow_setup', resourceId: number) {
    const agent = await db.get<{
        tenant_id: number;
    }>('SELECT tenant_id FROM agents WHERE id=?', agentId);
    if (!agent)
        throw new ExecutionDenied('Agent not found');
    const revision = await approvedExecutable(db, Number(agent.tenant_id), agentId, kind, resourceId);
    const current = await resourceSnapshot(db, Number(agent.tenant_id), kind, resourceId);
    if (executableDigest(current) !== revision.digest)
        throw new ExecutionDenied('Execution profile changed; publish and bind the new revision before launching.');
    return revision;
}
