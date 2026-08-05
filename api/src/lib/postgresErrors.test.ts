import { isPostgresUniqueViolation } from './postgresErrors';

describe('isPostgresUniqueViolation', () => {
  it('recognizes SQLSTATE 23505', () => {
    expect(isPostgresUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('can require an exact PostgreSQL constraint name', () => {
    const error = { code: '23505', constraint: 'uq_tasks_title' };
    expect(isPostgresUniqueViolation(error, ['uq_tasks_title'])).toBe(true);
    expect(isPostgresUniqueViolation(error, ['uq_tasks_slug'])).toBe(false);
  });

  it('does not recognize SQLite error shapes or unrelated SQLSTATEs', () => {
    expect(isPostgresUniqueViolation({ code: 'SQLITE_CONSTRAINT_UNIQUE' })).toBe(false);
    expect(isPostgresUniqueViolation({ code: '23503' })).toBe(false);
    expect(isPostgresUniqueViolation(new Error('UNIQUE constraint failed'))).toBe(false);
  });
});
