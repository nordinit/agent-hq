/** What middleware.ts answers an API call with once the browser's session has ended. */
export const UI_SESSION_REQUIRED = 'ui_session_required';

export function isUiSessionExpired(status: number, body: unknown): boolean {
  return status === 401
    && typeof body === 'object'
    && body !== null
    && (body as { code?: unknown }).code === UI_SESSION_REQUIRED;
}

/** Sends the browser to sign in, returning to the current page afterwards. */
export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}
