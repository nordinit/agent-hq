import fs from 'fs';
import path from 'path';

/** A client's immutable dispatch identity; never infer it from the agent's latest run. */
export interface AgentRunIdentity {
  instanceId: number;
  durableRunId: string;
}

export const AGENT_HQ_RUN_IDENTITY_FILE_ENV = 'AGENT_HQ_RUN_IDENTITY_FILE';

export function parseAgentRunIdentity(instance: unknown, durable: unknown): AgentRunIdentity | null {
  const instanceId = Number(instance);
  return Number.isSafeInteger(instanceId) && instanceId > 0
    && typeof durable === 'string' && durable.trim().length > 0
    ? { instanceId, durableRunId: durable.trim() } : null;
}

export function runIdentityFromEnv(env: NodeJS.ProcessEnv): AgentRunIdentity | null {
  return parseAgentRunIdentity(env.AGENT_HQ_INSTANCE_ID, env.AGENT_HQ_DURABLE_RUN_ID);
}

export function readRunIdentityFile(filePath: string): AgentRunIdentity | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    return parseAgentRunIdentity(value.instance_id, value.durable_run_id);
  } catch {
    return null;
  }
}

export function writeRunIdentityFile(filePath: string, identity: AgentRunIdentity): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    instance_id: identity.instanceId,
    durable_run_id: identity.durableRunId,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
  // A client reading during dispatch sees the previous or the next run, never a partial file.
  fs.renameSync(temporary, filePath);
}

/** Env pins are fixed for the process; an identity file is re-read because dispatch rewrites it. */
export function runIdentitySourceFromEnv(env: NodeJS.ProcessEnv): () => AgentRunIdentity | null {
  const pinned = runIdentityFromEnv(env);
  const file = env[AGENT_HQ_RUN_IDENTITY_FILE_ENV]?.trim();
  return () => pinned ?? (file ? readRunIdentityFile(file) : null);
}

export function agentRunHeaders(identity: AgentRunIdentity | null): Record<string, string> {
  return identity ? {
    'x-agent-hq-instance-id': String(identity.instanceId),
    'x-agent-hq-durable-run-id': identity.durableRunId,
  } : {};
}

function isAgentHqServer(name: string, env: Record<string, unknown> | undefined): boolean {
  return name.startsWith('agent-hq') || Boolean(env?.AGENT_HQ_MCP_API_KEY);
}

export function pinMcpRunIdentity(servers: Record<string, Record<string, unknown>>, identity: AgentRunIdentity): void {
  for (const [name, server] of Object.entries(servers)) {
    const env = server.env as Record<string, unknown> | undefined;
    if (!isAgentHqServer(name, env)) continue;
    // Pin at materialization time. An old process retains its old identity even
    // after another dispatch replaces the workspace's MCP configuration.
    server.env = {
      ...env,
      AGENT_HQ_INSTANCE_ID: String(identity.instanceId),
      AGENT_HQ_DURABLE_RUN_ID: identity.durableRunId,
    };
    if (server.url) server.headers = {
      ...(server.headers as Record<string, unknown> | undefined),
      ...agentRunHeaders(identity),
    };
  }
}

/**
 * For stdio configs shared by every dispatch in a workspace (OpenClaw bundles).
 * A pinned run would change the config on each dispatch, and the gateway
 * reloads the plugin, leaking heap, on every change.
 */
export function pinMcpRunIdentityFile(servers: Record<string, Record<string, unknown>>, filePath: string): void {
  for (const [name, server] of Object.entries(servers)) {
    const env = server.env as Record<string, unknown> | undefined;
    if (!isAgentHqServer(name, env)) continue;
    const next: Record<string, unknown> = { ...env, [AGENT_HQ_RUN_IDENTITY_FILE_ENV]: filePath };
    delete next.AGENT_HQ_INSTANCE_ID;
    delete next.AGENT_HQ_DURABLE_RUN_ID;
    server.env = next;
  }
}
