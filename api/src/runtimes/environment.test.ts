import {
  buildAgentRuntimeEnv,
  buildRunIdentityEnv,
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

describe('agent runtime environment layering', () => {
  const ambient = { PATH: '/usr/bin', DATABASE_URL: 'postgres://secret' } as NodeJS.ProcessEnv;

  const identity = buildRunIdentityEnv(
    {
      instanceId: 42,
      durableRunId: 'run-abc',
      taskId: 7,
      sessionKey: 'hook:session',
      agentSlug: 'atlas',
      workspaceRoot: null,
      activeRepoRoot: '/repo',
    },
    '/cwd',
  );

  it('drops ambient API secrets while keeping allowlisted host state', () => {
    const env = buildAgentRuntimeEnv({ runIdentity: identity }, ambient);
    expect(env.PATH).toBe('/usr/bin');
    expect(env.DATABASE_URL).toBeUndefined();
  });

  it('falls back to cwd only for the roots the run did not resolve', () => {
    expect(identity.AGENT_HQ_WORKSPACE_ROOT).toBe('/cwd');
    expect(identity.AGENT_HQ_ACTIVE_REPO_ROOT).toBe('/repo');
    expect(identity.AGENT_HQ_INSTANCE_ID).toBe('42');
  });

  it('lets injected secrets outrank agent config but never the run identity', () => {
    const env = buildAgentRuntimeEnv({
      agentConfig: { GH_TOKEN: 'from-config', AGENT_HQ_AGENT_SLUG: 'forged' },
      injectedSecrets: { GH_TOKEN: 'from-dispatch' },
      runIdentity: identity,
    }, ambient);

    expect(env.GH_TOKEN).toBe('from-dispatch');
    expect(env.AGENT_HQ_AGENT_SLUG).toBe('atlas');
  });

  it('keeps adapter-owned launch settings authoritative over every other layer', () => {
    const env = buildAgentRuntimeEnv({
      agentConfig: { CLAUDE_CONFIG_DIR: '/attacker-home' },
      injectedSecrets: { CLAUDE_CONFIG_DIR: '/also-not-this' },
      runIdentity: identity,
      adapterOwned: { CLAUDE_CONFIG_DIR: '/validated-home' },
    }, ambient);

    expect(env.CLAUDE_CONFIG_DIR).toBe('/validated-home');
  });

  it('passes agent config through when nothing above it collides', () => {
    const env = buildAgentRuntimeEnv({
      agentConfig: { FEATURE_FLAG: 'enabled' },
      runIdentity: identity,
    }, ambient);

    expect(env.FEATURE_FLAG).toBe('enabled');
  });
});
