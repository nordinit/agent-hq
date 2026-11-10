import type { Db } from '../../db/adapter/types';
/** Read-only migration report. Never includes key hashes, plaintext keys or executable bodies. */
export async function executionReadiness(db: Db, tenantId: number) {
    const keys = await db.all(`SELECT k.id,k.agent_id,k.key_role,k.revoked_at,k.expires_at FROM mcp_api_keys k WHERE k.tenant_id=? ORDER BY k.id`, tenantId);
    const agents = await db.all(`SELECT a.id,a.name,a.project_id,a.runtime_type,a.enabled,
    EXISTS(SELECT 1 FROM agent_mcp_capability_policies p WHERE p.agent_id=a.id AND p.capability_key='host.execute' AND p.enabled=1) AS host_execution_granted,
    EXISTS(SELECT 1 FROM execution_bindings b JOIN executable_revisions r ON r.id=b.revision_id
      WHERE b.tenant_id=a.tenant_id AND b.subject_kind='agent' AND b.subject_id=a.id AND b.resource_kind='agent_runtime'
        AND b.resource_id=a.id AND b.enabled=1 AND (b.expires_at IS NULL OR b.expires_at>now())
        AND r.published_at IS NOT NULL AND r.revoked_at IS NULL) AS direct_runtime_approval
    FROM agents a WHERE a.tenant_id=? ORDER BY a.id`, tenantId);
    const bindings = await db.all(`SELECT b.subject_kind,b.subject_id,b.resource_kind,b.resource_id,b.revision_id,b.enabled,b.expires_at,r.digest,r.published_at,r.revoked_at FROM execution_bindings b JOIN executable_revisions r ON r.id=b.revision_id WHERE b.tenant_id=? ORDER BY b.id`, tenantId);
    const active = await db.all("SELECT id,agent_id,run_id,status FROM job_instances WHERE tenant_id=? AND status IN ('queued','dispatched','running') ORDER BY id", tenantId);
    const unapproved = await db.all(`SELECT 'agent' AS subject_kind,a.agent_id AS subject_id,'tool' AS resource_kind,a.tool_id AS resource_id FROM agent_tool_assignments a JOIN agents x ON x.id=a.agent_id
    WHERE x.tenant_id=? AND a.enabled=1 AND NOT EXISTS(SELECT 1 FROM execution_bindings b WHERE b.subject_kind='agent' AND b.subject_id=a.agent_id AND b.resource_kind='tool' AND b.resource_id=a.tool_id AND b.enabled=1)
    UNION ALL SELECT 'agent',a.agent_id,'mcp_server',a.mcp_server_id FROM agent_mcp_assignments a JOIN agents x ON x.id=a.agent_id WHERE x.tenant_id=? AND a.enabled=1 AND NOT EXISTS(SELECT 1 FROM execution_bindings b WHERE b.subject_kind='agent' AND b.subject_id=a.agent_id AND b.resource_kind='mcp_server' AND b.resource_id=a.mcp_server_id AND b.enabled=1)
    UNION ALL SELECT 'team',a.team_id,'tool',a.tool_id FROM team_tool_assignments a JOIN teams x ON x.id=a.team_id WHERE x.tenant_id=? AND a.enabled=1 AND NOT EXISTS(SELECT 1 FROM execution_bindings b WHERE b.subject_kind='team' AND b.subject_id=a.team_id AND b.resource_kind='tool' AND b.resource_id=a.tool_id AND b.enabled=1)
    UNION ALL SELECT 'team',a.team_id,'mcp_server',a.mcp_server_id FROM team_mcp_assignments a JOIN teams x ON x.id=a.team_id WHERE x.tenant_id=? AND a.enabled=1 AND NOT EXISTS(SELECT 1 FROM execution_bindings b WHERE b.subject_kind='team' AND b.subject_id=a.team_id AND b.resource_kind='mcp_server' AND b.resource_id=a.mcp_server_id AND b.enabled=1)`, tenantId, tenantId, tenantId, tenantId);
    return { tenant_id: tenantId, keys, agents, bindings, active_runs: active, assignments_without_direct_approval: unapproved, automatic_grants: false, notes: ['Team bindings must also be reviewed when assessing effective access.', 'Dependency integrity and current runtime-profile digest are rechecked at execution.', 'Inventory unauthenticated callers from report-mode logs before enforce-mode cutover.'] };
}
