import {
  OPERATOR_SESSION_MAX_AGE_SECONDS,
  operatorSessionCookieName,
  readCookie,
  signOperatorSession,
  verifyOperatorSession,
} from './operatorSession';

const TOKEN = '0123456789abcdef'.repeat(4);
const NOW_MS = 1_900_000_000_000;

describe('operatorSession', () => {
  it('matches the vector ui/lib/operatorSession.test.ts pins, so UI and API agree on the format', () => {
    expect(operatorSessionCookieName(TOKEN)).toBe('agent_hq_session_4ec9a62ff308');
    expect(signOperatorSession(TOKEN, 2_000_000_000)).toBe('v1.2000000000.O0ijK0LVcCE9dRjp7Hq44mItP_TQRU06yhlMKKqUcow');
  });

  it('accepts a session until it expires', () => {
    const expiresAt = NOW_MS / 1000 + OPERATOR_SESSION_MAX_AGE_SECONDS;
    const session = signOperatorSession(TOKEN, expiresAt);
    expect(verifyOperatorSession(TOKEN, session, NOW_MS)).toBe(true);
    expect(verifyOperatorSession(TOKEN, session, expiresAt * 1000 - 1)).toBe(true);
    expect(verifyOperatorSession(TOKEN, session, expiresAt * 1000)).toBe(false);
  });

  it('refuses sessions signed with another token, so rotating the token ends every session', () => {
    const session = signOperatorSession('f'.repeat(64), NOW_MS / 1000 + 60);
    expect(verifyOperatorSession(TOKEN, session, NOW_MS)).toBe(false);
  });

  it('refuses tampered and malformed values', () => {
    const session = signOperatorSession(TOKEN, NOW_MS / 1000 + 60);
    const [version, expiry, signature] = session.split('.');
    expect(verifyOperatorSession(TOKEN, `${version}.${Number(expiry) + 3600}.${signature}`, NOW_MS)).toBe(false);
    expect(verifyOperatorSession(TOKEN, `v2.${expiry}.${signature}`, NOW_MS)).toBe(false);
    expect(verifyOperatorSession(TOKEN, `${version}.${expiry}.${signature.slice(1)}`, NOW_MS)).toBe(false);
    expect(verifyOperatorSession(TOKEN, `${version}.${expiry}`, NOW_MS)).toBe(false);
    expect(verifyOperatorSession(TOKEN, `${version}.-1.${signature}`, NOW_MS)).toBe(false);
    expect(verifyOperatorSession(TOKEN, '', NOW_MS)).toBe(false);
    expect(verifyOperatorSession(TOKEN, undefined, NOW_MS)).toBe(false);
  });

  it('names the cookie per token so installs sharing a host keep separate sessions', () => {
    expect(operatorSessionCookieName(TOKEN)).toMatch(/^agent_hq_session_[0-9a-f]{12}$/);
    expect(operatorSessionCookieName('f'.repeat(64))).not.toBe(operatorSessionCookieName(TOKEN));
  });

  it('reads one cookie out of a Cookie header', () => {
    expect(readCookie('a=1; agent_hq_session_x=v1.2.abc; b=2', 'agent_hq_session_x')).toBe('v1.2.abc');
    expect(readCookie(['a=1', 'agent_hq_session_x=v1.2.abc'], 'agent_hq_session_x')).toBe('v1.2.abc');
    expect(readCookie('agent_hq_session_xy=nope', 'agent_hq_session_x')).toBeUndefined();
    expect(readCookie(undefined, 'agent_hq_session_x')).toBeUndefined();
  });
});
