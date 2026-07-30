/**
 * Canonical timestamp handling for Agent HQ.
 *
 * ---------------------------------------------------------------------------
 * THE CANONICAL FORMAT
 * ---------------------------------------------------------------------------
 *
 *     'YYYY-MM-DD HH:MM:SS'   (UTC, space-separated, NO timezone designator)
 *
 * Optionally with fractional seconds ('YYYY-MM-DD HH:MM:SS.mmm') for rows that
 * historically carried millisecond precision. `nowTimestamp()` never emits
 * fractional seconds so that a JS-written value is byte-identical to what
 * SQLite's `datetime('now')` DEFAULT produces.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FORMAT AND NOT ISO-8601 'Z'
 * ---------------------------------------------------------------------------
 *
 * Until now the codebase produced timestamps two ways:
 *
 *   1. SQL: `datetime('now')` — 104 DEFAULT clauses in the schema plus ~797
 *      inline uses. Emits '2026-06-03 20:05:53' (UTC, offset-less).
 *   2. JS:  `new Date().toISOString()` — ~134 call sites. Emits
 *      '2026-06-03T20:05:53.000Z' (UTC, offset-bearing).
 *
 * 15 columns in production are written by BOTH paths and hold both encodings
 * concurrently. A bare `::timestamptz` cast during the Postgres migration reads
 * the offset-less form in the *server's local zone* (this host is UTC-4) while
 * reading the 'Z' form correctly — silently shifting some rows of a column by
 * four hours and leaving others alone, with no error raised.
 *
 * Offset-less UTC is the canonical form because:
 *
 *   - It is what every SQL DEFAULT already emits. Changing 104 DEFAULT clauses
 *     in SQLite requires a full table rebuild per table (SQLite cannot ALTER a
 *     column default), on a 2.8 GB production database. Changing ~134 JS call
 *     sites is a code edit with no schema change and no downtime.
 *   - Because DEFAULTs cannot practically be changed, choosing ISO-Z as
 *     canonical would leave every DEFAULT still emitting the offset-less form:
 *     the drift would regenerate the moment normalization finished. Offset-less
 *     is the only choice that is actually *enforceable* on this schema.
 *   - The UI already codifies this contract: `ui/lib/date.ts#parseDbDate`
 *     appends 'Z' to any offset-less value before parsing, i.e. the frontend
 *     already treats offset-less DB timestamps as UTC.
 *   - It yields ONE cast rule for the entire Postgres migration:
 *         col::timestamp AT TIME ZONE 'UTC'
 *     rather than a per-column decision that has to be re-derived (and can be
 *     silently gotten wrong) 144 times.
 *
 * Note on raw row counts: normalizing every timestamp column to offset-less
 * rewrites ~658k values, versus ~527k to go the other way. Row count alone
 * marginally favours ISO-Z, but that comparison is dominated by a single
 * already-uniform column (chat_messages.timestamp, 514k rows) that needs no
 * rewrite at all. Restricted to the columns that are actually mixed — the ones
 * that are actually broken — offset-less is also the cheaper direction:
 * ~15.5k values to rewrite versus ~99.3k. Both the enforceability argument and
 * the cost argument point the same way.
 *
 * ---------------------------------------------------------------------------
 * USAGE
 * ---------------------------------------------------------------------------
 *
 *   import { nowTimestamp, toCanonicalTimestamp } from '../lib/timestamps';
 *
 *   // writing "now" from JS
 *   db.prepare('UPDATE job_instances SET completed_at = ? WHERE id = ?')
 *     .run(nowTimestamp(), id);
 *
 *   // writing a caller-supplied / runtime-supplied instant
 *   db.prepare('UPDATE sprints SET ended_at = ? WHERE id = ?')
 *     .run(toCanonicalTimestamp(req.body.ended_at), id);
 *
 *   // inside SQL, `datetime('now')` remains correct and equivalent — prefer
 *   // CANONICAL_TIMESTAMP_SQL when building SQL strings so the intent is
 *   // greppable.
 */

/** SQL expression that produces a canonical timestamp inside SQLite. */
export const CANONICAL_TIMESTAMP_SQL = "datetime('now')";

/** Exactly what {@link nowTimestamp} emits: no fractional seconds, no offset. */
export const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Canonical, allowing the fractional-second variant retained on legacy rows. */
export const CANONICAL_TIMESTAMP_PATTERN_LOOSE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(\.\d{1,9})?(Z|z|[+-]\d{2}:?\d{2})?$/;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Format a Date as canonical UTC with second precision. */
function formatUtc(date: Date, fractional?: string): string {
  const base =
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}` +
    ` ${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}`;
  return fractional ? `${base}${fractional}` : base;
}

export interface NormalizeOptions {
  /**
   * Keep sub-second precision that the source value carried (default true).
   * Set false to truncate to whole seconds — the exact shape `datetime('now')`
   * and {@link nowTimestamp} produce.
   */
  preserveFractional?: boolean;
}

/**
 * The canonical "now". This is the ONLY approved way for JS/TS code to produce
 * a timestamp destined for the database. Never use `new Date().toISOString()`
 * for a column value.
 */
export function nowTimestamp(): string {
  return formatUtc(new Date());
}

/** Canonical timestamp for a specific instant. */
export function timestampFromDate(date: Date): string | null {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return formatUtc(date);
}

/** Canonical timestamp for an epoch-milliseconds value. */
export function timestampFromEpochMs(ms: number): string | null {
  if (!Number.isFinite(ms)) return null;
  return timestampFromDate(new Date(ms));
}

/** True when `value` is exactly what {@link nowTimestamp} emits. */
export function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_TIMESTAMP_PATTERN.test(value);
}

/**
 * True when `value` is canonical, allowing the fractional-second variant that
 * normalization preserves on legacy rows. This is the invariant the Postgres
 * migration depends on: offset-less, UTC, `timestamp`-parseable.
 */
export function isCanonicalTimestampLoose(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_TIMESTAMP_PATTERN_LOOSE.test(value);
}

/**
 * Convert any timestamp encoding this codebase has ever written into the
 * canonical form.
 *
 * Accepts:
 *   - canonical                 '2026-06-03 20:05:53'        (passthrough)
 *   - canonical + fraction      '2026-06-03 20:05:53.123'
 *   - ISO-Z                     '2026-06-03T20:05:53.000Z'
 *   - ISO + numeric offset      '2026-07-06T11:55:00-04:00'  (converted to UTC)
 *   - offset-less ISO 'T' form  '2026-06-03T20:05:53'        (assumed UTC)
 *   - minute precision          '2026-06-03T20:05Z'
 *   - date only                 '2026-03-09'                 (midnight UTC)
 *   - Date instance / epoch ms
 *
 * Returns null for null/undefined/empty/unparseable input, so callers can bind
 * it straight into a nullable column. Unparseable input never silently becomes
 * "now".
 */
export function toCanonicalTimestamp(
  value: unknown,
  options: NormalizeOptions = {},
): string | null {
  const preserveFractional = options.preserveFractional !== false;

  if (value === null || value === undefined) return null;
  if (value instanceof Date) return timestampFromDate(value);
  if (typeof value === 'number') return timestampFromEpochMs(value);
  if (typeof value !== 'string') return null;

  const raw = value.trim();
  if (!raw) return null;

  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]} 00:00:00`;

  const m = DATE_TIME.exec(raw);
  if (!m) return null;

  const [, y, mo, d, h, mi, s = '00', frac, zone] = m;
  const fractional = preserveFractional && frac ? frac : undefined;

  // Reject impossible calendar dates (2026-02-31) and out-of-range clock
  // fields, which `new Date(...)` would silently roll over into the next month.
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const probe = new Date(utcMs);
  if (
    Number.isNaN(utcMs) ||
    probe.getUTCFullYear() !== Number(y) ||
    probe.getUTCMonth() !== Number(mo) - 1 ||
    probe.getUTCDate() !== Number(d) ||
    probe.getUTCHours() !== Number(h) ||
    probe.getUTCMinutes() !== Number(mi) ||
    probe.getUTCSeconds() !== Number(s)
  ) {
    return null;
  }

  // Offset-less input is UTC by convention (see module header) — and so is 'Z'.
  if (!zone || zone === 'Z' || zone === 'z') {
    const canonical = `${y}-${mo}-${d} ${h}:${mi}:${s}`;
    return fractional ? `${canonical}${fractional}` : canonical;
  }

  // Numeric offset: shift to UTC.
  const offsetMatch = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (!offsetMatch) return null;
  const sign = offsetMatch[1] === '-' ? -1 : 1;
  const offsetMinutes = sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));
  return formatUtc(new Date(utcMs - offsetMinutes * 60_000), fractional);
}

/**
 * Canonical value or `nowTimestamp()` when the input is absent/unparseable.
 * Use only where a column is NOT NULL and "now" is the documented fallback.
 */
export function toCanonicalTimestampOrNow(value: unknown): string {
  return toCanonicalTimestamp(value) ?? nowTimestamp();
}

/** Parse a canonical (or legacy) DB timestamp back into a Date. */
export function parseTimestamp(value: unknown): Date | null {
  const canonical = toCanonicalTimestamp(value);
  if (!canonical) return null;
  const parsed = new Date(`${canonical.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Render a stored timestamp as ISO-8601 'Z' for API responses / external
 * payloads. Storage stays canonical; this is presentation only.
 */
export function toIsoUtc(value: unknown): string | null {
  const parsed = parseTimestamp(value);
  return parsed ? parsed.toISOString() : null;
}
