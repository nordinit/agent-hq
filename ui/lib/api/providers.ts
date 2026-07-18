import { apiFetch } from './http';
import type {
  DiscoveredProviderConnection,
  ProviderConnectionRecord,
  ProviderGateResponse,
  ProviderListResponse,
  ProviderSaveResponse,
  ProviderSlug,
  RuntimeProviderCapability,
} from './types';

export const providersClient = {
// Providers
getProviders: () => apiFetch<ProviderListResponse>('/api/v1/providers'),
getProviderGate: () => apiFetch<ProviderGateResponse>('/api/v1/providers/gate'),
createProvider: (data: { slug: ProviderSlug; display_name?: string; config: Record<string, unknown> }) =>
  apiFetch<ProviderSaveResponse>('/api/v1/providers', { method: 'POST', body: JSON.stringify(data) }),
updateProvider: (id: number, data: { display_name?: string; config: Record<string, unknown> }) =>
  apiFetch<ProviderSaveResponse>(`/api/v1/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
revalidateProvider: (id: number) =>
  apiFetch<{ ok: boolean; status: string; error: string | null; onboarding_provider_gate_passed: boolean }>(`/api/v1/providers/${id}/validate`, { method: 'POST' }),
deleteProvider: (id: number) =>
  apiFetch<{ ok: boolean; onboarding_provider_gate_passed: boolean }>(`/api/v1/providers/${id}`, { method: 'DELETE' }),
initiateOAuth: (slug: ProviderSlug) =>
  apiFetch<{ ok: boolean; message: string; oauthUrl?: string }>(`/api/v1/providers/${slug}/oauth/initiate`, { method: 'POST' }),
exchangeOAuth: (slug: ProviderSlug, callbackUrl: string) =>
  apiFetch<{ ok: boolean; message: string }>(`/api/v1/providers/${slug}/oauth/exchange`, { method: 'POST', body: JSON.stringify({ callbackUrl }) }),
setupToken: (slug: ProviderSlug, token: string) =>
  apiFetch<{ ok: boolean; message: string }>(`/api/v1/providers/${slug}/setup-token`, { method: 'POST', body: JSON.stringify({ token }) }),
getMiniMaxModels: () =>
  apiFetch<{ models: Array<{ id: string; label: string }> }>('/api/v1/providers/minimax/models'),
getProviderModels: (slug: ProviderSlug) =>
  apiFetch<{ models: Array<{ id: string; label: string }>; source?: string }>(`/api/v1/providers/${slug}/models`),
getProviderConnectionRegistry: () =>
  apiFetch<{ providers: unknown[]; capabilities: RuntimeProviderCapability[] }>('/api/v1/provider-connections/registry'),
getProviderConnections: () =>
  apiFetch<{ connections: ProviderConnectionRecord[] }>('/api/v1/provider-connections'),
getProviderAuthInstructions: (data: { provider: string; runtime: string; auth_mode: string }) =>
  apiFetch<{ capability: RuntimeProviderCapability; instructions: { command: string; args: string[]; message: string } }>('/api/v1/provider-connections/auth-instructions', { method: 'POST', body: JSON.stringify(data) }),
discoverProviderConnections: (data: { provider: string; runtime: string; auth_mode: string; runtime_config?: Record<string, unknown>; agent_slug?: string }) =>
  apiFetch<{ capability: RuntimeProviderCapability; connections: DiscoveredProviderConnection[] }>('/api/v1/provider-connections/discover', { method: 'POST', body: JSON.stringify(data) }),
createProviderConnection: (data: {
  provider_slug: string;
  auth_mode: string;
  runtime_type: string;
  external_ref: string;
  display_name?: string;
  metadata?: Record<string, unknown>;
  runtime_config?: Record<string, unknown>;
  agent_slug?: string;
}) => apiFetch<ProviderConnectionRecord>('/api/v1/provider-connections', { method: 'POST', body: JSON.stringify(data) }),
validateProviderConnection: (id: number, runtimeConfig?: Record<string, unknown>) =>
  apiFetch<{ ok: boolean; status: string; error: string | null }>(`/api/v1/provider-connections/${id}/validate`, { method: 'POST', body: JSON.stringify({ runtime_config: runtimeConfig }) }),
deleteProviderConnection: (id: number) =>
  apiFetch<{ ok: boolean }>(`/api/v1/provider-connections/${id}`, { method: 'DELETE' }),
};
