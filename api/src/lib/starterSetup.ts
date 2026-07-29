import { isAtlasAgentRecord } from './atlasAgent';
import {
  STARTER_BACKLOG_SPRINT_NAME,
  STARTER_ROUTING_PRIORITY,
  getStarterTaskTypesForSprintType,
  starterSprintTypeBaseKey,
} from './starterCatalog';
import { seedSprintTaskPolicy } from '../domains/routing/policy/seed';
import { listSprintTaskStatuses } from '../domains/routing/policy/statuses';
import { type Db } from "../db/adapter/types";

type SprintRow = {
  id: number;
  project_id: number;
  sprint_type: string | null;
};

type AgentRow = {
  id: number;
  name: string | null;
  role: string | null;
  job_title: string | null;
  system_role: string | null;
  session_key: string | null;
  openclaw_agent_id: string | null;
};

type RoutedAgentSet = {
  atlasId: number | null;
  devId: number | null;
  qaId: number | null;
  opsId: number | null;
};

type StarterRoutingRule = {
  task_type: string;
  status: 'ready' | 'review' | 'ready_to_merge';
  agent_id: number;
  priority: number;
};

async function tableHasColumn(db: Db, tableName: string, columnName: string): Promise<boolean> {
  try {
    const columns = await db.all(`PRAGMA table_info(${tableName})`) as Array<{ name: string }>;
    return columns.some((column) => column.name === columnName);
  } catch {
    return false;
  }
}

async function loadSprintRow(db: Db, sprintId: number): Promise<SprintRow | null> {
  return await db.get(`
    SELECT id, project_id, sprint_type
    FROM sprints
    WHERE id = ?
    LIMIT 1
  `, sprintId) as SprintRow | undefined ?? null;
}

async function loadProjectAgents(db: Db, projectId: number): Promise<AgentRow[]> {
  const deletedFilter = await tableHasColumn(db, 'agents', 'deleted_at') ? 'AND deleted_at IS NULL' : '';
  return await db.all(`
    SELECT id, name, role, job_title, system_role, session_key, openclaw_agent_id
    FROM agents
    WHERE project_id = ?
      ${deletedFilter}
    ORDER BY id ASC
  `, projectId) as AgentRow[];
}

function buildAgentHaystack(agent: AgentRow): string {
  return [
    agent.name ?? '',
    agent.role ?? '',
    agent.job_title ?? '',
    agent.openclaw_agent_id ?? '',
  ].join(' ').toLowerCase();
}

function matchesAny(haystack: string, terms: string[]): boolean {
  return terms.some((term) => haystack.includes(term));
}

function classifyProjectAgents(agents: AgentRow[]): RoutedAgentSet {
  const atlas = agents.find((agent) => isAtlasAgentRecord(agent as unknown as Record<string, unknown>));

  const findByTerms = (terms: string[], excludedIds: Set<number>): number | null => {
    const match = agents.find((agent) => {
      if (excludedIds.has(agent.id)) return false;
      return matchesAny(buildAgentHaystack(agent), terms);
    });
    return match?.id ?? null;
  };

  const usedIds = new Set<number>(atlas ? [atlas.id] : []);
  const qaId = findByTerms([' qa ', 'qa', 'quality assurance', 'tester', 'testing', 'validation', 'verify'], usedIds);
  if (qaId != null) usedIds.add(qaId);
  const opsId = findByTerms(['ops', 'operations', 'devops', 'release', 'deployment', 'infra', 'infrastructure', 'sre', 'site reliability'], usedIds);
  if (opsId != null) usedIds.add(opsId);
  const devId = findByTerms(['developer', 'development', 'engineer', 'backend', 'frontend', 'fullstack', 'software', 'implementation', 'app', 'api', 'code'], usedIds);

  return {
    atlasId: atlas?.id ?? null,
    devId,
    qaId,
    opsId,
  };
}

function resolveReadyOwner(taskType: string, agents: RoutedAgentSet): number | null {
  switch (taskType) {
    case 'backend':
    case 'frontend':
    case 'fullstack':
      return agents.devId ?? agents.atlasId ?? null;
    case 'qa':
      return agents.qaId ?? agents.atlasId ?? agents.devId ?? null;
    case 'ops':
      return agents.opsId ?? agents.atlasId ?? null;
    case 'adhoc':
    case 'other':
    default:
      return agents.atlasId ?? agents.devId ?? agents.opsId ?? null;
  }
}

function resolveReviewOwner(taskType: string, agents: RoutedAgentSet): number | null {
  switch (taskType) {
    case 'backend':
    case 'frontend':
    case 'fullstack':
      return agents.qaId ?? agents.atlasId ?? agents.devId ?? null;
    case 'qa':
      return agents.atlasId ?? agents.qaId ?? null;
    case 'ops':
      return agents.atlasId ?? agents.opsId ?? null;
    case 'adhoc':
    case 'other':
    default:
      return agents.atlasId ?? agents.devId ?? agents.opsId ?? null;
  }
}

function buildStarterRoutingRules(sprintType: string, agents: RoutedAgentSet, availableStatuses: Set<string>): StarterRoutingRule[] {
  const rules = new Map<string, StarterRoutingRule>();
  const taskTypes = getStarterTaskTypesForSprintType(sprintType);

  for (const taskType of taskTypes) {
    const readyOwner = resolveReadyOwner(taskType, agents);
    if (readyOwner != null && availableStatuses.has('ready')) {
      rules.set(`${taskType}:ready`, {
        task_type: taskType,
        status: 'ready',
        agent_id: readyOwner,
        priority: STARTER_ROUTING_PRIORITY,
      });
    }

    const reviewOwner = resolveReviewOwner(taskType, agents);
    if (reviewOwner != null && availableStatuses.has('review')) {
      rules.set(`${taskType}:review`, {
        task_type: taskType,
        status: 'review',
        agent_id: reviewOwner,
        priority: STARTER_ROUTING_PRIORITY,
      });
    }

    const mergeOwner = agents.atlasId ?? reviewOwner ?? readyOwner;
    if (mergeOwner != null && availableStatuses.has('ready_to_merge')) {
      rules.set(`${taskType}:ready_to_merge`, {
        task_type: taskType,
        status: 'ready_to_merge',
        agent_id: mergeOwner,
        priority: STARTER_ROUTING_PRIORITY,
      });
    }
  }

  return Array.from(rules.values());
}

export async function ensureProjectBacklogSprint(db: Db, projectId: number): Promise<number> {
  const project = await db.get(`SELECT tenant_id FROM projects WHERE id = ?`, projectId) as { tenant_id: number | null } | undefined;
  const tenantSprintType = project?.tenant_id != null
    ? (await db.get(`
      SELECT key
      FROM sprint_types
      WHERE tenant_id = ? AND (key = 'generic' OR key LIKE ?)
      ORDER BY CASE WHEN key = 'generic' THEN 0 ELSE 1 END, key ASC
      LIMIT 1
    `, project.tenant_id, '%__generic') as { key: string } | undefined)?.key ?? 'generic'
    : 'generic';
  const existing = await db.get(`
    SELECT id
    FROM sprints
    WHERE project_id = ?
      AND (lower(name) = lower(?) OR sprint_type = ?)
    ORDER BY CASE WHEN lower(name) = lower(?) THEN 0 ELSE 1 END, id ASC
    LIMIT 1
  `, projectId, STARTER_BACKLOG_SPRINT_NAME, tenantSprintType, STARTER_BACKLOG_SPRINT_NAME) as { id: number } | undefined;
  if (existing) return existing.id;

  const result = await db.run(`
    INSERT INTO sprints (tenant_id, project_id, name, goal, sprint_type, status, length_kind, length_value)
    VALUES (?, ?, ?, '', ?, 'active', 'time', 'ongoing')
  `, project?.tenant_id ?? null, projectId, STARTER_BACKLOG_SPRINT_NAME, tenantSprintType);

  const sprintId = Number(result.lastInsertId);
  await seedSprintTaskPolicy(db, sprintId);
  await syncStarterRoutingForSprint(db, sprintId);
  return sprintId;
}

export async function resolveDefaultProjectSprintId(db: Db, projectId: number | null | undefined): Promise<number | null> {
  if (!projectId || !Number.isFinite(projectId)) return null;
  return await ensureProjectBacklogSprint(db, projectId);
}

export async function syncStarterRoutingForProject(db: Db, projectId: number | null | undefined): Promise<void> {
  if (!projectId || !Number.isFinite(projectId)) return;
  const sprintRows = await db.all(`
    SELECT id
    FROM sprints
    WHERE project_id = ?
    ORDER BY id ASC
  `, projectId) as Array<{ id: number }>;

  for (const sprint of sprintRows) {
    await syncStarterRoutingForSprint(db, sprint.id);
  }
}

export async function syncStarterRoutingForSprint(db: Db, sprintId: number | null | undefined): Promise<void> {
  if (!sprintId || !Number.isFinite(sprintId)) return;
  const sprint = await loadSprintRow(db, sprintId);
  if (!sprint) return;
  if (!await tableHasColumn(db, 'sprint_task_routing_rules', 'is_system')) return;

  await seedSprintTaskPolicy(db, sprintId);

  const existingRuleCount = (await db.get(`
    SELECT COUNT(*) AS n
    FROM sprint_task_routing_rules
    WHERE sprint_id = ?
  `, sprintId) as { n: number }).n;
  if (existingRuleCount > 0) return;

  const starterSprintType = starterSprintTypeBaseKey(sprint.sprint_type);
  if (!starterSprintType) return;

  const agents = classifyProjectAgents(await loadProjectAgents(db, sprint.project_id));
  const availableStatuses = new Set((await listSprintTaskStatuses(db, sprintId)).map(status => status.name));
  const rules = buildStarterRoutingRules(starterSprintType, agents, availableStatuses);
  if (rules.length === 0) return;

  const insertRuleSql = `
    INSERT INTO sprint_task_routing_rules (sprint_id, task_type, status, agent_id, priority, is_system, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `;

  for (const rule of rules) {
    await db.run(insertRuleSql, sprintId, rule.task_type, rule.status, rule.agent_id, rule.priority);
  }
}
