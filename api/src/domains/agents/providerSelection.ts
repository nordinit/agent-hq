import { getDb } from '../../db/client';

export const CONNECTABLE_PROVIDER_SLUGS = ['anthropic', 'openai', 'openai-codex', 'google', 'openrouter', 'ollama', 'mlx-studio', 'minimax'] as const;
export type ConnectableProviderSlug = typeof CONNECTABLE_PROVIDER_SLUGS[number];

export type AgentModelSource =
  | { type: 'static'; models: Array<{ id: string; label: string }> }
  | { type: 'dynamic'; models: Array<{ id: string; label: string }> }
  | { type: 'freeform' };

const OPENAI_AGENT_MODELS = [
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
  { id: 'openai/gpt-5.4', label: 'GPT-5.4' },
];

export const MINIMAX_AGENT_MODELS = [
  { id: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
  { id: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed' },
  { id: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
  { id: 'MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed' },
  { id: 'MiniMax-M2.5-Lightning', label: 'MiniMax M2.5 Lightning' },
];

export const PROVIDER_MODEL_SOURCES: Record<ConnectableProviderSlug, AgentModelSource> = {
  anthropic: {
    type: 'static',
    models: [
      { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { id: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
    ],
  },
  openai: { type: 'static', models: OPENAI_AGENT_MODELS },
  google: {
    type: 'static',
    models: [
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  openrouter: {
    type: 'static',
    models: [
      { id: 'openrouter/auto', label: 'OpenRouter Auto' },
      { id: 'openai/gpt-5.5', label: 'GPT-5.5 via OpenRouter' },
      { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6 via OpenRouter' },
    ],
  },
  ollama: { type: 'freeform' },
  'openai-codex': {
    type: 'static',
    models: OPENAI_AGENT_MODELS.map(model => ({ ...model, label: `${model.label} (Codex)` })),
  },
  'mlx-studio': { type: 'freeform' },
  minimax: { type: 'dynamic', models: MINIMAX_AGENT_MODELS },
};

const DEFAULT_SCHEMA_SAFE_AGENT_PROVIDER = 'anthropic';

export async function getConnectedProviderSlugs(tenantId: number): Promise<string[]> {
  const db = getDb();
  const rows = await db.all(`SELECT slug FROM provider_config WHERE tenant_id = ? AND status = 'connected'`, tenantId) as Array<{ slug: string }>;
  const slugs = new Set(rows.map(row => row.slug));
  try {
    const connections = await db.all(`SELECT provider_slug FROM provider_connections WHERE tenant_id = ? AND status = 'connected'`, tenantId) as Array<{ provider_slug: string }>;
    connections.forEach(row => slugs.add(row.provider_slug));
  } catch { /* schema bootstrap tests may not create provider_connections */ }
  return Array.from(slugs);
}

export async function validateAgentProviderConnection(
  tenantId: number,
  runtimeType: string,
  preferredProvider: string | null | undefined,
  providerConnectionId: number | null | undefined,
): Promise<string | null> {
  if (providerConnectionId == null) return null;
  const db = getDb();
  let row: { provider_slug: string; runtime_type: string; status: string } | undefined;
  try {
    row = await db.get(`
      SELECT provider_slug, runtime_type, status
      FROM provider_connections
      WHERE id = ? AND tenant_id = ?
    `, providerConnectionId, tenantId) as typeof row;
  } catch {
    return 'provider connections are not available in the current schema';
  }
  if (!row) return `provider_connection_id ${providerConnectionId} was not found`;
  if (row.status !== 'connected') return `provider_connection_id ${providerConnectionId} is ${row.status}`;
  if (row.runtime_type !== runtimeType) return `provider_connection_id ${providerConnectionId} belongs to runtime '${row.runtime_type}', not '${runtimeType}'`;
  if (preferredProvider && row.provider_slug !== preferredProvider) {
    return `provider_connection_id ${providerConnectionId} is for '${row.provider_slug}', not '${preferredProvider}'`;
  }
  return null;
}

export async function validateAgentProviderSelection(tenantId: number, preferredProvider: string | null | undefined, model: string | null | undefined): Promise<string | null> {
  if (!preferredProvider) return null;
  if (!CONNECTABLE_PROVIDER_SLUGS.includes(preferredProvider as typeof CONNECTABLE_PROVIDER_SLUGS[number])) {
    return `preferred_provider must be one of: ${CONNECTABLE_PROVIDER_SLUGS.join(', ')}`;
  }
  const connectedProviders = await getConnectedProviderSlugs(tenantId);
  if (!connectedProviders.includes(preferredProvider)) {
    return `preferred_provider '${preferredProvider}' is not currently connected`;
  }
  return null;
}

export function defaultAgentModelForProvider(preferredProvider: string | null | undefined): string | null {
  if (!preferredProvider) return null;
  const source = PROVIDER_MODEL_SOURCES[preferredProvider as ConnectableProviderSlug];
  return source?.type === 'static' || source?.type === 'dynamic'
    ? source.models[0]?.id ?? null
    : null;
}

export function resolveSchemaSafePreferredProvider(connectedProviders: string[]): string {
  return connectedProviders.includes('openai')
    ? 'openai'
    : connectedProviders[0] ?? DEFAULT_SCHEMA_SAFE_AGENT_PROVIDER;
}

export function shouldSkipProviderValidationForRuntime(runtimeType: string, preferredProviderInput: string | null | undefined): boolean {
  return runtimeType === 'hermes' && (preferredProviderInput === undefined || preferredProviderInput === null);
}
