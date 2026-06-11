import type Database from 'better-sqlite3';
import { getNeedsAttentionEligibleStatuses, setNeedsAttentionEligibleStatuses } from '../../lib/reconcilerConfig';
import {
  CONTRACT_PLACEHOLDER_DEFINITIONS,
  getAvailableContractPlaceholders,
  normalizeContractTemplateKey,
  readSprintTypeContractTemplate,
  writeSprintTypeContractTemplate,
} from '../../services/contracts';

function parseSortRules(value: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export function getReconcilerRoutingConfig(db: Database.Database) {
  return {
    needs_attention_eligible_statuses: getNeedsAttentionEligibleStatuses(db),
  };
}

export function updateReconcilerRoutingConfig(db: Database.Database, input: Record<string, unknown>) {
  return {
    needs_attention_eligible_statuses: setNeedsAttentionEligibleStatuses(db, input.needs_attention_eligible_statuses),
  };
}

export function listAgentRoutingConfigs(db: Database.Database) {
  const configs = db.prepare(`
    SELECT a.id as agent_id, a.name as agent_name,
           a.stall_threshold_min, a.max_retries, a.sort_rules
    FROM agents a
    WHERE a.enabled = 1
    ORDER BY a.id
  `).all() as Array<Record<string, unknown>>;

  return {
    configs: configs.map((config) => ({
      ...config,
      sort_rules: parseSortRules(config.sort_rules),
    })),
  };
}

export function getAgentRoutingConfig(db: Database.Database, rawId: unknown) {
  const id = Number(rawId);
  const agent = db.prepare(`
    SELECT id as agent_id, name as agent_name,
           stall_threshold_min, max_retries, sort_rules
    FROM agents WHERE id = ?
  `).get(id) as Record<string, unknown> | undefined;

  if (!agent) {
    const error = new Error(`No routing config for id=${id}`) as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  return {
    ...agent,
    sort_rules: parseSortRules(agent.sort_rules),
  };
}

export function updateAgentRoutingConfig(
  db: Database.Database,
  rawId: unknown,
  input: Record<string, unknown>,
) {
  const id = Number(rawId);
  const agent = db.prepare('SELECT id FROM agents WHERE id = ?').get(id) as { id: number } | undefined;
  if (!agent) {
    const error = new Error(`Agent or job ${id} not found`) as Error & { status?: number };
    error.status = 404;
    throw error;
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (input.stall_threshold_min !== undefined) {
    sets.push('stall_threshold_min = ?');
    values.push(input.stall_threshold_min);
  }
  if (input.max_retries !== undefined) {
    sets.push('max_retries = ?');
    values.push(input.max_retries);
  }
  if (input.sort_rules !== undefined) {
    sets.push('sort_rules = ?');
    values.push(JSON.stringify(input.sort_rules));
  }

  if (sets.length === 0) {
    const error = new Error('No fields to update') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  sets.push("last_active = datetime('now')");
  values.push(agent.id);
  db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...values);

  return getAgentRoutingConfig(db, agent.id);
}

export function normalizeSprintTypeKey(raw: unknown): string {
  return normalizeContractTemplateKey(typeof raw === 'string' ? raw : null);
}

export function ensureSprintTypeExists(db: Database.Database, sprintTypeKey: string): void {
  const row = db.prepare(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`).get(sprintTypeKey) as { key: string } | undefined;
  if (!row) {
    const error = new Error(`Unknown sprint type "${sprintTypeKey}"`) as Error & { status?: number };
    error.status = 404;
    throw error;
  }
}

export function readAgentContract(db: Database.Database, rawSprintTypeKey: unknown) {
  const sprintTypeKey = normalizeSprintTypeKey(rawSprintTypeKey);
  ensureSprintTypeExists(db, sprintTypeKey);
  const contract = readSprintTypeContractTemplate(sprintTypeKey);
  return {
    sprint_type: sprintTypeKey,
    content: contract.content,
    path: contract.path,
    inherited_from: contract.inheritedFrom,
    placeholders: getAvailableContractPlaceholders(),
    placeholder_definitions: CONTRACT_PLACEHOLDER_DEFINITIONS,
    format: 'plain_text_v1',
  };
}

export function writeAgentContract(
  db: Database.Database,
  rawSprintTypeKey: unknown,
  content: unknown,
) {
  const sprintTypeKey = normalizeSprintTypeKey(rawSprintTypeKey);
  ensureSprintTypeExists(db, sprintTypeKey);
  if (typeof content !== 'string') {
    const error = new Error('`content` (string) is required') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const targetPath = writeSprintTypeContractTemplate(sprintTypeKey, content);
  return { ok: true, sprint_type: sprintTypeKey, path: targetPath };
}
