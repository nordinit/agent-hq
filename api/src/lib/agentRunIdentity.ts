/** A client's immutable dispatch identity; never infer it from the agent's latest run. */
export interface AgentRunIdentity {
  instanceId: number;
  durableRunId: string;
}

export function parseAgentRunIdentity(instance: unknown, durable: unknown): AgentRunIdentity | null {
  const instanceId = Number(instance);
  return Number.isSafeInteger(instanceId) && instanceId > 0
    && typeof durable === 'string' && durable.trim().length > 0
    ? { instanceId, durableRunId: durable.trim() } : null;
}

export function runIdentityFromEnv(env: NodeJS.ProcessEnv): AgentRunIdentity | null {
  return parseAgentRunIdentity(env.AGENT_HQ_INSTANCE_ID, env.AGENT_HQ_DURABLE_RUN_ID);
}

export function agentRunHeaders(identity: AgentRunIdentity | null): Record<string, string> {
  return identity ? {
    'x-agent-hq-instance-id': String(identity.instanceId),
    'x-agent-hq-durable-run-id': identity.durableRunId,
  } : {};
}

export function pinMcpRunIdentity(servers: Record<string, Record<string, unknown>>, identity: AgentRunIdentity): void {
  for (const [name, server] of Object.entries(servers)) {
    const env = server.env as Record<string, unknown> | undefined;
    if (!name.startsWith('agent-hq') && !env?.AGENT_HQ_MCP_API_KEY) continue;
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
