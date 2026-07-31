import {
  DISALLOWED_EXTRA_ARG_PREFIXES,
  DISALLOWED_EXTRA_ARG_VALUES,
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
        claudeBin: '/usr/local/bin/claude',
        model: 'claude-opus-4-5',
        effort: 'high',
        allowedTools: ['Bash', 'Read'],
        disallowedTools: ['WebSearch'],
        maxTurns: 40,
        maxBudgetUsd: 2.5,
        permissionMode: 'allowlist',
        systemPromptSuffix: 'Be terse.',
        extraArgs: ['--debug'],
        env: { AGENT_HQ_RUNTIME: 'claude-code' },
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

  it.each(['bypass', 'allowlist'] as const)('accepts permission mode %s', (permissionMode) => {
    expect(validateClaudeCodeRuntimeConfig({ permissionMode })).toBeNull();
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
});

describe('claude-code runtime extraArgs denylist', () => {
  it('pins the adapter-owned flag denylist', () => {
    // A silent drop from this list is a silent contract break: the CLI ignores
    // unknown flags and tolerates repeated ones, so nothing downstream errors.
    expect([...DISALLOWED_EXTRA_ARG_PREFIXES].sort()).toEqual(
      [
        '--print',
        '-p',
        '--output-format',
        '--input-format',
        '--verbose',
        '--session-id',
        '--resume',
        '-r',
        '--continue',
        '-c',
        '--fork-session',
        '--no-session-persistence',
        '--mcp-config',
        '--strict-mcp-config',
        '--model',
        '--effort',
        '--max-turns',
        '--max-budget-usd',
        '--append-system-prompt-file',
        '--append-system-prompt',
        '--system-prompt',
        '--system-prompt-file',
        '--permission-mode',
        '--dangerously-skip-permissions',
        '--allowedTools',
        '--allowed-tools',
        '--disallowedTools',
        '--disallowed-tools',
        '--tools',
        '--add-dir',
        '--settings',
        '--setting-sources',
        '--worktree',
        '--bg',
        '--background',
        '--remote-control',
      ].sort(),
    );
  });

  it('does not inherit the Hermes denylist', () => {
    // Hermes denies '-z' and treats '-p' as a Hermes-only flag; this adapter's
    // list is derived from the claude CLI's own surface.
    expect(DISALLOWED_EXTRA_ARG_PREFIXES).not.toContain('-z');
    expect(DISALLOWED_EXTRA_ARG_PREFIXES).toContain('-p');
  });

  it.each([...DISALLOWED_EXTRA_ARG_PREFIXES])('rejects extraArgs entry %s', (arg) => {
    expect(validateClaudeCodeRuntimeConfig({ extraArgs: [arg] })).toBe(
      `Claude Code runtime does not allow extraArgs entry ${JSON.stringify(arg)}`,
    );
  });

  it.each([...DISALLOWED_EXTRA_ARG_PREFIXES])('rejects the flag=value form of %s', (arg) => {
    const entry = `${arg}=value`;
    expect(validateClaudeCodeRuntimeConfig({ extraArgs: [entry] })).toBe(
      `Claude Code runtime does not allow extraArgs entry ${JSON.stringify(entry)}`,
    );
  });

  it.each([...DISALLOWED_EXTRA_ARG_VALUES])('rejects the %s subcommand word', (value) => {
    expect(validateClaudeCodeRuntimeConfig({ extraArgs: [value] })).toBe(
      `Claude Code runtime does not allow extraArgs entry ${JSON.stringify(value)}`,
    );
  });

  it('trims before matching, so padded entries cannot smuggle a denied flag', () => {
    expect(validateClaudeCodeRuntimeConfig({ extraArgs: ['  --session-id  '] })).toBe(
      'Claude Code runtime does not allow extraArgs entry "--session-id"',
    );
  });

  it('reports the first denied entry when several are present', () => {
    expect(
      validateClaudeCodeRuntimeConfig({ extraArgs: ['--debug', '--model', '--verbose'] }),
    ).toBe('Claude Code runtime does not allow extraArgs entry "--model"');
  });

  it.each(['--printer', '--models', '--verbosely', '--tools-config', '--add-dirs', 'mcp-proxy'])(
    'allows the near-miss entry %s',
    (arg) => {
      expect(validateClaudeCodeRuntimeConfig({ extraArgs: [arg] })).toBeNull();
    },
  );

  it('allows unrelated flags and skips blank entries', () => {
    expect(
      validateClaudeCodeRuntimeConfig({ extraArgs: ['--debug', '', '   ', '--ide'] }),
    ).toBeNull();
  });
});

describe('claude-code runtime config normalization', () => {
  it('applies defaults for an empty config', () => {
    expect(normalizeClaudeCodeRuntimeConfig({})).toEqual({
      workingDirectory: null,
      claudeBin: 'claude',
      model: null,
      effort: null,
      allowedTools: [],
      disallowedTools: [],
      maxTurns: null,
      maxBudgetUsd: null,
      permissionMode: 'bypass',
      systemPromptSuffix: null,
      extraArgs: [],
      env: {},
      killGraceMs: 10_000,
      claudeConfigDir: null,
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
        claudeBin: ' /usr/local/bin/claude ',
        model: ' claude-opus-4-5 ',
        effort: 'xhigh',
        allowedTools: ['Bash', 'Read'],
        disallowedTools: ['WebSearch'],
        maxTurns: 40,
        maxBudgetUsd: 2.5,
        permissionMode: 'allowlist',
        systemPromptSuffix: ' Be terse. ',
        extraArgs: ['--debug'],
        env: { AGENT_HQ_RUNTIME: 'claude-code' },
        killGraceMs: 250,
        claudeConfigDir: ' /tmp/claude-config ',
      }),
    ).toEqual({
      workingDirectory: '/tmp/worktree',
      claudeBin: '/usr/local/bin/claude',
      model: 'claude-opus-4-5',
      effort: 'xhigh',
      allowedTools: ['Bash', 'Read'],
      disallowedTools: ['WebSearch'],
      maxTurns: 40,
      maxBudgetUsd: 2.5,
      permissionMode: 'allowlist',
      systemPromptSuffix: 'Be terse.',
      extraArgs: ['--debug'],
      env: { AGENT_HQ_RUNTIME: 'claude-code' },
      killGraceMs: 250,
      claudeConfigDir: '/tmp/claude-config',
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
      env: { AGENT_HQ_RUNTIME: 'claude-code' },
    };

    const normalized = normalizeClaudeCodeRuntimeConfig(config);

    expect(normalized.allowedTools).not.toBe(config.allowedTools);
    expect(normalized.disallowedTools).not.toBe(config.disallowedTools);
    expect(normalized.extraArgs).not.toBe(config.extraArgs);
    expect(normalized.env).not.toBe(config.env);

    config.allowedTools?.push('Write');
    config.disallowedTools?.push('Read');
    config.extraArgs?.push('--ide');
    if (config.env) config.env.AGENT_HQ_RUNTIME = 'hermes';

    expect(normalized.allowedTools).toEqual(['Bash']);
    expect(normalized.disallowedTools).toEqual(['WebSearch']);
    expect(normalized.extraArgs).toEqual(['--debug']);
    expect(normalized.env).toEqual({ AGENT_HQ_RUNTIME: 'claude-code' });
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
