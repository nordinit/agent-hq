import type { Db } from '../../db/adapter/types';
import type { AgentToolRecord } from '../../runtimes/toolInjection';
import { executeSnapshot } from './execute';
import { checkDependencyPins } from './dependencies';
import { resolveExecutableSecrets } from './secrets';
import { approvedExecutable, ExecutionDenied, executableDigest } from './authority';
/** Deliberately bounded schema subset: unknown schema constructs fail closed. */
export function validateToolInput(schema: Record<string, any>, input: unknown, depth = 0): void {
    const supported = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description', 'title', 'default', '$schema', 'examples']);
    if (!schema || typeof schema !== 'object' || Array.isArray(schema) || Object.keys(schema).some(k => !supported.has(k)))
        throw new ExecutionDenied('Unsupported input schema contract.');
    if (schema.type !== undefined && !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type))
        throw new ExecutionDenied('Unsupported input schema type.');
    if (depth > 12)
        throw new ExecutionDenied('Input nesting is too deep.');
    if (schema.enum && !schema.enum.some((x: unknown) => JSON.stringify(x) === JSON.stringify(input)))
        throw new ExecutionDenied('Input is not an allowed enum value.');
    if (schema.$ref || schema.oneOf || schema.anyOf || schema.allOf || schema.patternProperties)
        throw new ExecutionDenied('This input schema needs an explicitly supported validation contract before publication.');
    const type = schema.type ?? (depth === 0 ? 'object' : undefined);
    if (type === 'object') {
        if (!input || typeof input !== 'object' || Array.isArray(input))
            throw new ExecutionDenied('Tool input must be an object.');
        const record = input as Record<string, unknown>, properties = schema.properties ?? {};
        if ((schema.required ?? []).some((k: string) => !(k in record)))
            throw new ExecutionDenied('A required tool input is missing.');
        for (const [k, v] of Object.entries(record)) {
            if (['__proto__', 'constructor', 'prototype'].includes(k))
                throw new ExecutionDenied('Invalid input field.');
            if (!(k in properties) && schema.additionalProperties !== true)
                throw new ExecutionDenied('Unknown tool input field.');
            if (k in properties)
                validateToolInput(properties[k], v, depth + 1);
        }
    }
    else if (type === 'array') {
        if (!Array.isArray(input) || input.length > Math.min(schema.maxItems ?? 1000, 1000) || input.length < (schema.minItems ?? 0))
            throw new ExecutionDenied('Invalid tool array input.');
        for (const x of input)
            validateToolInput(schema.items ?? {}, x, depth + 1);
    }
    else if (type === 'string') {
        if (typeof input !== 'string' || input.length > Math.min(schema.maxLength ?? 100000, 100000) || input.length < (schema.minLength ?? 0))
            throw new ExecutionDenied('Invalid tool string input.');
        if (schema.pattern)
            throw new ExecutionDenied('Regex input constraints must be reviewed before execution.');
    }
    else if (type === 'number' || type === 'integer') {
        if (typeof input !== 'number' || !Number.isFinite(input) || (type === 'integer' && !Number.isInteger(input)) || input < (schema.minimum ?? -Infinity) || input > (schema.maximum ?? Infinity))
            throw new ExecutionDenied('Invalid tool numeric input.');
    }
    else if (type === 'boolean' && typeof input !== 'boolean')
        throw new ExecutionDenied('Invalid tool boolean input.');
    else if (type === 'null' && input !== null)
        throw new ExecutionDenied('Invalid null input.');
}
export async function invokePublishedTool(db: Db, tenantId: number, toolId: number, input: Record<string, unknown>, actor: string, agentId?: number, revisionId?: string) {
    let revision: Record<string, any> | undefined;
    try {
        revision = agentId ? await approvedExecutable(db, tenantId, agentId, 'tool', toolId, revisionId) : await db.get<Record<string, any>>(`SELECT * FROM executable_revisions WHERE tenant_id=? AND resource_kind='tool' AND resource_id=? AND published_at IS NOT NULL AND revoked_at IS NULL AND (?::text IS NULL OR id=?) ORDER BY published_at DESC LIMIT 1`, tenantId, toolId, revisionId ?? null, revisionId ?? null);
        if (!revision)
            throw new ExecutionDenied('Publish the tool before invoking or testing it.');
        const sealed = typeof revision.snapshot === 'string' ? JSON.parse(revision.snapshot) : revision.snapshot;
        if (executableDigest(sealed) !== revision.digest)
            throw new ExecutionDenied('Executable integrity check failed.');
        try {
            checkDependencyPins(sealed.dependency_pins);
        }
        catch {
            throw new ExecutionDenied('Published dependency changed or is unavailable.');
        }
        const snapshot = await resolveExecutableSecrets(db, tenantId, sealed);
        if (JSON.stringify(input).length > 100000)
            throw new ExecutionDenied('Tool input exceeds the execution budget.');
        validateToolInput(snapshot.input_schema ?? {}, input);
        await db.run("INSERT INTO execution_audit(tenant_id,actor,action,revision_id,agent_id,decision) VALUES(?,?,'invoke',?,?,'allowed')", tenantId, actor, revision.id, agentId ?? null);
        // A cwd is not a sandbox. OS confinement belongs to the approved service account/profile.
        const result = await executeSnapshot({ ...snapshot, id: toolId, tenant_id: tenantId, agent_tenant_id: tenantId, assignment_id: 0, enabled: 1, assignment_enabled: 1, overrides: '{}', input_schema: JSON.stringify(snapshot.input_schema ?? {}) } as AgentToolRecord, input);
        await db.run('INSERT INTO execution_audit(tenant_id,actor,action,revision_id,agent_id,decision) VALUES(?,?,?,?,?,?)', tenantId, actor, 'result', revision.id, agentId ?? null, result.isError ? 'failed' : 'succeeded');
        return result;
    }
    catch (error) {
        await db.run("INSERT INTO execution_audit(tenant_id,actor,action,revision_id,agent_id,decision) VALUES(?,?,'invoke',?,?,'denied')", tenantId, actor, revision?.id ?? revisionId ?? null, agentId ?? null);
        throw error;
    }
}
