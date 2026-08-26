/**
 * Operator password for the MCP OAuth consent screen.
 *
 * Agent HQ has no user login, so the authorization endpoint had nothing to authenticate the
 * person approving a connector — and an authorization server that authorizes whoever reaches
 * the URL is not one. This is the smallest thing that closes that: one password, held as a
 * scrypt hash in app_settings, checked at the consent screen before any authorization code is
 * issued.
 *
 * It authenticates the operator, not an end user. There are no accounts, no reset flow, and no
 * sessions beyond the one-shot consent form. If Agent HQ grows real user auth, this is the piece
 * that should be replaced by it.
 */

import crypto from 'crypto';
import type { Db } from '../../db/adapter/types';

const SETTING_KEY = 'mcp_oauth_operator_password';

/** scrypt parameters. N=2^15 keeps a single verification near 100ms on the Mac mini this runs on. */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
/**
 * Node caps scrypt at 32MB by default and these parameters need 128*N*r = 32MB plus overhead, so
 * the default rejects them outright. Raised rather than weakening N, which is the parameter doing
 * the work.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

export const MIN_OPERATOR_PASSWORD_LENGTH = 12;

/**
 * Failed attempts, in memory and per process.
 *
 * Deliberately not in the database: a counter that survives restarts would need a write on every
 * failed guess, and the endpoint being protected is reachable only by someone who already has the
 * public URL. This exists to make online guessing impractical, which an in-process counter does.
 * A restart clears it, and that is an accepted limit rather than an oversight.
 */
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
let failureCount = 0;
let lockedUntil = 0;

function scryptHash(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
}

function encode(salt: Buffer, hash: Buffer): string {
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, n, r, p, salt, hash] = parts;
  const parsed = {
    n: Number.parseInt(n, 10),
    r: Number.parseInt(r, 10),
    p: Number.parseInt(p, 10),
    salt: Buffer.from(salt, 'base64'),
    hash: Buffer.from(hash, 'base64'),
  };
  if (!Number.isInteger(parsed.n) || !Number.isInteger(parsed.r) || !Number.isInteger(parsed.p)) return null;
  if (parsed.salt.length === 0 || parsed.hash.length === 0) return null;
  return parsed;
}

async function readStored(db: Db): Promise<string | null> {
  const row = await db.get(`SELECT value FROM app_settings WHERE key = ?`, SETTING_KEY) as { value: string } | undefined;
  const value = row?.value?.trim();
  return value ? value : null;
}

export async function isOperatorPasswordSet(db: Db): Promise<boolean> {
  return (await readStored(db)) !== null;
}

export async function setOperatorPassword(db: Db, password: string): Promise<void> {
  if (password.length < MIN_OPERATOR_PASSWORD_LENGTH) {
    throw new Error(`Operator password must be at least ${MIN_OPERATOR_PASSWORD_LENGTH} characters.`);
  }
  const salt = crypto.randomBytes(SALT_BYTES);
  const encoded = encode(salt, scryptHash(password, salt));
  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
  `, SETTING_KEY, encoded);
  resetOperatorPasswordLockout();
}

export async function clearOperatorPassword(db: Db): Promise<void> {
  await db.run(`DELETE FROM app_settings WHERE key = ?`, SETTING_KEY);
  resetOperatorPasswordLockout();
}

export type OperatorPasswordResult =
  | { ok: true }
  | { ok: false; reason: 'not_set' | 'invalid' | 'locked'; retryAfterSeconds?: number };

export async function verifyOperatorPassword(db: Db, password: string, now = Date.now()): Promise<OperatorPasswordResult> {
  if (now < lockedUntil) {
    return { ok: false, reason: 'locked', retryAfterSeconds: Math.ceil((lockedUntil - now) / 1000) };
  }

  const stored = await readStored(db);
  if (!stored) return { ok: false, reason: 'not_set' };

  const parsed = parse(stored);
  if (!parsed) return { ok: false, reason: 'not_set' };

  const candidate = crypto.scryptSync(password, parsed.salt, parsed.hash.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    // Sized from the stored parameters so a hash written with different ones still verifies.
    maxmem: Math.max(SCRYPT_MAXMEM, 256 * parsed.n * parsed.r),
  });
  const matches = candidate.length === parsed.hash.length && crypto.timingSafeEqual(candidate, parsed.hash);

  if (!matches) {
    failureCount += 1;
    if (failureCount >= LOCKOUT_THRESHOLD) {
      lockedUntil = now + LOCKOUT_MS;
      failureCount = 0;
      return { ok: false, reason: 'locked', retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000) };
    }
    return { ok: false, reason: 'invalid' };
  }

  failureCount = 0;
  return { ok: true };
}

/** Test seam, and called after the password changes so a lockout does not outlive the secret. */
export function resetOperatorPasswordLockout(): void {
  failureCount = 0;
  lockedUntil = 0;
}
