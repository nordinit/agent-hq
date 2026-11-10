import type { Db } from '../db/adapter/types';
import { createExecutableDraft, publishExecutable, bindExecutable, type ExecutableKind } from '../domains/execution/authority';
import { replaceAgentMcpPermissionPolicy } from '../lib/mcpApiAuth';
/** Explicit test approvals; no production caller imports this module. */
export async function approveExecutableFixture(db: Db, tenantId: number, agentId: number, kind: ExecutableKind, resourceId: number) {
    for (const capability of ['tools.execute', 'host.execute'])
        await db.run('INSERT INTO agent_mcp_capability_policies(agent_id,capability_key,enabled) VALUES(?,?,1) ON CONFLICT(agent_id,capability_key) DO UPDATE SET enabled=1', agentId, capability);
    const revision = (await createExecutableDraft(db, tenantId, kind, resourceId, 'test-fixture'))!;
    await publishExecutable(db, tenantId, String(revision.id), String(revision.digest), 'test-fixture');
    await bindExecutable(db, tenantId, 'agent', agentId, String(revision.id), 'test-fixture');
    return revision;
}
/** Scope matrices use a reviewed delegator for policy writes; separation has its own negative tests. */
export async function replaceDelegatorFixturePolicy(...args: Parameters<typeof replaceAgentMcpPermissionPolicy>) {
    const [db, agentId, capabilities, revision, actor] = args;
    const delegates = capabilities.some(key => ['routing_rules.manage_project_scope', 'routing_transitions.manage_project_scope', 'workflow_definitions.manage_project_scope', 'recurring_task_series.manage_project_scope'].includes(key));
    return replaceAgentMcpPermissionPolicy(db, agentId, delegates ? [...new Set([...capabilities, 'runs.dispatch', 'host.execute'])] : capabilities, revision, actor);
}
