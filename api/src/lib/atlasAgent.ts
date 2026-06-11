import os from 'os';
import path from 'path';
import { getDb } from '../db/client';

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

export function getAtlasAgentRecord(): Record<string, unknown> | null {
  const db = getDb();
  const row = db.prepare(`
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
  `).get(
    ATLAS_SYSTEM_ROLE,
    ATLAS_AGENT_SLUG,
    ATLAS_SESSION_KEY,
    LEGACY_ATLAS_SESSION_KEY,
    ATLAS_AGENT_NAME,
    ATLAS_SYSTEM_ROLE,
    ATLAS_AGENT_SLUG,
    ATLAS_SESSION_KEY,
    ATLAS_AGENT_NAME,
    LEGACY_ATLAS_SESSION_KEY,
  ) as Record<string, unknown> | undefined;

  return row ?? null;
}

export function resolveAtlasWorkspaceRoot(): string {
  const atlas = getAtlasAgentRecord();
  if (!atlas) return ATLAS_WORKSPACE_PATH;

  if (typeof atlas.workspace_path === 'string' && atlas.workspace_path.trim()) {
    return atlas.workspace_path;
  }

  if (typeof atlas.openclaw_agent_id === 'string' && atlas.openclaw_agent_id.trim()) {
    return path.join(HOME, '.openclaw', `workspace-${atlas.openclaw_agent_id}`);
  }

  return ATLAS_WORKSPACE_PATH;
}
