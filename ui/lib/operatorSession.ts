/**
 * The UI login session.
 *
 * The operator signs in with AGENT_HQ_OPERATOR_TOKEN, and the UI answers with an httpOnly cookie
 * holding an expiry and an HMAC over it, keyed by a key derived from that token. Nothing is stored
 * server-side, and rotating the token ends every session. The token itself never reaches the
 * browser: the /api/v1 proxy attaches it when forwarding.
 *
 * The API verifies the same cookie for the chat WebSocket (api/src/lib/operatorSession.ts, Node
 * crypto). This file uses Web Crypto so it runs in any Next.js runtime; both test suites pin the
 * same vector so the two implementations cannot drift apart.
 */

export const OPERATOR_SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Matches the API: `openssl rand -hex 32` yields 64 characters. */
export const MIN_OPERATOR_TOKEN_LENGTH = 32;
const SESSION_VERSION = 'v1';

const encoder = new TextEncoder();

async function hmac(key: BufferSource | string, message: string) {
  const raw = typeof key === 'string' ? encoder.encode(key) : key;
  const cryptoKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Compares without an early exit, so the time taken does not reveal where the inputs differ. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

/** The configured operator token, or null when it is missing or too short to be a real secret. */
export function getOperatorToken(env: Record<string, string | undefined> = process.env): string | null {
  const token = env.AGENT_HQ_OPERATOR_TOKEN?.trim();
  return token && token.length >= MIN_OPERATOR_TOKEN_LENGTH ? token : null;
}

/** Constant-time: both sides are digested first, so length does not leak either. */
export async function isOperatorToken(candidate: string, operatorToken: string): Promise<boolean> {
  if (!candidate) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(candidate.trim())),
    crypto.subtle.digest('SHA-256', encoder.encode(operatorToken)),
  ]);
  return constantTimeEqual(new Uint8Array(a), new Uint8Array(b));
}

/**
 * Derived from the token because cookies ignore the port: two installs on one host (prod and dev
 * side by side) would otherwise overwrite each other's session.
 */
export async function operatorSessionCookieName(operatorToken: string): Promise<string> {
  return `agent_hq_session_${toHex(await hmac(operatorToken, 'agent-hq:session-cookie-name')).slice(0, 12)}`;
}

async function sessionSignature(operatorToken: string, payload: string) {
  return hmac(await hmac(operatorToken, 'agent-hq:operator-session:v1'), payload);
}

/** `v1.<expiry, unix seconds>.<base64url HMAC-SHA256 over "v1.<expiry>">` */
export async function signOperatorSession(operatorToken: string, expiresAtSeconds: number): Promise<string> {
  const payload = `${SESSION_VERSION}.${expiresAtSeconds}`;
  return `${payload}.${toBase64Url(await sessionSignature(operatorToken, payload))}`;
}

/** The session's expiry (unix seconds) when it is genuine and current, otherwise null. */
export async function readOperatorSessionExpiry(
  operatorToken: string,
  value: string | undefined,
  nowMs = Date.now(),
): Promise<number | null> {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION || !/^\d{1,12}$/.test(parts[1])) return null;
  const expiresAt = Number(parts[1]);
  if (expiresAt * 1000 <= nowMs) return null;
  const expected = toBase64Url(await sessionSignature(operatorToken, `${parts[0]}.${parts[1]}`));
  return constantTimeEqual(encoder.encode(parts[2]), encoder.encode(expected)) ? expiresAt : null;
}

/** Renewed once half its lifetime has passed, so an operator who keeps using the UI stays in. */
export function shouldRenewOperatorSession(expiresAtSeconds: number, nowMs = Date.now()): boolean {
  return expiresAtSeconds * 1000 - nowMs < (OPERATOR_SESSION_MAX_AGE_SECONDS * 1000) / 2;
}

export async function newOperatorSession(operatorToken: string, nowMs = Date.now()): Promise<{
  name: string;
  value: string;
  expiresAt: number;
}> {
  const expiresAt = Math.floor(nowMs / 1000) + OPERATOR_SESSION_MAX_AGE_SECONDS;
  return {
    name: await operatorSessionCookieName(operatorToken),
    value: await signOperatorSession(operatorToken, expiresAt),
    expiresAt,
  };
}

/** HTTPS as the browser sees it, including behind a TLS-terminating reverse proxy. */
export function isSecureRequest(url: string, headers: Headers): boolean {
  const forwarded = headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwarded) return forwarded === 'https';
  return url.startsWith('https:');
}

/**
 * httpOnly keeps the session out of page scripts. SameSite=Lax rather than Strict so following a
 * link into the UI from elsewhere (a chat message, a notification) arrives signed in; cross-site
 * POSTs and subresource requests still carry no cookie.
 */
export function operatorSessionCookieOptions(secure: boolean, maxAgeSeconds = OPERATOR_SESSION_MAX_AGE_SECONDS) {
  return { httpOnly: true, sameSite: 'lax' as const, secure, path: '/', maxAge: maxAgeSeconds };
}

const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout']);

export type OperatorAccessDecision =
  | { kind: 'allow'; renewSession: boolean }
  | { kind: 'sign_in'; location: string }
  | { kind: 'reject'; status: 401 | 503; code: string; error: string };

/**
 * What middleware.ts does with a request. Every page and UI API route needs a signed-in operator;
 * only the sign-in page and the sign-in/sign-out endpoints answer without one. API routes answer
 * 401 so the page's scripts can send the browser to sign in; pages are handed to the sign-in
 * route, `location`, which redirects. Middleware does not redirect itself: Next rewrites a
 * middleware redirect to 127.0.0.1 into one to `localhost`, a different host for cookies, while
 * a route handler can answer with a relative Location that keeps the host the browser used.
 */
export async function decideOperatorAccess(params: {
  operatorToken: string | null;
  pathname: string;
  searchParams: URLSearchParams;
  cookie: (name: string) => string | undefined;
  nowMs?: number;
}): Promise<OperatorAccessDecision> {
  const { operatorToken, pathname, searchParams } = params;
  const isApi = pathname.startsWith('/api/');

  // `agent-hq open` signs in through the URL; the sign-in route drops the token from it.
  if (pathname === '/login' && searchParams.has('token')) {
    return { kind: 'sign_in', location: `/api/auth/login?${searchParams.toString()}` };
  }
  if (PUBLIC_PATHS.has(pathname)) return { kind: 'allow', renewSession: false };

  if (!operatorToken) {
    if (isApi) {
      return {
        kind: 'reject',
        status: 503,
        code: 'operator_token_not_configured',
        error: 'AGENT_HQ_OPERATOR_TOKEN is not configured for the UI.',
      };
    }
    return { kind: 'sign_in', location: '/api/auth/login' };
  }

  const expiresAt = await readOperatorSessionExpiry(
    operatorToken,
    params.cookie(await operatorSessionCookieName(operatorToken)),
    params.nowMs,
  );
  if (expiresAt === null) {
    if (isApi) {
      return { kind: 'reject', status: 401, code: 'ui_session_required', error: 'Your Agent HQ session has ended. Sign in again.' };
    }
    const search = searchParams.toString();
    return { kind: 'sign_in', location: `/api/auth/login?next=${encodeURIComponent(`${pathname}${search ? `?${search}` : ''}`)}` };
  }
  return { kind: 'allow', renewSession: shouldRenewOperatorSession(expiresAt, params.nowMs) };
}

/**
 * Where the sign-in route sends the browser, and whether it starts a session. With no token
 * presented it only shows the sign-in page; with one it signs in and drops the token from the URL.
 */
export async function signInWithToken(
  operatorToken: string | null,
  presented: string | null,
  nextParam: string | null,
): Promise<{ location: string; startSession: boolean }> {
  const next = safeRedirectPath(nextParam);
  const loginPage = (error?: string) => {
    const query = new URLSearchParams();
    if (error) query.set('error', error);
    if (next !== '/') query.set('next', next);
    return query.size ? `/login?${query.toString()}` : '/login';
  };
  if (!operatorToken || presented === null) return { location: loginPage(), startSession: false };
  if (!(await isOperatorToken(presented, operatorToken))) return { location: loginPage('invalid_token'), startSession: false };
  return { location: next, startSession: true };
}

/** Where to send the operator after signing in: a same-site path only, never another origin. */
export function safeRedirectPath(next: string | null | undefined): string {
  // URL parsers drop tabs and newlines and read backslashes as slashes, so "/\t/evil.example"
  // would otherwise become the protocol-relative "//evil.example".
  if (!next || !next.startsWith('/') || next.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(next)) return '/';
  if (next === '/login' || next.startsWith('/login?') || next.startsWith('/api/auth/')) return '/';
  return next;
}
