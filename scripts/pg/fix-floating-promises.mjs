#!/usr/bin/env node
/**
 * Finds and fixes discarded promises — calls to async functions whose result is thrown
 * away as a bare expression statement.
 *
 * This is the conversion's most dangerous residue, and the type checker is silent on it:
 * discarding a promise in an expression statement is legal TypeScript. `tsc --noEmit`
 * reports ZERO errors for code that is now badly broken.
 *
 * The failure that motivated this tool:
 *
 *     const pushValue = async (col, val) => { if (!await hasColumn(db, col)) return; ... };
 *     pushValue('tenant_id', tenantId);      // <- not awaited
 *     ...
 *     await db.run(`INSERT INTO logs (${columns.join(', ')}) VALUES (...)`);
 *
 * `columns` is still empty when the INSERT is built, so the statement becomes
 * `INSERT INTO logs () VALUES ()` — a syntax error at runtime, from code that compiles.
 *
 * `void expr` and `.then(...)/.catch(...)` are treated as DELIBERATE fire-and-forget and
 * left alone: that is how the codebase spells "I know, and I mean it".
 *
 * Usage: node scripts/pg/fix-floating-promises.mjs [--dry-run] [--report-only]
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind, Node } = require(path.resolve('api/node_modules/ts-morph'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const reportOnly = args.includes('--report-only');

const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const repoRoot = path.resolve('.');
const rel = (f) => f.getFilePath().replace(`${repoRoot}/`, '');

const found = [];
let fixed = 0;

function isPromiseType(type) {
  const text = type.getText();
  if (/^Promise</.test(text)) return true;
  const symbol = type.getSymbol?.();
  return symbol?.getName?.() === 'Promise';
}

for (const file of project.getSourceFiles()) {
  if (file.getFilePath().includes('/node_modules/')) continue;

  const statements = file.getDescendantsOfKind(SyntaxKind.ExpressionStatement);
  // Back to front, so an edit never invalidates a position still to be visited.
  for (const stmt of statements.slice().reverse()) {
    if (stmt.wasForgotten()) continue;
    const expr = stmt.getExpression();
    if (!expr || expr.wasForgotten()) continue;

    // `void fn()` is the codebase's way of saying deliberate fire-and-forget.
    if (Node.isVoidExpression(expr)) continue;
    if (Node.isAwaitExpression(expr)) continue;
    if (!Node.isCallExpression(expr)) continue;

    // A promise with a handler attached is being managed explicitly.
    const calleeText = expr.getExpression().getText();
    if (/\.(then|catch|finally)$/.test(calleeText)) continue;

    let type;
    try { type = expr.getType(); } catch { continue; }
    if (!isPromiseType(type)) continue;

    const fn = expr.getFirstAncestor((a) =>
      Node.isFunctionDeclaration(a) || Node.isMethodDeclaration(a) ||
      Node.isArrowFunction(a) || Node.isFunctionExpression(a));

    const entry = {
      file: rel(file),
      line: stmt.getStartLineNumber(),
      code: stmt.getText().split('\n')[0].trim().slice(0, 90),
      fixable: Boolean(fn),
    };
    found.push(entry);

    if (reportOnly || !fn) continue;

    expr.replaceWithText(`await ${expr.getText()}`);
    if (!fn.isAsync?.()) fn.setIsAsync(true);
    fixed++;
  }
}

if (!dryRun && !reportOnly) project.saveSync();

console.log(`discarded promises found: ${found.length}`);
console.log(`${dryRun || reportOnly ? 'would fix' : 'fixed'}: ${fixed}`);
const unfixable = found.filter((f) => !f.fixable);
if (unfixable.length) {
  console.log(`\nNOT fixable automatically (no enclosing function to make async): ${unfixable.length}`);
  for (const f of unfixable) console.log(`  ${f.file}:${f.line}  ${f.code}`);
}
console.log('');
for (const f of found.slice(0, 25)) console.log(`  ${f.file}:${f.line}  ${f.code}`);
if (found.length > 25) console.log(`  ... and ${found.length - 25} more`);
