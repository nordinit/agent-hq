import path from 'path';
import {
  Node,
  Project,
  SourceFile,
  SyntaxKind,
  type CallExpression,
  type Node as MorphNode,
} from 'ts-morph';

const OPENCLAW_SQLITE_INTEGRATION = 'src/lib/openclawOAuthProfiles.ts';
const LINTER_SOURCE = 'src/tooling/sqlPortabilityLint.ts';
const POLICY_SEED_ALLOWED_SOURCES = new Set([
  'src/lib/defaultInstallPackage.ts',
  'src/lib/starterTemplates.ts',
]);
const SQL_DEBT_EXEMPTIONS = new Map<string, ReadonlySet<string>>([
  // The runner owns only its migration ledger. Migration files own every application table.
  ['src/db/pg/migrationRunner.ts', new Set(['runtime schema DDL'])],
]);

type DebtPattern = {
  construct: string;
  detail: string;
  pattern: RegExp;
  sqlOnly?: boolean;
};

const DEBT_PATTERNS: DebtPattern[] = [
  { construct: 'datetime()', detail: 'Use canonical PostgreSQL timestamp expressions or compare canonical text directly.', pattern: /\bdatetime\s*\(/gi },
  { construct: 'CURRENT_TIMESTAMP', detail: 'Use the canonical UTC text expression so writes retain YYYY-MM-DD HH24:MI:SS.', pattern: /\bCURRENT_TIMESTAMP\b/gi },
  { construct: 'GROUP_CONCAT', detail: 'Use string_agg with an explicit text separator.', pattern: /\bGROUP_CONCAT\s*\(/gi },
  { construct: 'IFNULL', detail: 'Use COALESCE.', pattern: /\bIFNULL\s*\(/gi },
  { construct: 'INSTR', detail: 'Use strpos.', pattern: /\bINSTR\s*\(/gi },
  { construct: 'AUTOINCREMENT', detail: 'Identity ownership belongs in PostgreSQL migrations.', pattern: /\bAUTOINCREMENT\b/gi },
  { construct: 'rowid', detail: 'Use the declared primary key.', pattern: /\browid\b/gi },
  { construct: 'strftime()', detail: 'Use EXTRACT(EPOCH ...) or to_char with PostgreSQL format tokens.', pattern: /\bstrftime\s*\(/gi },
  { construct: 'julianday()', detail: 'Use direct timestamp subtraction and EXTRACT(EPOCH ...).', pattern: /\bjulianday\s*\(/gi },
  { construct: 'json_set()', detail: 'Use jsonb_set with a PostgreSQL text[] path.', pattern: /\bjson_set\s*\(/gi },
  { construct: 'json_extract()', detail: 'Use jsonb_extract_path_text and bind bare path keys.', pattern: /\bjson_extract\s*\(/gi },
  { construct: 'INSERT OR IGNORE', detail: 'Use INSERT ... ON CONFLICT DO NOTHING.', pattern: /\bINSERT\s+OR\s+IGNORE\b/gi },
  { construct: 'INSERT OR REPLACE', detail: 'Use ON CONFLICT with an explicit conflict target and update list.', pattern: /\bINSERT\s+OR\s+REPLACE\b/gi },
  { construct: 'PRAGMA', detail: 'Use information_schema or pg_catalog introspection.', pattern: /\bPRAGMA\b/gi },
  { construct: 'sqlite_master', detail: 'Use PostgreSQL catalog introspection.', pattern: /\bsqlite_master\b/gi },
  { construct: 'IS ? / IS NOT ?', detail: 'Use IS [NOT] DISTINCT FROM for null-safe parameter comparison.', pattern: /\bIS\s+(?:NOT\s+)?\?(?!\s*DISTINCT)/gi },
  { construct: '? IS NULL', detail: 'Cast a parameter used only for nullness (for example ?::text IS NULL).', pattern: /\?(?!\s*::[A-Za-z_][A-Za-z0-9_]*)\s+IS\s+(?:NOT\s+)?NULL\b/gi },
  { construct: 'runtime schema DDL', detail: 'Tables, columns, and indexes are owned exclusively by db/pg-migrations.', pattern: /\b(?:CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)|ALTER\s+(?:TABLE|INDEX)|DROP\s+(?:TABLE|INDEX))\b/gi, sqlOnly: true },
  { construct: 'unquoted mixed-case alias', detail: 'Quote mixed-case aliases so PostgreSQL does not fold the result key.', pattern: /\bAS\s+([a-z_][a-z0-9_]*[A-Z][A-Za-z0-9_]*)\b/g, sqlOnly: true },
];

export interface SqlPortabilityFinding {
  file: string;
  line: number;
  construct: string;
  detail: string;
}

function normalizedRelativePath(apiRoot: string, sourceFile: SourceFile): string {
  return path.relative(apiRoot, sourceFile.getFilePath()).split(path.sep).join('/');
}

function isSqlitePrepareCall(call: CallExpression): boolean {
  const expression = call.getExpression();
  return Node.isPropertyAccessExpression(expression) && expression.getName() === 'prepare';
}

function isWithinSqlitePrepare(node: MorphNode): boolean {
  return node.getAncestors().some((ancestor) => Node.isCallExpression(ancestor) && isSqlitePrepareCall(ancestor));
}

function isWithinExplicitDefaultProjectRoute(node: MorphNode): boolean {
  return node.getAncestors().some((ancestor) => {
    if (!Node.isCallExpression(ancestor)) return false;
    const routeExpression = ancestor.getExpression();
    if (
      !Node.isPropertyAccessExpression(routeExpression)
      || routeExpression.getExpression().getText() !== 'router'
      || routeExpression.getName() !== 'put'
    ) {
      return false;
    }
    const routePath = ancestor.getArguments()[0];
    return Node.isStringLiteral(routePath) && routePath.getLiteralValue() === '/:id/default';
  });
}

function sqlLiteralText(node: MorphNode): string | null {
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  if (!Node.isTemplateExpression(node)) return null;

  let text = node.getHead().getLiteralText();
  node.getTemplateSpans().forEach((span, index) => {
    text += `__AGENT_HQ_EXPRESSION_${index}__${span.getLiteral().getLiteralText()}`;
  });
  return text;
}

function literalMask(sql: string): boolean[] {
  const mask = new Array<boolean>(sql.length).fill(false);
  const mark = (start: number, end: number) => {
    for (let index = start; index < end && index < sql.length; index++) mask[index] = true;
  };

  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    if (char === "'" || char === '"') {
      const quote = char;
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) { end += 2; continue; }
          end++;
          break;
        }
        end++;
      }
      mark(index, end);
      index = end;
      continue;
    }
    if (char === '-' && sql[index + 1] === '-') {
      const newline = sql.indexOf('\n', index);
      const end = newline === -1 ? sql.length : newline;
      mark(index, end);
      index = end;
      continue;
    }
    if (char === '/' && sql[index + 1] === '*') {
      const close = sql.indexOf('*/', index + 2);
      const end = close === -1 ? sql.length : close + 2;
      mark(index, end);
      index = end;
      continue;
    }
    if (char === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(index));
      if (tag) {
        const close = sql.indexOf(tag[0], index + tag[0].length);
        const end = close === -1 ? sql.length : close + tag[0].length;
        mark(index, end);
        index = end;
        continue;
      }
    }
    index++;
  }
  return mask;
}

function looksLikeSql(text: string): boolean {
  return /\b(?:SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP|FROM|WHERE|JOIN|VALUES|SET)\b/i.test(text);
}

function codeMatches(text: string, pattern: RegExp): number[] {
  const mask = literalMask(text);
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  const indexes: number[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0] === '') { regex.lastIndex++; continue; }
    if (!mask[match.index]) indexes.push(match.index);
  }
  return indexes;
}

function twoArgumentRoundIndexes(text: string): number[] {
  const mask = literalMask(text);
  const indexes: number[] = [];
  const opener = /\bround\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(text)) !== null) {
    if (mask[match.index]) continue;
    let depth = 0;
    const argumentStart = match.index + match[0].length;
    const commas: number[] = [];
    let cursor = argumentStart - 1;
    for (; cursor < text.length; cursor++) {
      if (mask[cursor]) continue;
      if (text[cursor] === '(') depth++;
      else if (text[cursor] === ')') {
        depth--;
        if (depth === 0) break;
      } else if (text[cursor] === ',' && depth === 1) {
        commas.push(cursor);
      }
    }
    if (cursor >= text.length || commas.length !== 1) continue;
    const firstArgument = text.slice(argumentStart, commas[0]).trim();
    const isAlreadyNumeric = (
      /::\s*numeric\s*$/i.test(firstArgument)
      || /^[-+]?\d+(?:\.\d+)?$/.test(firstArgument)
      || /^CAST\s*\([\s\S]+\s+AS\s+numeric\s*\)$/i.test(firstArgument)
    );
    if (!isAlreadyNumeric) indexes.push(match.index);
    opener.lastIndex = cursor + 1;
  }
  return indexes;
}

function lineForMatch(node: MorphNode, text: string, index: number): number {
  return node.getStartLineNumber() + text.slice(0, index).split('\n').length - 1;
}

export function analyzeSqlPortabilitySourceFile(sourceFile: SourceFile, apiRoot: string): SqlPortabilityFinding[] {
  const relativeFile = normalizedRelativePath(apiRoot, sourceFile);
  if (
    relativeFile === LINTER_SOURCE
    || /\.(?:test|spec)\.ts$/.test(relativeFile)
  ) {
    return [];
  }

  const findings: SqlPortabilityFinding[] = [];
  const isExternalSqliteIntegration = relativeFile === OPENCLAW_SQLITE_INTEGRATION;
  const add = (line: number, construct: string, detail: string) => {
    findings.push({ file: relativeFile, line, construct, detail });
  };

  for (const importDeclaration of sourceFile.getImportDeclarations()) {
    if (importDeclaration.getModuleSpecifierValue() === 'better-sqlite3' && !isExternalSqliteIntegration) {
      add(
        importDeclaration.getStartLineNumber(),
        'better-sqlite3 import',
        `Only ${OPENCLAW_SQLITE_INTEGRATION} may access OpenClaw's external SQLite auth store.`,
      );
    }
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    if (
      Node.isIdentifier(expression)
      && ['seedSprintTaskPolicy', 'seedSprintTypeTaskStatuses'].includes(expression.getText())
      && !POLICY_SEED_ALLOWED_SOURCES.has(relativeFile)
    ) {
      add(
        call.getStartLineNumber(),
        'implicit workflow policy seeding',
        'Starter policy may be installed only by explicit install or template-application paths; ordinary config operations must never recreate deleted rows.',
      );
    }
    if (
      Node.isIdentifier(expression)
      && expression.getText() === 'setDefaultProjectId'
      && (
        relativeFile !== 'src/routes/projects.ts'
        || !isWithinExplicitDefaultProjectRoute(call)
      )
    ) {
      add(
        call.getStartLineNumber(),
        'implicit default-project write',
        'default_project_id may be persisted only by PUT /projects/:id/default; reads and unrelated project operations must remain read-only.',
      );
    }
    if (isSqlitePrepareCall(call) && !isExternalSqliteIntegration) {
      add(
        call.getStartLineNumber(),
        'raw .prepare()',
        `Use the async Db adapter; only ${OPENCLAW_SQLITE_INTEGRATION} may use the external SQLite driver.`,
      );
    }
    const moduleSpecifier = call.getArguments()[0];
    if (
      Node.isIdentifier(expression)
      && expression.getText() === 'require'
      && Node.isStringLiteral(moduleSpecifier)
      && moduleSpecifier.getLiteralValue() === 'better-sqlite3'
      && !isExternalSqliteIntegration
    ) {
      add(
        call.getStartLineNumber(),
        'better-sqlite3 import',
        `Only ${OPENCLAW_SQLITE_INTEGRATION} may access OpenClaw's external SQLite auth store.`,
      );
    }
  }

  // Production src/db modules are application code too. Keep exemptions construct-specific so a
  // legitimate ledger CREATE TABLE cannot mask SQLite syntax elsewhere in the same source file.
  const exemptConstructs = SQL_DEBT_EXEMPTIONS.get(relativeFile) ?? new Set<string>();
  const literalNodes = sourceFile.getDescendants().filter((node) => (
    Node.isStringLiteral(node)
    || Node.isNoSubstitutionTemplateLiteral(node)
    || Node.isTemplateExpression(node)
  ));
  for (const node of literalNodes) {
    if (isExternalSqliteIntegration && isWithinSqlitePrepare(node)) continue;
    const text = sqlLiteralText(node);
    if (text === null) continue;
    const sqlLike = looksLikeSql(text);
    for (const debt of DEBT_PATTERNS) {
      if (exemptConstructs.has(debt.construct)) continue;
      if (debt.sqlOnly && !sqlLike) continue;
      for (const index of codeMatches(text, debt.pattern)) {
        add(lineForMatch(node, text, index), debt.construct, debt.detail);
      }
    }
    if (sqlLike) {
      for (const index of twoArgumentRoundIndexes(text)) {
        add(
          lineForMatch(node, text, index),
          'round(expr, precision) without numeric cast',
          'PostgreSQL only defines two-argument round for numeric; cast the first argument to numeric.',
        );
      }
    }
  }

  return findings.filter((finding, index) => findings.findIndex((candidate) => (
    candidate.file === finding.file
    && candidate.line === finding.line
    && candidate.construct === finding.construct
  )) === index);
}

export function runSqlPortabilityLint(apiRoot = path.resolve(__dirname, '../..')): SqlPortabilityFinding[] {
  const project = new Project({
    tsConfigFilePath: path.join(apiRoot, 'tsconfig.json'),
    skipFileDependencyResolution: true,
  });
  return project.getSourceFiles()
    .flatMap((sourceFile) => analyzeSqlPortabilitySourceFile(sourceFile, apiRoot))
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.construct.localeCompare(right.construct));
}

function main(): void {
  const findings = runSqlPortabilityLint();
  if (findings.length === 0) {
    process.stdout.write('SQL portability lint passed.\n');
    return;
  }
  for (const finding of findings) {
    process.stderr.write(`${finding.file}:${finding.line} [${finding.construct}] ${finding.detail}\n`);
  }
  process.stderr.write(`SQL portability lint failed with ${findings.length} finding(s).\n`);
  process.exitCode = 1;
}

if (require.main === module) main();
