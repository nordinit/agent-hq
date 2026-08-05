import os from 'os';
import path from 'path';
import { getDb } from '../db/client';
import { type Db } from '../db/adapter/types';

const HOME = process.env.HOME ?? os.homedir();

export const ATLAS_SYSTEM_ROLE = 'atlas';
export const ATLAS_AGENT_NAME = 'Atlas';
export const ATLAS_AGENT_SLUG = 'atlas';
export const ATLAS_SESSION_KEY = 'agent:atlas:main';
export const LEGACY_ATLAS_SESSION_KEY = 'agent:main:main';
export const ATLAS_TELEGRAM_PREFIX = 'agent:atlas:telegram:direct:';
export const LEGACY_ATLAS_TELEGRAM_PREFIX = 'agent:main:telegram:direct:';
export const ATLAS_WORKSPACE_PATH = path.join(HOME, '.openclaw', 'workspace-atlas');
export const LEGACY_MAIN_WORKSPACE_PATH = path.join(HOME, '.openclaw', 'workspace');

export function isAtlasAgentRecord(agent: Record<string, unknown> | null | undefined): boolean {
  if (!agent) return false;
  return agent.system_role === ATLAS_SYSTEM_ROLE
    || agent.openclaw_agent_id === ATLAS_AGENT_SLUG
    || agent.session_key === ATLAS_SESSION_KEY
    || agent.session_key === LEGACY_ATLAS_SESSION_KEY
    || agent.name === ATLAS_AGENT_NAME;
}

export async function getAtlasAgentRecord(): Promise<Record<string, unknown> | null> {
  const db = getDb();
  const row = await db.get(`
    SELECT *
    FROM agents
    WHERE system_role = ?
       OR openclaw_agent_id = ?
       OR session_key = ?
       OR session_key = ?
       OR name = ?
    ORDER BY
      CASE
        WHEN system_role = ? THEN 0
        WHEN openclaw_agent_id = ? THEN 1
        WHEN session_key = ? THEN 2
        WHEN name = ? THEN 3
        WHEN session_key = ? THEN 4
        ELSE 9
      END,
      id ASC
    LIMIT 1
  `, ATLAS_SYSTEM_ROLE, ATLAS_AGENT_SLUG, ATLAS_SESSION_KEY, LEGACY_ATLAS_SESSION_KEY, ATLAS_AGENT_NAME, ATLAS_SYSTEM_ROLE, ATLAS_AGENT_SLUG, ATLAS_SESSION_KEY, ATLAS_AGENT_NAME, LEGACY_ATLAS_SESSION_KEY) as Record<string, unknown> | undefined;

  return row ?? null;
}

export async function resolveAtlasWorkspaceRoot(): Promise<string> {
  const atlas = await getAtlasAgentRecord();
  if (!atlas) return ATLAS_WORKSPACE_PATH;

  if (typeof atlas.workspace_path === 'string' && atlas.workspace_path.trim()) {
    return atlas.workspace_path;
  }

  if (typeof atlas.openclaw_agent_id === 'string' && atlas.openclaw_agent_id.trim()) {
    return path.join(HOME, '.openclaw', `workspace-${atlas.openclaw_agent_id}`);
  }

  return ATLAS_WORKSPACE_PATH;
}

/**
 * Put the default tenant's Atlas onto the canonical session key.
 *
 * The default install package may initially give Atlas an ordinary tenant-shaped session key,
 * such as 'agent:default-default-project:atlas:general-assistant:main'. The explicit installer
 * normalizes that one identity to ATLAS_SESSION_KEY before the install transaction commits.
 *
 * Lookups survive that: getAtlasAgentRecord() above matches on system_role first, and the MCP
 * and UI resolvers do the same. What does not survive is anything treating the key as a stable
 * identifier. The normalization also updates the related instance, chat, and session references,
 * which is coherent only when exactly one Atlas row owns the identity.
 *
 * Deliberately narrow. It renames one row rather than reconciling duplicates: if two agents
 * already claim atlas, that is a repair with real choices to make and it should not happen as a
 * side effect of a schema migration. This function is called only by explicit initial install.
 */
export async function ensureCanonicalAtlasSessionKey(db: Db): Promise<'unchanged' | 'renamed' | 'skipped'> {
  const defaultTenant = await db.get(
    `SELECT id FROM tenants WHERE is_default = 1 ORDER BY id ASC LIMIT 1`,
  ) as { id: number } | undefined;
  if (!defaultTenant) return 'skipped';

  const claimants = await db.all(
    `SELECT id, session_key FROM agents WHERE tenant_id = ? AND system_role = ? ORDER BY id ASC`,
    defaultTenant.id, ATLAS_SYSTEM_ROLE,
  ) as Array<{ id: number; session_key: string | null }>;
  if (claimants.length !== 1) return 'skipped';

  const [atlas] = claimants;
  if (atlas.session_key === ATLAS_SESSION_KEY) return 'unchanged';

  // The key is unique. If some other row already holds it, renaming would fail the constraint —
  // and that other row is the one to investigate, not to overwrite.
  const owner = await db.get(
    `SELECT id FROM agents WHERE session_key = ? AND id <> ? LIMIT 1`,
    ATLAS_SESSION_KEY, atlas.id,
  ) as { id: number } | undefined;
  if (owner) return 'skipped';

  await db.run(`UPDATE agents SET session_key = ? WHERE id = ?`, ATLAS_SESSION_KEY, atlas.id);
  return 'renamed';
}
