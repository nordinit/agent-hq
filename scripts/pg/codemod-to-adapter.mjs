#!/usr/bin/env node
/**
 * Converts better-sqlite3 call sites onto the async Db adapter.
 *
 *   db.prepare(SQL).get(a, b)        ->  await db.get(SQL, a, b)
 *   db.prepare(SQL).all(a)           ->  await db.all(SQL, a)
 *   db.prepare(SQL).run(a)           ->  await db.run(SQL, a)
 *   db.prepare(SQL).pluck().get(a)   ->  await db.value(SQL, a)
 *   db.exec(SQL)                     ->  await db.exec(SQL)
 *
 * THE HARD PART IS NOT THE REWRITE, IT IS THE PROPAGATION
 * Adding `await` forces the enclosing function to be async, which forces every CALLER to
 * await it, transitively, up to the route handlers — 1,352 functions by measurement. That
 * propagation is run to a fixpoint here rather than left to the type checker, because
 * TypeScript reports a missing await as a type error only when the result is USED; a
 * discarded Promise from a fire-and-forget write compiles cleanly and silently stops being
 * awaited. Those are exactly the sites that corrupt data under load.
 *
 * WHAT IT REFUSES TO TOUCH
 * Anything it cannot rewrite provably is left alone and reported: non-literal SQL built at
 * runtime, sites with no enclosing function, and getters/constructors that cannot be made
 * async. A half-converted file that compiles is more dangerous than one that obviously
 * still needs work.
 *
 * Usage:
 *   node scripts/pg/codemod-to-adapter.mjs [--dry-run] [--only=<substring>]
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind, Node } = require(path.resolve('api/node_modules/ts-morph'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const repoRoot = path.resolve('.');
const rel = (f) => f.getFilePath().replace(`${repoRoot}/`, '');

/**
 * Files the codemod must never touch, in any pass.
 *
 * The adapter is the ONE place that legitimately speaks better-sqlite3 directly — it is
 * the implementation everything else migrates onto. Rewriting its own Database.Database
 * field to Db makes it circular. client.ts and foreignKeyGuard.ts own the raw connection
 * and its pragmas for the same reason.
 */
const NEVER_TOUCH = [
  '/src/db/adapter/',
  '/src/db/client.ts',
  '/src/db/foreignKeyGuard.ts',
];

/**
 * Files that keep the RAW driver but still participate in async propagation.
 *
 * db/schema.ts is the SQLite schema-migration engine: it reads PRAGMA table_info to
 * discover columns, toggles PRAGMA foreign_keys around table rebuilds, and performs
 * SQLite's create-copy-drop-rename dance. None of that is expressible through the Db
 * interface, and none of it has a PostgreSQL equivalent — it is replaced wholesale by the
 * generated baseline, and deleted by task #766.
 *
 * So its own query sites and handle type are left alone. It DOES still need awaits,
 * because it calls functions elsewhere that the conversion made async; those two concerns
 * are independent, which is why this list is separate from NEVER_TOUCH.
 */
const RAW_DRIVER = [
  '/src/db/schema.ts',
];

const allFiles = project.getSourceFiles()
  .filter((f) => !f.getFilePath().includes('/node_modules/'))
  .filter((f) => !NEVER_TOUCH.some((e) => f.getFilePath().includes(e)));

// Passes 1 and 1b (rewrite + retype) skip RAW_DRIVER; propagation and return-type
// wrapping still cover it.
const rewritable = allFiles.filter((f) => !RAW_DRIVER.some((e) => f.getFilePath().includes(e)));
const files = only ? rewritable.filter((f) => rel(f).includes(only)) : rewritable;

const report = {
  rewritten: 0,
  byKind: {},
  skippedDynamicSql: [],
  skippedNoFunction: [],
  skippedUnasyncable: [],
  functionsMadeAsync: 0,
  awaitsAdded: 0,
  filesChanged: new Set(),
};

/** Functions that cannot carry `async`, so a rewrite inside them must be refused. */
function isUnasyncable(fn) {
  const k = fn.getKind();
  if (k === SyntaxKind.GetAccessor || k === SyntaxKind.SetAccessor) return true;
  if (k === SyntaxKind.Constructor) return true;
  return false;
}

function enclosingFunction(node) {
  return node.getFirstAncestor((a) =>
    Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) ||
    Node.isArrowFunction(a) || Node.isFunctionExpression(a) ||
    Node.isGetAccessorDeclaration(a) || Node.isSetAccessorDeclaration(a) ||
    Node.isConstructorDeclaration(a));
}

/**
 * Walks a `.get()/.all()/.run()` chain back to its `.prepare(...)`, returning the pieces
 * needed to rebuild it, or null when the chain is not a prepare chain.
 */
function analyseChain(call) {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return null;
  const terminal = expr.getName();
  if (!['get', 'all', 'run'].includes(terminal)) return null;

  let cursor = expr.getExpression();
  let plucked = false;

  // Optional .pluck() between prepare() and the terminal.
  if (Node.isCallExpression(cursor)) {
    const inner = cursor.getExpression();
    if (Node.isPropertyAccessExpression(inner) && inner.getName() === 'pluck') {
      plucked = true;
      cursor = inner.getExpression();
    }
  }
  if (!Node.isCallExpression(cursor)) return null;
  const prepareExpr = cursor.getExpression();
  if (!Node.isPropertyAccessExpression(prepareExpr) || prepareExpr.getName() !== 'prepare') return null;

  return {
    terminal,
    plucked,
    receiver: prepareExpr.getExpression().getText(),
    sqlArg: cursor.getArguments()[0],
    params: call.getArguments(),
  };
}

function isPlainLiteral(node) {
  if (!node) return false;
  return Node.isStringLiteral(node) ||
         Node.isNoSubstitutionTemplateLiteral(node) ||
         Node.isTemplateExpression(node);
}

/** An awaited expression used as an operand usually needs parentheses to stay valid. */
function needsParens(call) {
  const parent = call.getParent();
  if (!parent) return false;
  return Node.isPropertyAccessExpression(parent) ||
         Node.isElementAccessExpression(parent) ||
         Node.isCallExpression(parent) && parent.getExpression() === call ||
         Node.isNonNullExpression(parent) ||
         Node.isBinaryExpression(parent) && parent.getOperatorToken().getText() === '??';
}

// ---- pass 1: rewrite the call chains ------------------------------------------------
for (const file of files) {
  let changed = false;

  // Collect first: rewriting invalidates positions of later nodes in the same traversal.
  const calls = file.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of calls) {
    if (call.wasForgotten()) continue;
    const chain = analyseChain(call);
    if (!chain) continue;

    if (!isPlainLiteral(chain.sqlArg)) {
      report.skippedDynamicSql.push(`${rel(file)}:${call.getStartLineNumber()}`);
      continue;
    }

    const fn = enclosingFunction(call);
    if (!fn) { report.skippedNoFunction.push(`${rel(file)}:${call.getStartLineNumber()}`); continue; }
    if (isUnasyncable(fn)) { report.skippedUnasyncable.push(`${rel(file)}:${call.getStartLineNumber()}`); continue; }

    const method = chain.plucked ? 'value' : chain.terminal;
    const argText = [chain.sqlArg.getText(), ...chain.params.map((p) => p.getText())].join(', ');
    const replacement = `await ${chain.receiver}.${method}(${argText})`;

    call.replaceWithText(needsParens(call) ? `(${replacement})` : replacement);

    if (!fn.isAsync?.()) { fn.setIsAsync(true); report.functionsMadeAsync++; }

    report.rewritten++;
    report.byKind[method] = (report.byKind[method] ?? 0) + 1;
    changed = true;
  }

  // db.exec(...) — same treatment, but there is no chain to unwind.
  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.wasForgotten()) continue;
    const expr = call.getExpression();
    if (!Node.isPropertyAccessExpression(expr) || expr.getName() !== 'exec') continue;
    // Only database handles, not child_process.exec and friends.
    const receiver = expr.getExpression().getText();
    if (!/\bdb\b|Db\b|database/i.test(receiver)) continue;
    if (Node.isAwaitExpression(call.getParent())) continue;

    const fn = enclosingFunction(call);
    if (!fn || isUnasyncable(fn)) continue;

    call.replaceWithText(`await ${call.getText()}`);
    if (!fn.isAsync?.()) { fn.setIsAsync(true); report.functionsMadeAsync++; }
    report.rewritten++;
    report.byKind.exec = (report.byKind.exec ?? 0) + 1;
    changed = true;
  }

  if (changed) report.filesChanged.add(rel(file));
}

// ---- pass 1b: retype the handle ------------------------------------------------------
// The rewritten call sites are meaningless while the handle is still typed
// Database.Database: better-sqlite3's type has no get(sql, ...) member, so every one of
// them would be a compile error. Every annotation naming the concrete driver becomes the
// Db interface, and the driver import is dropped where nothing else needs it.
report.typesRetyped = 0;
report.importsRewritten = 0;

for (const file of files) {
  let changed = false;

  for (const ref of file.getDescendantsOfKind(SyntaxKind.TypeReference)) {
    if (ref.wasForgotten()) continue;
    const text = ref.getText();
    if (text !== 'Database.Database' && text !== 'BetterSqlite3.Database') continue;
    ref.replaceWithText('Db');
    report.typesRetyped++;
    changed = true;
  }

  if (!changed) continue;

  // Drop the driver import only when nothing else in the file still needs it: schema.ts
  // and its neighbours legitimately keep using the concrete driver for PRAGMA and
  // introspection, which the Db interface deliberately does not expose.
  const sqliteImport = file.getImportDeclaration((d) => d.getModuleSpecifierValue() === 'better-sqlite3');
  if (sqliteImport) {
    const stillUsedAsType = file.getDescendantsOfKind(SyntaxKind.TypeReference)
      .some((r) => !r.wasForgotten() && /^Database\./.test(r.getText()));
    const usedAsValue = file.getDescendantsOfKind(SyntaxKind.NewExpression)
      .some((n) => !n.wasForgotten() && n.getExpression().getText() === 'Database');
    if (!stillUsedAsType && !usedAsValue) {
      sqliteImport.remove();
      report.importsRewritten++;
    }
  }

  const adapterPath = path.relative(
    path.dirname(file.getFilePath()),
    path.resolve('api/src/db/adapter/types')
  );
  const spec = adapterPath.startsWith('.') ? adapterPath : `./${adapterPath}`;
  if (!file.getImportDeclaration((d) => d.getModuleSpecifierValue() === spec)) {
    file.addImportDeclaration({ moduleSpecifier: spec, namedImports: [{ name: 'Db', isTypeOnly: true }] });
  }
  report.filesChanged.add(rel(file));
}

// ---- pass 1c: wrap declared return types in Promise<> --------------------------------
// Marking a function async does not change its ANNOTATION, and TypeScript rejects an
// async function whose declared return type is not a Promise (TS1064). Every function the
// earlier passes made async therefore needs its annotation lifted. Functions with no
// annotation are left alone: inference already produces the right Promise type.
report.returnTypesWrapped = 0;

function wrapReturnTypes(file) {
  let changed = false;
  const fns = [
    ...file.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...file.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...file.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...file.getDescendantsOfKind(SyntaxKind.FunctionExpression),
  ];
  for (const fn of fns) {
    if (fn.wasForgotten() || !fn.isAsync?.()) continue;
    const ret = fn.getReturnTypeNode?.();
    if (!ret) continue;
    const text = ret.getText();
    if (/^Promise\s*</.test(text)) continue;
    // A type predicate ("x is Foo") cannot be wrapped; an async guard is not expressible.
    if (Node.isTypePredicate(ret)) {
      report.skippedUnasyncable.push(`${rel(file)}:${fn.getStartLineNumber()} (type predicate)`);
      continue;
    }
    ret.replaceWithText(`Promise<${text}>`);
    report.returnTypesWrapped++;
    changed = true;
  }
  return changed;
}

for (const file of allFiles) {
  if (wrapReturnTypes(file)) report.filesChanged.add(rel(file));
}

// ---- pass 2: propagate async to callers, to a fixpoint --------------------------------
// A function that became async returns a Promise, so every call to it must be awaited and
// every function containing such a call must itself become async. Repeat until stable.
function propagate() {
  let iterations = 0;
  for (;;) {
    iterations++;
    let changedAny = false;

    for (const file of allFiles) {
      for (const fn of [
        ...file.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
        ...file.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ]) {
        if (fn.wasForgotten() || !fn.isAsync()) continue;
        const nameNode = fn.getNameNode?.();
        if (!nameNode) continue;

        let refs;
        try { refs = nameNode.findReferencesAsNodes(); } catch { continue; }

        for (const ref of refs) {
          if (ref.wasForgotten()) continue;
          const parent = ref.getParent();
          if (!parent || !Node.isCallExpression(parent)) continue;
          if (parent.getExpression() !== ref && !(Node.isPropertyAccessExpression(parent.getExpression()) &&
              parent.getExpression().getNameNode() === ref)) continue;
          if (Node.isAwaitExpression(parent.getParent())) continue;

          const callerFn = enclosingFunction(parent);
          if (!callerFn || isUnasyncable(callerFn)) continue;

          // `void fn()` and `.then(...)` are deliberate fire-and-forget; leave them.
          const gp = parent.getParent();
          if (gp && Node.isVoidExpression(gp)) continue;
          if (gp && Node.isPropertyAccessExpression(gp) &&
              ['then', 'catch', 'finally'].includes(gp.getName())) continue;

          parent.replaceWithText(
            needsParens(parent) ? `(await ${parent.getText()})` : `await ${parent.getText()}`
          );
          report.awaitsAdded++;
          if (!callerFn.isAsync()) { report.functionsMadeAsync++; }
          callerFn.setIsAsync(true);
          report.filesChanged.add(rel(callerFn.getSourceFile()));
          changedAny = true;
        }
      }
    }

    if (!changedAny) return iterations;
    if (iterations > 12) {
      console.error('[codemod] propagation did not converge in 12 iterations; stopping');
      return iterations;
    }
  }
}

const iterations = propagate();

// Propagation made further functions async, so their annotations need the same lift.
for (const file of allFiles) {
  if (wrapReturnTypes(file)) report.filesChanged.add(rel(file));
}

if (!dryRun) project.saveSync();

console.log(`${dryRun ? 'WOULD REWRITE' : 'REWROTE'}: ${report.rewritten} call site(s)`);
for (const [k, v] of Object.entries(report.byKind).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(8)} ${v}`);
}
console.log(`functions made async : ${report.functionsMadeAsync}`);
console.log(`awaits added to calls: ${report.awaitsAdded}   (propagation converged in ${iterations} pass(es))`);
console.log(`return types wrapped : ${report.returnTypesWrapped}   (T -> Promise<T>)`);
console.log(`handle types retyped : ${report.typesRetyped}   (Database.Database -> Db)`);
console.log(`driver imports removed: ${report.importsRewritten}`);
console.log(`files changed        : ${report.filesChanged.size}`);
console.log('');
console.log(`SKIPPED, needs manual work:`);
console.log(`  dynamic SQL        : ${report.skippedDynamicSql.length}`);
for (const s of report.skippedDynamicSql.slice(0, 10)) console.log(`      ${s}`);
if (report.skippedDynamicSql.length > 10) console.log(`      ... and ${report.skippedDynamicSql.length - 10} more`);
console.log(`  no enclosing fn    : ${report.skippedNoFunction.length}`);
for (const s of report.skippedNoFunction) console.log(`      ${s}`);
console.log(`  cannot be async    : ${report.skippedUnasyncable.length}`);
for (const s of report.skippedUnasyncable.slice(0, 10)) console.log(`      ${s}`);
