import { ATLAS_AGENT_NAME, ATLAS_AGENT_SLUG } from '../../lib/atlasAgent';
const AGENT_TRUST_BEARING_FIELDS = ['system_role', 'tenant_id', 'session_key'] as const;
export function agentTrustBearingFieldInPatch(body: Record<string, unknown>): string | null {
    return AGENT_TRUST_BEARING_FIELDS.find((field) => Object.prototype.hasOwnProperty.call(body, field)) ?? null;
}
/**
 * Kept after the key-role change, though it no longer guards authority: the Atlas name and slug
 * identify the built-in assistant that tenant provisioning looks up, so letting a project-scoped
 * client mint a second one invites a collision rather than an escalation.
 */
export function agentIdentityNameIsReserved(body: Record<string, unknown>): boolean {
    const name = typeof body.name === 'string' ? body.name.trim().toLowerCase() : null;
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : null;
    return name === ATLAS_AGENT_NAME.toLowerCase() || slug === ATLAS_AGENT_SLUG.toLowerCase();
}
/**
 * Agent fields that decide what runs on this host, where it runs, and with which credentials:
 * the working directory (also the artifacts API root), the runtime driver, the remote gateway
 * URL and the auth header sent to it, the OS user whose home task checkouts live in, and the
 * GitHub identity injected into runs. project agent management edits what an agent is told to
 * do; these decide what it is allowed to do, so a scoped key may send them only unchanged.
 */
export const AGENT_HOST_EXECUTION_FIELDS = [
    'workspace_path',
    'runtime_type',
    'hooks_url',
    'hooks_auth_header',
    'os_user',
    'github_identity_id',
] as const;
/**
 * The runtime_config keys a scoped key may change: model and effort selection, prompt suffix,
 * and turn/budget limits. Every other key — executables, config homes, working directory,
 * permission and sandbox modes and their bypass switches, allowed tools, extra CLI arguments,
 * environment, webhook URLs and auth headers, provider profile references — must stay as
 * stored. An allowlist, so a runtime option added later is protected until someone decides
 * otherwise.
 */
const SCOPED_MUTABLE_RUNTIME_CONFIG_KEYS = new Set([
    'model',
    'effort',
    'reasoningEffort',
    'fastMode',
    'provider',
    'systemPromptSuffix',
    'maxTurns',
    'maxBudgetUsd',
]);
function comparableAgentValue(value: unknown): string {
    if (value === undefined || value === null || value === '')
        return 'null';
    if (typeof value === 'number' || typeof value === 'boolean')
        return JSON.stringify(String(value));
    if (typeof value !== 'object')
        return JSON.stringify(value);
    const sorted = (entry: unknown): unknown => {
        if (Array.isArray(entry))
            return entry.map(sorted);
        if (entry && typeof entry === 'object') {
            return Object.fromEntries(Object.keys(entry as Record<string, unknown>).sort()
                .map((key) => [key, sorted((entry as Record<string, unknown>)[key])]));
        }
        return entry;
    };
    return JSON.stringify(sorted(value));
}
function runtimeConfigRecord(value: unknown): Record<string, unknown> {
    if (typeof value === 'string') {
        try {
            return runtimeConfigRecord(JSON.parse(value));
        }
        catch {
            return {};
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/**
 * Returns the first host-execution field a scoped create or update would change, or null. For a
 * create, `stored` is null and every such field must be absent; runtime_type may be chosen then,
 * since the driver's executable and defaults are host policy, but not switched afterwards.
 * provision_openclaw registers the agent with the OpenClaw CLI, which is provisioning.
 */
export function agentHostExecutionFieldChange(body: Record<string, unknown>, stored: Record<string, unknown> | null): string | null {
    if (!stored && body.provision_openclaw)
        return 'provision_openclaw';
    for (const field of AGENT_HOST_EXECUTION_FIELDS) {
        if (!Object.prototype.hasOwnProperty.call(body, field))
            continue;
        if (!stored && field === 'runtime_type')
            continue;
        if (comparableAgentValue(body[field]) !== comparableAgentValue(stored?.[field]))
            return field;
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'runtime_config'))
        return null;
    // PUT replaces runtime_config wholesale, so a key the caller drops counts as a change too.
    const requested = runtimeConfigRecord(body.runtime_config);
    const current = runtimeConfigRecord(stored?.runtime_config);
    for (const key of new Set([...Object.keys(requested), ...Object.keys(current)])) {
        if (SCOPED_MUTABLE_RUNTIME_CONFIG_KEYS.has(key))
            continue;
        if (comparableAgentValue(requested[key]) !== comparableAgentValue(current[key]))
            return `runtime_config.${key}`;
    }
    return null;
}
