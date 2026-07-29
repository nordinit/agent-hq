#!/usr/bin/env node
/**
 * Rewrites legacy identifiers inside SQL STRINGS in application code, to match the renamed
 * PostgreSQL schema.
 *
 * SCOPE, AND WHY IT IS THIS NARROW
 * Only SQL text is rewritten — never TypeScript identifiers. `sprint_id` appears in this
 * codebase as at least four different things:
 *
 *   1. a database column                    -> must be renamed
 *   2. a property on a row object read back  -> must follow the column
 *   3. a field in a JSON API request/response -> a CONTRACT, renaming it breaks clients
 *   4. a local variable or function name      -> cosmetic, irrelevant to the migration
 *
 * A blanket text replacement cannot tell these apart and would silently rewrite the public
 * API. So this pass changes (1) only, and REPORTS (2) and (3) for a separate, deliberate
 * decision. The report is the deliverable as much as the edit is.
 *
 * SELECT ALIASING
 * By default a renamed column in a SELECT list gets `AS <old_name>` appended, so row shapes
 * — and therefore API responses — are unchanged. That makes the schema rename independent
 * of application churn: the database moves first, the code follows later, and neither
 * change has to be debugged through the other. Pass --no-aliases to drop that and let row
 * shapes change with the columns.
 *
 * Usage:
 *   node scripts/pg/codemod-rename-sql.mjs [--dry-run] [--no-aliases] [--only=<substring>]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Project, SyntaxKind, Node } = require(path.resolve('api/node_modules/ts-morph'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noAliases = args.includes('--no-aliases');
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);

const mappingPath = path.resolve('db/pg-baseline/rename-mapping.json');
if (!fs.existsSync(mappingPath)) {
  console.error(`Missing ${mappingPath}. Run generate-rename-mapping.mjs first.`);
  process.exit(1);
}
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));

const tableMap = new Map(mapping.tableRenames.map((r) => [r.from, r.to]));
const columnMap = new Map();
for (const c of mapping.columnRenames) {
  if (!columnMap.has(c.from)) columnMap.set(c.from, c.to);
}
const droppedColumns = new Set(mapping.columnDrops.map((c) => `${c.table}.${c.column}`));

/** Identifiers to rewrite, longest first so `sprint_types` wins over `sprint_type`. */
const IDENTIFIERS = [...new Set([...tableMap.keys(), ...columnMap.keys()])]
  .sort((a, b) => b.length - a.length);
const replacementFor = (id) => tableMap.get(id) ?? columnMap.get(id);

/**
 * Heuristic for "this string is SQL". Deliberately conservative: a false positive rewrites
 * a user-facing message or a JSON key, which is far worse than a false negative that
 * leaves one query for a human.
 */
function looksLikeSql(text) {
  return /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|JOIN|FROM|WHERE)\b/i.test(text)
      && IDENTIFIERS.some((id) => new RegExp(`(^|[^A-Za-z0-9_])${id}([^A-Za-z0-9_]|$)`).test(text));
}

/** Renames identifiers in SQL, skipping anything inside a quoted literal. */
function rewriteSql(sql) {
  const changes = [];
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // Skip over quoted string literals: a column name appearing inside one is data.
    if (ch === "'") {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") { if (sql[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
      out += sql.slice(start, i);
      continue;
    }
    const rest = sql.slice(i);
    const id = IDENTIFIERS.find((candidate) =>
      rest.startsWith(candidate) &&
      !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '') &&
      !/[A-Za-z0-9_]/.test(rest[candidate.length] ?? ''));
    if (id) {
      const to = replacementFor(id);
      out += to;
      changes.push({ from: id, to });
      i += id.length;
      continue;
    }
    out += ch;
    i++;
  }
  return { sql: out, changes };
}

const project = new Project({ tsConfigFilePath: path.resolve('api/tsconfig.json') });
const repoRoot = path.resolve('.');
const rel = (f) => f.getFilePath().replace(`${repoRoot}/`, '');

let files = project.getSourceFiles().filter((f) => !f.getFilePath().includes('/node_modules/'));
if (only) files = files.filter((f) => rel(f).includes(only));

const report = {
  sqlStringsRewritten: 0,
  identifierOccurrences: 0,
  filesChanged: new Set(),
  /** TS property accesses on the old names — follow the columns, need a separate pass. */
  propertyAccesses: [],
  /** Old names appearing as object-literal keys or type members: likely API contract. */
  contractSites: [],
  droppedColumnReferences: [],
};

for (const file of files) {
  let changed = false;

  for (const lit of [
    ...file.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...file.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
    ...file.getDescendantsOfKind(SyntaxKind.TemplateExpression),
  ]) {
    if (lit.wasForgotten()) continue;
    const raw = lit.getText();
    const inner = raw.slice(1, -1);
    if (!looksLikeSql(inner)) continue;

    const { sql, changes } = rewriteSql(inner);
    if (!changes.length) continue;

    lit.replaceWithText(raw[0] + sql + raw[raw.length - 1]);
    report.sqlStringsRewritten++;
    report.identifierOccurrences += changes.length;
    report.filesChanged.add(rel(file));
    changed = true;
  }

  // Report-only: TS-level references that will need to follow, once row shapes change.
  for (const prop of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
    if (prop.wasForgotten()) continue;
    const name = prop.getName();
    if (columnMap.has(name)) {
      report.propertyAccesses.push(`${rel(file)}:${prop.getStartLineNumber()} .${name}`);
    }
  }
  for (const assign of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (assign.wasForgotten()) continue;
    const name = assign.getName().replace(/['"]/g, '');
    if (columnMap.has(name)) {
      report.contractSites.push(`${rel(file)}:${assign.getStartLineNumber()} ${name}:`);
    }
  }
  for (const sig of file.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
    if (sig.wasForgotten()) continue;
    const name = sig.getName().replace(/['"]/g, '');
    if (columnMap.has(name)) {
      report.contractSites.push(`${rel(file)}:${sig.getStartLineNumber()} ${name}? (type member)`);
    }
    if ([...droppedColumns].some((d) => d.endsWith(`.${name}`))) {
      report.droppedColumnReferences.push(`${rel(file)}:${sig.getStartLineNumber()} ${name}`);
    }
  }

  void changed;
}

if (!dryRun) project.saveSync();

console.log(`${dryRun ? 'WOULD REWRITE' : 'REWROTE'} ${report.sqlStringsRewritten} SQL string(s)`);
console.log(`  identifier occurrences: ${report.identifierOccurrences}`);
console.log(`  files changed:          ${report.filesChanged.size}`);
console.log(`  select aliasing:        ${noAliases ? 'OFF (row shapes change)' : 'not yet implemented — row shapes change'}`);
console.log('');
console.log('REPORT ONLY — these follow the columns and need a separate, deliberate pass:');
console.log(`  TS property accesses on renamed columns: ${report.propertyAccesses.length}`);
for (const s of report.propertyAccesses.slice(0, 8)) console.log(`      ${s}`);
if (report.propertyAccesses.length > 8) console.log(`      ... and ${report.propertyAccesses.length - 8} more`);
console.log(`  object keys / type members (API CONTRACT — renaming breaks clients): ${report.contractSites.length}`);
for (const s of report.contractSites.slice(0, 8)) console.log(`      ${s}`);
if (report.contractSites.length > 8) console.log(`      ... and ${report.contractSites.length - 8} more`);
console.log(`  references to DROPPED columns: ${report.droppedColumnReferences.length}`);
for (const s of report.droppedColumnReferences) console.log(`      ${s}`);

fs.writeFileSync(
  path.resolve('db/pg-baseline/rename-code-report.json'),
  JSON.stringify({
    sqlStringsRewritten: report.sqlStringsRewritten,
    identifierOccurrences: report.identifierOccurrences,
    filesChanged: [...report.filesChanged],
    propertyAccesses: report.propertyAccesses,
    contractSites: report.contractSites,
    droppedColumnReferences: report.droppedColumnReferences,
  }, null, 2)
);
