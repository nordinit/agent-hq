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
    const source = PROVIDER_MODEL_SOURCES[preferredProvider as ConnectableProviderSlug];
    if (source.type === 'freeform') return null;
    if (!source.models.some(option => option.id === model)) {
      const matchingProviders = CONNECTABLE_PROVIDER_SLUGS.filter(slug => {
        const candidate = PROVIDER_MODEL_SOURCES[slug];
        return candidate.type !== 'freeform' && candidate.models.some(option => option.id === model);
      });
      if (matchingProviders.length > 0) {
        return `model '${model}' does not belong to preferred_provider '${preferredProvider}'`;
      }
      return `model '${model}' is not allowed for agent preferences`;
    }
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
