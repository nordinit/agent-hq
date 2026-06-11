const DIRECT_SESSION_STORAGE_PREFIX = 'agent-hq:direct-chat-session:';

// crypto.randomUUID() requires a secure context (HTTPS); fall back for plain HTTP
export function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function sessionSlug(sessionKey: string | null | undefined, runtimeSlug?: string | null): string | null {
  if (runtimeSlug) return runtimeSlug;
  if (!sessionKey) return null;
  const parts = sessionKey.split(':');
  if (parts[0] !== 'agent') return null;
  if (parts.length === 5 && parts[4] === 'main') return parts[2] || null;
  return parts[1] || null;
}

export function buildDirectSessionKey(baseSessionKey: string, runtimeSlug?: string | null, channel = 'web'): string {
  const slug = sessionSlug(baseSessionKey, runtimeSlug);
  if (!slug) return baseSessionKey;
  return `agent:${slug}:${channel}:direct:shared`;
}

export function resolveInitialDirectSessionKey(
  baseSessionKey: string,
  storedSessionKey: string | null,
  runtimeSlug?: string | null,
  channel = 'web',
): string {
  const slug = sessionSlug(baseSessionKey, runtimeSlug);
  if (!slug) return storedSessionKey ?? baseSessionKey;
  const sharedSessionKey = buildDirectSessionKey(baseSessionKey, runtimeSlug, channel);
  if (storedSessionKey === sharedSessionKey) {
    return storedSessionKey;
  }
  return sharedSessionKey;
}

export function getStoredDirectSessionKey(agentId: number): string | null {
  try {
    return localStorage.getItem(`${DIRECT_SESSION_STORAGE_PREFIX}${agentId}`);
  } catch {
    return null;
  }
}

export function setStoredDirectSessionKey(agentId: number, sessionKey: string): void {
  try {
    localStorage.setItem(`${DIRECT_SESSION_STORAGE_PREFIX}${agentId}`, sessionKey);
  } catch {
    // ignore storage failures
  }
}
