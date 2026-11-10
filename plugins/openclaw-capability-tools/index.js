import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import { execFileSync } from 'node:child_process';
import { resolveAgentHqApiAccess } from './api-credential.js';
import { resolveOpenClawAgentId, toOpenClawToolDefinition } from './tool-contract.js';
// Definitions contain broker identities, never shell bodies or privileged launch environments.
function discover(agentId, config) {
    const access = resolveAgentHqApiAccess(config);
    const script = `const [url]=process.argv.slice(1); fetch(url,{headers:{authorization:'Bearer '+process.env.AGENT_HQ_PLUGIN_API_TOKEN}}).then(async r=>{if(!r.ok)throw Error('Discovery denied');process.stdout.write(await r.text());}).catch(()=>process.exit(1));`;
    const output = execFileSync(process.execPath, ['-e', script, access.baseUrl + '/api/v1/tools/materialized/agents/' + encodeURIComponent(agentId)], { encoding: 'utf8', timeout: 10000, maxBuffer: 1048576, env: { PATH: process.env.PATH, AGENT_HQ_PLUGIN_API_TOKEN: access.token ?? '' } });
    return JSON.parse(output).tools ?? [];
}
async function invoke(tool, input, config) {
    if (tool.execution_type !== 'broker')
        throw new Error('Legacy local tool payloads are disabled; rematerialize approved broker tools.');
    const access = resolveAgentHqApiAccess(config), ref = tool.execution_payload;
    const response = await fetch(access.baseUrl + '/api/v1/execution/agents/' + ref.agent_id + '/invoke', { method: 'POST', headers: { authorization: 'Bearer ' + access.token, 'content-type': 'application/json' }, body: JSON.stringify({ tool_id: ref.tool_id, revision_id: ref.revision_id, input }), signal: AbortSignal.timeout(190000) });
    if (!response.ok)
        throw new Error('Execution broker denied this invocation (' + response.status + ').');
    return await response.json();
}
export default definePluginEntry({ id: 'agent-hq-capability-tools', name: 'Agent HQ capability tools', description: 'Invoke published Agent HQ capabilities through the authorization broker.', register(api) {
        api.registerTool(context => {
            const id = resolveOpenClawAgentId(context);
            if (!id)
                throw new Error('Agent identity is required.');
            return discover(id, api.pluginConfig).map(tool => ({ ...toOpenClawToolDefinition(tool), execute: async (_call, input) => invoke(tool, input ?? {}, api.pluginConfig) }));
        });
    } });
