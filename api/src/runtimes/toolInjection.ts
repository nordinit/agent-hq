import {resolvePublishedRows} from '../domains/execution/authority';
import { fetchEffectiveAgentToolRows } from '../domains/teams/effectiveCapabilities';
import { type Db } from "../db/adapter/types";


// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentToolRecord {
  id: number;
  tenant_id: number;
  agent_tenant_id: number;
  assignment_id: number;
  name: string;
  slug: string;
  description: string;
  implementation_type: 'bash' | 'shell' | 'script' | 'mcp' | 'function' | 'http';
  implementation_body: string;
  input_schema: string; // JSON string
  permissions: 'read_only' | 'read_write' | 'exec' | 'network';
  tags: string; // JSON array string
  enabled: number;
  overrides: string; // JSON string
  assignment_enabled: number;
}

// ── DB fetch ─────────────────────────────────────────────────────────────────

/**
 * fetchAgentTools — every enabled tool an agent can run.
 *
 * The effective set is the union of the agent's own assignments and those of every team it
 * belongs to, with agent-level rows winning; see domains/teams/effectiveCapabilities.ts for the
 * precedence rule. Returns only tools where the tool itself and the winning assignment are both
 * enabled.
 */
export async function fetchAgentTools(db: Db, agentId: number): Promise<AgentToolRecord[]> {
  const rows = await resolvePublishedRows(db,agentId,'tool',await fetchEffectiveAgentToolRows(db, agentId)) as unknown as AgentToolRecord[];

  try {
    // Evidence only — both paths are already excluded by the effective query's tenant joins.
    // Teams are counted here too because they are a second route into `tools`, and a grant
    // silently dropped for tenant reasons should still be visible in the log.
    const stale = await db.get(`
      SELECT
        (SELECT COUNT(*)
           FROM agent_tool_assignments ata
           JOIN agents a ON a.id = ata.agent_id
           JOIN tools t ON t.id = ata.tool_id
          WHERE ata.agent_id = ?
            AND ata.enabled = 1
            AND t.enabled = 1
            AND t.tenant_id <> a.tenant_id) AS agent_count,
        (SELECT COUNT(*)
           FROM team_members tm
           JOIN teams te ON te.id = tm.team_id
           JOIN agents a ON a.id = tm.agent_id
           JOIN team_tool_assignments tta ON tta.team_id = te.id
           JOIN tools t ON t.id = tta.tool_id
          WHERE tm.agent_id = ?
            AND tm.enabled = 1
            AND te.enabled = 1
            AND te.deleted_at IS NULL
            AND tta.enabled = 1
            AND t.enabled = 1
            AND (t.tenant_id <> a.tenant_id OR te.tenant_id <> a.tenant_id)) AS team_count
    `, agentId, agentId) as { agent_count?: number; team_count?: number } | undefined;
    const agentCount = Number(stale?.agent_count ?? 0);
    const teamCount = Number(stale?.team_count ?? 0);
    if (agentCount > 0) {
      console.warn(`[toolInjection] Suppressed ${agentCount} cross-tenant tool assignment(s) for agent #${agentId}`);
    }
    if (teamCount > 0) {
      console.warn(`[toolInjection] Suppressed ${teamCount} cross-tenant team tool assignment(s) for agent #${agentId}`);
    }
  } catch { /* best-effort stale assignment evidence only */ }

  return rows;
}

// Execution lives in domains/execution/invoke.ts; runtime shims use the broker.
