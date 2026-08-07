import {
  ALLOWED_EXTRA_ARGS,
  normalizeClaudeCodeRuntimeConfig,
  validateClaudeCodeRuntimeConfig,
} from './config';
import { type ClaudeCodeRuntimeConfig } from './types';

describe('claude-code runtime config validation', () => {
  it('accepts an empty config, null and undefined — EVERY FIELD IS OPTIONAL', () => {
    // Load-bearing: PUT /agents/:id re-validates the STORED runtime_config when
    // the body omits it, so making any field required retroactively 400s every
    // unrelated update to an existing claude-code agent (incl. the seeded dev
    // agents). If you are here because you added a required field: don't.
    expect(validateClaudeCodeRuntimeConfig({})).toBeNull();
    expect(validateClaudeCodeRuntimeConfig(null)).toBeNull();
    expect(validateClaudeCodeRuntimeConfig(undefined)).toBeNull();
  });

  it('accepts a fully populated config', () => {
    expect(
      validateClaudeCodeRuntimeConfig({
        workingDirectory: '/tmp/worktree',
        claudeBin: 'claude',
        model: 'claude-opus-4-5',
        effort: 'high',
        allowedTools: ['Bash', 'Read'],
        disallowedTools: ['WebSearch'],
        maxTurns: 40,
        maxBudgetUsd: 2.5,
        permissionMode: 'allowlist',
        allowDangerousBypass: false,
        systemPromptSuffix: 'Be terse.',
        extraArgs: ['--debug'],
        env: { RUNTIME_LABEL: 'claude-code' },
        killGraceMs: 5_000,
        claudeConfigDir: '/tmp/claude-config',
      }),
    ).toBeNull();
  });

  it('accepts a config carrying unknown extra keys', () => {
    expect(
      validateClaudeCodeRuntimeConfig({
        effort: 'medium',
        somethingTheUiAddedLater: { nested: true },
        legacyField: 42,
      }),
    ).toBeNull();
  });

  it('rejects a custom executable unless the API host explicitly allowlists it', () => {
    const previous = process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
    delete process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
    try {
      expect(validateClaudeCodeRuntimeConfig({ claudeBin: '/tmp/attacker-claude' })).toBe(
        'runtime_config.claudeBin path is not authorized by AGENT_HQ_ALLOWED_CLAUDE_BINARIES',
      );
      expect(() => normalizeClaudeCodeRuntimeConfig({ claudeBin: '/tmp/attacker-claude' }))
        .toThrow(/not authorized/);
    } finally {
      if (previous == null) delete process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
      else process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = previous;
    }
  });

  it('accepts an exact custom executable allowlisted by the API host', () => {
    const previous = process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
    process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = '/opt/agent-hq/bin/claude';
    try {
      expect(normalizeClaudeCodeRuntimeConfig({
        claudeBin: ' /opt/agent-hq/bin/claude ',
      }).claudeBin).toBe('/opt/agent-hq/bin/claude');
    } finally {
      if (previous == null) delete process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
      else process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = previous;
    }
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)('accepts effort %s', (effort) => {
    expect(validateClaudeCodeRuntimeConfig({ effort })).toBeNull();
  });

  it('accepts xhigh specifically — the level older config types dropped', () => {
    expect(validateClaudeCodeRuntimeConfig({ effort: 'xhigh' })).toBeNull();
    expect(normalizeClaudeCodeRuntimeConfig({ effort: 'xhigh' }).effort).toBe('xhigh');
  });

  it('rejects an unknown effort level', () => {
    expect(validateClaudeCodeRuntimeConfig({ effort: 'extreme' as never })).toBe(
      'runtime_config.effort must be one of: low, medium, high, xhigh, max',
    );
    expect(validateClaudeCodeRuntimeConfig({ effort: 3 as never })).toBe(
      'runtime_config.effort must be one of: low, medium, high, xhigh, max',
    );
  });

  it('rejects an unknown permission mode', () => {
    expect(validateClaudeCodeRuntimeConfig({ permissionMode: 'plan' as never })).toBe(
      'runtime_config.permissionMode must be one of: bypass, allowlist',
    );
  });

  it('accepts allowlist mode and requires an explicit latch for bypass', () => {
    expect(validateClaudeCodeRuntimeConfig({ permissionMode: 'allowlist' })).toBeNull();
    expect(validateClaudeCodeRuntimeConfig({ permissionMode: 'bypass' })).toBe(
      'runtime_config.allowDangerousBypass must be true when permissionMode is bypass',
    );
    expect(validateClaudeCodeRuntimeConfig({
      permissionMode: 'bypass', allowDangerousBypass: true,
    })).toBeNull();
    expect(validateClaudeCodeRuntimeConfig({ allowDangerousBypass: 'yes' as never })).toBe(
      'runtime_config.allowDangerousBypass must be a boolean',
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '10' as never])(
    'rejects maxTurns %p',
    (maxTurns) => {
      expect(validateClaudeCodeRuntimeConfig({ maxTurns })).toBe(
        'runtime_config.maxTurns must be a positive number',
      );
    },
  );

  it.each([0, -0.5, Number.NaN, Number.POSITIVE_INFINITY, '2.50' as never])(
    'rejects maxBudgetUsd %p',
    (maxBudgetUsd) => {
      expect(validateClaudeCodeRuntimeConfig({ maxBudgetUsd })).toBe(
        'runtime_config.maxBudgetUsd must be a positive number',
      );
    },
  );

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '5000' as never])(
    'rejects killGraceMs %p',
    (killGraceMs) => {
      expect(validateClaudeCodeRuntimeConfig({ killGraceMs })).toBe(
        'runtime_config.killGraceMs must be a non-negative number',
      );
    },
  );

  it('accepts killGraceMs of zero — SIGKILL with no grace is a legitimate choice', () => {
    expect(validateClaudeCodeRuntimeConfig({ killGraceMs: 0 })).toBeNull();
    expect(normalizeClaudeCodeRuntimeConfig({ killGraceMs: 0 }).killGraceMs).toBe(0);
  });

  it.each(['workingDirectory', 'claudeBin', 'model', 'systemPromptSuffix', 'claudeConfigDir'])(
    'rejects a non-string %s',
    (field) => {
      expect(validateClaudeCodeRuntimeConfig({ [field]: 7 } as ClaudeCodeRuntimeConfig)).toBe(
        `runtime_config.${field} must be a string`,
      );
    },
  );

  it.each(['allowedTools', 'disallowedTools', 'extraArgs'])(
    'rejects a non-array %s',
    (field) => {
      expect(validateClaudeCodeRuntimeConfig({ [field]: 'Bash' } as ClaudeCodeRuntimeConfig)).toBe(
        `runtime_config.${field} must be an array of strings`,
      );
    },
  );

  it.each(['allowedTools', 'disallowedTools', 'extraArgs'])(
    'rejects non-string entries in %s',
    (field) => {
      expect(
        validateClaudeCodeRuntimeConfig({ [field]: ['ok', 12] } as ClaudeCodeRuntimeConfig),
      ).toBe(`runtime_config.${field} must be an array of strings`);
    },
  );

  it('accepts only simple built-in identifiers in the configured tool lists', () => {
    expect(validateClaudeCodeRuntimeConfig({
      allowedTools: ['Bash', 'NotebookEdit', 'Custom_Tool-2'],
      disallowedTools: ['WebSearch'],
    })).toBeNull();
  });

  it.each([
    'Read,Bash',
    'Bash(*)',
    'Bash(git:*)',
    'mcp__agent-hq__agent_hq_post_task_outcome',
    ' Read',
    'Read ',
    'Read Write',
    '',
    'agent_hq_custom_tool',
  ])('rejects non-built-in policy syntax in allowedTools: %p', (toolName) => {
    expect(validateClaudeCodeRuntimeConfig({ allowedTools: [toolName] })).toContain(
      'must be a simple built-in tool identifier',
    );
  });

  it('rejects overlap only between EXPLICIT allowed and disallowed built-in tools', () => {
    expect(validateClaudeCodeRuntimeConfig({
      allowedTools: ['Bash', 'Read'],
      disallowedTools: ['read'],
    })).toBe('runtime_config.allowedTools and runtime_config.disallowedTools overlap on "read"');
    expect(validateClaudeCodeRuntimeConfig({ allowedTools: [], disallowedTools: ['Bash'] }))
      .toBeNull();
  });

  it('lets a denial narrow the implicit default instead of 400-ing', () => {
    // Denying a tool the operator never explicitly allowed is intent, not a
    // contradiction. Validating it against the default list would mean that GROWING
    // that list retroactively invalidates stored configs — and PUT /agents/:id
    // re-validates the stored config on every unrelated edit, so such an agent could
    // never be saved again. This is exactly what adding WebFetch/WebSearch would have
    // done to any agent carrying disallowedTools: ['WebSearch'].
    expect(validateClaudeCodeRuntimeConfig({ disallowedTools: ['Bash'] })).toBeNull();
    expect(validateClaudeCodeRuntimeConfig({ disallowedTools: ['WebSearch'] })).toBeNull();

    // Normalization resolves it: the denial is subtracted from the default so no
    // tool can reach both --tools and --disallowedTools in the same argv.
    const normalized = normalizeClaudeCodeRuntimeConfig({ disallowedTools: ['WebSearch'] });
    expect(normalized.allowedTools).toEqual(['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'WebFetch', 'Write']);
    expect(normalized.disallowedTools).toEqual(['WebSearch']);

    // An EXPLICIT list is still taken verbatim — validation already proved it clean.
    expect(normalizeClaudeCodeRuntimeConfig({ allowedTools: ['Bash'], disallowedTools: ['Read'] }).allowedTools)
      .toEqual(['Bash']);
  });

  it.each([
    'agent_hq_start_task_run',
    'agent_hq_post_task_outcome',
    'mcp__agent-hq__agent-42__agent_hq_start_task_run',
    'mcp__agent-hq__agent-42__agent_hq_post_task_outcome',
  ])('never permits disallowedTools to deny required lifecycle method %p', (toolName) => {
    expect(validateClaudeCodeRuntimeConfig({
      allowedTools: [],
      disallowedTools: [toolName],
    })).toBe(
      `runtime_config.disallowedTools may not deny required Agent HQ lifecycle tool ${JSON.stringify(toolName)}`,
    );
  });

  it('rejects a non-object env', () => {
    expect(validateClaudeCodeRuntimeConfig({ env: [] as never })).toBe(
      'runtime_config.env must be an object of string environment values',
    );
    expect(validateClaudeCodeRuntimeConfig({ env: 'PATH=/bin' as never })).toBe(
      'runtime_config.env must be an object of string environment values',
    );
  });

  it('rejects non-string env values', () => {
    expect(validateClaudeCodeRuntimeConfig({ env: { AGENT_HQ_TASK_ID: 42 as never } })).toBe(
      'runtime_config.env values must be strings',
    );
    expect(validateClaudeCodeRuntimeConfig({ env: { AGENT_HQ_DEBUG: null as never } })).toBe(
      'runtime_config.env values must be strings',
    );
  });

  it('accepts an empty env object', () => {
    expect(validateClaudeCodeRuntimeConfig({ env: {} })).toBeNull();
  });

  it.each([
    'AGENT_HQ_INSTANCE_ID',
    'agent_hq_runtime_id',
    'CLAUDE_CONFIG_DIR',
    'cLaUdE_config_dir',
    'ANTHROPIC_API_KEY',
    'aNtHrOpIc_organization',
    'CUSTOM_ACCESS_TOKEN',
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
    'NODE_OPTIONS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
    'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE',
    'SSLKEYLOGFILE',
  ])('rejects protected or credential environment key %s', (key) => {
    expect(validateClaudeCodeRuntimeConfig({ env: { [key]: 'unsafe' } })).toBe(
      `runtime_config.env may not set protected or credential variable ${JSON.stringify(key)}`,
    );
  });

  it('cannot redirect the default Claude executable through a runtime-owned PATH', () => {
    expect(validateClaudeCodeRuntimeConfig({
      claudeBin: 'claude',
      env: { PATH: '/tmp/attacker-bin' },
    })).toBe('runtime_config.env may not set protected or credential variable "PATH"');
  });
});

describe('claude-code runtime extraArgs allowlist', () => {
  it('pins the complete pass-through surface', () => {
    expect([...ALLOWED_EXTRA_ARGS]).toEqual([
      '--debug',
      '--exclude-dynamic-system-prompt-sections',
    ]);
  });

  it.each([...ALLOWED_EXTRA_ARGS])('allows the exact argument-free flag %s', (arg) => {
    expect(validateClaudeCodeRuntimeConfig({ extraArgs: [arg] })).toBeNull();
  });

  it.each([
    '--settings',
    '--plugin-dir',
    '--plugin-url',
    '--safe-mode',
    '--bare',
    '--allowedTools',
    '--tools',
    '--permission-mode',
    '--remote-control',
    '--worktree',
    '--ide',
    'plugins',
    '--printer',
    '--brand-new-flag',
  ])('rejects unowned or unknown extraArgs entry %s', (arg) => {
    expect(validateClaudeCodeRuntimeConfig({ extraArgs: [arg] })).toBe(
      `Claude Code runtime does not allow extraArgs entry ${JSON.stringify(arg)}`,
    );
  });

  it('rejects value-bearing forms even when the bare flag is allowed', () => {
    expect(validateClaudeCodeRuntimeConfig({ extraArgs: ['--debug=api'] })).toBe(
      'Claude Code runtime does not allow extraArgs entry "--debug=api"',
    );
    expect(validateClaudeCodeRuntimeConfig({ extraArgs: ['--debug', 'api'] })).toBe(
      'Claude Code runtime does not allow extraArgs entry "api"',
    );
  });

  it('trims allowed flags and drops blank entries during normalization', () => {
    expect(normalizeClaudeCodeRuntimeConfig({
      extraArgs: ['  --debug  ', '', '   ', '--exclude-dynamic-system-prompt-sections'],
    }).extraArgs).toEqual(['--debug', '--exclude-dynamic-system-prompt-sections']);
  });

  it('reports the first unowned entry when several are present', () => {
    expect(
      validateClaudeCodeRuntimeConfig({ extraArgs: ['--debug', '--model', '--verbose'] }),
    ).toBe('Claude Code runtime does not allow extraArgs entry "--model"');
  });
});

describe('claude-code runtime config normalization', () => {
  it('applies defaults for an empty config', () => {
    expect(normalizeClaudeCodeRuntimeConfig({})).toEqual({
      workingDirectory: null,
      claudeBin: 'claude',
      model: null,
      effort: null,
      allowedTools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write'],
      disallowedTools: [],
      maxTurns: null,
      maxBudgetUsd: null,
      permissionMode: 'allowlist',
      allowDangerousBypass: false,
      systemPromptSuffix: null,
      extraArgs: [],
      env: {},
      killGraceMs: 10_000,
      claudeConfigDir: null,
      providerConnectionExternalRef: null,
    });
  });

  it('normalizes null and undefined identically to an empty config', () => {
    const fromEmpty = normalizeClaudeCodeRuntimeConfig({});
    expect(normalizeClaudeCodeRuntimeConfig(null)).toEqual(fromEmpty);
    expect(normalizeClaudeCodeRuntimeConfig(undefined)).toEqual(fromEmpty);
  });

  it('carries through every supplied value, trimming strings', () => {
    expect(
      normalizeClaudeCodeRuntimeConfig({
        workingDirectory: ' /tmp/worktree ',
        claudeBin: ' claude ',
        model: ' claude-opus-4-5 ',
        effort: 'xhigh',
        allowedTools: ['Bash', 'Read'],
        disallowedTools: ['WebSearch'],
        maxTurns: 40,
        maxBudgetUsd: 2.5,
        permissionMode: 'allowlist',
        allowDangerousBypass: false,
        systemPromptSuffix: ' Be terse. ',
        extraArgs: ['--debug'],
        env: { RUNTIME_LABEL: 'claude-code' },
        killGraceMs: 250,
        claudeConfigDir: ' /tmp/claude-config ',
      }),
    ).toEqual({
      workingDirectory: '/tmp/worktree',
      claudeBin: 'claude',
      model: 'claude-opus-4-5',
      effort: 'xhigh',
      allowedTools: ['Bash', 'Read'],
      disallowedTools: ['WebSearch'],
      maxTurns: 40,
      maxBudgetUsd: 2.5,
      permissionMode: 'allowlist',
      allowDangerousBypass: false,
      systemPromptSuffix: 'Be terse.',
      extraArgs: ['--debug'],
      env: { RUNTIME_LABEL: 'claude-code' },
      killGraceMs: 250,
      claudeConfigDir: '/tmp/claude-config',
      providerConnectionExternalRef: null,
    });
  });

  it('falls back to the default binary for a blank claudeBin', () => {
    expect(normalizeClaudeCodeRuntimeConfig({ claudeBin: '   ' }).claudeBin).toBe('claude');
  });

  it('treats blank optional strings as absent', () => {
    const normalized = normalizeClaudeCodeRuntimeConfig({
      workingDirectory: '  ',
      model: '',
      systemPromptSuffix: '\n\t',
      claudeConfigDir: ' ',
    });
    expect(normalized.workingDirectory).toBeNull();
    expect(normalized.model).toBeNull();
    expect(normalized.systemPromptSuffix).toBeNull();
    expect(normalized.claudeConfigDir).toBeNull();
  });

  it('copies arrays and env instead of aliasing the stored config', () => {
    const config: ClaudeCodeRuntimeConfig = {
      allowedTools: ['Bash'],
      disallowedTools: ['WebSearch'],
      extraArgs: ['--debug'],
      env: { RUNTIME_LABEL: 'claude-code' },
    };

    const normalized = normalizeClaudeCodeRuntimeConfig(config);

    expect(normalized.allowedTools).not.toBe(config.allowedTools);
    expect(normalized.disallowedTools).not.toBe(config.disallowedTools);
    expect(normalized.extraArgs).not.toBe(config.extraArgs);
    expect(normalized.env).not.toBe(config.env);

    config.allowedTools?.push('Write');
    config.disallowedTools?.push('Read');
    config.extraArgs?.push('--ide');
    if (config.env) config.env.RUNTIME_LABEL = 'hermes';

    expect(normalized.allowedTools).toEqual(['Bash']);
    expect(normalized.disallowedTools).toEqual(['WebSearch']);
    expect(normalized.extraArgs).toEqual(['--debug']);
    expect(normalized.env).toEqual({ RUNTIME_LABEL: 'claude-code' });
  });

  it('does not mutate the input config', () => {
    const config: ClaudeCodeRuntimeConfig = { claudeBin: ' claude ', extraArgs: ['--debug'] };
    normalizeClaudeCodeRuntimeConfig(config);
    expect(config).toEqual({ claudeBin: ' claude ', extraArgs: ['--debug'] });
  });

  it('drops unknown extra keys from the normalized shape', () => {
    const normalized = normalizeClaudeCodeRuntimeConfig({ legacyField: 42 });
    expect(normalized).not.toHaveProperty('legacyField');
    expect(normalized.claudeBin).toBe('claude');
  });

  it('throws the validation message for an invalid config', () => {
    expect(() => normalizeClaudeCodeRuntimeConfig({ effort: 'extreme' as never })).toThrow(
      'runtime_config.effort must be one of: low, medium, high, xhigh, max',
    );
    expect(() => normalizeClaudeCodeRuntimeConfig({ maxTurns: 0 })).toThrow(
      'runtime_config.maxTurns must be a positive number',
    );
    expect(() => normalizeClaudeCodeRuntimeConfig({ extraArgs: ['--session-id'] })).toThrow(
      'Claude Code runtime does not allow extraArgs entry "--session-id"',
    );
  });
});
