/**
 * Validation for numeric route parameters.
 *
 * SQLite's weak typing hid a whole class of bug here. Given `/api/v1/workflows/types`, Express
 * matches `/:id` and hands the handler the string `'types'`. SQLite compares that to an
 * INTEGER column, finds no match, and the route returns a clean 404. PostgreSQL rejects the
 * cast outright:
 *
 *     invalid input syntax for type bigint: "types"
 *
 * so the same request becomes a 500 carrying a database error message — the wrong status, and
 * a small information leak.
 *
 * Validating at the boundary is more correct than either engine's accident: a non-numeric id
 * is a client error, and should never reach the database at all.
 */

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
