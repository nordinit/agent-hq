import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  OPERATOR_SESSION_MAX_AGE_SECONDS,
  decideOperatorAccess,
  getOperatorToken,
  isOperatorToken,
  isSecureRequest,
  newOperatorSession,
  operatorSessionCookieName,
  operatorSessionCookieOptions,
  readOperatorSessionExpiry,
  safeRedirectPath,
  shouldRenewOperatorSession,
  signInWithToken,
  signOperatorSession,
} from './operatorSession.ts';

const TOKEN = '0123456789abcdef'.repeat(4);
const NOW_MS = 1_900_000_000_000;

test('matches the vector api/src/lib/operatorSession.test.ts pins, so the API can verify UI sessions', async () => {
  assert.equal(await operatorSessionCookieName(TOKEN), 'agent_hq_session_4ec9a62ff308');
  assert.equal(await signOperatorSession(TOKEN, 2_000_000_000), 'v1.2000000000.O0ijK0LVcCE9dRjp7Hq44mItP_TQRU06yhlMKKqUcow');
});

test('a session is genuine until it expires, and only for the token that signed it', async () => {
  const session = await newOperatorSession(TOKEN, NOW_MS);
  assert.equal(session.expiresAt, NOW_MS / 1000 + OPERATOR_SESSION_MAX_AGE_SECONDS);
  assert.equal(await readOperatorSessionExpiry(TOKEN, session.value, NOW_MS), session.expiresAt);
  assert.equal(await readOperatorSessionExpiry(TOKEN, session.value, session.expiresAt * 1000), null);
  assert.equal(await readOperatorSessionExpiry('f'.repeat(64), session.value, NOW_MS), null);
});

test('tampered and malformed sessions are refused', async () => {
  const [version, expiry, signature] = (await signOperatorSession(TOKEN, NOW_MS / 1000 + 60)).split('.');
  for (const value of [
    `${version}.${Number(expiry) + 3600}.${signature}`,
    `v2.${expiry}.${signature}`,
    `${version}.${expiry}.${signature.slice(1)}`,
    `${version}.${expiry}`,
    '',
    undefined,
  ]) {
    assert.equal(await readOperatorSessionExpiry(TOKEN, value, NOW_MS), null, String(value));
  }
});

test('sessions renew once half their lifetime has passed', () => {
  const fresh = NOW_MS / 1000 + OPERATOR_SESSION_MAX_AGE_SECONDS;
  assert.equal(shouldRenewOperatorSession(fresh, NOW_MS), false);
  assert.equal(shouldRenewOperatorSession(NOW_MS / 1000 + OPERATOR_SESSION_MAX_AGE_SECONDS / 2 - 1, NOW_MS), true);
});

test('the token is compared exactly, tolerating only pasted whitespace', async () => {
  assert.equal(await isOperatorToken(TOKEN, TOKEN), true);
  assert.equal(await isOperatorToken(` ${TOKEN}\n`, TOKEN), true);
  assert.equal(await isOperatorToken(TOKEN.slice(0, -1), TOKEN), false);
  assert.equal(await isOperatorToken('', TOKEN), false);
});

test('the token is configuration only when it is long enough to be a generated secret', () => {
  assert.equal(getOperatorToken({ AGENT_HQ_OPERATOR_TOKEN: ` ${TOKEN} ` }), TOKEN);
  assert.equal(getOperatorToken({ AGENT_HQ_OPERATOR_TOKEN: 'short' }), null);
  assert.equal(getOperatorToken({}), null);
});

test('the cookie is httpOnly and Lax, and Secure whenever the browser used HTTPS', () => {
  assert.deepEqual(operatorSessionCookieOptions(false), {
    httpOnly: true, sameSite: 'lax', secure: false, path: '/', maxAge: OPERATOR_SESSION_MAX_AGE_SECONDS,
  });
  assert.equal(isSecureRequest('http://127.0.0.1:3500/login', new Headers({ 'x-forwarded-proto': 'https' })), true);
  assert.equal(isSecureRequest('https://hq.example.com/login', new Headers()), true);
  assert.equal(isSecureRequest('http://localhost:3500/login', new Headers()), false);
});

test('sign-in only ever redirects to a path on this site', () => {
  assert.equal(safeRedirectPath('/tasks?project_id=2'), '/tasks?project_id=2');
  for (const unsafe of ['https://evil.example', '//evil.example', '/\\evil.example', '/\t/evil.example', 'tasks', '/login', '/login?next=/x', '/api/auth/logout', null]) {
    assert.equal(safeRedirectPath(unsafe), '/', String(unsafe));
  }
});

async function decide(pathname: string, options: { query?: string; cookie?: string; token?: string | null } = {}) {
  const token = options.token === undefined ? TOKEN : options.token;
  const cookieName = token ? await operatorSessionCookieName(token) : '';
  return decideOperatorAccess({
    operatorToken: token,
    pathname,
    searchParams: new URLSearchParams(options.query ?? ''),
    cookie: (name) => (name === cookieName ? options.cookie : undefined),
    nowMs: NOW_MS,
  });
}

test('pages without a session go to sign in, and come back afterwards', async () => {
  assert.deepEqual(await decide('/tasks', { query: 'project_id=2' }), {
    kind: 'sign_in', location: '/api/auth/login?next=%2Ftasks%3Fproject_id%3D2',
  });
  assert.deepEqual(await signInWithToken(TOKEN, null, '/tasks?project_id=2'), {
    location: '/login?next=%2Ftasks%3Fproject_id%3D2', startSession: false,
  });
  assert.deepEqual(await signInWithToken(TOKEN, null, '/'), { location: '/login', startSession: false });
});

test('API routes without a session answer 401, and never reach the proxy', async () => {
  for (const path of ['/api/v1/tasks', '/api/chat-config', '/api/local-mlx-status']) {
    assert.deepEqual(await decide(path), {
      kind: 'reject', status: 401, code: 'ui_session_required', error: 'Your Agent HQ session has ended. Sign in again.',
    });
  }
});

test('a current session is let through, and renewed once it is half used', async () => {
  const fresh = await signOperatorSession(TOKEN, NOW_MS / 1000 + OPERATOR_SESSION_MAX_AGE_SECONDS);
  const ageing = await signOperatorSession(TOKEN, NOW_MS / 1000 + 60);
  assert.deepEqual(await decide('/api/v1/tasks', { cookie: fresh }), { kind: 'allow', renewSession: false });
  assert.deepEqual(await decide('/', { cookie: ageing }), { kind: 'allow', renewSession: true });
  const foreign = await signOperatorSession('f'.repeat(64), NOW_MS / 1000 + 60);
  assert.equal((await decide('/', { cookie: foreign })).kind, 'sign_in');
});

test('the sign-in page and endpoints need no session', async () => {
  for (const path of ['/login', '/api/auth/login', '/api/auth/logout']) {
    assert.deepEqual(await decide(path), { kind: 'allow', renewSession: false });
  }
});

test('?token= on /login is handed to the sign-in route', async () => {
  assert.deepEqual(await decide('/login', { query: `token=${TOKEN}&next=/chat` }), {
    kind: 'sign_in', location: `/api/auth/login?token=${TOKEN}&next=%2Fchat`,
  });
});

test('signing in with the token starts a session and drops the token from the URL', async () => {
  assert.deepEqual(await signInWithToken(TOKEN, TOKEN, '/chat'), { location: '/chat', startSession: true });
  assert.deepEqual(await signInWithToken(TOKEN, TOKEN, 'https://evil.example'), { location: '/', startSession: true });
  assert.deepEqual(await signInWithToken(TOKEN, 'wrong', '/chat'), {
    location: '/login?error=invalid_token&next=%2Fchat', startSession: false,
  });
  assert.deepEqual(await signInWithToken(null, TOKEN, '/chat'), { location: '/login?next=%2Fchat', startSession: false });
});

test('without a configured token only the sign-in page answers, to explain what is missing', async () => {
  assert.deepEqual(await decide('/login', { token: null }), { kind: 'allow', renewSession: false });
  assert.deepEqual(await decide('/tasks', { token: null }), { kind: 'sign_in', location: '/api/auth/login' });
  assert.equal((await decide('/api/v1/tasks', { token: null })).kind, 'reject');
});
