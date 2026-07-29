#!/usr/bin/env node
/**
 * Fixes the last shapes of raw-handle usage in test files, from tsc diagnostics.
 *
 *   A. `db = new Database(':memory:')` where db is Db-typed
 *      -> `db = new SqliteAdapter(new Database(':memory:'))`
 *      The earlier test codemod only handled DECLARATIONS (`const db = new Database(...)`),
 *      not ASSIGNMENTS to an already-declared variable, which is the shape most suites use
 *      because they reassign in beforeEach.
 *
 *   B. `getDb().prepare(...)` / `someDb.prepare(...)`
 *      -> the raw connection, since prepare is not on the Db interface.
 *
 * Both are located from the compiler rather than by text search, so a `new Database(...)`
 * that is genuinely meant to stay raw — several suites hold one deliberately — is left
 * alone, because it produces no diagnostic.
 *
 * Usage: node scripts/pg/fix-test-handles.mjs [--dry-run]
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind, Node } = require(path.resolve('api/node_modules/ts-morph'));

const dryRun = process.argv.includes('--dry-run');
const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const repoRoot = path.resolve('.');
const rel = (f) => f.getFilePath().replace(`${repoRoot}/`, '');

const totals = { wrapped: 0, prepareRepointed: 0, files: new Set() };

function ensureImport(file, name, targetAbs) {
  const p = path.relative(path.dirname(file.getFilePath()), targetAbs);
  const spec = p.startsWith('.') ? p : `./${p}`;
  const existing = file.getImportDeclaration((d) => d.getModuleSpecifierValue() === spec);
  if (existing) {
    if (!existing.getNamedImports().some((n) => n.getName() === name)) {
      existing.addNamedImport(name);
    }
    return;
  }
  file.addImportDeclaration({ moduleSpecifier: spec, namedImports: [name] });
}

for (let pass = 1; pass <= 4; pass++) {
  const diagnostics = project.getPreEmitDiagnostics();
  const byFile = new Map();

  for (const d of diagnostics) {
    const file = d.getSourceFile();
    if (!file || !file.getFilePath().endsWith('.test.ts')) continue;
    const message = typeof d.getMessageText() === 'string'
      ? d.getMessageText() : d.getMessageText().getMessageText();
    const start = d.getStart();
    if (start === undefined) continue;

    let kind = null;
    if (/Type 'Database' is missing the following properties from type 'Db'/.test(message)) kind = 'wrap';
    else if (/Property 'prepare' does not exist on type 'Db'/.test(message)) kind = 'prepare';
    if (!kind) continue;

    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ kind, start });
  }

  let changed = 0;
  for (const [file, items] of byFile) {
    items.sort((a, b) => b.start - a.start);
    for (const item of items) {
      const node = file.getDescendantAtPos(item.start);
      if (!node || node.wasForgotten()) continue;

      if (item.kind === 'wrap') {
        const New = Node.isNewExpression(node)
          ? node
          : node.getFirstAncestorByKind(SyntaxKind.NewExpression)
            ?? node.getParentIfKind?.(SyntaxKind.BinaryExpression)?.getRight?.();
        const target = New && Node.isNewExpression(New) ? New : null;
        if (!target || target.wasForgotten()) continue;
        if (target.getExpression().getText() !== 'Database') continue;
        target.replaceWithText(`new SqliteAdapter(${target.getText()})`);
        ensureImport(file, 'SqliteAdapter', path.resolve('api/src/db/adapter/SqliteAdapter'));
        totals.wrapped++; changed++; totals.files.add(rel(file));
        continue;
      }

      if (item.kind === 'prepare') {
        const access = node.getFirstAncestorByKind(SyntaxKind.PropertyAccessExpression);
        if (!access || access.wasForgotten()) continue;
        const receiver = access.getExpression();
        const text = receiver.getText();
        // getDb() has a raw counterpart; anything else gets .raw off the adapter.
        const replacement = text === 'getDb()'
          ? 'getRawDb()'
          : `(${text} as unknown as { raw: import('better-sqlite3').Database }).raw`;
        receiver.replaceWithText(replacement);
        if (replacement === 'getRawDb()') {
          ensureImport(file, 'getRawDb', path.resolve('api/src/db/client'));
        }
        totals.prepareRepointed++; changed++; totals.files.add(rel(file));
      }
    }
  }

  console.log(`pass ${pass}: ${changed} fix(es)`);
  if (!changed) break;
  if (!dryRun) project.saveSync();
}

if (!dryRun) project.saveSync();
console.log(`\nhandles wrapped   : ${totals.wrapped}`);
console.log(`prepare repointed : ${totals.prepareRepointed}`);
console.log(`files             : ${totals.files.size}`);
