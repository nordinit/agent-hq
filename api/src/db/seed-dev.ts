import '../config/loadRootEnv';
/**
 * seed-dev.ts — Seed the Dev database with representative data.
 *
 * Usage:
 *   DATABASE_URL=postgresql://localhost/agent_hq_dev \
 *   npx tsx src/db/seed-dev.ts
 *
 * This script is safe to re-run — it checks for existing rows before inserting.
 * It operates only on the PostgreSQL database named by DATABASE_URL.
 *
 * The whole script runs inside `main()` rather than at module top level: this file is
 * compiled as CommonJS, where top-level `await` is unavailable, and every database call
 * is now asynchronous.
 */

import os from 'os';
import { closeDb, getDb } from './client';
import type { Db } from './adapter/types';
import { getDefaultTenantId } from '../lib/tenantContext';

const HOME = process.env.HOME ?? os.homedir();
const OPENCLAW_DIR = process.env.WORKSPACE_PARENT ?? `${HOME}/.openclaw`;

async function seedIfEmpty(
  db: Db,
  table: string,
  checkSql: string,
  insertFn: () => Promise<void>,
): Promise<void> {
  const row = await db.get<{ cnt: number }>(checkSql);
  // Coerce defensively because aggregate result parsers may represent bigint as text.
  if (!row || Number(row.cnt) === 0) {
    await insertFn();
    console.log(`[seed-dev] Seeded table: ${table}`);
  } else {
    console.log(`[seed-dev] Skipped (already seeded): ${table}`);
  }
}

// ── Agents ────────────────────────────────────────────────────────────────────
// Pixel claude-code runtime config (task #306 migration)
const pixelRuntimeConfig = JSON.stringify({
  workingDirectory: `${OPENCLAW_DIR}/workspace-agency-frontend`,
  model: 'claude-sonnet-4-6',
  effort: 'high',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch'],
  maxTurns: 150,
  maxBudgetUsd: 5.00,
});

// Forge claude-code runtime config (task #305 migration)
const forgeRuntimeConfig = JSON.stringify({
  workingDirectory: `${OPENCLAW_DIR}/workspace-agency-backend`,
  model: 'claude-sonnet-4-6',
  effort: 'high',
  allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
  maxTurns: 150,
  maxBudgetUsd: 5.00,
});

const devAgents = [
  { name: 'Atlas',          role: 'Built-in assistant — dev session',       session_key: 'agent:atlas:main',            workspace_path: `${OPENCLAW_DIR}/workspace-atlas`,            openclaw_agent_id: 'atlas',           runtime_type: 'openclaw',    runtime_config: null, system_role: 'atlas' },
  { name: 'Forge',          role: 'Senior Backend Engineer — dev session',   session_key: 'agent:agency-backend:main',   workspace_path: `${OPENCLAW_DIR}/workspace-agency-backend`,  openclaw_agent_id: 'agency-backend',  runtime_type: 'claude-code', runtime_config: forgeRuntimeConfig },
  { name: 'Kai',            role: 'Developer Tools Engineer — dev session',  session_key: 'agent:agency-tools:main',     workspace_path: `${OPENCLAW_DIR}/workspace-agency-tools`,    openclaw_agent_id: null,              runtime_type: 'claude-code', runtime_config: forgeRuntimeConfig },
  { name: 'Pixel',          role: 'Senior Frontend Engineer — dev session',  session_key: 'agent:agency-frontend:main',  workspace_path: `${OPENCLAW_DIR}/workspace-agency-frontend`, openclaw_agent_id: null,              runtime_type: 'claude-code', runtime_config: pixelRuntimeConfig },
  { name: 'Harbor (DevOps)',role: 'Release engineer / DevOps — dev session', session_key: 'agent:agency-devops:main',    workspace_path: `${OPENCLAW_DIR}/workspace-agency-devops`,   openclaw_agent_id: null,              runtime_type: 'openclaw',    runtime_config: null },
  { name: 'Vera',           role: 'QA Engineer — dev session',               session_key: 'agent:agency-qa:main',        workspace_path: `${OPENCLAW_DIR}/workspace-agency-qa`,       openclaw_agent_id: 'agency-qa',       runtime_type: 'openclaw',    runtime_config: null },
];

const INSERT_AGENT_SQL = `
  INSERT INTO agents (tenant_id, name, role, session_key, workspace_path, openclaw_agent_id, runtime_type, runtime_config, status, system_role)
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?
  WHERE NOT EXISTS (SELECT 1 FROM agents WHERE session_key = ?)
`;

async function main(): Promise<void> {
  const db = getDb();
  const defaultTenantId = await getDefaultTenantId(db);

  // ── Projects ────────────────────────────────────────────────────────────────
  await seedIfEmpty(
    db,
    'projects',
    `SELECT COUNT(*) AS cnt FROM projects WHERE tenant_id = ${defaultTenantId} AND name IN ('Agency', 'Agent HQ')`,
    async () => {
      await db.run(`
        INSERT INTO projects (tenant_id, name, description, context_md) VALUES
          (?, 'Agency', 'Dev sandbox: General IT agency work bucket', '## Agency (dev)\nDev environment — safe to mutate.'),
          (?, 'Agent HQ', 'Dev sandbox: Agent HQ internal platform project', '## Agent HQ (dev)\nDev environment — safe to mutate.')
      `, defaultTenantId, defaultTenantId);
    }
  );

  // ── Agents ──────────────────────────────────────────────────────────────────
  // Insert missing dev agents by session_key — safe to run multiple times
  let agentsAdded = 0;
  for (const agent of devAgents) {
    const res = await db.run(
      INSERT_AGENT_SQL,
      defaultTenantId,
      agent.name,
      agent.role,
      agent.session_key,
      agent.workspace_path,
      agent.openclaw_agent_id,
      agent.runtime_type,
      agent.runtime_config,
      agent.system_role ?? null,
      agent.session_key,
    );
    await db.run(
      `UPDATE agents SET tenant_id = COALESCE(tenant_id, ?) WHERE session_key = ?`,
      defaultTenantId,
      agent.session_key,
    );
    agentsAdded += Number(res.changes);
  }
  console.log(`[seed-dev] Agents: ${agentsAdded} added (existing skipped).`);

  // ── Sprints ─────────────────────────────────────────────────────────────────
  await seedIfEmpty(
    db,
    'sprints',
    `SELECT COUNT(*) AS cnt FROM sprints WHERE tenant_id = ${defaultTenantId} AND name IN ('Dev Sprint 1', 'Agent HQ Enhancements (dev)')`,
    async () => {
      // We need a project id — get first agency project
      const agencyProject = await db.get<{ id: number }>(`SELECT id FROM projects WHERE tenant_id = ? AND name = 'Agency' LIMIT 1`, defaultTenantId);
      const atlasProject  = await db.get<{ id: number }>(`SELECT id FROM projects WHERE tenant_id = ? AND name = 'Agent HQ' LIMIT 1`, defaultTenantId);

      if (agencyProject) {
        await db.run(`
          INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value) VALUES
            (?, ?, 'Dev Sprint 1', 'Validate dev environment isolation and seed data', 'dev', 'active', 'time', '2w')
        `, defaultTenantId, agencyProject.id);
      }
      if (atlasProject) {
        await db.run(`
          INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value) VALUES
            (?, ?, 'Agent HQ Enhancements (dev)', 'Test Agent HQ feature work in isolation', 'dev', 'active', 'time', '2w')
        `, defaultTenantId, atlasProject.id);
      }
    }
  );

  // ── Job Templates (removed — Task #579) ────────────────────────────────────
  // job_templates table has been dropped. Agent execution config now lives on
  // the agents table via job_instructions, schedule, routing rules, etc.

  // ── Routing: task statuses ──────────────────────────────────────────────────
  // Routing configuration is installation/operator data; this dev fixture does not reconcile it.

  // ── Sample Tasks ────────────────────────────────────────────────────────────
  await seedIfEmpty(
    db,
    'tasks',
    `SELECT COUNT(*) AS cnt FROM tasks WHERE tenant_id = ${defaultTenantId}`,
    async () => {
      const agencyProject = await db.get<{ id: number }>(`SELECT id FROM projects WHERE tenant_id = ? AND name = 'Agency' LIMIT 1`, defaultTenantId);
      const sprint = await db.get<{ id: number }>(`SELECT id FROM sprints WHERE tenant_id = ? AND name = 'Dev Sprint 1' LIMIT 1`, defaultTenantId);
      const forgeAgent = await db.get<{ id: number }>(`SELECT id FROM agents WHERE tenant_id = ? AND session_key = 'agent:agency-backend:main' LIMIT 1`, defaultTenantId);

      if (agencyProject) {
        await db.run(`
          INSERT INTO tasks (tenant_id, title, description, status, priority, project_id, sprint_id, assigned_agent_id) VALUES
            (?, 'Sample dev task — todo', 'A representative task in todo state for dev/test use', 'todo', 'medium', ?, ?, ?),
            (?, 'Sample dev task — in_progress', 'A representative task in in_progress state for dev/test use', 'in_progress', 'high', ?, ?, ?),
            (?, 'Sample dev task — review', 'A representative task in review state for dev/test use', 'review', 'low', ?, ?, ?)
        `, defaultTenantId, agencyProject.id, sprint?.id ?? null, forgeAgent?.id ?? null, defaultTenantId, agencyProject.id, sprint?.id ?? null, forgeAgent?.id ?? null, defaultTenantId, agencyProject.id, sprint?.id ?? null, forgeAgent?.id ?? null);
      }
    }
  );

  console.log('[seed-dev] Done.');
}

void main()
  .catch((err) => {
    console.error('[seed-dev] Failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
