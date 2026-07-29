/**
 * tokenBackfill.ts
 *
 * Fetches token usage from OpenClaw's sessions.list API and backfills
 * job_instances rows that completed without token data.
 *
 * Runs periodically as part of the reconciler tick.
 */

import { execFile, spawnSync } from 'child_process';
import fs from 'fs';
import { getDb } from '../../db/client';
import { OPENCLAW_BIN, OPENCLAW_CONFIG_PATH, OPENCLAW_PATH } from '../../config';
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

const GATEWAY_AUTH_TOKEN = readGatewayToken();

type TokenMap = Map<number, { input: number | null; output: number | null; total: number | null }>;

function buildSessionsListArgs(): string[] {
  const args = [
    'gateway', 'call', 'sessions.list',
    '--json',
    '--params', JSON.stringify({ activeMinutes: SESSIONS_ACTIVE_MINUTES, limit: 500 }),
  ];

  if (GATEWAY_AUTH_TOKEN) {
    args.push('--token', GATEWAY_AUTH_TOKEN);
  }

  return args;
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
  const result = spawnSync(
    OPENCLAW_BIN,
    buildSessionsListArgs(),
    {
      encoding: 'utf-8',
      timeout: 15_000,
      env: {
        ...process.env,
        PATH: OPENCLAW_PATH,
        OPENCLAW_HIDE_BANNER: '1',
        OPENCLAW_SUPPRESS_NOTES: '1',
      },
    },
  );

  if (result.error || result.status !== 0) {
    console.warn('[tokenBackfill] Failed to fetch sessions.list:', result.stderr?.slice(0, 200));
    return new Map();
  }

  return buildTokenMap(parseSessionsListOutput(result.stdout ?? ''));
}

export async function fetchHookSessionTokensAsync(): Promise<TokenMap> {
  const args = buildSessionsListArgs();

  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    execFile(
      OPENCLAW_BIN,
      args,
      {
        encoding: 'utf-8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: OPENCLAW_PATH,
          OPENCLAW_HIDE_BANNER: '1',
          OPENCLAW_SUPPRESS_NOTES: '1',
        },
      },
      (error, stdout, stderr) => {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: error && 'code' in error ? Number(error.code ?? 1) : 0 });
      },
    );
  });

  if (result.code !== 0) {
    console.warn('[tokenBackfill] Failed to fetch sessions.list:', result.stderr.slice(0, 200));
    return new Map();
  }

  return buildTokenMap(parseSessionsListOutput(result.stdout));
}

/**
 * Backfill token data for recently completed instances that have no token data.
 * Returns the count of rows updated.
 */
async function getBackfillCandidates(db: Db): Promise<Array<{ id: number; session_key: string | null }>> {
  return await db.all(`
    SELECT id, session_key
    FROM job_instances
    WHERE token_input IS NULL
      AND token_output IS NULL
      AND token_total IS NULL
      AND status IN ('done', 'failed')
      AND created_at >= datetime('now', '-14 days')
    ORDER BY created_at DESC, id DESC
    LIMIT 500
  `) as Array<{ id: number; session_key: string | null }>;
}

function applyTokenBackfill(
  db: Db,
  candidates: Array<{ id: number; session_key: string | null }>,
  tokenMap: TokenMap,
): number {
  if (candidates.length === 0 || tokenMap.size === 0) return 0;

  const update = db.prepare(`
    UPDATE job_instances
    SET token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output),
        token_total = COALESCE(?, token_total)
    WHERE id = ?
  `);

  let updated = 0;

  for (const row of candidates) {
    let tokens = row.session_key ? tokenMap.get(extractInstanceId(row.session_key) ?? -1) : undefined;
    if (!tokens) {
      tokens = tokenMap.get(row.id);
    }
    if (!tokens) continue;

    const result = update.run(tokens.input, tokens.output, tokens.total, row.id);
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
  return applyTokenBackfill(db, candidates, fetchHookSessionTokens());
}

export async function backfillInstanceTokensAsync(db: Db = getDb()): Promise<number> {
  const candidates = await getBackfillCandidates(db);
  if (candidates.length === 0) return 0;

  const now = Date.now();
  if (BACKFILL_MIN_INTERVAL_MS > 0 && now - lastBackfillFetchAtMs < BACKFILL_MIN_INTERVAL_MS) {
    return 0;
  }
  lastBackfillFetchAtMs = now;

  return applyTokenBackfill(db, candidates, await fetchHookSessionTokensAsync());
}
