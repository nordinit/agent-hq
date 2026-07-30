#!/usr/bin/env node
/**
 * Fixes the residue the async conversion left behind, using the compiler's own
 * diagnostics to locate each site precisely.
 *
 * Three classes, each with a single correct mechanical fix:
 *
 *   A. "Property 'x' does not exist on type 'Promise<T>'"
 *      A call to a now-async function was never awaited, and the result is being used as
 *      if it were the value. Insert the await.
 *
 *   B. "Type 'T' is not assignable to type 'Promise<T>'"
 *      A function's declared return type was lifted to Promise<T> but the function itself
 *      was never marked async — so its `return value` no longer typechecks. Mark it async.
 *      (The reverse fix, unwrapping the return type, would be wrong: the function's body
 *      contains awaits, which is why the type was lifted.)
 *
 *   C. "Argument of type 'Database' is not assignable to parameter of type 'Db'"
 *      Raw-driver code calling a converted function. Wrap the argument in an adapter.
 *
 * Driving this from diagnostics rather than pattern-matching source matters: a missing
 * await is invisible in the text — it looks like perfectly ordinary code — and is only
 * identifiable by what the type checker knows about the callee.
 *
 * Usage: node scripts/pg/fix-async-residue.mjs [--dry-run] [--max-passes=N]
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind, Node } = require(path.resolve('api/node_modules/ts-morph'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const maxPasses = Number(args.find((a) => a.startsWith('--max-passes='))?.split('=')[1] ?? 6);

const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const repoRoot = path.resolve('.');
const rel = (f) => f.getFilePath().replace(`${repoRoot}/`, '');

const totals = { awaitsAdded: 0, markedAsync: 0, adaptersWrapped: 0, passes: 0 };

function enclosingFunction(node) {
  return node.getFirstAncestor((a) =>
    Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) ||
    Node.isArrowFunction(a) || Node.isFunctionExpression(a));
}

function needsParens(node) {
  const parent = node.getParent();
  if (!parent) return false;
  return Node.isPropertyAccessExpression(parent) ||
         Node.isElementAccessExpression(parent) ||
         Node.isNonNullExpression(parent) ||
         (Node.isCallExpression(parent) && parent.getExpression() === node);
}

/** Walks out to the outermost call/identifier chain that produced the Promise. */
function promiseProducingExpression(node) {
  let cur = node;
  while (cur) {
    const parent = cur.getParent();
    if (parent && Node.isPropertyAccessExpression(parent) && parent.getExpression() === cur) return cur;
    if (parent && Node.isCallExpression(parent) && parent.getExpression() === cur) { cur = parent; continue; }
    return cur;
  }
  return node;
}

for (let pass = 1; pass <= maxPasses; pass++) {
  totals.passes = pass;
  const diagnostics = project.getPreEmitDiagnostics();
  let changed = 0;

  // Group by file so edits within a file can be applied back-to-front, keeping positions
  // valid; ts-morph invalidates nodes after each structural edit.
  const byFile = new Map();
  for (const d of diagnostics) {
    const file = d.getSourceFile();
    if (!file) continue;
    if (file.getFilePath().includes('/node_modules/')) continue;
    const message = typeof d.getMessageText() === 'string'
      ? d.getMessageText()
      : d.getMessageText().getMessageText();
    const start = d.getStart();
    if (start === undefined) continue;

    let kind = null;
    if (/Property '.*' does not exist on type 'Promise</.test(message)) kind = 'await';
    else if (/is not assignable to type 'Promise</.test(message)) kind = 'async';
    else if (/Argument of type 'Database' is not assignable to parameter of type 'Db'/.test(message)) kind = 'adapter';
    if (!kind) continue;

    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push({ kind, start, message });
  }

  for (const [file, items] of byFile) {
    items.sort((a, b) => b.start - a.start);
    for (const item of items) {
      const node = file.getDescendantAtPos(item.start);
      if (!node || node.wasForgotten()) continue;

      if (item.kind === 'await') {
        // The diagnostic points at the PROPERTY name; the await belongs on the expression
        // that produced the Promise, one level out.
        const access = node.getFirstAncestorByKind(SyntaxKind.PropertyAccessExpression);
        const target = access ? access.getExpression() : promiseProducingExpression(node);
        if (!target || target.wasForgotten()) continue;
        if (Node.isAwaitExpression(target.getParent())) continue;
        const fn = enclosingFunction(target);
        if (!fn) continue;
        const text = target.getText();
        target.replaceWithText(needsParens(target) ? `(await ${text})` : `await ${text}`);
        if (!fn.isAsync?.()) fn.setIsAsync(true);
        totals.awaitsAdded++; changed++;
        continue;
      }

      if (item.kind === 'async') {
        const fn = enclosingFunction(node);
        if (!fn || fn.isAsync?.()) continue;
        fn.setIsAsync(true);
        totals.markedAsync++; changed++;
        continue;
      }

      if (item.kind === 'adapter') {
        // Resolve the actual ARGUMENT node rather than trusting the diagnostic position to
        // land on one. Taking the nearest enclosing Identifier is not safe: for a
        // diagnostic reported inside a declaration it finds the declaration's NAME, and
        // wrapping that produces `let new SqliteAdapter(x) = false`, which is not even
        // parseable. Only an expression that is genuinely an argument of a call is wrapped.
        const call = node.getFirstAncestorByKind(SyntaxKind.CallExpression);
        if (!call || call.wasForgotten()) continue;
        const arg = call.getArguments().find(
          (a) => !a.wasForgotten() && a.getStart() <= item.start && item.start < a.getEnd()
        );
        if (!arg || arg.wasForgotten()) continue;
        const text = arg.getText();
        if (text.startsWith('new SqliteAdapter')) continue;
        arg.replaceWithText(`new SqliteAdapter(${text})`);
        const sf = file;
        const spec = (() => {
          const p = path.relative(path.dirname(sf.getFilePath()), path.resolve('api/src/db/adapter/SqliteAdapter'));
          return p.startsWith('.') ? p : `./${p}`;
        })();
        if (!sf.getImportDeclaration((d) => d.getModuleSpecifierValue() === spec)) {
          sf.addImportDeclaration({ moduleSpecifier: spec, namedImports: ['SqliteAdapter'] });
        }
        totals.adaptersWrapped++; changed++;
        continue;
      }
    }
  }

  console.log(`pass ${pass}: ${changed} fix(es)`);
  if (!changed) break;
  if (!dryRun) project.saveSync();
}

if (!dryRun) project.saveSync();

console.log('');
console.log(`awaits added   : ${totals.awaitsAdded}`);
console.log(`marked async   : ${totals.markedAsync}`);
console.log(`args adapted   : ${totals.adaptersWrapped}`);
console.log(`passes         : ${totals.passes}`);
