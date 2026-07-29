/**
 * SQLite -> PostgreSQL SQL translation.
 *
 * Every rewrite here is mechanical and provably safe on its own. Translations that
 * cannot be done safely by text substitution are deliberately NOT attempted — they are
 * detected and reported instead, so they get fixed at the source rather than silently
 * mistranslated. A wrong rewrite that still parses is far more dangerous than a loud
 * failure, because it produces plausible but incorrect results.
 */

/**
 * Rewrites positional `?` placeholders to PostgreSQL's `$1..$n`.
 *
 * A naive replace corrupts any `?` inside a string literal, an identifier or a comment.
 * Agent HQ stores prose and JSON, and its SQL contains literals like '{}' and messages
 * ending in '?', so this walks the statement and only rewrites placeholders found in
 * actual code positions.
 *
 * Handles: single-quoted strings (with '' escapes), double-quoted identifiers,
 * dollar-quoted blocks, line comments and block comments.
 */
export function toPositionalParams(sql: string): string {
  let out = '';
  let index = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // Single-quoted string literal. '' is an escaped quote, not a terminator.
    if (ch === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }

    // Double-quoted identifier. "" is an escaped quote.
    if (ch === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }

    // Dollar-quoted block: $tag$ ... $tag$
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (tag) {
        const marker = tag[0];
        const end = sql.indexOf(marker, i + marker.length);
        const stop = end === -1 ? sql.length : end + marker.length;
        out += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }

    // -- line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? sql.length : nl;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    // /* block comment */ (not nested, matching SQLite and PostgreSQL practice here)
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += sql.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === '?') {
      index++;
      out += `$${index}`;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

/** A construct that cannot be safely auto-translated and must be fixed at the source. */
export interface DialectIncompatibility {
  construct: string;
  detail: string;
}

/**
 * Rewrites that are safe as text substitution, applied outside strings and comments.
 *
 * `datetime('now')` is the important one. It yields 'YYYY-MM-DD HH:MM:SS' in UTC, and
 * the migrated columns are still text, so the PostgreSQL form must produce a
 * byte-identical string. now()::text would emit a different format entirely (timezone
 * offset, microseconds) and would silently break ordering and equality for every row
 * written after the migration.
 */
const SAFE_REWRITES: Array<{ pattern: RegExp; replacement: string; note: string }> = [
  {
    pattern: /\bdatetime\s*\(\s*'now'\s*\)/gi,
    replacement: `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`,
    note: "datetime('now') must keep SQLite's exact text format",
  },
  {
    pattern: /\bCURRENT_TIMESTAMP\b/gi,
    replacement: `to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`,
    note: 'CURRENT_TIMESTAMP differs in both type and format between the engines',
  },
  {
    pattern: /\bGROUP_CONCAT\s*\(/gi,
    replacement: 'string_agg(',
    note: 'GROUP_CONCAT has no PostgreSQL equivalent by that name',
  },
  {
    pattern: /\bIFNULL\s*\(/gi,
    replacement: 'COALESCE(',
    note: 'IFNULL is SQLite-only',
  },
  {
    pattern: /\bINSTR\s*\(/gi,
    replacement: 'STRPOS(',
    note: 'INSTR is SQLite-only',
  },
];

/**
 * Constructs this translator refuses to rewrite, because no text substitution is
 * correct for them. Each is reported with what has to change instead.
 */
const UNSAFE_CONSTRUCTS: Array<{ pattern: RegExp; construct: string; detail: string }> = [
  {
    pattern: /\bIS\s+\?/gi,
    construct: 'IS ?',
    detail:
      'SQLite uses `IS ?` for NULL-safe equality. PostgreSQL rejects a parameter after ' +
      'IS. Rewrite as `col IS NOT DISTINCT FROM ?`.',
  },
  {
    pattern: /\browid\b/gi,
    construct: 'rowid',
    detail:
      'rowid is a SQLite implicit column with no PostgreSQL equivalent. Use the ' +
      'declared primary key.',
  },
  {
    pattern: /\bGROUP_CONCAT\s*\([^)]*,\s*'[^']*'\s*\)/gi,
    construct: 'GROUP_CONCAT with separator',
    detail:
      "GROUP_CONCAT(x, sep) maps to string_agg(x, sep) but PostgreSQL requires the " +
      'argument to be text; add an explicit ::text cast.',
  },
  {
    pattern: /\bAUTOINCREMENT\b/gi,
    construct: 'AUTOINCREMENT',
    detail: 'Use GENERATED BY DEFAULT AS IDENTITY in PostgreSQL.',
  },
  {
    pattern: /\bPRAGMA\b/gi,
    construct: 'PRAGMA',
    detail:
      'PRAGMA is SQLite-only. Schema introspection must go through information_schema ' +
      'or pg_catalog.',
  },
  {
    pattern: /\bINSERT\s+OR\s+(REPLACE|IGNORE)\b/gi,
    construct: 'INSERT OR REPLACE / INSERT OR IGNORE',
    detail: 'Use INSERT ... ON CONFLICT ... DO UPDATE / DO NOTHING.',
  },
];

/**
 * Reports constructs that need a source fix. Does not modify the SQL.
 *
 * Matching uses the position mask rather than a blanked-out copy, because some of these
 * patterns contain a string literal themselves — GROUP_CONCAT's separator argument, for
 * one — and would never match text that had its literals removed.
 */
export function findIncompatibilities(sql: string): DialectIncompatibility[] {
  const found: DialectIncompatibility[] = [];
  for (const { pattern, construct, detail } of UNSAFE_CONSTRUCTS) {
    if (matchesInCode(sql, pattern)) found.push({ construct, detail });
  }
  return found;
}

/** Blanks out string literals and comments so pattern matching cannot see inside them. */
export function stripStringsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; }
          i++; break;
        }
        i++;
      }
      out += ' '.repeat(i - start);
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? sql.length : nl;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Marks which character positions sit inside a string, quoted identifier or comment.
 *
 * Splitting the statement into spans and rewriting only the code spans does NOT work
 * here, because some constructs legitimately CONTAIN a literal — `datetime('now')` is
 * exactly that shape, and splitting cuts the pattern in half so it can never match.
 *
 * Masking positions instead lets a pattern span a literal while still rejecting one that
 * BEGINS inside a literal, which is the distinction that actually matters: rewriting
 * `datetime('now')` is correct, rewriting the same text inside a stored message is not.
 */
function literalMask(sql: string): boolean[] {
  const mask = new Array<boolean>(sql.length).fill(false);
  let i = 0;
  const markSpan = (from: number, to: number) => {
    for (let k = from; k < to && k < sql.length; k++) mask[k] = true;
  };

  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === quote) {
          if (sql[j + 1] === quote) { j += 2; continue; }
          j++; break;
        }
        j++;
      }
      markSpan(i, j);
      i = j;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      const stop = nl === -1 ? sql.length : nl;
      markSpan(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      markSpan(i, stop);
      i = stop;
      continue;
    }
    i++;
  }
  return mask;
}

/** Replaces matches whose START is in a code position, leaving literal content alone. */
function replaceInCode(sql: string, pattern: RegExp, replacement: string): string {
  const mask = literalMask(sql);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (mask[m.index]) continue;
    out += sql.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
  }
  return out + sql.slice(last);
}

/** True when the pattern matches at a position that is not inside a literal or comment. */
function matchesInCode(sql: string, pattern: RegExp): boolean {
  const mask = literalMask(sql);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (!mask[m.index]) return true;
  }
  return false;
}

/** Applies the safe rewrites, leaving string and comment CONTENT untouched. */
export function applySafeRewrites(sql: string): string {
  let text = sql;
  for (const { pattern, replacement } of SAFE_REWRITES) {
    text = replaceInCode(text, pattern, replacement);
  }
  return text;
}

/** Full translation for the PostgreSQL adapter: safe rewrites, then placeholders. */
export function translateToPostgres(sql: string): string {
  return toPositionalParams(applySafeRewrites(sql));
}
