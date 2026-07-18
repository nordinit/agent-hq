export const PROVIDER_AUTH_MODES = ['api_key', 'oauth', 'subscription', 'local'] as const;
export type ProviderAuthMode = typeof PROVIDER_AUTH_MODES[number];

export interface ProviderDefinition {
  slug: string;
  label: string;
  modelPrefix: string;
  authModes: ProviderAuthMode[];
}

const PROVIDERS: ProviderDefinition[] = [
  { slug: 'anthropic', label: 'Anthropic', modelPrefix: 'anthropic/', authModes: ['api_key', 'subscription'] },
  { slug: 'openai', label: 'OpenAI', modelPrefix: 'openai/', authModes: ['api_key', 'oauth'] },
  { slug: 'google', label: 'Google / Gemini', modelPrefix: 'google/', authModes: ['api_key'] },
  { slug: 'openrouter', label: 'OpenRouter', modelPrefix: '', authModes: ['api_key'] },
  { slug: 'ollama', label: 'Ollama', modelPrefix: '', authModes: ['local'] },
  { slug: 'mlx-studio', label: 'MLX Studio', modelPrefix: '', authModes: ['local'] },
  { slug: 'minimax', label: 'MiniMax', modelPrefix: '', authModes: ['api_key'] },
];

export function listProviderDefinitions(): ProviderDefinition[] {
  return PROVIDERS.map(provider => ({ ...provider, authModes: [...provider.authModes] }));
}

export function getProviderDefinition(slug: string): ProviderDefinition | null {
  return PROVIDERS.find(provider => provider.slug === slug) ?? null;
}
