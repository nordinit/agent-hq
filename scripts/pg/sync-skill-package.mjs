#!/usr/bin/env node

/** Synchronize supplemental files from one local skill directory into skill_files. */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { Client } = require(path.resolve('api/node_modules/pg'));

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const database = option('database');
const skillName = option('skill');
const sourceDir = option('dir');
const tenantId = Number(option('tenant') ?? '1');

if (!database || !skillName || !sourceDir || !Number.isInteger(tenantId) || tenantId <= 0) {
  console.error('usage: node scripts/pg/sync-skill-package.mjs --database <name-or-url> --tenant <id> --skill <name> --dir <path>');
  process.exit(1);
}

const root = path.resolve(sourceDir);
const utf8 = new TextDecoder('utf-8', { fatal: true });

function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute, relative));
    else if (entry.isFile() && relative !== 'SKILL.md') files.push({ path: relative, absolute });
  }
  return files;
}

const files = listFiles(root).map((file) => {
  try {
    return { path: file.path, content: utf8.decode(fs.readFileSync(file.absolute)) };
  } catch {
    throw new Error(`Skill package file is not valid UTF-8 text: ${file.path}`);
  }
});

const client = new Client(database.includes('://')
  ? { connectionString: database }
  : { database });

try {
  await client.connect();
  await client.query('BEGIN');
  const skill = await client.query(
    'SELECT id FROM skills WHERE tenant_id = $1 AND name = $2 LIMIT 1',
    [tenantId, skillName],
  );
  if (skill.rows.length !== 1) throw new Error(`Tenant ${tenantId} skill not found: ${skillName}`);
  const skillId = Number(skill.rows[0].id);

  for (const file of files) {
    await client.query(`
      INSERT INTO skill_files (tenant_id, skill_id, path, content)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (tenant_id, skill_id, path) DO UPDATE SET
        content = excluded.content,
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    `, [tenantId, skillId, file.path, file.content]);
  }

  if (files.length > 0) {
    await client.query(`
      DELETE FROM skill_files
      WHERE tenant_id = $1 AND skill_id = $2 AND NOT (path = ANY($3::text[]))
    `, [tenantId, skillId, files.map((file) => file.path)]);
  } else {
    await client.query('DELETE FROM skill_files WHERE tenant_id = $1 AND skill_id = $2', [tenantId, skillId]);
  }
  await client.query('COMMIT');

  console.log(JSON.stringify({ ok: true, tenant_id: tenantId, skill: skillName, files: files.length }));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}
