#!/usr/bin/env node
/**
 * Finds promises used as booleans.
 *
 * This is the async conversion's most silent defect class. A Promise object is always
 * truthy, so:
 *
 *     if (!isAllowed(db, id)) deny();        // isAllowed became async -> NEVER denies
 *     if (hasRows(db)) skipFallback();       // hasRows became async  -> ALWAYS skips
 *     const x = ready(db) ? a : b;           // ready became async    -> ALWAYS a
 *
 * Every one of these compiles without a single diagnostic, because using an object in a
 * boolean position is legal. grep cannot find them either — the source text is
 * indistinguishable from correct code. The only way to see them is to ask the type checker
 * what the operand's type actually is, in the positions where truthiness is evaluated.
 *
 * One instance of this shipped already: `!this.hasHermesJsonTranscriptRows(...)` made a
 * guard permanently false, so failed Hermes runs silently lost their chat transcript.
 *
 * Reports only. Every hit needs a human decision about whether the condition should await
 * or whether the call belongs somewhere else entirely, so there is deliberately no fix mode.
 *
 * Usage: node scripts/pg/find-promise-conditions.mjs [--include-tests]
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind, Node } = require(path.resolve('api/node_modules/ts-morph'));

const includeTests = process.argv.includes('--include-tests');
const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const repoRoot = path.resolve('.');
const rel = (f) => f.getFilePath().replace(`${repoRoot}/`, '');

function isPromise(node) {
  if (!node || node.wasForgotten?.()) return false;
  // An awaited expression is already resolved; so is a `.then()` chain's own value.
  if (Node.isAwaitExpression(node)) return false;
  let type;
  try { type = node.getType(); } catch { return false; }
  const text = type.getText();
  if (/^Promise</.test(text)) return true;
  return type.getSymbol?.()?.getName?.() === 'Promise';
}

const hits = [];

for (const file of project.getSourceFiles()) {
  const p = file.getFilePath();
  if (p.includes('/node_modules/')) continue;
  if (!includeTests && p.endsWith('.test.ts')) continue;

  const push = (node, position) => {
    hits.push({
      file: rel(file),
      line: node.getStartLineNumber(),
      position,
      code: node.getText().split('\n')[0].trim().slice(0, 95),
    });
  };

  // `!expr`
  for (const unary of file.getDescendantsOfKind(SyntaxKind.PrefixUnaryExpression)) {
    if (unary.getOperatorToken() !== SyntaxKind.ExclamationToken) continue;
    if (isPromise(unary.getOperand())) push(unary, 'negation');
  }

  // `if (expr)` and `while (expr)`
  for (const stmt of file.getDescendantsOfKind(SyntaxKind.IfStatement)) {
    if (isPromise(stmt.getExpression())) push(stmt.getExpression(), 'if-condition');
  }
  for (const stmt of file.getDescendantsOfKind(SyntaxKind.WhileStatement)) {
    if (isPromise(stmt.getExpression())) push(stmt.getExpression(), 'while-condition');
  }

  // `expr ? a : b`
  for (const cond of file.getDescendantsOfKind(SyntaxKind.ConditionalExpression)) {
    if (isPromise(cond.getCondition())) push(cond.getCondition(), 'ternary');
  }

  // `a && b`, `a || b`, `a ?? b` — a promise on either side of a logical operator is
  // being treated as a truth value (or, for ??, as possibly-nullish, which it never is).
  for (const bin of file.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    const op = bin.getOperatorToken().getKind();
    if (op !== SyntaxKind.AmpersandAmpersandToken
      && op !== SyntaxKind.BarBarToken
      && op !== SyntaxKind.QuestionQuestionToken) continue;
    if (isPromise(bin.getLeft())) push(bin.getLeft(), 'logical-operand');
    // The right side of && / || is only a truth value if the whole expression is; skipping
    // it avoids flagging `x && somethingAsync()` where the result is legitimately returned.
    if (op === SyntaxKind.QuestionQuestionToken && isPromise(bin.getRight())) {
      push(bin.getRight(), 'nullish-operand');
    }
  }
}

// ---- async callbacks passed to SYNCHRONOUS array predicates -------------------------
// every/some/filter/find/findIndex/sort all evaluate their callback's return value
// immediately. An async callback returns a Promise, which is always truthy, so:
//   .every(async ...)  -> ALWAYS true
//   .some(async ...)   -> ALWAYS true (if non-empty)
//   .filter(async ...) -> keeps EVERY element
//   .find(async ...)   -> returns the FIRST element
// map/forEach/flatMap are excluded: an async callback there is a normal idiom, usually
// paired with Promise.all.
const SYNC_PREDICATES = new Set(['every', 'some', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'sort']);

for (const file of project.getSourceFiles()) {
  const fp = file.getFilePath();
  if (fp.includes('/node_modules/')) continue;
  if (!includeTests && fp.endsWith('.test.ts')) continue;

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.wasForgotten()) continue;
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    if (!SYNC_PREDICATES.has(callee.getName())) continue;
    const cb = call.getArguments()[0];
    if (!cb) continue;
    const isAsyncCb = (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb)) && cb.isAsync?.();
    if (!isAsyncCb) continue;
    hits.push({
      file: rel(file),
      line: call.getStartLineNumber(),
      position: `async-cb-in-${callee.getName()}`,
      code: call.getText().split('\n')[0].trim().slice(0, 95),
    });
  }
}

hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

console.log(`promises used as booleans: ${hits.length}\n`);
const byPosition = {};
for (const h of hits) byPosition[h.position] = (byPosition[h.position] ?? 0) + 1;
for (const [k, v] of Object.entries(byPosition)) console.log(`  ${k.padEnd(18)} ${v}`);
console.log('');
for (const h of hits) {
  console.log(`  ${h.file}:${h.line}  [${h.position}]`);
  console.log(`      ${h.code}`);
}
if (!hits.length) console.log('  none — every truthiness test operates on a resolved value.');
