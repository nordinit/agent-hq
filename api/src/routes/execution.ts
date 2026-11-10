import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { getDb } from '../db/client';
import { resolveTenantIdFromRequest } from '../lib/tenantContext';
import { ACCESS_PRESETS } from '../domains/access/capabilities';
import { operationCatalog } from '../domains/access/operations';
import { approvedExecutable, bindExecutable, createExecutableDraft, publishExecutable } from '../domains/execution/authority';
import { invokePublishedTool } from '../domains/execution/invoke';
import { fetchAgentTools } from '../runtimes/toolInjection';
import { executionReadiness } from '../domains/execution/readiness';
import { fetchEffectiveAgentMcpRows } from '../domains/teams/effectiveCapabilities';
const router = Router();
const kind = z.enum(['tool', 'mcp_server', 'agent_runtime', 'workflow_setup']);
const actor = (req: Request) => req.mcpIdentity?.auditActor ?? 'operator';
function reviewSnapshot(value: any, key = ''): any {
    if(value&&typeof value==='object'&&typeof value.$secret_ref==='string')return {$secret_ref:value.$secret_ref,digest:value.digest};
    if (/(?:secret|token|password|credential|auth_header|api_key)/i.test(key))
        return '[redacted]';
    if (['env', 'headers'].includes(key) && value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,v&&typeof v==='object'&&'$secret_ref' in v?reviewSnapshot(v):'[redacted; digest bound]']));
    if (Array.isArray(value))
        return value.map(v => reviewSnapshot(v));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, reviewSnapshot(v, k)]));
    if (key === 'implementation_body' && typeof value === 'string') {
        try {
            return JSON.stringify(reviewSnapshot(JSON.parse(value)));
        }
        catch {
            return value;
        }
    }
    return value;
}
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response) => { void fn(req, res).catch(e => res.status(e instanceof z.ZodError ? 400 : e.status ?? 500).json({ code: e.code ?? 'execution_request_failed', error: e instanceof z.ZodError ? 'Invalid execution request.' : e.status ? e.message : 'Execution request failed.' })); };
router.get('/presets', (_req, res) => res.json({ presets: ACCESS_PRESETS, automatic_grants: false }));
router.get('/operations', handle(async (req, res) => {
    const { owner, effect, limit, offset } = z.object({ owner: z.string().max(100).optional(), effect: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50), offset: z.coerce.number().int().min(0).default(0) }).strict().parse(req.query);
    const operations = operationCatalog().filter(o => (!owner || o.owner === owner) && (!effect || o.effects.includes(effect as any)));
    res.json({ operations: operations.slice(offset, offset + limit), total: operations.length, limit, offset, has_more: offset + limit < operations.length });
}));
router.get('/readiness', handle(async (req, res) => res.json(await executionReadiness(getDb(), await resolveTenantIdFromRequest(getDb(), req)))));
router.get('/revisions', handle(async (req, res) => {
    const tenant = await resolveTenantIdFromRequest(getDb(), req);
    const filter = z.object({ resource_kind: kind.optional(), resource_id: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }).strict().parse(req.query);
    const rows = await getDb().all(`SELECT id,resource_kind,resource_id,digest,created_by,created_at,published_by,published_at,revoked_at FROM executable_revisions WHERE tenant_id=? AND (?::text IS NULL OR resource_kind=?) AND (?::bigint IS NULL OR resource_id=?) ORDER BY created_at DESC,id DESC LIMIT ?`, tenant, filter.resource_kind ?? null, filter.resource_kind ?? null, filter.resource_id ?? null, filter.resource_id ?? null, filter.limit);
    res.json({ revisions: rows });
}));
router.get('/revisions/:id', handle(async (req, res) => {
    const tenant = await resolveTenantIdFromRequest(getDb(), req);
    const row = await getDb().get<Record<string, any>>('SELECT * FROM executable_revisions WHERE id=? AND tenant_id=?', req.params.id, tenant);
    if (!row)
        return res.status(404).json({ error: 'Revision not found.' });
    const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
    // Executable source is publisher-only. Never expose stored launch credential values.
    return res.json({ ...row, snapshot: reviewSnapshot(snapshot) });
}));
router.post('/revisions', handle(async (req, res) => {
    const body = z.object({ resource_kind: kind, resource_id: z.number().int().positive() }).strict().parse(req.body);
    res.status(201).json(await createExecutableDraft(getDb(), await resolveTenantIdFromRequest(getDb(), req), body.resource_kind, body.resource_id, actor(req)));
}));
router.post('/revisions/:id/publish', handle(async (req, res) => {
    const body = z.object({ digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
    res.json(await publishExecutable(getDb(), await resolveTenantIdFromRequest(getDb(), req), req.params.id, body.digest, actor(req)));
}));
router.post('/revisions/:id/revoke', handle(async (req, res) => {
    z.object({}).strict().parse(req.body ?? {});
    const db = getDb(), tenant = await resolveTenantIdFromRequest(db, req);
    await db.withTransaction(async (tx) => {
        const revision = await tx.get('SELECT id FROM executable_revisions WHERE id=? AND tenant_id=? FOR UPDATE', req.params.id, tenant);
        if (!revision)
            throw Object.assign(new Error('Revision not found'), { status: 404 });
        await tx.run('UPDATE executable_revisions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=?', req.params.id);
        await tx.run("INSERT INTO execution_audit(tenant_id,actor,action,revision_id,decision) VALUES(?,?,'revoke',?,'allowed')", tenant, actor(req), req.params.id);
    });
    res.json({ id: req.params.id, revoked: true });
}));
router.post('/bindings', handle(async (req, res) => {
    const body = z.object({ subject_kind: z.enum(['agent', 'team']), subject_id: z.number().int().positive(), revision_id: z.string().uuid(), expires_at: z.string().datetime().optional() }).strict().parse(req.body);
    res.json(await bindExecutable(getDb(), await resolveTenantIdFromRequest(getDb(), req), body.subject_kind, body.subject_id, body.revision_id, actor(req), body.expires_at));
}));
router.get('/bindings', handle(async (req, res) => {
    const { limit, offset } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), offset: z.coerce.number().int().min(0).default(0) }).strict().parse(req.query);
    const rows = await getDb().all('SELECT id,subject_kind,subject_id,resource_kind,resource_id,revision_id,enabled,expires_at FROM execution_bindings WHERE tenant_id=? ORDER BY id LIMIT ? OFFSET ?', await resolveTenantIdFromRequest(getDb(), req), limit + 1, offset);
    res.json({ bindings: rows.slice(0, limit), limit, offset, has_more: rows.length > limit });
}));
router.delete('/bindings/:id', handle(async (req, res) => {
    const db = getDb(), tenant = await resolveTenantIdFromRequest(db, req), id = z.coerce.number().int().positive().parse(req.params.id);
    await db.withTransaction(async (tx) => {
        const row = await tx.get<{
            revision_id: string;
        }>('SELECT revision_id FROM execution_bindings WHERE id=? AND tenant_id=? FOR UPDATE', id, tenant);
        if (!row)
            throw Object.assign(new Error('Binding not found'), { status: 404 });
        await tx.run('UPDATE execution_bindings SET enabled=0,updated_at=now(),changed_by=? WHERE id=?', actor(req), id);
        await tx.run("INSERT INTO execution_audit(tenant_id,actor,action,revision_id,decision) VALUES(?,?,'unbind',?,'allowed')", tenant, actor(req), row.revision_id);
    });
    res.json({ id, enabled: false });
}));
router.get('/agent-tools', handle(async (req, res) => {
    if (!req.mcpIdentity)
        return res.status(400).json({ error: 'Use an agent credential for runtime discovery.' });
    const tools = await fetchAgentTools(getDb(), req.mcpIdentity.agentId);
    return res.json({ agent_id: req.mcpIdentity.agentId, tools: tools.map(t => ({ id: t.id, slug: t.slug, description: t.description, input_schema: t.input_schema, revision_id: (t as any).execution_revision_id })) });
}));
router.post('/invoke', handle(async (req, res) => {
    const body = z.object({ tool_id: z.number().int().positive(), revision_id: z.string().uuid(), input: z.record(z.string(), z.unknown()) }).strict().parse(req.body);
    res.json(await invokePublishedTool(getDb(), await resolveTenantIdFromRequest(getDb(), req), body.tool_id, body.input, actor(req), req.mcpIdentity?.agentId, body.revision_id));
}));
router.post('/authorize', handle(async (req, res) => {
    if (!req.mcpIdentity)
        return res.status(403).json({ error: 'Use the executing agent credential.' });
    const body = z.object({ resource_kind: z.literal('mcp_server'), resource_id: z.number().int().positive(), revision_id: z.string().uuid(), phase: z.enum(['launch', 'call']), tool_name: z.string().min(1).max(256).optional() }).strict().parse(req.body);
    const tenant = await resolveTenantIdFromRequest(getDb(), req);
    const row = await approvedExecutable(getDb(), tenant, req.mcpIdentity.agentId, body.resource_kind, body.resource_id, body.revision_id);
    if (body.tool_name) {
        const candidate = (await fetchEffectiveAgentMcpRows(getDb(), req.mcpIdentity.agentId)).find(r => Number(r.mcp_server_id) === body.resource_id)!;
        const overrides = typeof candidate.overrides === 'string' ? JSON.parse(candidate.overrides) : candidate.overrides ?? {};
        const fields = ['allowed_tools', 'allowedTools', 'allowed_tool_names', 'allowedToolNames', 'tool_allowlist', 'toolAllowlist', 'mcp_tool_allowlist', 'mcpToolAllowlist', 'include_tools', 'includeTools'];
        const field = fields.find(k => Object.prototype.hasOwnProperty.call(overrides, k));
        if ((field && (!Array.isArray(overrides[field]) || !overrides[field].includes(body.tool_name))) || (!field && !['agent-hq', 'dev-environment-lease-manager'].includes(String(candidate.slug))))
            return res.status(403).json({ code: 'execution_scope_denied', error: 'MCP tool is no longer allowed by this assignment.' });
    }
    return res.json({ allowed: true, revision_id: row.id, digest: row.digest });
}));
router.post('/agents/:agentId/invoke', handle(async (req, res) => {
    const agentId = z.coerce.number().int().positive().parse(req.params.agentId);
    if (req.mcpIdentity && req.mcpIdentity.agentId !== agentId)
        return res.status(403).json({ code: 'execution_scope_denied', error: 'Cannot invoke another agent’s tools.' });
    const body = z.object({ tool_id: z.number().int().positive(), revision_id: z.string().uuid(), input: z.record(z.string(), z.unknown()) }).strict().parse(req.body);
    return res.json(await invokePublishedTool(getDb(), await resolveTenantIdFromRequest(getDb(), req), body.tool_id, body.input, actor(req), agentId, body.revision_id));
}));
export default router;
