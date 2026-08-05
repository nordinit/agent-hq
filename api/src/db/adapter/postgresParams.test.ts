import { toPostgresParams } from './postgresParams';

describe('toPostgresParams', () => {
  it('numbers bind markers in code', () => {
    expect(toPostgresParams('SELECT * FROM tasks WHERE id = ? AND status = ?'))
      .toBe('SELECT * FROM tasks WHERE id = $1 AND status = $2');
  });

  it('preserves question marks in quoted values and identifiers', () => {
    expect(toPostgresParams(`SELECT '?', "why?", value FROM events WHERE id = ?`))
      .toBe(`SELECT '?', "why?", value FROM events WHERE id = $1`);
  });

  it('preserves question marks in comments and dollar-quoted bodies', () => {
    const sql = `SELECT ? -- leave ? here\n, $body$?$body$, ? /* outer ? /* nested ? */ still ? */`;
    expect(toPostgresParams(sql))
      .toBe(`SELECT $1 -- leave ? here\n, $body$?$body$, $2 /* outer ? /* nested ? */ still ? */`);
  });

  it('leaves existing PostgreSQL positional parameters alone', () => {
    expect(toPostgresParams('SELECT $1, ?')).toBe('SELECT $1, $1');
  });
});
