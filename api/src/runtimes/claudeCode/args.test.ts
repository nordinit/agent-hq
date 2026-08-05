import { BASE_CLAUDE_ARGS, CLAUDE_BOUNDARY_SETTINGS, buildClaudeArgs } from './args';
import {
  NO_ALLOWED_MCP_TOOLS_SENTINEL,
  type ClaudeArgsInput,
  type NormalizedClaudeCodeRuntimeConfig,
} from './types';

/**
 * Every assertion in this file compares the WHOLE argv with `toEqual`, never
 * `toContain`. The CLI silently ignores unknown flags (verified 2.1.222), so a
 * typo or a future flag rename produces no error and no log line — an exact
 * vector is the only thing that can catch it. The small validated `extraArgs`
 * surface stays last, but cannot replace adapter-owned boundary flags.
 */

const SESSION_ID = '9278eeca-b7af-44f7-bc1f-2e6d4c16ee09';

function config(
  overrides: Partial<NormalizedClaudeCodeRuntimeConfig> = {},
): NormalizedClaudeCodeRuntimeConfig {
  return {
    workingDirectory: null,
    claudeBin: 'claude',
    model: null,
    effort: null,
    allowedTools: [],
    disallowedTools: [],
    maxTurns: null,
    maxBudgetUsd: null,
    permissionMode: 'bypass',
    allowDangerousBypass: true,
    systemPromptSuffix: null,
    extraArgs: [],
    env: {},
    killGraceMs: 10_000,
    claudeConfigDir: null,
    providerConnectionExternalRef: null,
    ...overrides,
  };
}

function input(overrides: Partial<ClaudeArgsInput> = {}): ClaudeArgsInput {
  return {
    config: overrides.config ?? config(),
    sessionId: SESSION_ID,
    ...overrides,
  };
}

/** The argv every case starts with, up to and including the permission posture. */
const SESSION_HEAD = [
  ...BASE_CLAUDE_ARGS,
  '--session-id',
  SESSION_ID,
];

function bypassHead(tools = ''): string[] {
  return [
    ...SESSION_HEAD,
    '--dangerously-skip-permissions',
    '--tools',
    tools,
  ];
}

function allowlistHead(builtInTools = '', allowedTools = builtInTools): string[] {
  return [
    ...SESSION_HEAD,
    '--permission-mode',
    'dontAsk',
    '--tools',
    builtInTools,
    '--allowedTools',
    allowedTools,
  ];
}

const BYPASS_HEAD = [
  ...SESSION_HEAD,
  '--dangerously-skip-permissions',
  '--tools',
  '',
];

describe('BASE_CLAUDE_ARGS', () => {
  it('is the exact stdin-driven stream-json prefix', () => {
    expect([...BASE_CLAUDE_ARGS]).toEqual([
      '--print',
      '-',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      '',
      '--settings',
      CLAUDE_BOUNDARY_SETTINGS,
      '--disable-slash-commands',
      '--no-chrome',
      '--strict-mcp-config',
    ]);
  });

  it('never carries the prompt — `-` selects stdin', () => {
    expect(BASE_CLAUDE_ARGS).toContain('-');
    expect(BASE_CLAUDE_ARGS.indexOf('-')).toBe(BASE_CLAUDE_ARGS.indexOf('--print') + 1);
  });
});

describe('buildClaudeArgs — minimal argv', () => {
  it('emits only the base, the session and the posture when nothing is configured', () => {
    expect(buildClaudeArgs(input())).toEqual(BYPASS_HEAD);
  });

  it('does not mutate BASE_CLAUDE_ARGS across calls', () => {
    buildClaudeArgs(input({ config: config({ effort: 'xhigh' }) }));
    expect([...BASE_CLAUDE_ARGS]).toHaveLength(12);
    expect(buildClaudeArgs(input())).toEqual(BYPASS_HEAD);
  });

  it('passes the pre-minted session id through verbatim', () => {
    const args = buildClaudeArgs(input({ sessionId: 'a-b-c' }));
    expect(args).toEqual([
      ...BASE_CLAUDE_ARGS,
      '--session-id',
      'a-b-c',
      '--dangerously-skip-permissions',
      '--tools',
      '',
    ]);
  });
});

describe('buildClaudeArgs — permission posture fork', () => {
  it('uses --dangerously-skip-permissions under bypass', () => {
    const args = buildClaudeArgs(input({ config: config({ permissionMode: 'bypass' }) }));
    expect(args).toEqual(BYPASS_HEAD);
  });

  it('combines exclusive --tools with dontAsk and --allowedTools under allowlist', () => {
    const args = buildClaudeArgs(
      input({ config: config({ permissionMode: 'allowlist', allowedTools: ['Bash', 'Read'] }) }),
    );
    expect(args).toEqual(allowlistHead('Bash,Read'));
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('emits an EMPTY --allowedTools rather than omitting it when nothing is allowed', () => {
    // Both availability and auto-approval must remain empty; omitting either
    // flag would hand the run more authority than the stored policy.
    const args = buildClaudeArgs(input({ config: config({ permissionMode: 'allowlist' }) }));
    expect(args).toEqual(allowlistHead());
  });
});

describe('buildClaudeArgs — MCP allowlist assembly', () => {
  it('merges built-ins and fully-qualified MCP tool names in that order', () => {
    const args = buildClaudeArgs(
      input({
        config: config({ permissionMode: 'allowlist', allowedTools: ['Read', 'Bash'] }),
        mcpAllowedToolNames: ['mcp__agent-hq__post_outcome', 'mcp__agent-hq__get_task'],
      }),
    );
    expect(args).toEqual(allowlistHead(
      'Read,Bash',
      'Read,Bash,mcp__agent-hq__post_outcome,mcp__agent-hq__get_task',
    ));
  });

  it('de-duplicates the merged list while preserving first-seen order', () => {
    const args = buildClaudeArgs(
      input({
        config: config({ permissionMode: 'allowlist', allowedTools: ['Read', 'Bash', 'Read'] }),
        mcpAllowedToolNames: ['mcp__a__x', 'Bash', 'mcp__a__x'],
      }),
    );
    expect(args).toEqual(allowlistHead('Read,Bash', 'Read,Bash,mcp__a__x'));
  });

  it('passes an assigned-server wildcard to --allowedTools verbatim', () => {
    const args = buildClaudeArgs(
      input({
        config: config({ permissionMode: 'allowlist' }),
        mcpAllowedToolNames: ['mcp__agent-hq__agent-42__*'],
      }),
    );
    expect(args).toEqual(allowlistHead('', 'mcp__agent-hq__agent-42__*'));
  });

  it('drops the no-tools sentinel instead of passing it off as a tool name', () => {
    const args = buildClaudeArgs(
      input({
        config: config({ permissionMode: 'allowlist' }),
        mcpAllowedToolNames: [NO_ALLOWED_MCP_TOOLS_SENTINEL],
      }),
    );
    expect(args).toEqual(allowlistHead());
  });

  it('ignores mcpAllowedToolNames entirely under bypass', () => {
    const args = buildClaudeArgs(
      input({
        config: config({ permissionMode: 'bypass' }),
        mcpAllowedToolNames: ['mcp__agent-hq__post_outcome'],
      }),
    );
    expect(args).toEqual(BYPASS_HEAD);
  });
});

describe('buildClaudeArgs — model resolution', () => {
  it('omits --model when neither dispatch nor config resolves one', () => {
    expect(buildClaudeArgs(input())).toEqual(BYPASS_HEAD);
  });

  it('uses config.model when dispatch supplies none', () => {
    const args = buildClaudeArgs(input({ config: config({ model: 'claude-opus-4-5' }) }));
    expect(args).toEqual([...BYPASS_HEAD, '--model', 'claude-opus-4-5']);
  });

  it('lets the per-dispatch model outrank config.model', () => {
    const args = buildClaudeArgs(
      input({ config: config({ model: 'claude-haiku-4-5' }), model: 'claude-opus-4-5' }),
    );
    expect(args).toEqual([...BYPASS_HEAD, '--model', 'claude-opus-4-5']);
  });

  it('falls back to config.model when the dispatch override is null', () => {
    const args = buildClaudeArgs(
      input({ config: config({ model: 'claude-haiku-4-5' }), model: null }),
    );
    expect(args).toEqual([...BYPASS_HEAD, '--model', 'claude-haiku-4-5']);
  });
});

describe('buildClaudeArgs — numeric and enum flags', () => {
  it('emits --effort with the level verbatim, including xhigh', () => {
    const args = buildClaudeArgs(input({ config: config({ effort: 'xhigh' }) }));
    expect(args).toEqual([...BYPASS_HEAD, '--effort', 'xhigh']);
  });

  it('emits --max-turns as a string when positive', () => {
    const args = buildClaudeArgs(input({ config: config({ maxTurns: 40 }) }));
    expect(args).toEqual([...BYPASS_HEAD, '--max-turns', '40']);
  });

  it('omits --max-turns when zero', () => {
    expect(buildClaudeArgs(input({ config: config({ maxTurns: 0 }) }))).toEqual(BYPASS_HEAD);
  });

  it('emits --max-budget-usd as a string when positive', () => {
    const args = buildClaudeArgs(input({ config: config({ maxBudgetUsd: 2.5 }) }));
    expect(args).toEqual([...BYPASS_HEAD, '--max-budget-usd', '2.5']);
  });

  it('omits --max-budget-usd when zero', () => {
    expect(buildClaudeArgs(input({ config: config({ maxBudgetUsd: 0 }) }))).toEqual(BYPASS_HEAD);
  });
});

describe('buildClaudeArgs — tool set flags', () => {
  it('emits --tools under bypass, where it is the only way to narrow the built-ins', () => {
    const args = buildClaudeArgs(input({ config: config({ allowedTools: ['Bash', 'Read'] }) }));
    expect(args).toEqual(bypassHead('Bash,Read'));
  });

  it('emits --tools under allowlist because --allowedTools alone is not exclusive', () => {
    const args = buildClaudeArgs(
      input({ config: config({ permissionMode: 'allowlist', allowedTools: ['Bash', 'Read'] }) }),
    );
    expect(args).toEqual(allowlistHead('Bash,Read'));
  });

  it('emits empty --tools when no built-ins are configured', () => {
    expect(buildClaudeArgs(input({ config: config({ allowedTools: [] }) }))).toEqual(BYPASS_HEAD);
    expect(BYPASS_HEAD).toContain('--tools');
  });

  it('emits --disallowedTools when set, in both postures', () => {
    expect(
      buildClaudeArgs(input({ config: config({ disallowedTools: ['WebFetch', 'WebSearch'] }) })),
    ).toEqual([...BYPASS_HEAD, '--disallowedTools', 'WebFetch,WebSearch']);

    expect(
      buildClaudeArgs(
        input({
          config: config({ permissionMode: 'allowlist', disallowedTools: ['WebFetch'] }),
        }),
      ),
    ).toEqual([...allowlistHead(), '--disallowedTools', 'WebFetch']);
  });

  it('omits --disallowedTools when empty', () => {
    const args = buildClaudeArgs(input({ config: config({ disallowedTools: [] }) }));
    expect(args).toEqual(BYPASS_HEAD);
  });
});

describe('buildClaudeArgs — file and directory flags', () => {
  it('emits --append-system-prompt-file when a path is provided', () => {
    const args = buildClaudeArgs(input({ appendSystemPromptFilePath: '/run/42/system.md' }));
    expect(args).toEqual([...BYPASS_HEAD, '--append-system-prompt-file', '/run/42/system.md']);
  });

  it('omits --append-system-prompt-file when null', () => {
    expect(buildClaudeArgs(input({ appendSystemPromptFilePath: null }))).toEqual(BYPASS_HEAD);
  });

  it('adds a materialized config inside the invariant strict MCP boundary', () => {
    const args = buildClaudeArgs(input({ mcpConfigPath: '/run/42/mcp-config.json' }));
    expect(args).toEqual([
      ...BYPASS_HEAD,
      '--mcp-config',
      '/run/42/mcp-config.json',
    ]);
    expect(args).toContain('--strict-mcp-config');
  });

  it('keeps strict MCP mode when no config was materialized', () => {
    const args = buildClaudeArgs(input({ mcpConfigPath: null }));
    expect(args).toEqual(BYPASS_HEAD);
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
  });

  it('repeats --add-dir once per directory, in order', () => {
    const args = buildClaudeArgs(input({ addDirs: ['/repos/a', '/repos/b', '/repos/c'] }));
    expect(args).toEqual([
      ...BYPASS_HEAD,
      '--add-dir',
      '/repos/a',
      '--add-dir',
      '/repos/b',
      '--add-dir',
      '/repos/c',
    ]);
  });

  it('omits --add-dir when the list is empty', () => {
    expect(buildClaudeArgs(input({ addDirs: [] }))).toEqual(BYPASS_HEAD);
  });
});

describe('buildClaudeArgs — extraArgs', () => {
  it('appends validated argument-free extraArgs last', () => {
    const args = buildClaudeArgs(
      input({
        config: config({ model: 'claude-haiku-4-5', extraArgs: ['--debug'] }),
        mcpConfigPath: '/run/42/mcp-config.json',
        addDirs: ['/repos/a'],
      }),
    );
    expect(args).toEqual([
      ...BYPASS_HEAD,
      '--model',
      'claude-haiku-4-5',
      '--mcp-config',
      '/run/42/mcp-config.json',
      '--add-dir',
      '/repos/a',
      '--debug',
    ]);
  });

  it('adds nothing when extraArgs is empty', () => {
    expect(buildClaudeArgs(input({ config: config({ extraArgs: [] }) }))).toEqual(BYPASS_HEAD);
  });
});

describe('buildClaudeArgs — full argv ordering', () => {
  it('orders every bypass flag deterministically', () => {
    const args = buildClaudeArgs(
      input({
        config: config({
          permissionMode: 'bypass',
          model: 'claude-haiku-4-5',
          effort: 'max',
          maxTurns: 12,
          maxBudgetUsd: 7,
          allowedTools: ['Bash', 'Read'],
          disallowedTools: ['WebFetch'],
          extraArgs: ['--debug'],
        }),
        model: 'claude-opus-4-5',
        mcpConfigPath: '/run/42/mcp-config.json',
        appendSystemPromptFilePath: '/run/42/system.md',
        addDirs: ['/repos/a', '/repos/b'],
      }),
    );

    expect(args).toEqual([
      ...BASE_CLAUDE_ARGS,
      '--session-id',
      SESSION_ID,
      '--dangerously-skip-permissions',
      '--tools',
      'Bash,Read',
      '--model',
      'claude-opus-4-5',
      '--effort',
      'max',
      '--max-turns',
      '12',
      '--max-budget-usd',
      '7',
      '--disallowedTools',
      'WebFetch',
      '--append-system-prompt-file',
      '/run/42/system.md',
      '--mcp-config',
      '/run/42/mcp-config.json',
      '--add-dir',
      '/repos/a',
      '--add-dir',
      '/repos/b',
      '--debug',
    ]);
  });

  it('orders every allowlist flag deterministically', () => {
    const args = buildClaudeArgs(
      input({
        config: config({
          permissionMode: 'allowlist',
          model: 'claude-opus-4-5',
          effort: 'high',
          maxTurns: 3,
          maxBudgetUsd: 0.5,
          allowedTools: ['Read'],
          disallowedTools: ['Bash'],
          extraArgs: ['--debug'],
        }),
        mcpConfigPath: '/run/9/mcp-config.json',
        mcpAllowedToolNames: ['mcp__agent-hq__post_outcome'],
        appendSystemPromptFilePath: '/run/9/system.md',
        addDirs: ['/repos/z'],
      }),
    );

    expect(args).toEqual([
      ...BASE_CLAUDE_ARGS,
      '--session-id',
      SESSION_ID,
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read',
      '--allowedTools',
      'Read,mcp__agent-hq__post_outcome',
      '--model',
      'claude-opus-4-5',
      '--effort',
      'high',
      '--max-turns',
      '3',
      '--max-budget-usd',
      '0.5',
      '--disallowedTools',
      'Bash',
      '--append-system-prompt-file',
      '/run/9/system.md',
      '--mcp-config',
      '/run/9/mcp-config.json',
      '--add-dir',
      '/repos/z',
      '--debug',
    ]);
  });

  it('is deterministic across repeated calls with the same input', () => {
    const payload = input({
      config: config({ effort: 'low', allowedTools: ['Read'], extraArgs: ['--debug'] }),
      addDirs: ['/repos/a'],
    });
    expect(buildClaudeArgs(payload)).toEqual(buildClaudeArgs(payload));
  });

  it('drops blank entries so a comma-join can never emit an empty tool name', () => {
    const args = buildClaudeArgs(
      input({
        config: config({ permissionMode: 'allowlist', allowedTools: ['Read', '', '  '] }),
        mcpAllowedToolNames: ['', 'mcp__a__x'],
        addDirs: ['/repos/a', ''],
      }),
    );
    expect(args).toEqual([
      ...allowlistHead('Read', 'Read,mcp__a__x'),
      '--add-dir',
      '/repos/a',
    ]);
  });
});
