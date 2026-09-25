import crypto from 'crypto';

/**
 * The UI login session, verified here as well so the chat WebSocket — which the browser opens
 * straight against the API port — requires the same login as every UI page.
 *
 * The session is stateless: a cookie holding an expiry and an HMAC over it, keyed by a key
 * derived from AGENT_HQ_OPERATOR_TOKEN. The UI server and the API both hold the token, so either
 * can check a session without a shared store, and rotating the token ends every session at once.
 * Cookies are scoped to a host, not a port, which is what lets the API see the cookie the UI set.
 *
 * ui/lib/operatorSession.ts implements the same format with Web Crypto. Both test suites pin the
 * same vector, so the two cannot drift apart silently.
 */

export const OPERATOR_SESSION_VERSION = 'v1';
export const OPERATOR_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function hmac(key: crypto.BinaryLike, message: string): Buffer {
  return crypto.createHmac('sha256', key).update(message, 'utf8').digest();
}

/**
 * Derived from the token so two installs on one host — prod and dev side by side, say — keep
 * separate sessions instead of overwriting one shared cookie.
 */
export function operatorSessionCookieName(operatorToken: string): string {
  return `agent_hq_session_${hmac(operatorToken, 'agent-hq:session-cookie-name').toString('hex').slice(0, 12)}`;
}

function sessionSigningKey(operatorToken: string): Buffer {
  return hmac(operatorToken, 'agent-hq:operator-session:v1');
}

/** `v1.<expiry, unix seconds>.<base64url HMAC-SHA256 over "v1.<expiry>">` */
export function signOperatorSession(operatorToken: string, expiresAtSeconds: number): string {
  const payload = `${OPERATOR_SESSION_VERSION}.${expiresAtSeconds}`;
  return `${payload}.${hmac(sessionSigningKey(operatorToken), payload).toString('base64url')}`;
}

export function verifyOperatorSession(operatorToken: string, value: string | undefined, nowMs = Date.now()): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== OPERATOR_SESSION_VERSION || !/^\d{1,12}$/.test(parts[1])) return false;
  if (Number(parts[1]) * 1000 <= nowMs) return false;
  const expected = hmac(sessionSigningKey(operatorToken), `${parts[0]}.${parts[1]}`);
  const presented = Buffer.from(parts[2], 'base64url');
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

/** Reads one cookie from a Cookie header without decoding the rest of it. */
export function readCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (!raw) return undefined;
  for (const pair of raw.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() === name) return pair.slice(separator + 1).trim();
  }
  return undefined;
}
