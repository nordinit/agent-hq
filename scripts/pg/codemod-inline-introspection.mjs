#!/usr/bin/env node
/**
 * Converts INLINE schema-introspection queries onto db/introspection.ts.
 *
 * The earlier pass replaced the bodies of ~40 named helpers. This one handles the 46 sites
 * that inline the same query directly, in a handful of recurring shapes:
 *
 *   (await db.all('PRAGMA table_info(t)') as Array<{name:string}>).some(c => c.name === x)
 *     -> await columnExists(db, 't', x)
 *   (await db.all('PRAGMA table_info(t)') as Array<{name:string}>).map(r => r.name)
 *     -> await tableColumns(db, 't')
 *   Boolean((await db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='t' ...`))?.name)
 *     -> await tableExists(db, 't')
 *
 * Each rewrite is anchored on the FULL expression, not just the query string, so a partial
 * match cannot leave a half-converted expression behind. Anything that does not match one of
 * the shapes exactly is left alone and reported — an inline query doing something subtler than
 * "does this exist" needs reading, not pattern matching.
 *
 * Usage: node scripts/pg/codemod-inline-introspection.mjs [--dry-run]
 */
import fs from 'fs';
import path from 'path';
import { globSync } from 'fs';

const dryRun = process.argv.includes('--dry-run');
const API = path.resolve('api');

const EXCLUDED = [
  'src/db/schema.ts', 'src/db/introspection.ts', 'src/db/startupVerifier.ts',
  'src/db/adapter/', 'src/db/client.ts',
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full, out); continue; }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

const Q = "[`'\"]";                       // any quote style
// Table name OR a ${...} interpolation. The leading char class must admit '$', or every
// `PRAGMA table_info(${table})` site is silently skipped.
const TBL = '([A-Za-z_$][A-Za-z0-9_$.{}]*)';

/** Renders a captured table name as a TS expression: literal string, or template if interpolated. */
function tableExpr(name) {
  return name.includes('${') ? '`' + name + '`' : `'${name}'`;
}

/** Each rule: a pattern over the whole expression, and how to rebuild it. */
const RULES = [
  {
    name: 'table_info(...).some(c => c.name === X)  -> columnExists',
    // (await <recv>.all(<q>PRAGMA table_info(<tbl>)<q>) as Array<{ name: string }>).some((v) => v.name === <expr>)
    pattern: new RegExp(
      `\\(await ([A-Za-z_$][\\w.$]*)\\.all\\(\\s*${Q}PRAGMA table_info\\(${TBL}\\)${Q}\\s*\\)` +
      `(?:\\s+as\\s+Array<\\{[^}]*\\}>)?\\)` +
      `\\.some\\(\\s*\\(?(\\w+)\\)?\\s*=>\\s*\\3\\.name\\s*===\\s*([^)]+?)\\)`,
      'g'),
    build: (m) => `await sharedColumnExists(${m[1]}, ${tableExpr(m[2])}, ${m[4].trim()})`,
  },
  {
    name: 'table_info(...).map(r => r.name)  -> tableColumns',
    pattern: new RegExp(
      `\\(await ([A-Za-z_$][\\w.$]*)\\.all\\(\\s*${Q}PRAGMA table_info\\(${TBL}\\)${Q}\\s*\\)` +
      `(?:\\s+as\\s+Array<\\{[^}]*\\}>)?\\)` +
      `\\.map\\(\\s*\\(?(\\w+)\\)?\\s*=>\\s*\\3\\.name\\s*\\)`,
      'g'),
    build: (m) => `await sharedTableColumns(${m[1]}, ${tableExpr(m[2])})`,
  },
  {
    name: 'multi-line table_info(...).some / .map  -> columnExists / tableColumns',
    // Same two shapes as above but tolerant of newlines and a trailing `as Array<...>` on its
    // own line, which is how most of the remaining sites are formatted.
    pattern: new RegExp(
      `\\(await ([A-Za-z_$][\\w.$]*)\\.all\\(\\s*${Q}PRAGMA table_info\\(${TBL}\\)${Q}\\s*\\)` +
      `(?:\\s*as\\s+Array<\\{[^}]*\\}>)?\\s*\\)` +
      `\\s*\\.(some|map)\\(\\s*\\(?(\\w+)\\)?\\s*=>\\s*` +
      `(?:\\4\\.name\\s*===\\s*([^)\\n]+?)|\\4\\.name)\\s*\\)`,
      'g'),
    build: (m) => (m[3] === 'some'
      ? `await sharedColumnExists(${m[1]}, ${tableExpr(m[2])}, ${(m[5] ?? '').trim()})`
      : `await sharedTableColumns(${m[1]}, ${tableExpr(m[2])})`),
  },
  {
    name: "const x = await db.get(sqlite_master name='t')  -> tableExists",
    // Result is only ever used for truthiness, so a boolean is an exact substitute.
    pattern: new RegExp(
      `await ([A-Za-z_$][\\w.$]*)\\.get\\(\\s*${Q}SELECT name FROM sqlite_master ` +
      `WHERE type\\s*=\\s*'table' AND name\\s*=\\s*'([A-Za-z_][\\w]*)'(?: LIMIT 1)?${Q}\\s*\\)` +
      `(?:\\s*as\\s+\\{[^}]*\\}\\s*\\|\\s*undefined)?`,
      'g'),
    build: (m) => `await sharedTableExists(${m[1]}, '${m[2]}')`,
  },
  {
    name: "all(sqlite_master type='table')  -> listTables",
    pattern: new RegExp(
      `await ([A-Za-z_$][\\w.$]*)\\.all\\(\\s*${Q}SELECT name FROM sqlite_master ` +
      `WHERE type\\s*=\\s*'table'${Q}\\s*\\)(?:\\s*as\\s+Array<\\{[^}]*\\}>)?`,
      'g'),
    build: (m) => `(await sharedListTables(${m[1]})).map((name) => ({ name }))`,
  },
  {
    name: 'assigned table_info(...) -> tableColumns mapped back to {name} rows',
    // `const cols = await db.all('PRAGMA table_info(t)') as Array<{name:string}>` — the value
    // is inspected later, so the row SHAPE has to be preserved rather than flattened.
    pattern: new RegExp(
      `await ([A-Za-z_$][\\w.$]*)\\.all\\(\\s*${Q}PRAGMA table_info\\(${TBL}\\)${Q}\\s*\\)` +
      `\\s*as\\s+Array<\\{\\s*name:\\s*string;?\\s*\\}>`,
      'g'),
    build: (m) => `(await sharedTableColumns(${m[1]}, ${tableExpr(m[2])})).map((name) => ({ name }))`,
  },
  {
    name: "Boolean(sqlite_master name='t')  -> tableExists",
    pattern: new RegExp(
      `Boolean\\(\\(await ([A-Za-z_$][\\w.$]*)\\.get\\(\\s*${Q}SELECT name FROM sqlite_master ` +
      `WHERE type\\s*=\\s*'table' AND name\\s*=\\s*'([A-Za-z_][\\w]*)'(?: LIMIT 1)?${Q}\\s*\\)` +
      `(?:\\s+as\\s+[^)]+?)?\\)\\?\\.name\\)`,
      'g'),
    build: (m) => `await sharedTableExists(${m[1]}, '${m[2]}')`,
  },
];

let converted = 0;
const perRule = {};
const touched = new Set();

for (const file of walk(path.join(API, 'src'))) {
  const relPath = file.replace(`${API}/`, '');
  if (EXCLUDED.some((e) => relPath.startsWith(e) || relPath.includes(e))) continue;

  let src = fs.readFileSync(file, 'utf8');
  const before = src;

  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    src = src.replace(rule.pattern, (...args) => {
      const m = args.slice(0, -2);
      perRule[rule.name] = (perRule[rule.name] ?? 0) + 1;
      converted++;
      return rule.build(m);
    });
  }

  if (src === before) continue;

  // Add aliased imports if the file now references them and does not already import them.
  const needed = [
    ['sharedTableExists', 'tableExists'],
    ['sharedColumnExists', 'columnExists'],
    ['sharedTableColumns', 'tableColumns'],
    ['sharedListTables', 'listTables'],
  ].filter(([alias]) => src.includes(alias) && !new RegExp(`\\b${alias}\\b[^\\n]*from`).test(src));

  if (needed.length) {
    const rel = path.relative(path.dirname(file), path.join(API, 'src/db/introspection'));
    const spec = rel.startsWith('.') ? rel : `./${rel}`;
    const existing = new RegExp(`import \\{([^}]*)\\} from ["']${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'];`);
    const match = existing.exec(src);
    if (match) {
      const additions = needed
        .filter(([alias]) => !match[1].includes(alias))
        .map(([alias, real]) => `${real} as ${alias}`);
      if (additions.length) {
        src = src.replace(match[0], `import {${match[1]}, ${additions.join(', ')} } from "${spec}";`);
      }
    } else {
      const line = `import { ${needed.map(([alias, real]) => `${real} as ${alias}`).join(', ')} } from "${spec}";\n`;
      // After the final top-level import, so the file's import block stays contiguous.
      const lastImport = [...src.matchAll(/^import .*?;$/gm)].pop();
      src = lastImport
        ? src.slice(0, lastImport.index + lastImport[0].length + 1) + line + src.slice(lastImport.index + lastImport[0].length + 1)
        : line + src;
    }
  }

  if (!dryRun) fs.writeFileSync(file, src);
  touched.add(relPath);
}

console.log(`${dryRun ? 'would convert' : 'converted'}: ${converted} inline site(s)`);
for (const [name, n] of Object.entries(perRule)) console.log(`  ${String(n).padStart(3)}  ${name}`);
console.log(`files touched: ${touched.size}`);
