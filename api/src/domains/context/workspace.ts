/**
 * Read model for the Context page: everything that shapes what an agent's model is given, with
 * the editable sources carrying a content hash so a staged batch can detect concurrent edits.
 *
 * The prompt of a recorded run comes from GET /instances/:id/context. This module adds what sits
 * around it: the agent's instructions and skills (and how each runtime delivers them), its tools
 * (built-in, Agent HQ registry tools, MCP servers with their advertised definitions), and the
 * workflow, project, task and series text that dispatch renders into the prompt.
 */

import { createHash } from 'crypto';
import type { Db } from '../../db/adapter/types';
import { assignmentToolNames } from '../../services/runtimeBoundaryAssignments';
import { effectiveBuiltInTools } from '../../services/runtimeBoundaryBuilder';
import {
  fetchEffectiveAgentMcpRows,
  fetchEffectiveAgentToolRows,
  resolveEffectiveSkillNames,
} from '../teams/effectiveCapabilities';

/** Parsed assignment overrides; malformed JSON reads as no overrides. */
export function parseOverrides(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export class ContextNotFound extends Error {
  status = 404;
}

/** sha256 of a source exactly as stored. Text uses '' for null; lists hash their JSON. */
export function contextSourceHash(value: unknown): string {
  const material = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return createHash('sha256').update(material).digest('hex');
}

export interface EditableText {
  value: string;
  hash: string;
  chars: number;
}

function editableText(value: unknown): EditableText {
  const text = typeof value === 'string' ? value : '';
  return { value: text, hash: contextSourceHash(text), chars: text.length };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** The `description:` line of a SKILL.md frontmatter block: what the runtimes list to the model. */
function frontmatterDescription(content: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content.trimStart());
  if (!match) return null;
  const line = match[1].split(/\r?\n/).find((entry) => /^description:/.test(entry));
  if (!line) return null;
  return line.replace(/^description:\s*/, '').replace(/^["']|["']$/g, '').trim() || null;
}

export function skillDelivery(runtimeType: string | null): { mode: string; summary: string } {
  switch (runtimeType) {
    case 'claude-code':
      return {
        mode: 'claude_code_plugin',
        summary: 'Listed to the model as agent-hq:<name> with its description. The Skill tool loads the full SKILL.md when a task matches.',
      };
    case 'codex':
      return {
        mode: 'codex_skill_listing',
        summary: "Listed in Codex's available skills with its description and SKILL.md path. The model reads the file when a task matches.",
      };
    case 'openclaw':
      return { mode: 'openclaw_workspace', summary: 'Copied into the workspace skills/ folder, which OpenClaw lists to the model.' };
    case 'hermes':
      return { mode: 'hermes_profile', summary: 'Copied into the Hermes profile skills folder.' };
    case 'webhook':
      return { mode: 'prompt_metadata', summary: 'Named in the dispatch metadata sent to the webhook.' };
    default:
      return { mode: 'none', summary: 'This runtime has no skill delivery.' };
  }
}

function registryToolDelivery(runtimeType: string | null): string {
  if (runtimeType === 'claude-code') return 'Given to the model through the Agent HQ tools bridge (MCP server agent-hq-tools).';
  if (runtimeType === 'openclaw') return 'Given to the model through the OpenClaw gateway plugin.';
  if (runtimeType === 'codex') return 'Not delivered: Codex runs have no bridge for registry tools yet.';
  return 'Delivery depends on the runtime.';
}

export interface RunMcpServerTools {
  serverName: string;
  mcpServerId: number | null;
  capturedAt: string | null;
  toolCount: number;
  definitionChars: number;
  tools: Array<{ name: string; title: string | null; description: string; chars: number }>;
}

/** The MCP tool definitions recorded for one run, server by server. */
export async function runMcpTools(db: Db, tenantId: number, instanceId: number): Promise<RunMcpServerTools[]> {
  const rows = await db.all<Record<string, any>>(
    `SELECT r.server_name, s.mcp_server_id, s.last_seen_at, s.tool_count, s.definition_chars, s.tools
     FROM runs.run_mcp_tool_snapshots r
     JOIN agents.mcp_tool_snapshots s ON s.id = r.snapshot_id
     WHERE r.tenant_id = ? AND r.instance_id = ?
     ORDER BY r.server_name`,
    tenantId,
    instanceId,
  );
  return rows.map(mapSnapshotRow);
}

function mapSnapshotRow(row: Record<string, any>): RunMcpServerTools {
  const tools = (parseJson(row.tools) as Array<Record<string, unknown>> | null) ?? [];
  return {
    serverName: String(row.server_name),
    mcpServerId: row.mcp_server_id == null ? null : Number(row.mcp_server_id),
    capturedAt: row.last_seen_at ? new Date(row.last_seen_at).toISOString() : null,
    toolCount: Number(row.tool_count ?? tools.length),
    definitionChars: Number(row.definition_chars ?? 0),
    tools: tools.map((tool) => ({
      name: String(tool.name),
      title: typeof tool.title === 'string' ? tool.title : null,
      description: typeof tool.description === 'string' ? tool.description : '',
      chars: JSON.stringify(tool).length,
    })),
  };
}

/** The most recent recorded tools for each server name this agent's runs used. */
async function latestAgentMcpTools(db: Db, tenantId: number, agentId: number): Promise<Map<string, RunMcpServerTools>> {
  const rows = await db.all<Record<string, any>>(
    `SELECT DISTINCT ON (r.server_name)
            r.server_name, s.mcp_server_id, s.last_seen_at, s.tool_count, s.definition_chars, s.tools
     FROM runs.run_mcp_tool_snapshots r
     JOIN agents.mcp_tool_snapshots s ON s.id = r.snapshot_id
     JOIN job_instances j ON j.id = r.instance_id
     WHERE r.tenant_id = ? AND j.agent_id = ?
     ORDER BY r.server_name, r.recorded_at DESC`,
    tenantId,
    agentId,
  );
  return new Map(rows.map((row) => [String(row.server_name), mapSnapshotRow(row)]));
}

export async function agentContextSources(db: Db, tenantId: number, agentId: number) {
  const agent = await db.get<Record<string, any>>(
    `SELECT id, name, runtime_type, model, job_instructions, instructions_version, skill_names, runtime_config
     FROM agents WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`,
    agentId,
    tenantId,
  );
  if (!agent) throw new ContextNotFound('Agent not found');
  const runtimeType: string | null = agent.runtime_type ?? null;
  const parsedSkillNames = parseJson(agent.skill_names);
  const ownSkillNames = (Array.isArray(parsedSkillNames) ? parsedSkillNames : [])
    .filter((name: unknown): name is string => typeof name === 'string');
  const effectiveSkillNames = await resolveEffectiveSkillNames(db, agentId, agent.skill_names);
  const runtimeConfig = parseJson(agent.runtime_config);
  const builtIn = effectiveBuiltInTools(
    runtimeType ?? '',
    runtimeConfig && typeof runtimeConfig === 'object' ? (runtimeConfig as Record<string, unknown>) : null,
    effectiveSkillNames.length > 0,
  );

  const skillRows = await db.all<Record<string, any>>(
    `SELECT s.name, s.description, length(s.content) AS content_chars, s.content,
            (SELECT count(*) FROM skill_files f WHERE f.skill_id = s.id AND f.tenant_id = s.tenant_id) AS file_count
     FROM skills s WHERE s.tenant_id = ? ORDER BY s.name`,
    tenantId,
  );
  const byName = new Map(skillRows.map((row) => [String(row.name), row]));
  const delivery = skillDelivery(runtimeType);
  const skills = effectiveSkillNames.map((name) => {
    const row = byName.get(name);
    const description = (row && (frontmatterDescription(String(row.content ?? '')) ?? row.description)) || '';
    return {
      name,
      description,
      source: ownSkillNames.includes(name) ? 'agent' : 'team',
      found: Boolean(row),
      contentChars: Number(row?.content_chars ?? 0),
      fileCount: Number(row?.file_count ?? 0),
      // What sits in the prompt before the skill is opened: its listed name and description.
      listingChars: name.length + description.length + (runtimeType === 'claude-code' ? 'agent-hq:'.length : 0),
      delivery: delivery.mode,
    };
  });

  const recordedTools = await latestAgentMcpTools(db, tenantId, agentId);
  const mcpRows = await fetchEffectiveAgentMcpRows(db, agentId);
  const mcpServers = mcpRows.map((row) => {
    // Read exactly as launch reads it, so the page shows the allowlist runs enforce.
    const enforced = assignmentToolNames(parseOverrides(row.overrides));
    const allowlist = enforced ?? [];
    const runName = `${row.slug}__agent-${agentId}`;
    const recorded = recordedTools.get(runName) ?? null;
    recordedTools.delete(runName);
    return {
      mcpServerId: Number(row.mcp_server_id),
      slug: String(row.slug),
      runName,
      source: String(row.source),
      teamName: row.source_team_name ?? null,
      // Only an agent's own assignment can be edited here; team assignments belong to the team.
      editable: row.source === 'agent',
      enabled: Number(row.assignment_enabled ?? 1) === 1,
      allowlist: { value: allowlist, hash: contextSourceHash(allowlist) },
      unrestricted: enforced === null,
      recorded,
    };
  });
  // Servers a run had that are not assignments, such as the registry tools bridge.
  const otherServers = [...recordedTools.values()];

  const registryTools = (await fetchEffectiveAgentToolRows(db, agentId)).map((row) => {
    const definition = { name: row.slug ?? row.name, description: row.description ?? '', input_schema: parseJson(row.input_schema) };
    return {
      id: Number(row.id),
      slug: String(row.slug ?? ''),
      name: String(row.name ?? row.slug ?? ''),
      description: String(row.description ?? ''),
      source: String(row.source ?? 'agent'),
      teamName: row.source_team_name ?? null,
      definitionChars: JSON.stringify(definition).length,
    };
  });

  const workflows = await db.all<Record<string, any>>(
    `SELECT w.id, w.name, w.goal, w.project_id, p.name AS project_name, p.context_md,
            count(*) AS run_count, max(j.id) AS latest_instance_id,
            array_agg(DISTINCT t.task_type) FILTER (WHERE t.task_type IS NOT NULL) AS task_types
     FROM job_instances j
     JOIN tasks t ON t.id = j.task_id
     JOIN workflows w ON w.id = t.workflow_id
     JOIN projects p ON p.id = w.project_id
     WHERE j.agent_id = ? AND w.tenant_id = ?
     GROUP BY w.id, w.name, w.goal, w.project_id, p.name, p.context_md
     ORDER BY max(j.id) DESC
     LIMIT 50`,
    agentId,
    tenantId,
  );
  const projects = new Map<number, { id: number; name: string; contextMd: EditableText }>();
  for (const row of workflows) {
    if (!projects.has(Number(row.project_id))) {
      projects.set(Number(row.project_id), {
        id: Number(row.project_id),
        name: String(row.project_name),
        contextMd: editableText(row.context_md),
      });
    }
  }

  const teams = await db.all<Record<string, any>>(
    `SELECT te.id, te.name, length(coalesce(te.goal, '')) AS goal_chars, length(coalesce(te.charter, '')) AS charter_chars
     FROM teams te JOIN team_members tm ON tm.team_id = te.id
     WHERE tm.agent_id = ? AND tm.enabled = 1 AND te.enabled = 1 AND te.deleted_at IS NULL AND te.tenant_id = ?
     ORDER BY te.id`,
    agentId,
    tenantId,
  );

  return {
    agent: {
      id: Number(agent.id),
      name: String(agent.name),
      runtimeType,
      model: agent.model ?? null,
      instructionsVersion: agent.instructions_version == null ? null : Number(agent.instructions_version),
      jobInstructions: editableText(agent.job_instructions),
      ownSkillNames: { value: ownSkillNames, hash: contextSourceHash(ownSkillNames) },
    },
    skillDelivery: delivery,
    skills,
    availableSkills: skillRows.map((row) => ({
      name: String(row.name),
      description: (frontmatterDescription(String(row.content ?? '')) ?? row.description) || '',
    })),
    tools: {
      builtIn,
      registry: registryTools,
      registryDelivery: registryToolDelivery(runtimeType),
      mcpServers,
      otherServers,
    },
    teams: teams.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      goalChars: Number(row.goal_chars ?? 0),
      charterChars: Number(row.charter_chars ?? 0),
    })),
    workflows: workflows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      projectId: Number(row.project_id),
      goal: editableText(row.goal),
      runCount: Number(row.run_count ?? 0),
      latestInstanceId: Number(row.latest_instance_id),
      taskTypes: (row.task_types ?? []).map(String).sort(),
    })),
    projects: [...projects.values()],
  };
}

export async function taskContextSources(db: Db, tenantId: number, taskId: number) {
  const task = await db.get<Record<string, any>>(
    `SELECT id, title, description, task_type, workflow_id, recurring_series_id
     FROM tasks WHERE id = ? AND tenant_id = ?`,
    taskId,
    tenantId,
  );
  if (!task) throw new ContextNotFound('Task not found');
  const series = task.recurring_series_id
    ? await db.get<Record<string, any>>(
        `SELECT id, title_template, description_template, schedule_expression, timezone, enabled
         FROM recurring_task_series WHERE id = ? AND tenant_id = ?`,
        task.recurring_series_id,
        tenantId,
      )
    : null;
  return {
    task: {
      id: Number(task.id),
      title: String(task.title),
      taskType: task.task_type ?? null,
      workflowId: task.workflow_id == null ? null : Number(task.workflow_id),
      description: editableText(task.description),
    },
    series: series
      ? {
          id: Number(series.id),
          titleTemplate: String(series.title_template),
          schedule: `${series.schedule_expression} (${series.timezone})`,
          enabled: Number(series.enabled) === 1,
          descriptionTemplate: editableText(series.description_template),
        }
      : null,
  };
}

export interface ContextRunFilter {
  agentId?: number;
  workflowId?: number;
  taskType?: string;
  taskId?: number;
  limit?: number;
}

/** Recorded runs (those with a captured prompt), newest first. */
export async function listContextRuns(db: Db, tenantId: number, filter: ContextRunFilter) {
  const rows = await db.all<Record<string, any>>(
    `SELECT b.instance_id, b.task_id, b.agent_id, b.prompt_chars, b.created_at,
            j.status, j.token_input, j.token_cached_input, j.token_output,
            t.title AS task_title, t.task_type, t.workflow_id, a.name AS agent_name
     FROM dispatch_context_bundles b
     JOIN job_instances j ON j.id = b.instance_id
     LEFT JOIN tasks t ON t.id = b.task_id
     LEFT JOIN agents a ON a.id = b.agent_id
     WHERE b.tenant_id = ?
       AND (?::bigint IS NULL OR b.agent_id = ?)
       AND (?::bigint IS NULL OR t.workflow_id = ?)
       AND (?::text IS NULL OR t.task_type = ?)
       AND (?::bigint IS NULL OR b.task_id = ?)
     ORDER BY b.id DESC
     LIMIT ?`,
    tenantId,
    filter.agentId ?? null, filter.agentId ?? null,
    filter.workflowId ?? null, filter.workflowId ?? null,
    filter.taskType ?? null, filter.taskType ?? null,
    filter.taskId ?? null, filter.taskId ?? null,
    Math.min(Math.max(filter.limit ?? 25, 1), 100),
  );
  return rows.map((row) => ({
    instanceId: Number(row.instance_id),
    taskId: row.task_id == null ? null : Number(row.task_id),
    taskTitle: row.task_title ?? null,
    taskType: row.task_type ?? null,
    workflowId: row.workflow_id == null ? null : Number(row.workflow_id),
    agentId: row.agent_id == null ? null : Number(row.agent_id),
    agentName: row.agent_name ?? null,
    status: row.status ?? null,
    promptChars: Number(row.prompt_chars ?? 0),
    tokenInput: row.token_input == null ? null : Number(row.token_input),
    tokenCachedInput: row.token_cached_input == null ? null : Number(row.token_cached_input),
    tokenOutput: row.token_output == null ? null : Number(row.token_output),
    createdAt: row.created_at ?? null,
  }));
}
