import { detectProviderLimitFailureText } from '../providerLimitFailure';
import type { CodexStreamAccumulator } from './streamJson';
import type { CodexFailureClassification } from './types';

export interface ClassifyCodexRunInput {
  accumulator: CodexStreamAccumulator;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error | null;
  timedOut: boolean;
  aborted: boolean;
  stderr: string;
  malformedLineCount: number;
  timeoutSeconds: number;
}

function clip(value: string): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function matches(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

const AUTH = [
  /not logged in/i,
  /please run.*codex login/i,
  /invalid api key/i,
  /unauthorized/i,
  /authentication.*(?:failed|required)/i,
  /(?:status|http)\s*40[13]\b/i,
];
const TRANSIENT = [
  /service unavailable/i,
  /bad gateway/i,
  /gateway time-?out/i,
  /overloaded/i,
  /(?:status|http)\s*5\d{2}\b/i,
  /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/,
];
const MODEL = [
  /model[^\n]{0,80}(?:not found|does not exist|not available)/i,
  /unknown model/i,
  /invalid model/i,
];
const MCP = [/mcp[^\n]{0,80}(?:failed|unavailable|could not start|timed out)/i];
const SANDBOX = [
  /sandbox[^\n]{0,80}(?:denied|violation|blocked)/i,
  /operation not permitted/i,
  /permission denied/i,
  /read-only file system/i,
];

export function classifyCodexRun(input: ClassifyCodexRunInput): CodexFailureClassification {
  if (input.spawnError) {
    return {
      code: 'spawn_failed',
      family: 'infra',
      summary: `Failed to start the Codex CLI: ${clip(input.spawnError.message)}`,
    };
  }
  if (input.aborted) {
    return { code: 'aborted', family: 'none', summary: 'Codex run was aborted by an operator.' };
  }
  if (input.timedOut) {
    return {
      code: 'timeout',
      family: 'runtime',
      summary: `Codex run exceeded its ${input.timeoutSeconds}s limit and was terminated.`,
    };
  }

  if (
    input.exitCode === 0 &&
    input.signal === null &&
    input.accumulator.sawTurnCompleted &&
    !input.accumulator.sawTurnFailed
  ) {
    return { code: 'success', family: 'none', summary: 'Codex turn completed.' };
  }

  const content = [input.accumulator.errors.join('\n'), input.stderr]
    .filter(Boolean)
    .join('\n');
  const quota = detectProviderLimitFailureText(content);
  if (matches(content, AUTH)) {
    return { code: 'codex_auth_required', family: 'infra', summary: `Codex authentication failed: ${clip(content)}` };
  }
  if (quota) {
    return { code: 'provider_quota', family: 'infra', summary: `Provider limit reached: ${clip(quota)}` };
  }
  if (matches(content, TRANSIENT)) {
    return { code: 'codex_transient_upstream', family: 'infra', summary: `Transient Codex upstream failure: ${clip(content)}` };
  }
  if (matches(content, MODEL)) {
    return { code: 'model_not_found', family: 'infra', summary: `Codex model is unavailable: ${clip(content)}` };
  }
  if (matches(content, MCP)) {
    return { code: 'mcp_not_ready', family: 'infra', summary: `Codex MCP failure: ${clip(content)}` };
  }
  if (matches(content, SANDBOX)) {
    return { code: 'sandbox_denied', family: 'runtime', summary: `Codex sandbox denied an operation: ${clip(content)}` };
  }
  if (input.accumulator.sawTurnFailed) {
    return { code: 'turn_failed', family: 'runtime', summary: `Codex reported a failed turn${content ? `: ${clip(content)}` : '.'}` };
  }
  if (input.malformedLineCount > 0 && input.accumulator.eventCount === 0) {
    return { code: 'malformed_output', family: 'runtime', summary: 'Codex stdout did not contain valid JSONL events.' };
  }
  if (!input.accumulator.sawTurnCompleted) {
    return { code: 'no_turn_completion', family: 'runtime', summary: `Codex exited without a turn.completed event${content ? `: ${clip(content)}` : '.'}` };
  }
  return { code: 'nonzero_exit', family: 'runtime', summary: `Codex CLI exited ${input.exitCode ?? 'without an exit code'}${content ? `: ${clip(content)}` : '.'}` };
}
