import { apiFetch } from './http';
import type { ProviderGateResponse, ProviderListResponse, ProviderSaveResponse, ProviderSlug } from './types';

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
};
