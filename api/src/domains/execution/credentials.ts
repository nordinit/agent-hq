import type { Db } from '../../db/adapter/types';
import { ExecutionDenied } from './authority';
export async function issueExecutionCredential(db: Db, agentId: number, instanceId: number, durableRunId: string) {
    const run = await db.get('SELECT id FROM job_instances WHERE id=? AND agent_id=? AND run_id=? AND status IN (\'queued\',\'dispatched\',\'running\')', instanceId, agentId, durableRunId);
    if (!run)
        throw new ExecutionDenied('Execution credential requires a current owned run.');
    const { issueMcpApiKeyForAgent } = await import('../../lib/mcpApiAuth');
    const key = await issueMcpApiKeyForAgent(db, agentId, 'run-scoped execution broker', 'scoped');
    await db.run("UPDATE mcp_api_keys SET expires_at=to_char((now()+interval '1 hour') AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') WHERE id=?", key.keyId);
    await db.run("INSERT INTO execution_credential_scopes(key_id,agent_id,instance_id,durable_run_id,expires_at) VALUES(?,?,?,?,now()+interval '1 hour')", key.keyId, agentId, instanceId, durableRunId);
    return key.apiKey;
}
