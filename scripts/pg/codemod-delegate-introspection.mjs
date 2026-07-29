#!/usr/bin/env node
/**
 * Points the ~40 local `tableExists` / `tableHasColumn` / `tableColumns` / `hasTenantId`
 * reimplementations at the shared dialect-aware module in db/introspection.ts.
 *
 * WHY REPLACE BODIES RATHER THAN CALL SITES
 * These helpers are duplicated across ~30 files, each with its own copy of the same
 * `sqlite_master` / `PRAGMA table_info` query. Rewriting every CALL SITE would touch hundreds
 * of lines. Replacing each local function's BODY leaves its name, signature and every caller
 * exactly as they are, so the diff is confined to the helpers themselves and behaviour on
 * SQLite is provably unchanged — the green suite is the check.
 *
 * The local definitions are deliberately KEPT rather than deleted. Some are exported and
 * imported elsewhere, some are typed `(db: ReturnType<typeof getDb>)` rather than `(db: Db)`,
 * and a couple return `Set<string>` instead of `string[]`. Delegating preserves each local
 * contract; deleting them would mean reconciling all of that at the same time as changing the
 * query, which is two risks at once.
 *
 * Usage: node scripts/pg/codemod-delegate-introspection.mjs [--dry-run]
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind, Node } = require(path.resolve('api/node_modules/ts-morph'));

const dryRun = process.argv.includes('--dry-run');
const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const repoRoot = path.resolve('.');
const rel = (f) => f.getFilePath().replace(`${repoRoot}/`, '');

/** The module that owns the real implementations, and must never delegate to itself. */
const OWNER = '/src/db/introspection.ts';
/**
 * db/schema.ts is SQLite-only by nature and holds the raw driver deliberately; it is deleted
 * when SQLite is removed. Converting it would mean handing it a Db it does not have.
 */
const EXCLUDED = [OWNER, '/src/db/schema.ts', '/src/db/adapter/', '/src/db/client.ts'];

/**
 * Local helper name -> how to delegate. `shape` says what the local signature returns, so a
 * helper returning Set<string> keeps returning one.
 */
const DELEGATES = {
  tableExists: { fn: 'tableExists', args: (p) => `${p[0]}, ${p[1]}`, shape: 'value' },
  tableHasColumn: { fn: 'columnExists', args: (p) => `${p[0]}, ${p[1]}, ${p[2]}`, shape: 'value' },
  columnExists: { fn: 'columnExists', args: (p) => `${p[0]}, ${p[1]}, ${p[2]}`, shape: 'value' },
  indexExists: { fn: 'indexExists', args: (p) => `${p[0]}, ${p[1]}`, shape: 'value' },
  // hasTenantId(db, table) is "does this table have a tenant_id column".
  hasTenantId: { fn: 'columnExists', args: (p) => `${p[0]}, ${p[1]}, 'tenant_id'`, shape: 'value' },
};

let converted = 0;
const touched = new Set();
const skipped = [];

for (const file of project.getSourceFiles()) {
  const fp = file.getFilePath();
  if (fp.includes('/node_modules/')) continue;
  if (fp.endsWith('.test.ts')) continue;
  if (EXCLUDED.some((e) => fp.includes(e))) continue;

  let changedFile = false;

  for (const fn of file.getFunctions()) {
    const name = fn.getName();
    if (!name) continue;

    const params = fn.getParameters().map((p) => p.getName());
    const returnsSet = /Set<\s*string\s*>/.test(fn.getReturnType().getText());

    // tableColumns has two shapes in the wild: string[] and Set<string>.
    if (name === 'tableColumns') {
      if (params.length < 2) { skipped.push(`${rel(file)}: tableColumns has ${params.length} params`); continue; }
      const call = `await sharedTableColumns(${params[0]}, ${params[1]})`;
      fn.setBodyText(returnsSet ? `return new Set(${call});` : `return ${call};`);
      if (!fn.isAsync()) fn.setIsAsync(true);
      converted++; changedFile = true;
      continue;
    }

    const delegate = DELEGATES[name];
    if (!delegate) continue;

    const needed = name === 'tableHasColumn' || name === 'columnExists' ? 3 : 2;
    if (params.length < needed) {
      skipped.push(`${rel(file)}: ${name} takes ${params.length} params, expected ${needed}`);
      continue;
    }

    fn.setBodyText(`return await shared${capitalise(delegate.fn)}(${delegate.args(params)});`);
    if (!fn.isAsync()) fn.setIsAsync(true);
    converted++; changedFile = true;
  }

  if (!changedFile) continue;

  // Import under aliases so a local helper of the same name never shadows the import.
  const spec = (() => {
    const p = path.relative(path.dirname(fp), path.resolve('api/src/db/introspection'));
    return p.startsWith('.') ? p : `./${p}`;
  })();
  const existing = file.getImportDeclaration((d) => d.getModuleSpecifierValue() === spec);
  const wanted = [
    { name: 'tableExists', alias: 'sharedTableExists' },
    { name: 'columnExists', alias: 'sharedColumnExists' },
    { name: 'tableColumns', alias: 'sharedTableColumns' },
    { name: 'indexExists', alias: 'sharedIndexExists' },
  ];
  if (existing) {
    for (const w of wanted) {
      if (!existing.getNamedImports().some((n) => n.getAliasNode()?.getText() === w.alias)) {
        existing.addNamedImport(w);
      }
    }
  } else {
    file.addImportDeclaration({ moduleSpecifier: spec, namedImports: wanted });
  }
  touched.add(rel(file));
}

function capitalise(s) { return s[0].toUpperCase() + s.slice(1); }

if (!dryRun) project.saveSync();

console.log(`${dryRun ? 'would convert' : 'converted'}: ${converted} local helper(s)`);
console.log(`files touched: ${touched.size}`);
if (skipped.length) {
  console.log(`skipped: ${skipped.length}`);
  for (const s of skipped) console.log(`  ${s}`);
}
