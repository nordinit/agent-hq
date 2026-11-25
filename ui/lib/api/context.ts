import { apiFetch, getApiBase } from './http';

/** Mirrors api/src/domains/context/workspace.ts and publish.ts. */

export interface EditableText {
  value: string;
  hash: string;
  chars: number;
}

export interface EditableList {
  value: string[];
  hash: string;
}

export interface RecordedMcpTool {
  name: string;
  title: string | null;
  description: string;
  chars: number;
}

export interface RecordedMcpServer {
  serverName: string;
  mcpServerId: number | null;
  capturedAt: string | null;
  toolCount: number;
  definitionChars: number;
  tools: RecordedMcpTool[];
}

export interface ContextMcpServer {
  mcpServerId: number;
  slug: string;
  runName: string;
  source: string;
  teamName: string | null;
  editable: boolean;
  enabled: boolean;
  allowlist: EditableList;
  unrestricted: boolean;
  recorded: RecordedMcpServer | null;
}

export interface ContextSkill {
  name: string;
  description: string;
  source: 'agent' | 'team';
  found: boolean;
  contentChars: number;
  fileCount: number;
  listingChars: number;
  delivery: string;
}

export interface AgentContextSources {
  agent: {
    id: number;
    name: string;
    runtimeType: string | null;
    model: string | null;
    instructionsVersion: number | null;
    jobInstructions: EditableText;
    ownSkillNames: EditableList;
  };
  skillDelivery: { mode: string; summary: string };
  skills: ContextSkill[];
  availableSkills: Array<{ name: string; description: string }>;
  tools: {
    builtIn: string[];
    registry: Array<{ id: number; slug: string; name: string; description: string; source: string; teamName: string | null; definitionChars: number }>;
    registryDelivery: string;
    mcpServers: ContextMcpServer[];
    otherServers: RecordedMcpServer[];
  };
  teams: Array<{ id: number; name: string; goalChars: number; charterChars: number }>;
  workflows: Array<{
    id: number;
    name: string;
    projectId: number;
    goal: EditableText;
    runCount: number;
    latestInstanceId: number;
    taskTypes: string[];
  }>;
  projects: Array<{ id: number; name: string; contextMd: EditableText }>;
}

export interface TaskContextSources {
  task: { id: number; title: string; taskType: string | null; workflowId: number | null; description: EditableText };
  series: { id: number; titleTemplate: string; schedule: string; enabled: boolean; descriptionTemplate: EditableText } | null;
}

export interface ContextRun {
  instanceId: number;
  taskId: number | null;
  taskTitle: string | null;
  taskType: string | null;
  workflowId: number | null;
  agentId: number | null;
  agentName: string | null;
  status: string | null;
  promptChars: number;
  tokenInput: number | null;
  tokenCachedInput: number | null;
  tokenOutput: number | null;
  createdAt: string | null;
}

export type ContextChange =
  | { kind: 'job_instructions'; agent_id: number; base_hash: string; value: string }
  | { kind: 'agent_skills'; agent_id: number; base_hash: string; value: string[] }
  | { kind: 'mcp_allowlist'; agent_id: number; mcp_server_id: number; base_hash: string; value: string[] }
  | { kind: 'workflow_goal'; workflow_id: number; base_hash: string; value: string }
  | { kind: 'project_context'; project_id: number; base_hash: string; value: string }
  | { kind: 'task_description'; task_id: number; base_hash: string; value: string }
  | { kind: 'series_template'; series_id: number; base_hash: string; value: string };

export interface ContextPublishResult {
  applied: Array<{ kind: ContextChange['kind']; target: string; hash: string }>;
  republished: Array<{ agentId: number; revisionId: string; digest: string }>;
}

export class ContextPublishConflict extends Error {
  constructor(message: string, public conflicts: Array<{ target: string; kind: string; currentHash: string }>) {
    super(message);
  }
}

function query(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

export const contextClient = {
  getContextRuns: (filter: { agentId?: number | null; workflowId?: number | null; taskType?: string | null; taskId?: number | null; limit?: number }) =>
    apiFetch<{ runs: ContextRun[] }>(`/api/v1/context/runs${query({
      agent_id: filter.agentId,
      workflow_id: filter.workflowId,
      task_type: filter.taskType,
      task_id: filter.taskId,
      limit: filter.limit,
    })}`).then((body) => body.runs),
  getAgentContextSources: (agentId: number) => apiFetch<AgentContextSources>(`/api/v1/context/agents/${agentId}`),
  getTaskContextSources: (taskId: number) => apiFetch<TaskContextSources>(`/api/v1/context/tasks/${taskId}`),
  getRunMcpTools: (instanceId: number) =>
    apiFetch<{ servers: RecordedMcpServer[] }>(`/api/v1/context/runs/${instanceId}/mcp-tools`).then((body) => body.servers),
  /** Reads the conflict list on 409, which apiFetch would drop. */
  publishContextChanges: async (changes: ContextChange[]): Promise<ContextPublishResult> => {
    const res = await fetch(`${getApiBase()}/api/v1/context/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    });
    const body = await res.json().catch(() => ({})) as {
      error?: string;
      detail?: { conflicts?: Array<{ target: string; kind: string; currentHash: string }> };
    } & Partial<ContextPublishResult>;
    if (res.status === 409) throw new ContextPublishConflict(body.error ?? 'Some sources changed.', body.detail?.conflicts ?? []);
    if (!res.ok) throw new Error(body.error ?? `API error ${res.status}`);
    return body as ContextPublishResult;
  },
};
