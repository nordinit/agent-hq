import { execFileSync, execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { type Db } from "../db/adapter/types";

const DEFAULT_TOOL_TIMEOUT_MS = 180_000;

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
 * fetchAgentTools — query the DB for all enabled tools assigned to an agent.
 * Returns only tools where both the tool and the assignment are enabled.
 */
export async function fetchAgentTools(db: Db, agentId: number): Promise<AgentToolRecord[]> {
  const rows = await db.all(`
    SELECT ata.id as assignment_id, ata.overrides, ata.enabled as assignment_enabled,
           a.tenant_id as agent_tenant_id,
           t.*
    FROM agent_tool_assignments ata
    JOIN agents a ON a.id = ata.agent_id
    JOIN tools t ON t.id = ata.tool_id AND t.tenant_id = a.tenant_id
    WHERE ata.agent_id = ?
      AND ata.enabled = 1
      AND t.enabled = 1
    ORDER BY t.name ASC
  `, agentId) as AgentToolRecord[];

  try {
    const stale = await db.get(`
      SELECT COUNT(*) AS count
      FROM agent_tool_assignments ata
      JOIN agents a ON a.id = ata.agent_id
      JOIN tools t ON t.id = ata.tool_id
      WHERE ata.agent_id = ?
        AND ata.enabled = 1
        AND t.enabled = 1
        AND t.tenant_id <> a.tenant_id
    `, agentId) as { count?: number } | undefined;
    const count = Number(stale?.count ?? 0);
    if (count > 0) {
      console.warn(`[toolInjection] Suppressed ${count} cross-tenant tool assignment(s) for agent #${agentId}`);
    }
  } catch { /* best-effort stale assignment evidence only */ }

  return rows;
}

// ── Tool execution ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readTimeoutMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TOOL_TIMEOUT_MS;
}

function toolExecutionEnv(input: Record<string, unknown>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TOOL_INPUT: JSON.stringify(input),
    ...Object.fromEntries(
      Object.entries(input).map(([k, v]) => [
        `TOOL_${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`,
        typeof v === 'string' ? v : JSON.stringify(v),
      ]),
    ),
  };
}

/**
 * executeToolImplementation — run a tool's implementation and return the result.
 *
 * For bash tools: executes the implementation_body as a shell command in the
 * agent's workspace directory, with tool input passed as TOOL_INPUT env var.
 *
 * Errors are caught and returned as structured error messages, never thrown.
 */
export function executeToolImplementation(
  toolRecord: AgentToolRecord,
  input: Record<string, unknown>,
  workingDirectory?: string,
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  try {
    switch (toolRecord.implementation_type) {
      case 'bash': {
        const command = toolRecord.implementation_body;
        if (!command) {
          return {
            content: [{ type: 'text', text: 'Error: tool has no implementation body' }],
            isError: true,
          };
        }

        const result = execSync(command, {
          encoding: 'utf-8',
          timeout: DEFAULT_TOOL_TIMEOUT_MS,
          cwd: workingDirectory || process.cwd(),
          env: toolExecutionEnv(input),
          maxBuffer: 1024 * 1024, // 1MB
        });

        return { content: [{ type: 'text', text: result }] };
      }

      case 'script': {
        const body = parseJsonRecord(toolRecord.implementation_body);
        const command = typeof body.command === 'string' && body.command.trim() ? body.command.trim() : undefined;
        const inline = typeof body.inline === 'string' && body.inline.trim() ? body.inline : undefined;
        const args = Array.isArray(body.args)
          ? body.args.filter((entry): entry is string => typeof entry === 'string')
          : [];
        const timeout = readTimeoutMs(body.timeoutMs);
        const cwd = workingDirectory || process.cwd();
        const env = toolExecutionEnv(input);

        if (command && !inline) {
          const result = execFileSync(command, args, {
            encoding: 'utf-8',
            timeout,
            cwd,
            env,
            maxBuffer: 1024 * 1024,
          });
          return { content: [{ type: 'text', text: result }] };
        }

        if (!inline) {
          return {
            content: [{ type: 'text', text: 'Error: script tool has no inline body or command' }],
            isError: true,
          };
        }

        const tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-hq-tool-'));
        const tempFile = path.join(tempDir, 'inline-script');
        try {
          writeFileSync(tempFile, inline, 'utf8');
          const result = execFileSync(command || '/bin/sh', [tempFile, ...args], {
            encoding: 'utf-8',
            timeout,
            cwd,
            env,
            maxBuffer: 1024 * 1024,
          });
          return { content: [{ type: 'text', text: result }] };
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }

      case 'function': {
        return {
          content: [{ type: 'text', text: `Error: function tools are not yet supported at runtime` }],
          isError: true,
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Error: unsupported implementation type "${toolRecord.implementation_type}"` }],
          isError: true,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stderr = (err as any)?.stderr;
    const errorText = stderr ? `${message}\n\nStderr:\n${stderr}` : message;

    return {
      content: [{ type: 'text', text: `Error executing tool "${toolRecord.slug}": ${errorText}` }],
      isError: true,
    };
  }
}

// ── Note on the removed SDK MCP server ───────────────────────────────────────
//
// `createAgentToolServer()` used to build an IN-PROCESS MCP server here so the
// Claude Agent SDK could expose these registry tools to a claude-code run.
// The claude-code runtime is now CLI-backed (runtimes/claudeCode/), so the tools
// are served out-of-process by src/bin/agent-tool-mcp.ts instead — which also
// runs them in the run's own cwd rather than inside the API process, and makes
// them reachable from Codex/Hermes rather than claude-code only.
//
// Removing it dropped the last `@anthropic-ai/claude-agent-sdk` import in the
// codebase. `fetchAgentTools` and `executeToolImplementation` below are still
// live — routes/tools.ts serves them over REST.
