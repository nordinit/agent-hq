import fs from 'fs';
import path from 'path';
import { preflightMcpServer } from '../claudeCode/mcpPreflight';
import { redactSensitiveRuntimeText } from '../sensitiveText';

function matches(pattern: string, name: string): boolean {
  const normalized = pattern.trim();
  if (!normalized) return false;
  const escaped = normalized.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`).test(name);
}

/** Probe precisely the generated bundle, without consulting OpenClaw's global registry. */
export async function probeOpenClawMcpBundle(params: {
  bundlePath: string;
  workingDirectory: string;
  serverNames: string[];
  requiredToolsByServerName: Record<string, string[]>;
}): Promise<void> {
  const content = fs.readFileSync(params.bundlePath, 'utf8');
  const parsed = JSON.parse(content) as { mcpServers?: Record<string, Record<string, unknown>>; agentHqServerNames?: Record<string, string> };
  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) {
    throw new Error('OpenClaw MCP bundle has no server map');
  }
  for (const serverName of params.serverNames) {
    const server = parsed.mcpServers[parsed.agentHqServerNames?.[serverName] ?? serverName];
    if (!server || typeof server !== 'object') throw new Error(`OpenClaw MCP server "${serverName}" was not materialized`);
    const required = params.requiredToolsByServerName[serverName] ?? [];
    // OpenClaw applies these filters after tools/list. Verify that required
    // methods are allowed, not merely advertised by the underlying server.
    const filters = server.toolFilter as { include?: string[]; exclude?: string[] } | undefined;
    const denied = required.filter(name => filters?.exclude?.some(pattern => matches(pattern, name))
      || (filters?.include?.length && !filters.include.some(pattern => matches(pattern, name))));
    if (denied.length) throw new Error(`OpenClaw MCP server "${serverName}" filters required tool(s): ${denied.join(', ')}`);
    const result = await preflightMcpServer(serverName, {
      ...server,
      cwd: typeof server.cwd === 'string' ? path.resolve(params.workingDirectory, server.cwd) : params.workingDirectory,
    }, 20_000, required);
    if (!result.ok) {
      throw new Error(redactSensitiveRuntimeText(`OpenClaw MCP server "${serverName}" startup probe failed: ${result.error}`));
    }
  }
  if (fs.readFileSync(params.bundlePath, 'utf8') !== content) {
    throw new Error('OpenClaw MCP configuration changed during startup checks; retry with the current configuration');
  }
}
