/**
 * The `/api/v1` proxy forwards requests to the API as the operator, so another website must not
 * be able to drive it through the signed-in operator's browser. A browser attaches `Origin` to
 * cross-origin requests; a same-origin request from the UI's own pages carries the UI's own
 * host. Requests without `Origin` (server-side callers) pass.
 */
export function isSameOriginProxyRequest(headers: Headers): boolean {
  const origin = headers.get('origin');
  if (origin === null) return true;
  let host: string;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    host = parsed.host.toLowerCase();
  } catch {
    return false;
  }
  // A reverse proxy in front of the UI may rewrite Host and report the public one here.
  // Browsers cannot set this header on a cross-origin request without a preflight, and the
  // preflight itself fails this check.
  const candidates = [headers.get('x-forwarded-host'), headers.get('host')]
    .flatMap(value => (value ?? '').split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return candidates.includes(host);
}
