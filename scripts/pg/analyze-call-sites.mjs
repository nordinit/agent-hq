#!/usr/bin/env node
/**
 * Surveys the better-sqlite3 call sites before converting them.
 *
 * The conversion's real cost is not the call sites themselves — those are mechanical —
 * but the async propagation they trigger: every function containing one becomes async,
 * which forces every CALLER to await, transitively, up to the route handlers. Knowing how
 * regular the sites are, and how deep the call graph runs, decides whether a codemod is
 * viable or whether the work has to be staged by module.
 *
 * Usage: node scripts/pg/analyze-call-sites.mjs
 */
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind } = require(path.resolve('api/node_modules/ts-morph'));

const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const files = project.getSourceFiles().filter((f) => !f.getFilePath().includes('/node_modules/'));

const TERMINALS = new Set(['get', 'all', 'run', 'pluck', 'iterate']);

const stats = {
  files: files.length,
  prepareChains: 0,
  byTerminal: {},
  pluckChains: 0,
  execCalls: 0,
  transactionCalls: 0,
  /** prepare() whose SQL is not a single literal — these cannot be rewritten blindly. */
  dynamicSql: 0,
  /** Chains where the result is used inline, e.g. as a call argument. */
  inlineUsage: 0,
  containingFunctions: new Set(),
  alreadyAsync: 0,
  /** Sites at top level of a module, with no enclosing function to make async. */
  topLevel: 0,
  filesTouched: new Set(),
};

for (const file of files) {
  const filePath = file.getFilePath().replace(`${path.resolve('.')}/`, '');

  for (const call of file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();

    if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
      const name = expr.getName();

      if (name === 'exec') { stats.execCalls++; continue; }
      if (name === 'transaction') { stats.transactionCalls++; continue; }

      if (!TERMINALS.has(name)) continue;

      // Walk back down the chain looking for .prepare(...)
      let cursor = expr.getExpression();
      let sawPrepare = false;
      let sawPluck = false;
      let prepareCall = null;
      while (cursor) {
        if (cursor.getKind() === SyntaxKind.CallExpression) {
          const inner = cursor.getExpression();
          if (inner.getKind() === SyntaxKind.PropertyAccessExpression) {
            const innerName = inner.getName();
            if (innerName === 'prepare') { sawPrepare = true; prepareCall = cursor; break; }
            if (innerName === 'pluck') { sawPluck = true; cursor = inner.getExpression(); continue; }
          }
          cursor = inner;
          continue;
        }
        if (cursor.getKind() === SyntaxKind.PropertyAccessExpression) {
          cursor = cursor.getExpression();
          continue;
        }
        break;
      }
      if (!sawPrepare) continue;

      stats.prepareChains++;
      stats.byTerminal[name] = (stats.byTerminal[name] ?? 0) + 1;
      if (sawPluck) stats.pluckChains++;
      stats.filesTouched.add(filePath);

      // Is the SQL a single literal?
      const sqlArg = prepareCall.getArguments()[0];
      const isLiteral = sqlArg && (
        sqlArg.getKind() === SyntaxKind.StringLiteral ||
        sqlArg.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral ||
        sqlArg.getKind() === SyntaxKind.TemplateExpression
      );
      if (!isLiteral) stats.dynamicSql++;

      // Enclosing function, if any.
      const fn = call.getFirstAncestor((a) =>
        a.getKind() === SyntaxKind.FunctionDeclaration ||
        a.getKind() === SyntaxKind.MethodDeclaration ||
        a.getKind() === SyntaxKind.ArrowFunction ||
        a.getKind() === SyntaxKind.FunctionExpression);
      if (!fn) { stats.topLevel++; }
      else {
        const nameNode = fn.getKind() === SyntaxKind.FunctionDeclaration || fn.getKind() === SyntaxKind.MethodDeclaration
          ? fn.getName?.() : undefined;
        stats.containingFunctions.add(`${filePath}#${nameNode ?? fn.getStartLineNumber()}`);
        if (fn.isAsync?.()) stats.alreadyAsync++;
      }

      // Result used inline (as an argument, in a binary expression, member access...)?
      const parent = call.getParent();
      if (parent && parent.getKind() !== SyntaxKind.VariableDeclaration &&
          parent.getKind() !== SyntaxKind.ExpressionStatement) {
        stats.inlineUsage++;
      }
    }
  }
}

console.log(`source files scanned      ${stats.files}`);
console.log(`files with query sites    ${stats.filesTouched.size}`);
console.log(`prepare(...) chains       ${stats.prepareChains}`);
for (const [k, v] of Object.entries(stats.byTerminal).sort((a, b) => b[1] - a[1])) {
  console.log(`  .${k.padEnd(10)}            ${v}`);
}
console.log(`  of which .pluck()       ${stats.pluckChains}`);
console.log(`db.exec(...) calls        ${stats.execCalls}`);
console.log(`db.transaction(...) calls ${stats.transactionCalls}`);
console.log('');
console.log(`SQL not a plain literal   ${stats.dynamicSql}   <- cannot be rewritten blindly`);
console.log(`result used inline        ${stats.inlineUsage}   <- needs parenthesised await`);
console.log(`distinct enclosing fns    ${stats.containingFunctions.size}   <- become async, forcing callers to await`);
console.log(`  already async           ${stats.alreadyAsync}`);
console.log(`sites at module top level ${stats.topLevel}   <- no enclosing function; needs restructuring`);
