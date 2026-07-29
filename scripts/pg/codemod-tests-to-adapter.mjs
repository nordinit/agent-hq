#!/usr/bin/env node
/**
 * Adapts test files that construct better-sqlite3 directly.
 *
 * 49 suites do `const db = new Database(path)` and then either pass `db` to production
 * code (which now expects the Db interface) or call `db.get(sql, ...)` because the earlier
 * codemod rewrote their query sites. Both need the handle to be an adapter.
 *
 * But those same suites ALSO legitimately use the raw driver — `db.pragma(...)`,
 * `db.prepare(...)`, `db.close()` — which the Db interface does not expose. So the handle
 * cannot simply become an adapter; the file needs BOTH, with each reference pointed at the
 * right one.
 *
 * The transform:
 *     const db = new Database(p);        ->  const dbRaw = new Database(p);
 *                                            const db = new SqliteAdapter(dbRaw);
 * and every `db.pragma`, `db.prepare`, `db.close`, `db.transaction`, `db.inTransaction`
 * reference is repointed at `dbRaw`.
 *
 * This is an INTERIM step. These suites are rewritten again onto PostgreSQL fixtures when
 * SQLite is removed. It exists because a green suite on the engine that already works is
 * the only clean signal that the 3,735 converted call sites did not change behaviour — a
 * signal that disappears if the engine changes at the same time.
 *
 * Usage: node scripts/pg/codemod-tests-to-adapter.mjs [--dry-run] [--only=<substring>]
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind, Node } = require(path.resolve('api/node_modules/ts-morph'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

/** Members that exist on better-sqlite3 but NOT on the Db interface. */
const RAW_ONLY_MEMBERS = new Set([
  'pragma', 'prepare', 'close', 'transaction', 'inTransaction', 'open',
  'name', 'memory', 'readonly', 'backup', 'function', 'aggregate', 'loadExtension',
  'defaultSafeIntegers', 'unsafeMode', 'serialize',
]);

const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const repoRoot = path.resolve('.');
const rel = (f) => f.getFilePath().replace(`${repoRoot}/`, '');

let files = project.getSourceFiles()
  .filter((f) => f.getFilePath().endsWith('.test.ts'))
  .filter((f) => !f.getFilePath().includes('/node_modules/'))
  // The adapter's own suites construct handles deliberately and are already correct.
  .filter((f) => !f.getFilePath().includes('/src/db/adapter/'));
if (only) files = files.filter((f) => rel(f).includes(only));

const report = { filesChanged: [], handlesWrapped: 0, rawRefsRepointed: 0, skipped: [] };

for (const file of files) {
  const decls = file.getDescendantsOfKind(SyntaxKind.VariableDeclaration)
    .filter((d) => {
      const init = d.getInitializer();
      return init && Node.isNewExpression(init) && init.getExpression().getText() === 'Database';
    });
  if (!decls.length) continue;

  let changedFile = false;

  for (const decl of decls) {
    if (decl.wasForgotten()) continue;
    const nameNode = decl.getNameNode();
    if (!Node.isIdentifier(nameNode)) {
      report.skipped.push(`${rel(file)}:${decl.getStartLineNumber()} (destructured handle)`);
      continue;
    }
    const name = nameNode.getText();
    const rawName = `${name}Raw`;

    // Partition the references BEFORE editing anything.
    //
    // Using nameNode.rename() would repoint EVERY reference, including the adapter-style
    // calls that are the whole reason for this transform — it renames the symbol, not a
    // subset of its uses. So each identifier node is rewritten individually instead:
    // raw-driver members move to the raw handle, everything else keeps the original name
    // and resolves to the adapter declared alongside it.
    const rawRefs = [];
    for (const ref of nameNode.findReferencesAsNodes()) {
      if (ref.wasForgotten()) continue;
      if (ref === nameNode) continue;
      const parent = ref.getParent();
      const isRawMember = parent && Node.isPropertyAccessExpression(parent) &&
                          parent.getExpression() === ref &&
                          RAW_ONLY_MEMBERS.has(parent.getName());
      if (isRawMember) rawRefs.push(ref);
    }

    // Rewrite in REVERSE document order: an earlier edit shifts every later position.
    const toRewrite = [nameNode, ...rawRefs].sort((a, b) => b.getStart() - a.getStart());
    for (const node of toRewrite) {
      if (node.wasForgotten()) continue;
      node.replaceWithText(rawName);
    }
    report.rawRefsRepointed += rawRefs.length;

    // Declare the adapter under the ORIGINAL name, so every non-raw reference now
    // resolves to it without being touched.
    const stmt = decl.getFirstAncestorByKind(SyntaxKind.VariableStatement)
      ?? file.getDescendantsOfKind(SyntaxKind.VariableStatement)
             .find((v) => v.getText().includes(`${rawName} = new Database`));
    if (!stmt || stmt.wasForgotten()) {
      report.skipped.push(`${rel(file)}: could not locate the declaration statement for ${name}`);
      continue;
    }
    const isConst = stmt.getDeclarationKind?.() === 'const';
    stmt.replaceWithText(
      `${stmt.getText().replace(/;?\s*$/, ';')}\n` +
      `${isConst ? 'const' : 'let'} ${name} = new SqliteAdapter(${rawName});`
    );

    report.handlesWrapped++;
    changedFile = true;
  }

  if (!changedFile) continue;

  const adapterPath = path.relative(
    path.dirname(file.getFilePath()),
    path.resolve('api/src/db/adapter/SqliteAdapter')
  );
  const spec = adapterPath.startsWith('.') ? adapterPath : `./${adapterPath}`;
  if (!file.getImportDeclaration((d) => d.getModuleSpecifierValue() === spec)) {
    file.addImportDeclaration({ moduleSpecifier: spec, namedImports: ['SqliteAdapter'] });
  }
  report.filesChanged.push(rel(file));
}

if (!dryRun) project.saveSync();

console.log(`${dryRun ? 'WOULD CHANGE' : 'CHANGED'} ${report.filesChanged.length} test file(s)`);
console.log(`  handles wrapped:      ${report.handlesWrapped}`);
console.log(`  raw member refs kept: ${report.rawRefsRepointed}`);
console.log(`  skipped:              ${report.skipped.length}`);
for (const s of report.skipped.slice(0, 10)) console.log(`      ${s}`);
