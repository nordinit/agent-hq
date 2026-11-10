import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../../db/adapter/types';
const fail = (message: string) => Object.assign(new Error(message), { status: 403, code: 'execution_denied' });
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const sensitive = /(?:secret|token|password|credential|api[_-]?key|authorization|auth_header)/i;
/** Private server-side values are referenced by immutable version, never copied into publication records. */
export async function sealExecutableSecrets(db: Db, tenantId: number, value: any, key = '', depth = 0, force = false): Promise<any> {
    if (depth > 32)
        throw fail('Executable configuration nesting exceeds its review budget.');
    if (value && typeof value === 'object' && '$secret_ref' in value)
        throw fail('Secret reference objects are reserved for the publication service.');
    if (typeof value === 'string' && (force || sensitive.test(key))) {
        const hash = digest(value);
        await db.run('INSERT INTO executable_secret_values(id,tenant_id,digest,value) VALUES(?,?,?,?) ON CONFLICT(tenant_id,digest) DO NOTHING', randomUUID(), tenantId, hash, value);
        const ref = await db.get<{
            id: string;
        }>('SELECT id FROM executable_secret_values WHERE tenant_id=? AND digest=?', tenantId, hash);
        return { $secret_ref: ref!.id, digest: hash };
    }
    if (key === 'implementation_body' && typeof value === 'string') {
        let parsed: any;
        try {
            parsed = JSON.parse(value);
        }
        catch {
            return value;
        }
        return JSON.stringify(await sealExecutableSecrets(db, tenantId, parsed, '', depth + 1));
    }
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value)
            result.push(await sealExecutableSecrets(db, tenantId, item, '', depth + 1, force));
        return result;
    }
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [child, item] of Object.entries(value))
            result[child] = await sealExecutableSecrets(db, tenantId, item, child, depth + 1, key === 'env' || key === 'headers');
        return result;
    }
    return value;
}
export async function resolveExecutableSecrets(db: Db, tenantId: number, value: any, key = '', depth = 0): Promise<any> {
    if (depth > 32)
        throw fail('Executable configuration nesting exceeds its review budget.');
    if (value && typeof value === 'object' && !Array.isArray(value) && '$secret_ref' in value) {
        const row = await db.get<{
            value: string;
            digest: string;
        }>('SELECT value,digest FROM executable_secret_values WHERE id=? AND tenant_id=?', value.$secret_ref, tenantId);
        if (!row || row.digest !== value.digest || digest(row.value) !== value.digest)
            throw fail('Executable secret reference is missing or changed.');
        return row.value;
    }
    if (key === 'implementation_body' && typeof value === 'string') {
        let parsed: any;
        try {
            parsed = JSON.parse(value);
        }
        catch {
            return value;
        }
        return JSON.stringify(await resolveExecutableSecrets(db, tenantId, parsed, '', depth + 1));
    }
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value)
            result.push(await resolveExecutableSecrets(db, tenantId, item, '', depth + 1));
        return result;
    }
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = {};
        for (const [child, item] of Object.entries(value))
            result[child] = await resolveExecutableSecrets(db, tenantId, item, child, depth + 1);
        return result;
    }
    return value;
}
