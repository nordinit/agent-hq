#!/usr/bin/env node
/**
 * Converts `expect(async () => ...)` with a SYNCHRONOUS throw matcher into the promise form.
 *
 * `expect(fn).toThrow()` invokes fn synchronously and inspects what it THREW. An async fn
 * never throws synchronously — it returns a promise. So:
 *
 *   expect(async () => await f()).not.toThrow()   passes trivially, and f() runs DETACHED
 *   expect(async () => await f()).toThrow(X)      never matches, whatever f does
 *
 * The first form is the damaging one. The detached call keeps running after the test
 * returns; when teardown closes the connection or the statement violates a constraint, the
 * rejection is unhandled and **kills the jest worker** — which is why five suites reported
 * "Test suite failed to run" with no individual test failure.
 *
 * Done with the AST rather than a regex because most of these span multiple lines: an
 * earlier regex pass caught 11 single-line instances and silently missed 11 multi-line ones.
 *
 * Usage: node scripts/pg/fix-async-throw-matchers.mjs [--dry-run]
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind, Node } = require(path.resolve('api/node_modules/ts-morph'));

const dryRun = process.argv.includes('--dry-run');
const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const repoRoot = path.resolve('.');
const rel = (f) => f.getFilePath().replace(`${repoRoot}/`, '');

let converted = 0;
const touched = new Set();

for (const file of project.getSourceFiles()) {
  if (!file.getFilePath().endsWith('.test.ts')) continue;
  if (file.getFilePath().includes('/node_modules/')) continue;

  // Back to front: each replacement invalidates later positions.
  const calls = file.getDescendantsOfKind(SyntaxKind.CallExpression).reverse();

  for (const call of calls) {
    if (call.wasForgotten()) continue;

    // Match  expect(<async fn>) . [not.] toThrow( ... )
    const matcherAccess = call.getExpression();
    if (!Node.isPropertyAccessExpression(matcherAccess)) continue;
    if (matcherAccess.getName() !== 'toThrow') continue;

    let receiver = matcherAccess.getExpression();
    let negated = false;
    if (Node.isPropertyAccessExpression(receiver) && receiver.getName() === 'not') {
      negated = true;
      receiver = receiver.getExpression();
    }
    if (!Node.isCallExpression(receiver)) continue;
    if (receiver.getExpression().getText() !== 'expect') continue;

    const inner = receiver.getArguments()[0];
    if (!inner) continue;
    const isAsyncFn = (Node.isArrowFunction(inner) || Node.isFunctionExpression(inner)) && inner.isAsync?.();
    if (!isAsyncFn) continue;

    const fnText = inner.getText();
    const matcherArgs = call.getArguments().map((a) => a.getText()).join(', ');

    // not.toThrow  -> just await it; if it rejects, the test fails, which is the intent.
    // toThrow(...) -> assert on the REJECTION.
    const replacement = negated
      ? `await (${fnText})()`
      : `await expect((${fnText})()).rejects.toThrow(${matcherArgs})`;

    call.replaceWithText(replacement);
    converted++;
    touched.add(rel(file));
  }

  // Any it()/test() body that now awaits must be async.
  for (const decl of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (decl.wasForgotten()) continue;
    const name = decl.getExpression().getText();
    if (name !== 'it' && name !== 'test') continue;
    const body = decl.getArguments()[1];
    if (!body || !(Node.isArrowFunction(body) || Node.isFunctionExpression(body))) continue;
    if (body.isAsync?.()) continue;
    if (!/\bawait\b/.test(body.getText())) continue;
    body.setIsAsync(true);
    touched.add(rel(file));
  }
}

if (!dryRun) project.saveSync();

console.log(`${dryRun ? 'would convert' : 'converted'}: ${converted}`);
console.log(`files touched: ${touched.size}`);
for (const f of [...touched].sort()) console.log(`  ${f}`);
