#!/usr/bin/env node
/**
 * Applies targeted fixes at the exact locations the TypeScript compiler reports.
 *
 * Driving the edit from the compiler's own diagnostics rather than from a text search is
 * what makes these rewrites safe. `.lastInsertRowid` is CORRECT on a raw better-sqlite3
 * result and WRONG on the adapter's RunResult, and both still exist in the codebase —
 * db/schema.ts deliberately keeps the raw driver. A blanket find-and-replace cannot tell
 * them apart; the type checker already has.
 *
 * Usage: node scripts/pg/fix-from-tsc.mjs <tsc-log> [--dry-run]
 */
import fs from 'fs';
import path from 'path';

const [, , LOG, ...flags] = process.argv;
if (!LOG) {
  console.error('usage: fix-from-tsc.mjs <tsc-log> [--dry-run]');
  process.exit(1);
}
const dryRun = flags.includes('--dry-run');

/**
 * Each rule matches a diagnostic and edits the reported line.
 * `apply` receives the line text and returns the replacement, or null to skip.
 */
const RULES = [
  {
    name: 'lastInsertRowid -> lastInsertId',
    match: /Property 'lastInsertRowid' does not exist on type 'RunResult'/,
    apply: (line) => line.includes('lastInsertRowid')
      ? line.replace(/\.lastInsertRowid\b/g, '.lastInsertId')
      : null,
  },
  {
    name: 'changes on RunResult is already correct',
    match: /Property 'changes' does not exist on type 'RunResult'/,
    apply: () => null,
  },
];

const log = fs.readFileSync(LOG, 'utf8').split('\n');
const edits = new Map(); // file -> Map(lineNo -> newText)
const counts = {};
let unmatched = 0;

for (const entry of log) {
  const m = /^(.+?)\((\d+),(\d+)\): (error TS\d+: .*)$/.exec(entry);
  if (!m) continue;
  const [, file, lineNo, , message] = m;

  const rule = RULES.find((r) => r.match.test(message));
  if (!rule) { unmatched++; continue; }

  const abs = path.resolve('api', file);
  if (!fs.existsSync(abs)) continue;

  if (!edits.has(abs)) edits.set(abs, new Map());
  const fileEdits = edits.get(abs);
  const idx = Number(lineNo) - 1;
  if (fileEdits.has(idx)) continue;

  const lines = fs.readFileSync(abs, 'utf8').split('\n');
  const replaced = rule.apply(lines[idx]);
  if (replaced === null || replaced === lines[idx]) continue;

  fileEdits.set(idx, replaced);
  counts[rule.name] = (counts[rule.name] ?? 0) + 1;
}

let filesChanged = 0;
for (const [file, fileEdits] of edits) {
  if (!fileEdits.size) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const [idx, text] of fileEdits) lines[idx] = text;
  if (!dryRun) fs.writeFileSync(file, lines.join('\n'));
  filesChanged++;
}

console.log(`${dryRun ? 'WOULD APPLY' : 'APPLIED'}:`);
for (const [name, n] of Object.entries(counts)) console.log(`  ${String(n).padStart(5)}  ${name}`);
console.log(`files changed: ${filesChanged}`);
console.log(`diagnostics with no rule: ${unmatched}`);
