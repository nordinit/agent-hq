/**
 * runtimes/claudeCode/args.ts — pure argv builder for the Claude Code CLI.
 *
 * Pure module: no DB, no filesystem, no process handles. Given a
 * `ClaudeArgsInput` it returns the exact argument vector to hand to `spawn`.
 *
 * Two verified CLI behaviours (2.1.220) shape everything here:
 *
 *  1. `--print -` reads the PROMPT FROM STDIN. The prompt is therefore absent
 *     from this payload entirely; putting a multi-KB task context in argv would
 *     risk E2BIG.
 *
 *  2. **The CLI SILENTLY IGNORES UNKNOWN FLAGS.** A typo, or a flag renamed in a
 *     future release, does not error — it just stops taking effect. A dropped
 *     `--allowedTools` degrades a locked-down run into an unrestricted one with
 *     no signal anywhere. That is why argv order is fixed and asserted
 *     exactly in args.test.ts rather than spot-checked.
 */

import { NO_ALLOWED_MCP_TOOLS_SENTINEL, type ClaudeArgsInput } from './types';

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
 * Ordering is deterministic by construction: adapter-owned flags first, operator
 * `extraArgs` LAST. Later occurrences of a repeated flag win in the CLI's own
 * parser, so putting operator args last is what makes them an escape hatch
 * instead of something the adapter can silently override.
 */
export function buildClaudeArgs(input: ClaudeArgsInput): string[] {
  const { config } = input;
  const args: string[] = [...BASE_CLAUDE_ARGS];

  args.push('--session-id', input.sessionId);

  const builtInTools = compact(config.allowedTools);

  if (config.permissionMode === 'bypass') {
    args.push('--dangerously-skip-permissions');
  } else {
    // The MCP names arrive already fully-qualified (`mcp__<server>__<tool>`);
    // the built-ins are bare. Both share one namespace in --allowedTools.
    const mcpTools = compact(input.mcpAllowedToolNames).filter(
      // The materializer writes this sentinel to mean "this assignment grants no
      // tools". It is not a tool name and must never reach the CLI.
      (name) => name !== NO_ALLOWED_MCP_TOOLS_SENTINEL,
    );

    // Emitted even when the combined list is empty. An empty allowlist means a
    // tool-less run; omitting the flag would instead hand the run the CLI's
    // full default tool set, turning the strictest configuration into the
    // loosest one. Fail-open here defeats the entire posture.
    args.push('--allowedTools', dedupe([...builtInTools, ...mcpTools]).join(','));
  }

  const model = (input.model ?? '').trim() || (config.model ?? '').trim();
  if (model) args.push('--model', model);

  if (config.effort) args.push('--effort', config.effort);
  if (isPositive(config.maxTurns)) args.push('--max-turns', String(config.maxTurns));
  if (isPositive(config.maxBudgetUsd)) args.push('--max-budget-usd', String(config.maxBudgetUsd));

  // `--tools` REPLACES the built-in tool set outright (verified 2.1.220), which
  // is how a bypass run gets narrowed at all. Under 'allowlist' the same names
  // are already carried by --allowedTools, and passing both states the policy
  // twice in two mechanisms — contradictory, so we pick one.
  if (builtInTools.length > 0 && config.permissionMode === 'bypass') {
    args.push('--tools', builtInTools.join(','));
  }

  const disallowedTools = compact(config.disallowedTools);
  if (disallowedTools.length > 0) args.push('--disallowedTools', disallowedTools.join(','));

  if (input.appendSystemPromptFilePath) {
    args.push('--append-system-prompt-file', input.appendSystemPromptFilePath);
  }

  if (input.mcpConfigPath) {
    // ALWAYS paired. `--mcp-config` alone MERGES the operator's personal
    // ~/.claude MCP servers into the run; `--strict-mcp-config` restricts the
    // run to exactly the servers Agent HQ materialized for it.
    args.push('--mcp-config', input.mcpConfigPath, '--strict-mcp-config');
  }

  for (const dir of compact(input.addDirs)) args.push('--add-dir', dir);

  args.push(...config.extraArgs);

  return args;
}
