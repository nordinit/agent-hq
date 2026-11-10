import { agentRunHeaders, runIdentitySourceFromEnv } from '../../lib/agentRunIdentity';
export function executionBrokerClient(env: NodeJS.ProcessEnv = process.env, fetcher: typeof fetch = fetch) {
    const base = env.AGENT_HQ_API_URL ?? env.AGENT_HQ_INTERNAL_BASE_URL ?? 'http://127.0.0.1:3501';
    const url = new URL(base);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
        throw new Error('Execution broker requires HTTPS or loopback.');
    const key = env.AGENT_HQ_MCP_API_KEY;
    if (!key)
        throw new Error('A run-scoped execution credential is required.');
    const identity = runIdentitySourceFromEnv(env);
    return async (method: 'GET' | 'POST', suffix: '/agent-tools' | '/invoke', body?: unknown) => {
        const response = await fetcher(base.replace(/\/$/, '') + '/api/v1/execution' + suffix, { method, headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json', ...agentRunHeaders(identity()) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(190000) });
        if (!response.ok)
            throw new Error('Execution broker rejected the request (' + response.status + ').');
        return await response.json() as any;
    };
}
