import type { ProviderSlug, ProviderRecord } from '@/lib/api';

export interface AgentModelOption {
  value: string;
  label: string;
}

type ModelSource =
  | { type: 'static'; models: AgentModelOption[] }
  | { type: 'dynamic' }
  | { type: 'freeform' };

const OPENAI_AGENT_MODELS: AgentModelOption[] = [
  { value: 'openai/gpt-5.5', label: 'GPT-5.5' },
  { value: 'openai/gpt-5.4', label: 'GPT-5.4' },
];

export const MINIMAX_AGENT_MODELS: AgentModelOption[] = [
  { value: 'MiniMax-M2.7', label: 'MiniMax M2.7' },
  { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed' },
  { value: 'MiniMax-M2.5', label: 'MiniMax M2.5' },
  { value: 'MiniMax-M2.5-highspeed', label: 'MiniMax M2.5 Highspeed' },
  { value: 'MiniMax-M2.5-Lightning', label: 'MiniMax M2.5 Lightning' },
];

export const PROVIDER_MODEL_SOURCES: Record<ProviderSlug, ModelSource> = {
  anthropic: {
    type: 'static',
    models: [
      { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
      { value: 'anthropic/claude-opus-4-6', label: 'Claude Opus 4.6' },
    ],
  },
  openai: { type: 'static', models: OPENAI_AGENT_MODELS },
  google: {
    type: 'static',
    models: [
      { value: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { value: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
  },
  openrouter: {
    type: 'static',
    models: [
      { value: 'openrouter/auto', label: 'OpenRouter Auto' },
      { value: 'openai/gpt-5.5', label: 'GPT-5.5 via OpenRouter' },
      { value: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6 via OpenRouter' },
    ],
  },
  ollama: { type: 'freeform' },
  'openai-codex': {
    type: 'static',
    models: OPENAI_AGENT_MODELS.map(model => ({ ...model, label: `${model.label} (Codex)` })),
  },
  'mlx-studio': { type: 'freeform' },
  minimax: { type: 'dynamic' },
};

export const AGENT_MODEL_OPTIONS: AgentModelOption[] = Object.values(PROVIDER_MODEL_SOURCES)
  .flatMap(source => source.type === 'static' ? source.models : []);

export const PROVIDER_LABELS: Record<ProviderSlug, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  'openai-codex': 'OpenAI Codex (OAuth)',
  'mlx-studio': 'MLX Studio',
  minimax: 'MiniMax',
};

/** Providers that require dynamic model fetching (no static model list) */
export const DYNAMIC_MODEL_PROVIDERS: ProviderSlug[] = Object.entries(PROVIDER_MODEL_SOURCES)
  .filter(([, source]) => source.type === 'dynamic')
  .map(([slug]) => slug as ProviderSlug);

export function getConnectedProviders(providers: ProviderRecord[]): ProviderRecord[] {
  return providers.filter(provider => provider.status === 'connected');
}

export function getAgentProviderOptions(providers: ProviderRecord[]) {
  return getConnectedProviders(providers).map(provider => ({
    value: provider.slug,
    label: provider.display_name || PROVIDER_LABELS[provider.slug],
  }));
}

export function getAgentModelOptionsForProvider(provider: string | null | undefined) {
  if (!provider) return [];
  const source = PROVIDER_MODEL_SOURCES[provider as ProviderSlug];
  return source?.type === 'static' ? source.models : [];
}

export function getDefaultAgentModelForProvider(provider: string | null | undefined) {
  return getAgentModelOptionsForProvider(provider)[0]?.value ?? null;
}

export function getAgentModelLabel(model: string | null | undefined) {
  if (!model) return 'Default (inherit)';
  return AGENT_MODEL_OPTIONS.find(option => option.value === model)?.label
    ?? MINIMAX_AGENT_MODELS.find(option => option.value === model)?.label
    ?? model;
}

export function isProviderConnected(providers: ProviderRecord[], provider: string | null | undefined) {
  return !!provider && getConnectedProviders(providers).some(item => item.slug === provider);
}

export function isModelAllowedForProvider(model: string | null | undefined, provider: string | null | undefined) {
  if (!model) return true;
  return !!provider && !!PROVIDER_MODEL_SOURCES[provider as ProviderSlug];
}

/** Returns true for providers that accept freeform model name entry (no fixed model list) */
export function isLocalModelProvider(provider: string | null | undefined): boolean {
  return !!provider && PROVIDER_MODEL_SOURCES[provider as ProviderSlug]?.type === 'freeform';
}

/** Returns true for providers that fetch their model list dynamically from an external API */
export function isDynamicModelProvider(provider: string | null | undefined): boolean {
  return !!provider && PROVIDER_MODEL_SOURCES[provider as ProviderSlug]?.type === 'dynamic';
}

/**
 * Returns true for providers that should only appear when the agent runtime is OpenClaw.
 * MiniMax requires the OpenClaw runtime to work correctly.
 */
export function isOpenClawOnlyProvider(provider: string | null | undefined): boolean {
  return provider === 'minimax' || provider === 'openai-codex';
}
