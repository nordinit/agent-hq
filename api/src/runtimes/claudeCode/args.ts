/**
 * runtimes/claudeCode/args.ts — pure argv builder for the Claude Code CLI.
 *
 * Pure module: no DB, no filesystem, no process handles. Given a
 * `ClaudeArgsInput` it returns the exact argument vector to hand to `spawn`.
 *
 * Three verified CLI behaviours (2.1.222) shape everything here:
 *
 *  1. `--print -` reads the PROMPT FROM STDIN. The prompt is therefore absent
 *     from this payload entirely; putting a multi-KB task context in argv would
 *     risk E2BIG.
 *
 *  2. `--allowedTools` is a permission allow rule, NOT an available-tool
 *     boundary. `--tools` replaces the built-in tool set, while
 *     `--permission-mode dontAsk` denies every unapproved call.
 *
 *  3. **The CLI SILENTLY IGNORES UNKNOWN FLAGS.** A typo, or a flag renamed in a
 *     future release, does not error — it just stops taking effect. That is why
 *     all three boundary flags and argv order are asserted exactly in
 *     args.test.ts rather than spot-checked.
 */

import { NO_ALLOWED_MCP_TOOLS_SENTINEL, type ClaudeArgsInput } from './types';

/**
 * Adapter-owned settings are passed at CLI precedence while ambient user,
 * project and local settings are disabled with `--setting-sources ''`.
 * `--strict-mcp-config` separately owns the MCP boundary. Managed organization
 * policy remains authoritative by Claude Code design and cannot be bypassed by
 * a child-process caller.
 */
export const CLAUDE_BOUNDARY_SETTINGS = JSON.stringify({
  disableAllHooks: true,
  enabledPlugins: {},
  extraKnownMarketplaces: {},
});

/**
 * The invariant prefix every Agent HQ claude-code run starts with.
 *
 * The bare `-` after `--print` is what selects stdin as the prompt source, and
 * `--verbose` is REQUIRED for `--output-format stream-json` to emit the full
 * event stream rather than a single terminal result.
 */
export const BASE_CLAUDE_ARGS: readonly string[] = [
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
];

/** Drop blank entries so a comma-join can never produce `Read,,Bash`. */
function compact(values: readonly string[] | undefined | null): string[] {
  if (!values) return [];
  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

/** Concatenate preserving first-seen order, dropping duplicates. */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isPositive(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Build the argument vector for one dispatched run.
 *
 * Ordering is deterministic by construction: adapter-owned flags first, then a
 * tiny validated allowlist of argument-free operator observability flags. No
 * operator argument can replace a boundary flag.
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const { config } = input;
  const args: string[] = [...BASE_CLAUDE_ARGS];

  // `--resume` continues an existing conversation; `--session-id` opens a new one
  // under a chosen id. Exactly one applies, never both.
  args.push(input.resume ? '--resume' : '--session-id', input.sessionId);

  const builtInTools = dedupe(compact(config.allowedTools));

  if (config.permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
    // Even the explicitly dangerous posture gets a deterministic built-in tool
    // surface. In particular, an explicit [] must not degrade into CLI defaults.
    args.push('--tools', builtInTools.join(','));
  } else {
    // The MCP names arrive already fully-qualified (`mcp__<server>__<tool>`);
    // the built-ins are bare. Both share one namespace in --allowedTools.
    const mcpTools = compact(input.mcpAllowedToolNames).filter(
      // The materializer writes this sentinel to mean "this assignment grants no
      // tools". It is not a tool name and must never reach the CLI.
      (name) => name !== NO_ALLOWED_MCP_TOOLS_SENTINEL,
    );

    // `--tools` is the exclusive built-in availability boundary; `--allowedTools`
    // only pre-approves calls. `dontAsk` turns every unlisted MCP call into a hard
    // denial instead of an interactive prompt. All three are required.
    args.push('--permission-mode', 'dontAsk');
    args.push('--tools', builtInTools.join(','));
    args.push('--allowedTools', dedupe([...builtInTools, ...mcpTools]).join(','));
  }

  const model = (input.model ?? '').trim() || (config.model ?? '').trim();
  if (model) args.push('--model', model);

  if (config.effort) args.push('--effort', config.effort);
  if (isPositive(config.maxTurns)) args.push('--max-turns', String(config.maxTurns));
  if (isPositive(config.maxBudgetUsd)) args.push('--max-budget-usd', String(config.maxBudgetUsd));

  const disallowedTools = compact(config.disallowedTools);
  if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','));

  if (input.appendSystemPromptFilePath) {
    args.push('--append-system-prompt-file', input.appendSystemPromptFilePath);
  }

  if (input.mcpConfigPath) args.push('--mcp-config', input.mcpConfigPath);
  // `--strict-mcp-config` is in the invariant prefix, including for a run with
  // zero assignments. Omitting it when no file exists would re-enable ambient
  // user/project/plugin MCP servers.

  for (const dir of compact(input.addDirs)) args.push('--add-dir', dir);

  args.push(...config.extraArgs);

  return args;
}
