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
const UTC_NOW = `now() AT TIME ZONE 'utc'`;
const SQLITE_TS_FORMAT = `'YYYY-MM-DD HH24:MI:SS'`;

/**
 * Translates SQLite's `datetime('now', ...modifiers)` into PostgreSQL.
 *
 * The single-argument form is the common case (930 sites), but the codebase also uses
 * literal offset modifiers — `datetime('now', '-1 hour')`, `datetime('now', '-24 hours',
 * '-1 minute')` — and `'start of day'`. SQLite applies modifiers left to right, so they
 * compose as nested expressions in the same order.
 *
 * The output stays wrapped in to_char with SQLite's exact format. The migrated columns are
 * still text: emitting a timestamptz here, or now()::text, would produce a different string
 * shape and silently break both ordering and equality against every existing row.
 *
 * Returns null when a modifier is not a literal this can translate — a bound parameter or a
 * concatenated expression cannot become an interval by text substitution. Those are
 * reported as incompatibilities instead of guessed at.
 */
function translateDatetimeCall(modifiers: string[]): string | null {
  let expr = UTC_NOW;
  for (const raw of modifiers) {
    const modifier = raw.trim().replace(/^'|'$/g, '').trim();

    const offset = /^([+-])\s*(\d+)\s+(second|minute|hour|day|month|year)s?$/i.exec(modifier);
    if (offset) {
      const [, sign, amount, unit] = offset;
      expr = `(${expr} ${sign} interval '${amount} ${unit.toLowerCase()}')`;
      continue;
    }
    if (/^start of day$/i.test(modifier)) { expr = `date_trunc('day', ${expr})`; continue; }
    if (/^start of month$/i.test(modifier)) { expr = `date_trunc('month', ${expr})`; continue; }
    if (/^start of year$/i.test(modifier)) { expr = `date_trunc('year', ${expr})`; continue; }
    return null;
  }
  return `to_char(${expr}, ${SQLITE_TS_FORMAT})`;
}

/** Rewrites every translatable datetime('now', ...), ignoring occurrences inside literals. */
function rewriteDatetimeCalls(sql: string): string {
  // datetime('now') plus any number of single-quoted modifier arguments.
  const pattern = /\bdatetime\s*\(\s*'now'\s*((?:,\s*'[^']*'\s*)*)\)/gi;
  return replaceInCodeWith(sql, pattern, (m) => {
    const modifiers = m[1]?.match(/'[^']*'/g) ?? [];
    return translateDatetimeCall(modifiers) ?? m[0];
  });
}

const SAFE_REWRITES: Array<{ pattern: RegExp; replacement: string; note: string }> = [
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
    // Runtime "ensure table exists" DDL is written in SQLite dialect. On PostgreSQL the
    // schema comes from migrations and every table already exists, so these statements are
    // no-ops in intent — but they must still PARSE. Translating the column definition is
    // safer than skipping the statement: a skip is silent, and would also hide a genuine
    // CREATE TABLE that the migrations had missed.
    pattern: /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
    replacement: 'bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY',
    note: 'AUTOINCREMENT is SQLite-only; IDENTITY is the PostgreSQL equivalent',
  },
  {
    // Any remaining bare AUTOINCREMENT (e.g. a differently-ordered declaration).
    pattern: /\s+AUTOINCREMENT\b/gi,
    replacement: '',
    note: 'AUTOINCREMENT has no PostgreSQL equivalent and is implied by IDENTITY',
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
    pattern: /\bdatetime\s*\(\s*'now'\s*,\s*(?!')/gi,
    construct: "datetime('now', <non-literal>)",
    detail:
      "A datetime() modifier built from a bound parameter or a concatenation cannot be " +
      'translated by substitution — an interval literal has to be known at translation time. ' +
      "Rewrite the SQL to compute the bound in the caller, or use " +
      "`now() AT TIME ZONE 'utc' - make_interval(...)` explicitly.",
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
  // datetime() first: it is the only rewrite that inspects its own arguments, and running it
  // before the blanket patterns keeps the multi-argument forms intact.
  text = rewriteDatetimeCalls(text);
  for (const { pattern, replacement } of SAFE_REWRITES) {
    text = replaceInCode(text, pattern, replacement);
  }
  return text;
}

/**
 * Replaces matches whose START is in a code position, using a function to build each
 * replacement.
 *
 * Deliberately NOT implemented by splitting the statement into code and literal spans and
 * transforming the code ones: constructs like `datetime('now', '-1 hour')` CONTAIN string
 * literals, so span splitting cuts the pattern into `datetime(`, `, ` and `)` and it can
 * never match. Matching against the whole statement and checking only where the match BEGINS
 * lets a pattern span a literal while still ignoring one that starts inside a message.
 */
function replaceInCodeWith(sql: string, pattern: RegExp, build: (match: RegExpExecArray) => string): string {
  const mask = literalMask(sql);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    if (mask[m.index]) continue;
    out += sql.slice(last, m.index) + build(m);
    last = m.index + m[0].length;
  }
  return out + sql.slice(last);
}

/** Full translation for the PostgreSQL adapter: safe rewrites, then placeholders. */
export function translateToPostgres(sql: string): string {
  return toPositionalParams(applySafeRewrites(sql));
}
