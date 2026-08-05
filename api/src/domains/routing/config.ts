import { getNeedsAttentionEligibleStatuses, setNeedsAttentionEligibleStatuses } from '../../lib/reconcilerConfig';
import {
  CONTRACT_PLACEHOLDER_DEFINITIONS,
  getAvailableContractPlaceholders,
  normalizeContractTemplateKey,
  readSprintTypeContractTemplate,
  writeSprintTypeContractTemplate,
} from '../../services/contracts';
import { type Db } from "../../db/adapter/types";

function parseSortRules(value: unknown): string[] {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '[]');
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

export async function getReconcilerRoutingConfig(db: Db) {
  return {
    needs_attention_eligible_statuses: await getNeedsAttentionEligibleStatuses(db),
  };
}

export async function updateReconcilerRoutingConfig(db: Db, input: Record<string, unknown>) {
  return {
    needs_attention_eligible_statuses: await setNeedsAttentionEligibleStatuses(db, input.needs_attention_eligible_statuses),
  };
}

export async function listAgentRoutingConfigs(db: Db) {
  const configs = await db.all(`
    SELECT a.id as agent_id, a.name as agent_name,
           a.stall_threshold_min, a.max_retries, a.sort_rules
    FROM agents a
    WHERE a.enabled = 1
    ORDER BY a.id
  `) as Array<Record<string, unknown>>;

  return {
    configs: configs.map((config) => ({
      ...config,
      sort_rules: parseSortRules(config.sort_rules),
    })),
  };
}

export async function getAgentRoutingConfig(db: Db, rawId: unknown) {
  const id = Number(rawId);
  const agent = await db.get(`
    SELECT id as agent_id, name as agent_name,
           stall_threshold_min, max_retries, sort_rules
    FROM agents WHERE id = ?
  `, id) as Record<string, unknown> | undefined;

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

export async function updateAgentRoutingConfig(
  db: Db,
  rawId: unknown,
  input: Record<string, unknown>,
) {
  const id = Number(rawId);
  const agent = await db.get('SELECT id FROM agents WHERE id = ?', id) as { id: number } | undefined;
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

  sets.push("last_active = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')");
  values.push(agent.id);
  await db.run(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`, ...values);

  return await getAgentRoutingConfig(db, agent.id);
}

export function normalizeSprintTypeKey(raw: unknown): string {
  return normalizeContractTemplateKey(typeof raw === 'string' ? raw : null);
}

export async function ensureSprintTypeExists(db: Db, sprintTypeKey: string): Promise<void> {
  const row = await db.get(`SELECT key FROM sprint_types WHERE key = ? LIMIT 1`, sprintTypeKey) as { key: string } | undefined;
  if (!row) {
    const error = new Error(`Unknown sprint type "${sprintTypeKey}"`) as Error & { status?: number };
    error.status = 404;
    throw error;
  }
}

export async function readAgentContract(db: Db, rawSprintTypeKey: unknown) {
  const sprintTypeKey = normalizeSprintTypeKey(rawSprintTypeKey);
  await ensureSprintTypeExists(db, sprintTypeKey);
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

export async function writeAgentContract(
  db: Db,
  rawSprintTypeKey: unknown,
  content: unknown,
) {
  const sprintTypeKey = normalizeSprintTypeKey(rawSprintTypeKey);
  await ensureSprintTypeExists(db, sprintTypeKey);
  if (typeof content !== 'string') {
    const error = new Error('`content` (string) is required') as Error & { status?: number };
    error.status = 400;
    throw error;
  }

  const targetPath = writeSprintTypeContractTemplate(sprintTypeKey, content);
  return { ok: true, sprint_type: sprintTypeKey, path: targetPath };
}
