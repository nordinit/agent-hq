/**
 * Convert the application's `?` parameter style to node-postgres `$1..$n`.
 *
 * Question marks inside SQL strings, identifiers, dollar-quoted bodies, and comments are
 * data rather than bind markers and must remain unchanged.
 */
export function toPostgresParams(sql: string): string {
  let output = '';
  let parameter = 0;
  let index = 0;

  while (index < sql.length) {
    const character = sql[index];

    if (character === "'" || character === '"') {
      const quote = character;
      const start = index++;
      while (index < sql.length) {
        if (sql[index] !== quote) {
          index += 1;
          continue;
        }
        if (sql[index + 1] === quote) {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      output += sql.slice(start, index);
      continue;
    }

    if (character === '$') {
      const delimiter = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index))?.[0];
      if (delimiter) {
        const start = index;
        const closing = sql.indexOf(delimiter, index + delimiter.length);
        index = closing < 0 ? sql.length : closing + delimiter.length;
        output += sql.slice(start, index);
        continue;
      }
    }

    if (character === '-' && sql[index + 1] === '-') {
      const start = index;
      const newline = sql.indexOf('\n', index + 2);
      index = newline < 0 ? sql.length : newline;
      output += sql.slice(start, index);
      continue;
    }

    if (character === '/' && sql[index + 1] === '*') {
      const start = index;
      let depth = 0;
      while (index < sql.length) {
        if (sql.startsWith('/*', index)) {
          depth += 1;
          index += 2;
          continue;
        }
        if (sql.startsWith('*/', index)) {
          depth -= 1;
          index += 2;
          if (depth === 0) break;
          continue;
        }
        index += 1;
      }
      output += sql.slice(start, index);
      continue;
    }

    if (character === '?') {
      parameter += 1;
      output += `$${parameter}`;
      index += 1;
      continue;
    }

    output += character;
    index += 1;
  }

  return output;
}
