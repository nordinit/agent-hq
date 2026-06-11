import { getDb } from '../../db/client';

export const CONNECTABLE_PROVIDER_SLUGS = ['anthropic', 'openai', 'openai-codex', 'google', 'ollama', 'mlx-studio', 'minimax'] as const;

const AGENT_MODEL_PROVIDER_PREFIX: Record<string, string> = {
  'anthropic/claude-sonnet-4-6': 'anthropic',
  'anthropic/claude-opus-4-6': 'anthropic',
  'openai/gpt-5.5': 'openai-codex',
  'openai/gpt-5.4': 'openai-codex',
};

const DEFAULT_AGENT_MODEL_BY_PROVIDER: Record<string, string> = {
  anthropic: 'anthropic/claude-sonnet-4-6',
  'openai-codex': 'openai/gpt-5.5',
};

const DEFAULT_SCHEMA_SAFE_AGENT_PROVIDER = 'anthropic';

// Local/OpenAI-compatible providers that accept freeform model names (no fixed model list)
const LOCAL_MODEL_PROVIDER_SLUGS: string[] = ['ollama', 'mlx-studio', 'minimax'];

export function getConnectedProviderSlugs(tenantId: number): string[] {
  const db = getDb();
  const rows = db.prepare(`SELECT slug FROM provider_config WHERE tenant_id = ? AND status = 'connected'`).all(tenantId) as Array<{ slug: string }>;
  return rows.map(row => row.slug);
}

export function validateAgentProviderSelection(tenantId: number, preferredProvider: string | null | undefined, model: string | null | undefined): string | null {
  if (!preferredProvider) return null;
  if (!CONNECTABLE_PROVIDER_SLUGS.includes(preferredProvider as typeof CONNECTABLE_PROVIDER_SLUGS[number])) {
    return `preferred_provider must be one of: ${CONNECTABLE_PROVIDER_SLUGS.join(', ')}`;
  }
  const connectedProviders = getConnectedProviderSlugs(tenantId);
  if (!connectedProviders.includes(preferredProvider)) {
    return `preferred_provider '${preferredProvider}' is not currently connected`;
  }
  if (model) {
    // Local providers (Ollama, MLX Studio) accept any freeform model name.
    if (LOCAL_MODEL_PROVIDER_SLUGS.includes(preferredProvider)) return null;
    const expectedProvider = AGENT_MODEL_PROVIDER_PREFIX[model];
    if (!expectedProvider) {
      return `model '${model}' is not allowed for agent preferences`;
    }
    if (expectedProvider !== preferredProvider) {
      return `model '${model}' does not belong to preferred_provider '${preferredProvider}'`;
    }
  }
  return null;
}

export function defaultAgentModelForProvider(preferredProvider: string | null | undefined): string | null {
  if (!preferredProvider) return null;
  return DEFAULT_AGENT_MODEL_BY_PROVIDER[preferredProvider] ?? null;
}

export function resolveSchemaSafePreferredProvider(connectedProviders: string[]): string {
  return connectedProviders.includes('openai')
    ? 'openai'
    : connectedProviders[0] ?? DEFAULT_SCHEMA_SAFE_AGENT_PROVIDER;
}

export function shouldSkipProviderValidationForRuntime(runtimeType: string, preferredProviderInput: string | null | undefined): boolean {
  return runtimeType === 'hermes' && (preferredProviderInput === undefined || preferredProviderInput === null);
}
