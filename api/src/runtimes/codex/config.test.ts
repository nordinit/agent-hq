import {
  normalizeCodexRuntimeConfig,
  validateCodexRuntimeConfig,
} from './config';

describe('Codex runtime config', () => {
  it('applies headless, workspace-safe defaults', () => {
    expect(normalizeCodexRuntimeConfig({})).toMatchObject({
      codexBin: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
      allowDangerousFullAccess: false,
      skipGitRepoCheck: false,
      reasoningEffort: null,
    });
  });

  it('requires an explicit latch for full host access', () => {
    expect(validateCodexRuntimeConfig({ sandboxMode: 'danger-full-access' }))
      .toMatch(/allowDangerousFullAccess/);
    expect(validateCodexRuntimeConfig({
      sandboxMode: 'danger-full-access',
      allowDangerousFullAccess: true,
    })).toBeNull();
  });

  it('does not accept the deprecated on-failure approval policy', () => {
    expect(validateCodexRuntimeConfig({ approvalPolicy: 'on-failure' as never }))
      .toMatch(/approvalPolicy/);
  });

  it('rejects a custom executable unless the API host explicitly allowlists it', () => {
    const previous = process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
    delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
    try {
      expect(validateCodexRuntimeConfig({ codexBin: '/tmp/attacker-codex' })).toBe(
        'runtime_config.codexBin path is not authorized by AGENT_HQ_ALLOWED_CODEX_BINARIES',
      );
      expect(() => normalizeCodexRuntimeConfig({ codexBin: '/tmp/attacker-codex' }))
        .toThrow(/not authorized/);
    } finally {
      if (previous == null) delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
      else process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = previous;
    }
  });

  it('accepts an exact custom executable allowlisted by the API host', () => {
    const previous = process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
    process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = '/opt/agent-hq/bin/codex';
    try {
      expect(normalizeCodexRuntimeConfig({
        codexBin: ' /opt/agent-hq/bin/codex ',
      }).codexBin).toBe('/opt/agent-hq/bin/codex');
    } finally {
      if (previous == null) delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
      else process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = previous;
    }
  });

  it.each([
    '--json',
    '--model=gpt-5.5',
    '-c',
    '--sandbox',
    '--ask-for-approval',
    '-a',
    '--full-auto',
    '--add-dir',
    '--oss',
    '--local-provider',
    '--image',
    '-i',
    '--ignore-rules',
    '--enable',
    '--disable',
    '--dangerously-bypass-approvals-and-sandbox',
    'resume',
  ])('denies adapter-owned extra arg %s', (arg) => {
    expect(validateCodexRuntimeConfig({ extraArgs: [arg] })).toMatch(/Codex runtime/);
  });

  it('rejects unknown passthrough flags until they have a first-class validated field', () => {
    expect(validateCodexRuntimeConfig({ extraArgs: ['--future-safe-flag=value'] }))
      .toContain('extraArgs are disabled');
  });

  it('copies operator arrays and environment maps', () => {
    const source = { extraArgs: [] as string[], env: { FOO: 'bar' } };
    const normalized = normalizeCodexRuntimeConfig(source);
    normalized.extraArgs.push('--disable');
    normalized.env.FOO = 'changed';
    expect(source).toEqual({ extraArgs: [], env: { FOO: 'bar' } });
  });

  it.each([
    'CODEX_HOME',
    'cOdEx_HoMe',
    'AGENT_HQ_INSTANCE_ID',
    'agent_hq_runtime_id',
    'OPENAI_API_KEY',
    'oPeNaI_organization',
    'LINEAR_TOKEN',
    'PATH',
    'pAtHeXt',
    'home',
    'UserProfile',
    'homedrive',
    'HomePath',
    'xdg_config_home',
    'Pwd',
    'oldpwd',
    'bash_env',
    'Env',
    'zdotdir',
    'comspec',
    'Shell',
    'LD_LIBRARY_PATH',
    'dyld_library_path',
    'Node_Path',
    'pythonpath',
    'HTTPS_PROXY',
    'NODE_OPTIONS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'SSLKEYLOGFILE',
  ])('rejects protected or credential env key %s', (key) => {
    expect(validateCodexRuntimeConfig({ env: { [key]: 'value' } }))
      .toContain('may not set protected');
  });

  it('cannot redirect the default Codex executable through a runtime-owned PATH', () => {
    expect(validateCodexRuntimeConfig({
      codexBin: 'codex',
      env: { PATH: '/tmp/attacker-bin' },
    })).toBe('runtime_config.env may not set protected or credential variable "PATH"');
  });
});
