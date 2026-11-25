/**
 * What each MCP server told a run's model it could do.
 *
 * Every server a run gets is recorded against that run with the definitions it advertised
 * (`tools/list`). Definitions are stored once per distinct server configuration and tool list
 * (agents.mcp_tool_snapshots); a run only adds a link row (runs.run_mcp_tool_snapshots).
 *
 * Servers that launch preflight already probed cost nothing extra. A server preflight skipped is
 * probed only when its configuration has no snapshot from the last day, and that probe runs after
 * the agent process has started, so recording never delays or fails a launch.
 */

import { createHash } from 'crypto';
import type { Db } from '../db/adapter/types';
import type { RuntimeBoundaryV1 } from './runtimeBoundary';
import {
  preflightMcpServer,
  type McpAdvertisedTool,
  type McpPreflightResult,
} from './claudeCode/mcpPreflight';

const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const PROBE_TIMEOUT_MS = 15_000;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Characters one definition adds to the request, as the model receives it (JSON). */
export function mcpToolDefinitionChars(tool: McpAdvertisedTool): number {
  return JSON.stringify(tool).length;
}

/** `agency-crm__agent-42` → `agency-crm`. */
export function mcpServerSlugFromRunName(serverName: string): string {
  return serverName.replace(/__agent-\d+$/, '');
}

async function upsertSnapshot(
  db: Db,
  tenantId: number,
  serverName: string,
  configFingerprint: string,
  tools: McpAdvertisedTool[],
): Promise<number> {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const definitionsFingerprint = createHash('sha256').update(stable(sorted)).digest('hex');
  const definitionChars = sorted.reduce((sum, tool) => sum + mcpToolDefinitionChars(tool), 0);
  const server = await db.get<{ id: number }>(
    'SELECT id FROM mcp_servers WHERE tenant_id = ? AND slug = ? LIMIT 1',
    tenantId,
    mcpServerSlugFromRunName(serverName),
  );
  const row = await db.get<{ id: number }>(
    `INSERT INTO agents.mcp_tool_snapshots
       (tenant_id, mcp_server_id, server_name, config_fingerprint, definitions_fingerprint, tools, tool_count, definition_chars)
     VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)
     ON CONFLICT (tenant_id, config_fingerprint, definitions_fingerprint)
     DO UPDATE SET last_seen_at = now(), server_name = EXCLUDED.server_name
     RETURNING id`,
    tenantId,
    server?.id ?? null,
    serverName,
    configFingerprint,
    definitionsFingerprint,
    JSON.stringify(sorted),
    sorted.length,
    definitionChars,
  );
  return Number(row!.id);
}

async function linkRun(db: Db, tenantId: number, instanceId: number, serverName: string, snapshotId: number) {
  await db.run(
    `INSERT INTO runs.run_mcp_tool_snapshots (tenant_id, instance_id, server_name, snapshot_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (instance_id, server_name) DO UPDATE SET snapshot_id = EXCLUDED.snapshot_id, recorded_at = now()`,
    tenantId,
    instanceId,
    serverName,
    snapshotId,
  );
}

export interface RecordRunMcpToolSnapshotsInput {
  db: Db | null;
  tenantId: number | null;
  instanceId: number | null | undefined;
  boundary: RuntimeBoundaryV1 | null | undefined;
  /** Preflight results from this launch; their definitions are recorded without a new probe. */
  preflightResults: readonly McpPreflightResult[];
  /** The materialized server configs, by run server name, for servers preflight did not probe. */
  servers: Record<string, Record<string, unknown>>;
  /** Overridable for tests. */
  probe?: typeof preflightMcpServer;
  now?: () => number;
}

/**
 * Record this run's MCP tool definitions. Never throws: recording is observability, so a failure
 * is logged and the run carries on.
 */
export async function recordRunMcpToolSnapshots(input: RecordRunMcpToolSnapshotsInput): Promise<void> {
  const { db, tenantId, instanceId, boundary } = input;
  if (!db || tenantId == null || instanceId == null || !boundary) return;
  const fingerprints = new Map(boundary.tools.mcpServers.map((server) => [server.name, server.configFingerprint]));
  const probed = new Map(
    input.preflightResults
      .filter((result) => Array.isArray(result.tools))
      .map((result) => [result.serverName, result.tools!]),
  );
  const probe = input.probe ?? preflightMcpServer;
  const now = input.now ?? Date.now;

  for (const [serverName, configFingerprint] of fingerprints) {
    try {
      let tools = probed.get(serverName);
      if (!tools) {
        const recent = await db.get<{ id: number; last_seen_at: string | Date }>(
          `SELECT id, last_seen_at FROM agents.mcp_tool_snapshots
           WHERE tenant_id = ? AND config_fingerprint = ?
           ORDER BY last_seen_at DESC LIMIT 1`,
          tenantId,
          configFingerprint,
        );
        if (recent && now() - new Date(recent.last_seen_at).getTime() < STALE_AFTER_MS) {
          await linkRun(db, tenantId, instanceId, serverName, Number(recent.id));
          continue;
        }
        const config = input.servers[serverName];
        if (!config) continue;
        const result = await probe(serverName, config, PROBE_TIMEOUT_MS, []);
        if (!Array.isArray(result.tools)) continue;
        tools = result.tools;
      }
      const snapshotId = await upsertSnapshot(db, tenantId, serverName, configFingerprint, tools);
      await linkRun(db, tenantId, instanceId, serverName, snapshotId);
    } catch (error) {
      console.warn(
        `[mcpToolSnapshots] run #${instanceId}: could not record tools for ${serverName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
