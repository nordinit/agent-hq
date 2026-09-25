/**
 * Validation for numeric route parameters.
 *
 * Given `/api/v1/workflows/types`, Express matches `/:id` and hands the handler the string
 * `'types'`. PostgreSQL rejects the cast outright:
 *
 *     invalid input syntax for type bigint: "types"
 *
 * so without validation the request becomes a 500 carrying a database error message — the
 * wrong status, and a small information leak.
 *
 * A non-numeric id is a client error, and should never reach the database at all.
 */

import type { NextFunction, Request, Response } from 'express';

/** Parses a positive integer route parameter, or null when it is not one. */
export function parseIdParam(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  // Reject anything that is not purely digits. Number('12abc') is NaN, but Number(' 12 ') is 12
  // and Number('1e3') is 1000 — neither is a valid id, and both would reach the database.
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return value;
}

/**
 * Router-level guard for a numeric `:id`, registered with `router.param('id', requireNumericId)`.
 *
 * IT MUST BE PER-ROUTER. `app.param()` does NOT fire for a parameter declared on a mounted
 * sub-router — verified directly: with only `app.param('id', ...)` registered, a request to
 * `/api/app/types` reached the handler with id='types' and returned 200, while the identical
 * router carrying its own `router.param('id', ...)` returned 404. Since every route here lives on
 * a sub-router mounted under /api/v1, a single app-level registration would silently do nothing.
 *
 * 404 rather than 400 is deliberate: a non-numeric id names no row, so "not found" is the
 * established contract every client and test was written against.
 *
 * Safe to apply to every `:id` in this codebase: the only TEXT primary keys are
 * chat_messages.id, app_settings.key, task_statuses.name, schema_migrations.id and the
 * transition-requirement tombstone keys — and none of them is ever reached through an `:id`
 * route parameter (the one chat_messages lookup by id builds its key internally). A route whose
 * id is genuinely non-numeric must NOT register this.
 */
export function requireNumericId(req: Request, res: Response, next: NextFunction, value: string): void {
  if (parseIdParam(value) !== null) return next();
  res.status(404).json({
    error: 'Not found',
    code: 'invalid_id',
    detail: `'${value}' is not a valid numeric id.`,
  });
}
