type PostgresErrorLike = {
  code?: unknown;
  constraint?: unknown;
};

/** PostgreSQL SQLSTATE 23505, optionally narrowed to one of the named constraints. */
export function isPostgresUniqueViolation(
  error: unknown,
  constraints: readonly string[] = [],
): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as PostgresErrorLike;
  if (candidate.code !== '23505') return false;
  if (constraints.length === 0) return true;
  return typeof candidate.constraint === 'string' && constraints.includes(candidate.constraint);
}
