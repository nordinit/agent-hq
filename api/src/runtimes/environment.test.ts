import {
  buildRuntimeChildEnv,
  isProtectedRuntimeConfigEnvKey,
  sanitizedRuntimeProcessEnv,
} from './environment';

describe('runtime child environment boundary', () => {
  it('keeps process essentials while dropping ambient API and provider secrets', () => {
    const result = sanitizedRuntimeProcessEnv({
      PATH: '/usr/bin',
      HOME: '/runtime-user',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
      SSH_AUTH_SOCK: '/tmp/ssh.sock',
      SSH_AGENT_PID: '4242',
      GPG_TTY: '/dev/ttys001',
      DATABASE_URL: 'postgres://agent:database-secret@db/agent_hq',
      ANTHROPIC_API_KEY: 'anthropic-secret',
      OPENAI_API_KEY: 'openai-secret',
      GITHUB_TOKEN: 'github-secret',
      HTTP_PROXY: 'http://proxy-user:proxy-secret@proxy',
      NODE_OPTIONS: '--require /tmp/injected.js',
    });

    expect(result).toEqual({
      PATH: '/usr/bin',
      HOME: '/runtime-user',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'C',
    });
  });

  it('layers validated adapter values after the sanitized ambient environment', () => {
    expect(buildRuntimeChildEnv(
      { AGENT_HQ_INSTANCE_ID: '42', FEATURE_FLAG: 'enabled' },
      { PATH: '/usr/bin', AGENT_HQ_INSTANCE_ID: 'forged', DATABASE_URL: 'secret' },
    )).toEqual({
      PATH: '/usr/bin',
      AGENT_HQ_INSTANCE_ID: '42',
      FEATURE_FLAG: 'enabled',
    });
  });

  it('recognizes protected runtime-config keys case-insensitively', () => {
    expect(isProtectedRuntimeConfigEnvKey('pAtH')).toBe(true);
    expect(isProtectedRuntimeConfigEnvKey(' userProfile ')).toBe(true);
    expect(isProtectedRuntimeConfigEnvKey('DyLd_InSeRt_LiBrArIeS')).toBe(true);
    expect(isProtectedRuntimeConfigEnvKey('customAccessToken')).toBe(true);
    expect(isProtectedRuntimeConfigEnvKey('FEATURE_FLAG')).toBe(false);
  });

  it.each([
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'SSLKEYLOGFILE',
  ])('does not let runtime_config redirect TLS trust or key logging via %s', (key) => {
    expect(isProtectedRuntimeConfigEnvKey(key)).toBe(true);
  });
});
