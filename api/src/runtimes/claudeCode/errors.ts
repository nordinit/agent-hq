/**
 * runtimes/claudeCode/errors.ts — collapse a finished Claude Code CLI run into a
 * single normalized {@link ClaudeFailureClassification}.
 *
 * Pure module: it reads an already-folded {@link ClaudeStreamAccumulator} plus
 * the process outcome, and returns a verdict. No DB, no filesystem, no child
 * process handles.
 *
 * Two properties drive every decision below.
 *
 *  1. PRECEDENCE IS FIXED AND TOTAL. The rules are evaluated in one documented
 *     order so that a run matching several signals always lands in the same
 *     bucket. An operator abort outranks the timeout it raced with; a dead
 *     required MCP server outranks a clean exit 0.
 *
 *  2. A FALSE `infra` VERDICT IS THE EXPENSIVE MISTAKE. `infra` tells Agent HQ
 *     "the agent never had a fair chance" — it re-queues work and suppresses the
 *     failure signal. Misfiling a genuine agent bug as `infra` therefore hides a
 *     real defect and burns another dispatch on it. So: structured signals are
 *     preferred over prose, prose patterns stay narrow, and text scanning is
 *     gated on the run actually showing failure evidence (see
 *     {@link hasFailureEvidence}).
 */

import { detectProviderLimitFailureText } from '../providerLimitFailure';
import { timestampFromEpochMs } from '../../lib/timestamps';
import { type ClaudeRateLimitInfo, type ClaudeStreamAccumulator } from './streamJson';
import { type ClaudeErrorCode, type ClaudeFailureClassification } from './types';

// ── Input ────────────────────────────────────────────────────────────────────

export interface ClassifyClaudeRunInput {
  accumulator: ClaudeStreamAccumulator;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error | null;
  timedOut: boolean;
  aborted: boolean;
  mcpReady: boolean;
  stderr: string;
  timeoutSeconds: number;
}

// ── Success encoding ─────────────────────────────────────────────────────────

/**
 * The code a successful run carries.
 *
 * `ClaudeErrorCode` has no `success` member and types.ts is the shared contract
 * this module may not extend, so success has to reuse an existing code. Rule 12
 * is the only other producer of `no_result` and it always pairs it with
 * `family: 'runtime'`, which leaves the PAIR (`family: 'none'`,
 * `code: 'no_result'`) produced by exactly one path — the success path. See the
 * {@link classifyClaudeRun} JSDoc for the caller-side contract.
 */
const SUCCESS_CODE: ClaudeErrorCode = 'no_result';

// ── Text patterns ────────────────────────────────────────────────────────────
//
// Every pattern here is deliberately narrow. Broad ones (a bare /error/, a bare
// /failed/) would swallow the agent's own prose, and each of these families maps
// to `infra`.

const AUTH_PATTERNS: readonly RegExp[] = [
  /\binvalid api key\b/i,
  /\bauthentication[_\s-]?error\b/i,
  /\binvalid bearer token\b/i,
  /\boauth token (?:has )?expired\b/i,
  /\bplease run\s*`?\/login`?/i,
  /\brun\s*`?\/login`?\s*to\b/i,
  /\bnot logged in\b/i,
  /\b(?:http|status|error code:?)\s*40[13]\b/i,
  /\bunauthorized\b/i,
  /\bcredentials?\s+(?:are\s+)?(?:invalid|missing|expired|not found)\b/i,
];

/**
 * Billing exhaustion phrasings that read as quota but carry none of the tokens
 * `detectProviderLimitFailureText` looks for (no 429, no "rate limit", no
 * "quota"). Supplements that detector rather than replacing it.
 */
const CREDIT_EXHAUSTION_PATTERNS: readonly RegExp[] = [
  /\bcredit balance is too low\b/i,
  /\binsufficient credits?\b/i,
  /\bout[_\s-]of[_\s-]credits\b/i,
];

const TRANSIENT_UPSTREAM_PATTERNS: readonly RegExp[] = [
  /\boverloaded(?:_error)?\b/i,
  /\binternal server error\b/i,
  /\bservice unavailable\b/i,
  /\bbad gateway\b/i,
  /\bgateway time-?out\b/i,
  /\bupstream connect error\b/i,
  /\bsocket hang ?up\b/i,
  /\bfetch failed\b/i,
  /\b(?:http|status|error code:?)\s*5\d{2}\b/i,
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b/,
];

const MODEL_NOT_FOUND_PATTERNS: readonly RegExp[] = [
  /\bmodel[_\s-]*not[_\s-]*found\b/i,
  /\bunknown model\b/i,
  /\binvalid model\b/i,
  /\bnot_found_error\b/i,
  /\bmodel\b[^\n]{0,60}\bdoes not exist\b/i,
];

const MAX_BUDGET_PATTERNS: readonly RegExp[] = [
  /\bmax(?:imum)?[_\s-]?budget\b/i,
  /\bbudget\s+(?:limit\s+)?(?:exceeded|exhausted|reached)\b/i,
  /\bcost limit\s+(?:exceeded|reached)\b/i,
  /\bexceeded[^\n]{0,40}\bbudget\b/i,
];

const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\brefusal\b/i,
  /\bstop[_\s-]?reason\W{0,4}refus/i,
  /\bviolates?\s+(?:the\s+)?(?:usage|acceptable[_\s-]use|content)\s+polic/i,
  /\bI\s+(?:cannot|can't|won't|will not)\s+(?:comply|assist with|help with)\b/i,
];

// ── Small helpers ────────────────────────────────────────────────────────────

const SUMMARY_DETAIL_LIMIT = 240;

/** Collapse to one line and clip, so a summary stays fit for `runtime_end_error`. */
function clip(text: string, limit = SUMMARY_DETAIL_LIMIT): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** First pattern hit, clipped — gives the summary something concrete to quote. */
function firstMatch(patterns: readonly RegExp[], text: string): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) {
      // Quote the surrounding sentence, not the bare token, so the summary is
      // readable by a human triaging the run.
      const start = Math.max(0, match.index - 60);
      return clip(text.slice(start, match.index + match[0].length + 120));
    }
  }
  return null;
}

/**
 * The CLI's `api_error_status` is an open string; pull an HTTP status out of it
 * when there is one. A structured status beats any prose pattern.
 */
function httpStatusFrom(apiErrorStatus: string | null): number | null {
  if (!apiErrorStatus) return null;
  const match = /\b([1-5]\d{2})\b/.exec(apiErrorStatus);
  return match ? Number(match[1]) : null;
}

/** Errors the CLI attached + child stderr + the agent's own final text. */
function combinedFailureText(input: ClassifyClaudeRunInput): string {
  const { accumulator } = input;
  return [accumulator.errors.join('\n'), input.stderr, accumulator.finalText]
    .filter((part) => part.length > 0)
    .join('\n');
}

function describeRateLimit(info: ClaudeRateLimitInfo): string {
  const parts: string[] = [];
  if (info.rateLimitType) parts.push(`type=${info.rateLimitType}`);
  if (info.status) parts.push(`status=${info.status}`);
  if (info.overageStatus) parts.push(`overage=${info.overageStatus}`);
  if (info.overageDisabledReason) parts.push(`reason=${info.overageDisabledReason}`);
  return parts.length > 0 ? parts.join(' ') : 'provider reported a rate limit';
}

/**
 * Did the provider actually refuse the request?
 *
 * `allowed_warning` is a heads-up attached to a request the provider still
 * served, so only a status outside the `allowed*` family counts as a refusal.
 * Treating every non-`allowed` string as a rejection would fail runs that merely
 * approached their limit.
 */
function rateLimitIsRejecting(info: ClaudeRateLimitInfo | null): boolean {
  if (!info) return false;
  if (info.overageStatus === 'rejected') return true;
  if (!info.status) return false;
  return !info.status.toLowerCase().startsWith('allowed');
}

function signalSuffix(signal: NodeJS.Signals | null): string {
  return signal ? ` (killed by ${signal})` : '';
}

/**
 * Is there any evidence at all that this run failed?
 *
 * Rules 5–13 read prose that INCLUDES the agent's own final answer, because a
 * CLI-level failure often only shows up there. That makes them unsafe to run
 * against a healthy run: an agent whose task was "fix our 429 retry handling"
 * will happily write "429" and "rate limit" into a perfectly successful report,
 * and a text-driven `provider_quota` verdict would throw that work away.
 *
 * So the text rules are gated behind this predicate. Everything it tests is
 * process- or protocol-level and cannot be authored by the agent: the CLI's own
 * `is_error` flag, a non-success result subtype, a missing result event, a
 * non-zero exit, a killing signal, or the structured `max_turns` terminal
 * reason.
 *
 * A rejected rate-limit event is deliberately NOT evidence: `accumulator
 * .rateLimit` holds the LATEST event, and a run that went on to produce a clean
 * successful result plainly was not blocked by it.
 */
function hasFailureEvidence(input: ClassifyClaudeRunInput): boolean {
  const { accumulator } = input;
  if (accumulator.isError) return true;
  if (!accumulator.sawResult) return true;
  if (input.signal !== null) return true;
  if (input.exitCode !== null && input.exitCode !== 0) return true;
  if (accumulator.terminalReason === 'max_turns') return true;
  const subtype = accumulator.resultSubtype;
  return subtype !== null && subtype !== 'success';
}

// ── Retry hint ───────────────────────────────────────────────────────────────

/**
 * Earliest canonical timestamp at which a rate-limited run could be retried.
 *
 * `rate_limit_info.resetsAt` is EPOCH SECONDS (verified against CLI 2.1.220 —
 * e.g. 1785527400), so it is scaled to milliseconds before formatting. The
 * result is a canonical offset-less UTC timestamp from lib/timestamps, never an
 * ISO string with `T`/`Z`: this value is written to a DB column and compared
 * with `datetime()`.
 */
export function retryNotBeforeFromRateLimit(info: ClaudeRateLimitInfo | null): string | null {
  if (!info || info.resetsAt === null || !Number.isFinite(info.resetsAt)) return null;
  return timestampFromEpochMs(info.resetsAt * 1000);
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Classify a finished claude-code run.
 *
 * Rules are evaluated strictly in this order; the first match wins:
 *
 *   1. spawn error        -> `spawn_failed`              (infra)
 *   2. operator abort     -> `aborted`                   (none)
 *   3. wall-clock timeout -> `timeout`                   (runtime)
 *   4. required MCP down  -> `mcp_not_ready`             (infra)
 *   -- no failure evidence: SUCCESS, see below
 *   5. auth               -> `claude_auth_required`      (infra)
 *   6. provider quota     -> `provider_quota`            (infra, + retryNotBefore)
 *   7. transient upstream -> `claude_transient_upstream`  (infra, + retryNotBefore)
 *   8. model missing      -> `model_not_found`           (infra)
 *   9. turn budget        -> `max_turns_exhausted`       (runtime)
 *  10. cost budget        -> `max_budget_exhausted`      (runtime)
 *  11. refusal            -> `claude_refusal`            (runtime)
 *  12. no result event    -> `no_result`                 (runtime)
 *  13. anything else      -> `nonzero_exit`              (runtime)
 *
 * SUCCESS CONTRACT. There is no `success` member in `ClaudeErrorCode`, so a
 * healthy run is reported as `{ family: 'none', code: 'no_result' }`. That pair
 * is unambiguous: rule 12 is the only other producer of `no_result` and it
 * always pairs it with `family: 'runtime'`. Callers should therefore treat
 * `family === 'none'` as "not a failure" and read `code` only to tell a success
 * (`no_result`) from an operator abort (`aborted`) — those are the only two
 * classifications that ever carry `family: 'none'`.
 *
 * The success check is evaluated after rule 4 rather than last. This changes no
 * outcome — rules 5–13 can only match a run that already shows failure evidence
 * (see {@link hasFailureEvidence}) — but it keeps the agent's own prose from
 * being scanned on a run that plainly succeeded.
 */
export function classifyClaudeRun(input: ClassifyClaudeRunInput): ClaudeFailureClassification {
  const { accumulator } = input;

  // 1. The CLI never started: bad path, missing binary, EACCES.
  if (input.spawnError) {
    return {
      code: 'spawn_failed',
      family: 'infra',
      summary: `Failed to start the Claude Code CLI: ${clip(input.spawnError.message)}`,
    };
  }

  // 2. An operator abort is not a failure of the work, so family is 'none'.
  //    It outranks `timedOut` because a stop request and the watchdog can race,
  //    and the human's intent is the more informative of the two.
  if (input.aborted) {
    return {
      code: 'aborted',
      family: 'none',
      summary: `Run was aborted before the CLI finished${signalSuffix(input.signal)}.`,
    };
  }

  // 3.
  if (input.timedOut) {
    return {
      code: 'timeout',
      family: 'runtime',
      summary:
        `Run exceeded its ${input.timeoutSeconds}s limit and was terminated` +
        `${signalSuffix(input.signal)}.`,
    };
  }

  // 4. Verified against CLI 2.1.220: an MCP server that fails to start does NOT
  //    fail the run — the process still exits 0 with terminal_reason
  //    'completed'. So the CLI is reporting this run as a success while the
  //    agent had no way to post an outcome, update a task, or read its brief.
  //    Nothing downstream can detect that after the fact, which is why this gate
  //    outranks every content-derived rule below.
  if (!input.mcpReady) {
    return {
      code: 'mcp_not_ready',
      family: 'infra',
      summary:
        'Agent could not reach Agent HQ lifecycle tools: a required MCP server never ' +
        'reached "connected". The CLI reports this run as a success, so its result ' +
        'cannot be trusted.',
    };
  }

  if (!hasFailureEvidence(input)) {
    return {
      code: SUCCESS_CODE,
      family: 'none',
      summary: `Run completed (${accumulator.totalTurns} turns).`,
    };
  }

  const text = combinedFailureText(input);
  const apiStatus = httpStatusFrom(accumulator.apiErrorStatus);
  const rateLimit = accumulator.rateLimit;

  // 5.
  if (apiStatus === 401 || apiStatus === 403 || matchesAny(AUTH_PATTERNS, text)) {
    const detail = firstMatch(AUTH_PATTERNS, text) ?? accumulator.apiErrorStatus ?? 'no detail';
    return {
      code: 'claude_auth_required',
      family: 'infra',
      summary: `Claude Code CLI is not authenticated: ${detail}`,
    };
  }

  // 6. The structured rate-limit event is authoritative and is checked before
  //    any prose: it says what the provider decided, in the provider's own
  //    words, and it carries the reset instant that prose never does.
  const quotaText = detectProviderLimitFailureText(text);
  const quotaFromRateLimit = rateLimit !== null && rateLimitIsRejecting(rateLimit);
  if (
    quotaFromRateLimit ||
    apiStatus === 429 ||
    quotaText !== null ||
    matchesAny(CREDIT_EXHAUSTION_PATTERNS, text)
  ) {
    // Quote whichever signal actually fired, so the summary never describes an
    // informational rate-limit event as the cause of a prose-detected limit.
    const detail =
      quotaFromRateLimit && rateLimit
        ? describeRateLimit(rateLimit)
        : (quotaText ?? firstMatch(CREDIT_EXHAUSTION_PATTERNS, text) ?? 'provider returned HTTP 429');
    return {
      code: 'provider_quota',
      family: 'infra',
      summary: `Provider limit reached: ${clip(detail)}`,
      retryNotBefore: retryNotBeforeFromRateLimit(rateLimit),
    };
  }

  // 7.
  if ((apiStatus !== null && apiStatus >= 500) || matchesAny(TRANSIENT_UPSTREAM_PATTERNS, text)) {
    const detail =
      firstMatch(TRANSIENT_UPSTREAM_PATTERNS, text) ?? accumulator.apiErrorStatus ?? 'no detail';
    const retryNotBefore = retryNotBeforeFromRateLimit(rateLimit);
    return {
      code: 'claude_transient_upstream',
      family: 'infra',
      summary: `Transient upstream failure from the Claude API: ${detail}`,
      ...(retryNotBefore ? { retryNotBefore } : {}),
    };
  }

  // 8. A 404 alone is not enough — the agent's own HTTP work can 404. Require
  //    the word "model" to be in play before blaming model availability.
  const mentionsModel = /\bmodel\b/i.test(text);
  if (mentionsModel && (apiStatus === 404 || matchesAny(MODEL_NOT_FOUND_PATTERNS, text))) {
    const detail = firstMatch(MODEL_NOT_FOUND_PATTERNS, text) ?? accumulator.model ?? 'no detail';
    return {
      code: 'model_not_found',
      family: 'infra',
      summary: `Model is not available to this account: ${detail}`,
    };
  }

  // 9. Both signals are structured; neither needs the prose.
  if (accumulator.resultSubtype === 'error_max_turns' || accumulator.terminalReason === 'max_turns') {
    return {
      code: 'max_turns_exhausted',
      family: 'runtime',
      summary: `Run stopped after exhausting its turn budget (${accumulator.totalTurns} turns).`,
    };
  }

  // 10.
  const budgetSubtype =
    (accumulator.resultSubtype ?? '').includes('budget') ||
    (accumulator.terminalReason ?? '').includes('budget');
  if (budgetSubtype || matchesAny(MAX_BUDGET_PATTERNS, text)) {
    const cost = accumulator.costUsd;
    const spent = cost === null ? '' : ` after $${cost.toFixed(4)}`;
    return {
      code: 'max_budget_exhausted',
      family: 'runtime',
      summary: `Run stopped after exhausting its cost budget${spent}.`,
    };
  }

  // 11.
  if ((accumulator.resultSubtype ?? '').includes('refusal') || matchesAny(REFUSAL_PATTERNS, text)) {
    const detail = firstMatch(REFUSAL_PATTERNS, text) ?? accumulator.resultSubtype ?? 'no detail';
    return {
      code: 'claude_refusal',
      family: 'runtime',
      summary: `The model declined to complete the task: ${detail}`,
    };
  }

  // 12. The process ended without ever emitting a result event — a crash, an
  //     OOM kill, or stdout that never carried one.
  if (!accumulator.sawResult) {
    const exited = input.exitCode === null ? 'no exit code' : `exit ${input.exitCode}`;
    return {
      code: 'no_result',
      family: 'runtime',
      summary: `CLI ended without emitting a result event (${exited}${signalSuffix(input.signal)}).`,
    };
  }

  // 13. Catch-all runtime failure: the agent ran and the work failed. Also the
  //     landing spot for a result flagged `is_error` on an otherwise clean exit.
  const exited =
    input.exitCode === null
      ? 'CLI terminated'
      : input.exitCode === 0
        ? 'CLI exited 0 but reported a failed result'
        : `CLI exited ${input.exitCode}`;
  const detail = clip(text);
  return {
    code: 'nonzero_exit',
    family: 'runtime',
    summary: `${exited}${signalSuffix(input.signal)}${detail ? `: ${detail}` : '.'}`,
  };
}
