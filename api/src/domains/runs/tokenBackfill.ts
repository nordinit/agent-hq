/**
 * tokenBackfill.ts
 *
 * Fetches token usage from OpenClaw's sessions.list API and backfills
 * job_instances rows that completed without token data.
 *
 * Runs periodically as part of the reconciler tick.
 */

import { execFile, type ExecFileException } from 'child_process';
import fs from 'fs';
import { getDb } from '../../db/client';
import { OPENCLAW_BIN, OPENCLAW_CONFIG_PATH } from '../../config';
import { buildOpenClawEnv, runOpenClawSync } from '../../lib/openclawCli';
import { parseHookSessionKey } from '../../lib/sessionKeys';
import { type Db } from "../../db/adapter/types";

function readGatewayToken(): string {
  // Prefer explicit env override
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const token = cfg.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : '';
  } catch {
    return '';
  }
}

type TokenMap = Map<number, { input: number | null; output: number | null; total: number | null }>;

function buildSessionsListArgs(): string[] {
  return [
    'gateway', 'call', 'sessions.list',
    '--json',
    '--params', JSON.stringify({ activeMinutes: SESSIONS_ACTIVE_MINUTES, limit: 500 }),
  ];
}

// The token travels as OPENCLAW_GATEWAY_TOKEN, which the CLI accepts in place of `--token`; on argv
// `ps` would show it to every local user.
function buildSessionsListEnv(token: string): NodeJS.ProcessEnv {
  return buildOpenClawEnv(token ? { OPENCLAW_GATEWAY_TOKEN: token } : {});
}

const SESSIONS_LIST_TIMEOUT_MS = 15_000;
// A session is about 2 KB of JSON and up to 500 are requested, which can outgrow the 1 MiB default.
const SESSIONS_LIST_MAX_BUFFER = 16 * 1024 * 1024;

interface SessionsListOutcome {
  stdout: string;
  stderr: string;
  /** Exit status; null when the process never ran or was killed. */
  status: number | null;
  signal: string | null;
  /** Why the process could not be run or read (ENOENT, output over maxBuffer), if it could not. */
  spawnError: string | null;
  timedOut: boolean;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
}

/** The CLI reports a failed `--json` call on stdout as {"ok":false,"error":{type,kind,message}}. */
function parseCliError(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const error = (parsed as { error?: unknown } | null)?.error;
  if (!error || typeof error !== 'object') return null;
  const { type, kind, message } = error as { type?: unknown; kind?: unknown; message?: unknown };
  const label = [type, kind].filter((part): part is string => typeof part === 'string' && part !== '').join('/');
  const text = typeof message === 'string' ? firstLine(message) : '';
  return [label, text].filter(Boolean).join(': ') || null;
}

/**
 * One line saying why sessions.list failed, or null when it succeeded. Only the first line of the
 * CLI's error and of stderr are kept, so repeats of one failure read the same and throttle together.
 */
function describeSessionsListFailure(outcome: SessionsListOutcome, token = ''): string | null {
  let description: string;
  if (outcome.timedOut) {
    description = `timed out after ${SESSIONS_LIST_TIMEOUT_MS}ms`;
  } else if (outcome.spawnError) {
    description = outcome.spawnError;
  } else if (outcome.status === 0) {
    return null;
  } else {
    const parts = [outcome.status !== null ? `exit ${outcome.status}` : `killed by ${outcome.signal ?? 'signal'}`];
    const cliError = parseCliError(outcome.stdout);
    if (cliError) parts.push(cliError);
    const stderr = firstLine(outcome.stderr);
    if (stderr) parts.push(`stderr: ${stderr}`);
    description = parts.join('; ');
  }
  // The token is never on the command line now, but keep it out of the log whatever the CLI echoes.
  if (token) description = description.split(token).join('<redacted>');
  return description.slice(0, 500);
}

// A dead gateway fails every reconciler tick the same way; say so once an hour, not every tick.
const FAILURE_LOG_INTERVAL_MS = 60 * 60_000;
const failureLog = new Map<string, { loggedAtMs: number; suppressed: number }>();

function logSessionsListFailure(description: string): void {
  const nowMs = Date.now();
  const previous = failureLog.get(description);
  if (previous && nowMs - previous.loggedAtMs < FAILURE_LOG_INTERVAL_MS) {
    previous.suppressed += 1;
    return;
  }
  for (const [key, entry] of failureLog) {
    if (nowMs - entry.loggedAtMs >= FAILURE_LOG_INTERVAL_MS) failureLog.delete(key);
  }
  failureLog.set(description, { loggedAtMs: nowMs, suppressed: 0 });
  const repeats = previous?.suppressed ? ` (repeated ${previous.suppressed} more time(s) since last logged)` : '';
  console.warn(`[tokenBackfill] Failed to fetch sessions.list: ${description}${repeats}`);
}

function readSessionsListOutcome(outcome: SessionsListOutcome, token: string): TokenMap {
  const failure = describeSessionsListFailure(outcome, token);
  if (failure) {
    logSessionsListFailure(failure);
    return new Map();
  }
  return buildTokenMap(parseSessionsListOutput(outcome.stdout));
}

export function resetTokenBackfillStateForTests(): void {
  failureLog.clear();
  lastBackfillFetchAtMs = 0;
}

function buildTokenMap(sessions: SessionEntry[]): TokenMap {
  const tokenMap: TokenMap = new Map();

  for (const session of sessions) {
    if (!session.key) continue;

    const instanceId = extractInstanceId(session.key);
    if (instanceId === null) continue;

    const input = toPositiveInt(session.inputTokens);
    const output = toPositiveInt(session.outputTokens);
    const total = toPositiveInt(session.totalTokens);

    if (input === null && output === null && total === null) continue;

    const existing = tokenMap.get(instanceId);
    if (!existing || session.totalTokensFresh) {
      tokenMap.set(instanceId, { input, output, total });
    }
  }

  return tokenMap;
}

// Look back up to 7 days of sessions. activeMinutes=10080 = 7 days
// In practice, most backfills happen within hours; 7d covers edge cases.
const SESSIONS_ACTIVE_MINUTES = 10_080;
const DEFAULT_BACKFILL_MIN_INTERVAL_MS = 5 * 60_000;
const BACKFILL_MIN_INTERVAL_MS = (() => {
  const raw = Number(process.env.AGENT_HQ_TOKEN_BACKFILL_MIN_INTERVAL_MS ?? '');
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_BACKFILL_MIN_INTERVAL_MS;
})();
let lastBackfillFetchAtMs = 0;

interface SessionEntry {
  key: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  totalTokensFresh?: boolean;
}

interface SessionsListResult {
  sessions?: SessionEntry[];
}

function parseSessionsListOutput(stdout: string): SessionEntry[] {
  try {
    const data = JSON.parse(stdout) as SessionsListResult;
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}

/**
 * Extract instance ID from session key patterns:
 *   agent:<project>:<agent>:<role>:run:<id>
 *   agent:<slug>:run:<id>:<durable-run-id>
 *   agent:<slug>:hook:atlas:jobrun:<id>
 *   hook:atlas:jobrun:<id>
 *   run:<id>[:<durable-run-id>]
 */
function extractInstanceId(sessionKey: string): number | null {
  return parseHookSessionKey(sessionKey)?.instanceId ?? null;
}

function toPositiveInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  return null;
}

/**
 * Fetch sessions from OpenClaw gateway and return a map of
 * instanceId → token data for all canonical or legacy dispatched run sessions.
 */
export function fetchHookSessionTokens(): TokenMap {
  const token = readGatewayToken();
  const result = runOpenClawSync(buildSessionsListArgs(), {
    timeout: SESSIONS_LIST_TIMEOUT_MS,
    maxBuffer: SESSIONS_LIST_MAX_BUFFER,
    env: buildSessionsListEnv(token),
  });
  const error = result.error as NodeJS.ErrnoException | undefined;

  return readSessionsListOutcome({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    signal: result.signal,
    spawnError: error && error.code !== 'ETIMEDOUT' ? error.message : null,
    timedOut: error?.code === 'ETIMEDOUT',
  }, token);
}

export async function fetchHookSessionTokensAsync(): Promise<TokenMap> {
  const token = readGatewayToken();
  const outcome = await new Promise<SessionsListOutcome>((resolve) => {
    execFile(
      OPENCLAW_BIN,
      buildSessionsListArgs(),
      {
        encoding: 'utf-8',
        timeout: SESSIONS_LIST_TIMEOUT_MS,
        maxBuffer: SESSIONS_LIST_MAX_BUFFER,
        env: buildSessionsListEnv(token),
      },
      (error: ExecFileException | null, stdout, stderr) => {
        // A numeric code is the exit status; a string code (ENOENT, maxBuffer) means the process
        // could not be run or read; neither, with the child killed, is the timeout firing.
        const exitStatus = typeof error?.code === 'number' ? error.code : null;
        const spawnError = typeof error?.code === 'string' ? error.message : null;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          status: error ? exitStatus : 0,
          signal: error?.signal ?? null,
          spawnError,
          timedOut: Boolean(error?.killed) && spawnError === null,
        });
      },
    );
  });

  return readSessionsListOutcome(outcome, token);
}

/**
 * Backfill token data for recently completed instances that have no token data.
 * Returns the count of rows updated.
 */
/**
 * Only OpenClaw runs can be backfilled from here.
 *
 * The token source is OpenClaw's own sessions.list, so a claude-code, codex or
 * hermes run can never match — without this filter those rows stayed candidates
 * on every tick forever, re-fetched and re-scanned to no effect. Those runtimes
 * persist their own usage at run end (see ClaudeCodeRuntime), so a row that
 * still has no tokens has none to record, not tokens waiting to be found.
 */
async function getBackfillCandidates(db: Db): Promise<Array<{ id: number; session_key: string | null }>> {
  return await db.all(`
    SELECT ji.id, ji.session_key
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    WHERE ji.token_input IS NULL
      AND ji.token_output IS NULL
      AND ji.token_total IS NULL
      AND ji.status IN ('done', 'failed')
      AND (a.runtime_type IS NULL OR a.runtime_type = '' OR a.runtime_type = 'openclaw')
      AND ji.created_at >= to_char((now() AT TIME ZONE 'utc' - interval '14 day'), 'YYYY-MM-DD HH24:MI:SS')
    ORDER BY ji.created_at DESC, ji.id DESC
    LIMIT 500
  `) as Array<{ id: number; session_key: string | null }>;
}

async function applyTokenBackfill(
  db: Db,
  candidates: Array<{ id: number; session_key: string | null }>,
  tokenMap: TokenMap,
): Promise<number> {
  if (candidates.length === 0 || tokenMap.size === 0) return 0;

  const updateSql = `
    UPDATE job_instances
    SET token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output),
        token_total = COALESCE(?, token_total)
    WHERE id = ?
  `;

  let updated = 0;

  for (const row of candidates) {
    let tokens = row.session_key ? tokenMap.get(extractInstanceId(row.session_key) ?? -1) : undefined;
    if (!tokens) {
      tokens = tokenMap.get(row.id);
    }
    if (!tokens) continue;

    const result = await db.run(updateSql, tokens.input, tokens.output, tokens.total, row.id);
    if (result.changes > 0) updated++;
  }

  if (updated > 0) {
    console.log(`[tokenBackfill] Backfilled token usage for ${updated} instance(s)`);
  }

  return updated;
}

export async function backfillInstanceTokens(db: Db = getDb()): Promise<number> {
  const candidates = await getBackfillCandidates(db);
  if (candidates.length === 0) return 0;
  return await applyTokenBackfill(db, candidates, fetchHookSessionTokens());
}

export async function backfillInstanceTokensAsync(db: Db = getDb()): Promise<number> {
  const candidates = await getBackfillCandidates(db);
  if (candidates.length === 0) return 0;

  const now = Date.now();
  if (BACKFILL_MIN_INTERVAL_MS > 0 && now - lastBackfillFetchAtMs < BACKFILL_MIN_INTERVAL_MS) {
    return 0;
  }
  lastBackfillFetchAtMs = now;

  return await applyTokenBackfill(db, candidates, await fetchHookSessionTokensAsync());
}
