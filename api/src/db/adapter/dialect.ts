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

/**
 * Unwraps single-argument `datetime(<expr>)` where <expr> is not 'now'.
 *
 * SQLite uses this to NORMALISE a timestamp string. Every such column in Agent HQ already
 * holds the canonical 'YYYY-MM-DD HH:MM:SS' form — lib/timestamps.ts is the single writer and
 * scripts/normalize-timestamps.mjs rewrote the historical rows — so the call is an identity
 * operation there. PostgreSQL has no datetime() function at all.
 *
 * Dropping the wrapper is therefore behaviour-preserving, and ordering survives it because the
 * canonical format is fixed-width, so lexicographic and chronological order coincide.
 *
 * Hand-written rather than a regex because the argument can contain nested parentheses and
 * commas — `datetime(COALESCE(a, b, c))` is a real call site — which a regex cannot bracket
 * correctly. Only calls with exactly ONE top-level argument are unwrapped; a two-argument call
 * is a modifier form and belongs to translateDatetimeCall.
 */
function unwrapSingleArgDatetime(sql: string): string {
  const mask = literalMask(sql);
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const match = /^datetime\s*\(/i.exec(sql.slice(i));
    if (!match || mask[i]) { out += sql[i]; i++; continue; }

    // Walk to the matching close paren, tracking depth and skipping string literals.
    let depth = 0;
    let j = i + match[0].length - 1;
    const argStart = j + 1;
    const commas = [];
    for (; j < sql.length; j++) {
      if (mask[j]) continue;
      const ch = sql[j];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
      else if (ch === ',' && depth === 1) commas.push(j);
    }
    if (j >= sql.length) { out += sql[i]; i++; continue; }

    const arg = sql.slice(argStart, j).trim();
    // Two or more arguments, or the 'now' form: leave it for translateDatetimeCall.
    if (commas.length > 0 || /^'now'$/i.test(arg) || arg === '') {
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    out += arg;
    i = j + 1;
  }

  return out;
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
    // The `(? IS NULL OR col = ?)` optional-filter idiom, used at ~30 sites. PostgreSQL infers a
    // parameter's type from its context, and `IS NULL` supplies none, so the statement is
    // rejected before it runs with "could not determine data type of parameter $N". SQLite is
    // untyped and never had to care.
    //
    // The cast is safe precisely because this occurrence is only ever tested for nullness: each
    // `?` becomes its own positional parameter, so casting this one to text cannot affect the
    // comparison in the other half of the OR. NULL::text IS NULL stays true, and any non-null
    // value stays non-null.
    // A lookahead, not a capture: replaceInCode inserts the replacement literally and does not
    // expand $1, so matching the IS NULL text would delete it and leave a stray "$1" behind.
    pattern: /\?(?=\s+IS\s+(?:NOT\s+)?NULL\b)/gi,
    replacement: '?::text',
    note: 'a bare parameter in IS NULL has no inferable type in PostgreSQL',
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
    // OR IGNORE is translated automatically (see rewriteInsertOrIgnore); OR REPLACE is not,
    // because rebuilding it as DO UPDATE needs a conflict target and the full column list.
    pattern: /\bINSERT\s+OR\s+REPLACE\b/gi,
    construct: 'INSERT OR REPLACE',
    detail:
      'Rewrite as INSERT ... ON CONFLICT (<target>) DO UPDATE SET ..., naming the conflicting ' +
      'columns explicitly. INSERT OR IGNORE needs no change — it is translated to ' +
      'ON CONFLICT DO NOTHING.',
  },
  {
    // json_set with a literal path is translated; anything else reaches PostgreSQL as-is.
    pattern: /\bjson_set\s*\((?![^)]*'\$\.)/gi,
    construct: 'json_set() with a non-literal path',
    detail:
      "Only json_set(target, '$.literal.path', json(value)) can be translated to jsonb_set — " +
      'a path built from a bound parameter is not known at translation time. Use ' +
      'jsonb_set(target::jsonb, <text[] path>, value::jsonb) directly.',
  },
  {
    pattern: /\bjson_extract\s*\(/gi,
    construct: 'json_extract()',
    detail:
      'PostgreSQL has no json_extract. For a literal path use ' +
      "target::jsonb #>> '{a,b}'; for a path supplied as a bound parameter use " +
      'jsonb_extract_path_text(target::jsonb, ?), which takes bare key names rather than ' +
      "SQLite's '$.a.b' form — so the caller must change what it binds, not just the SQL.",
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
/**
 * `json_set(target, '$.path', json(value))` -> `jsonb_set((target)::jsonb, '{path}', (value)::jsonb)`
 *
 * PostgreSQL has no `json_set`, and the two dialects disagree on how a path is written:
 * SQLite takes `'$.a.b'`, PostgreSQL takes a text[] like `'{a,b}'`. Assigning the jsonb result
 * back into a text column needs no cast — PostgreSQL casts on assignment.
 *
 * Only the three-argument form with a LITERAL path and a `json()`-wrapped value is translated.
 * A path built from a bound parameter cannot be converted by substitution, so it is left intact
 * for findIncompatibilities() to report rather than silently rewritten into something else.
 */
/**
 * `round(x, n)` -> `round((x)::numeric, n)`.
 *
 * PostgreSQL only defines two-argument round() for numeric; applied to a double precision value
 * — which is what any AVG(), division or SUM() of a real column produces — it fails with
 * "function round(double precision, integer) does not exist". SQLite's round() takes any numeric
 * type, so the same expression is valid there.
 *
 * Only the two-argument form is touched. Single-argument round() is defined for double precision
 * in PostgreSQL and needs no cast.
 *
 * The numeric result needs no cast back to a float type here: PostgresAdapter registers a numeric
 * type parser, so every numeric the driver returns arrives as a JS number. Casting again would be
 * a second mechanism for one problem, and the parser has to exist regardless — SUM(bigint) and
 * AVG() widen to numeric with no round() involved.
 */
function rewriteRoundCalls(sql: string): string {
  return rewriteTwoArgCall(sql, 'round', (first, rest) => `round((${first})::numeric, ${rest})`);
}

/**
 * Shared walker for `fn(a, b)` rewrites: finds each call to `name` in a code position, splits its
 * arguments at the top-level comma, and hands both halves to `build`.
 *
 * Written as a paren-matching walk rather than a regex because an argument can itself contain
 * parentheses and string literals — `round(AVG(x) * 100.0 / COUNT(*), 1)` being the case that
 * matters here — which no regex can bracket correctly.
 */
function rewriteTwoArgCall(
  sql: string,
  name: string,
  build: (first: string, rest: string) => string,
): string {
  const mask = literalMask(sql);
  const opener = new RegExp(`^${name}\\s*\\(`, 'i');
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const match = opener.exec(sql.slice(i));
    if (!match || mask[i]) { out += sql[i]; i++; continue; }
    // A longer identifier ending in `name` (my_round(...)) must not match.
    if (i > 0 && /[A-Za-z0-9_]/.test(sql[i - 1])) { out += sql[i]; i++; continue; }

    let depth = 0;
    let j = i + match[0].length - 1;
    const argStart = j + 1;
    const commas: number[] = [];
    for (; j < sql.length; j++) {
      if (mask[j]) continue;
      const ch = sql[j];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
      else if (ch === ',' && depth === 1) commas.push(j);
    }
    if (j >= sql.length || commas.length !== 1) { out += sql[i]; i++; continue; }

    out += build(sql.slice(argStart, commas[0]).trim(), sql.slice(commas[0] + 1, j).trim());
    i = j + 1;
  }

  return out;
}

function rewriteJsonSetCalls(sql: string): string {
  const mask = literalMask(sql);
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const match = /^json_set\s*\(/i.exec(sql.slice(i));
    if (!match || mask[i]) { out += sql[i]; i++; continue; }

    // Walk to the matching close paren, tracking depth and skipping string literals, so a
    // nested call like COALESCE(response, '{}') is treated as one argument.
    let depth = 0;
    let j = i + match[0].length - 1;
    const argStart = j + 1;
    const commas: number[] = [];
    for (; j < sql.length; j++) {
      if (mask[j]) continue;
      const ch = sql[j];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
      else if (ch === ',' && depth === 1) commas.push(j);
    }
    if (j >= sql.length || commas.length !== 2) { out += sql[i]; i++; continue; }

    const target = sql.slice(argStart, commas[0]).trim();
    const path = sql.slice(commas[0] + 1, commas[1]).trim();
    const value = sql.slice(commas[1] + 1, j).trim();

    const literalPath = /^'\$\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)'$/.exec(path);
    const jsonValue = /^json\s*\(([\s\S]*)\)$/i.exec(value);
    if (!literalPath || !jsonValue) { out += sql[i]; i++; continue; }

    out += `jsonb_set((${target})::jsonb, '{${literalPath[1].split('.').join(',')}}', (${jsonValue[1].trim()})::jsonb)`;
    i = j + 1;
  }

  return out;
}

/**
 * `INSERT OR IGNORE INTO ...` -> `INSERT INTO ... ON CONFLICT DO NOTHING`.
 *
 * PostgreSQL accepts `ON CONFLICT DO NOTHING` with NO conflict target, meaning "any unique
 * violation", which is exactly SQLite's OR IGNORE semantics — so this needs no per-statement
 * knowledge of which constraint might fire. Row counts match too: a suppressed insert reports
 * zero changes on both engines.
 *
 * The clause is placed BEFORE any RETURNING, because PostgresAdapter.run() appends
 * `RETURNING <pk>` to the statement before translation runs, and ON CONFLICT must precede it.
 *
 * INSERT OR REPLACE is deliberately NOT handled: it would need a conflict target and the full
 * column list to rebuild as DO UPDATE, so it stays a reported incompatibility.
 */
function rewriteInsertOrIgnore(sql: string): string {
  if (!matchesInCode(sql, /\bINSERT\s+OR\s+IGNORE\b/i)) return sql;

  const text = replaceInCode(sql, /\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT');
  // An explicit ON CONFLICT already states the resolution; a second clause is a syntax error.
  if (matchesInCode(text, /\bON\s+CONFLICT\b/i)) return text;

  const mask = literalMask(text);
  let insertAt = text.length;
  const returning = /\bRETURNING\b/gi;
  let m: RegExpExecArray | null;
  while ((m = returning.exec(text)) !== null) {
    if (!mask[m.index]) { insertAt = m.index; break; }
  }
  if (insertAt === text.length) {
    insertAt = text.length - (/[\s;]*$/.exec(text)?.[0].length ?? 0);
  }

  const head = text.slice(0, insertAt).replace(/\s+$/, '');
  const tail = text.slice(insertAt).trimStart();
  return tail ? `${head} ON CONFLICT DO NOTHING ${tail}` : `${head} ON CONFLICT DO NOTHING`;
}

export function applySafeRewrites(sql: string): string {
  let text = sql;
  // datetime() first: it is the only rewrite that inspects its own arguments, and running it
  // before the blanket patterns keeps the multi-argument forms intact.
  // Modifier forms first, then unwrap the remaining single-argument calls: doing it the other
  // way round would strip datetime('now') down to a bare 'now' string literal.
  text = rewriteDatetimeCalls(text);
  text = unwrapSingleArgDatetime(text);
  text = rewriteJsonSetCalls(text);
  text = rewriteRoundCalls(text);
  text = rewriteInsertOrIgnore(text);
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
