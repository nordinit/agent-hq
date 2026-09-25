import { getAgentHqBaseUrl } from '../agentHqBaseUrl';
import { isUiSessionExpired, redirectToLogin } from '../sessionExpiry';

export const getApiBase = () => {
  // Browser clients should always use the UI origin and rely on Next rewrites / route handlers.
  if (typeof window !== 'undefined') return '';
  return getAgentHqBaseUrl();
};

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text();
    let errorMsg = `API error ${res.status}`;
    try {
      const json = JSON.parse(body) as { error?: string };
      errorMsg = json.error ?? errorMsg;
      if (isUiSessionExpired(res.status, json)) redirectToLogin();
    } catch { /* ignore */ }
    throw new Error(errorMsg);
  }

  return res.json() as Promise<T>;
}
