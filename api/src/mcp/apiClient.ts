/**
 * Agent HQ MCP Server — API Client
 *
 * Thin wrapper around the Agent HQ REST API.
 * All MCP tool implementations call through here.
 * Never accesses the database directly.
 */

import { TASK_STATUSES } from '../lib/taskStatuses';

type RecordLike = Record<string, unknown>;

export class AgentHqApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'AgentHqApiError';
  }
}

function apiErrorMessage(data: unknown, fallback: string): string {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    const message = record.error ?? record.message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return fallback;
}

export interface AgentHqProjectSummary {
  id: number;
  name: string;
  description: string | null;
  agent_count: number;
  created_at: string | null;
}

export interface AgentHqProjectFile {
  id: number;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_at: string | null;
  uploaded_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
  current_version: number;
  current_version_id: number | null;
  file_path?: string | null;
}

export interface AgentHqProjectFileVersion {
  id: number;
  tenant_id: number;
  project_id: number;
  file_id: number;
  version_number: number;
  filename: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  created_by: string | null;
  created_at: string | null;
  change_source: string | null;
}

export interface AgentHqProjectFileDownload {
  metadata: AgentHqProjectFile;
  content_base64: string;
  encoding: 'base64';
  text: string | null;
}

export interface AgentHqSprintSummary {
  id: number;
  project_id: number;
  project_name: string | null;
  name: string;
  goal: string | null;
  status: string | null;
  task_count: number;
  tasks_done: number;
  total_story_points: number;
  done_story_points: number;
  remaining_story_points: number;
  created_at: string | null;
  started_at: string | null;
  ended_at: string | null;
}

export interface AgentHqTaskSummary {
  id: number;
  title: string;
  status: string | null;
  priority: string | null;
  task_type: string | null;
  story_points: number | null;
  project_id: number | null;
  sprint_id: number | null;
  sprint_name: string | null;
  agent_id: number | null;
  agent_name: string | null;
  active_instance_id: number | null;
  updated_at: string | null;
  blockers: Array<{ id: number; title: string; status: string | null }>;
  blocking: Array<{ id: number; title: string; status: string | null }>;
}

export interface AgentHqTaskDetail extends AgentHqTaskSummary {
  description: string | null;
  review_branch: string | null;
  review_commit: string | null;
  review_url: string | null;
  qa_verified_commit: string | null;
  qa_tested_url: string | null;
  merged_commit: string | null;
  deployed_commit: string | null;
  deploy_target: string | null;
  latest_run_stage: string | null;
  latest_run_outcome: string | null;
  blocker_reason: string | null;
  integrity_state: string | null;
  integrity_warnings: string[];
  changed_files: string[];
}

export interface AgentHqTaskHistoryEntry {
  id: number;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  created_at: string | null;
}

export type AgentHqTaskContextMode = 'summary' | 'full';

export interface AgentHqTaskContextOptions {
  includeNotes?: boolean;
  includeHistory?: boolean;
  includeRuns?: boolean;
  includeLease?: boolean;
  recentNotesLimit?: number;
  recentHistoryLimit?: number;
  recentRunsLimit?: number;
  recentExternalEventsLimit?: number;
  timelineLimit?: number;
  sinceTimestamp?: string;
  sinceNoteId?: number;
  sinceHistoryId?: number;
  includeNoisyEvents?: boolean;
}

export interface AgentHqTaskContextResponse extends RecordLike {
  task_id?: number;
  mode?: AgentHqTaskContextMode;
  server_summary?: string;
}

export interface AgentHqLifecycleCheckIn {
  stage: 'start' | 'progress' | 'blocker' | 'heartbeat';
  summary?: string;
  session_key?: string;
  blocker_reason?: string;
  meaningful_output?: boolean;
  details?: Record<string, unknown>;
}

function asRecord(value: unknown): RecordLike {
  return value && typeof value === 'object' ? (value as RecordLike) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))
      ? Number(value)
      : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  return asArray(value).map((item) => (typeof item === 'string' ? item : String(item))).filter(Boolean);
}

function isTextMimeType(mimeType: string | null): boolean {
  const normalized = (mimeType ?? '').toLowerCase();
  return normalized.startsWith('text/')
    || normalized.includes('json')
    || normalized.includes('xml')
    || normalized.includes('yaml')
    || normalized.includes('csv')
    || normalized === 'application/javascript'
    || normalized === 'application/typescript';
}

function appendQuery(path: string, params: Record<string, unknown> = {}): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${path}?${query}` : path;
}

function tenantSelectorQuery(input: Record<string, unknown> = {}): Record<string, unknown> {
  return input.tenant_id === undefined || input.tenant_id === null || input.tenant_id === ''
    ? {}
    : { tenant_id: input.tenant_id };
}

function omitTenantSelector<T extends Record<string, unknown>>(input: T): Omit<T, 'tenant_id'> {
  const { tenant_id: _tenantId, ...rest } = input;
  return rest;
}

function shapeTaskRef(value: unknown): { id: number; title: string; status: string | null } | null {
  const row = asRecord(value);
  const id = asNumber(row.id);
  const title = asString(row.title);
  if (id === null || title === null) return null;
  return {
    id,
    title,
    status: asString(row.status),
  };
}

export function shapeProjectSummary(value: unknown): AgentHqProjectSummary {
  const row = asRecord(value);
  return {
    id: asNumber(row.id) ?? 0,
    name: asString(row.name) ?? 'Untitled project',
    description: asString(row.description),
    agent_count: asNumber(row.agent_count) ?? 0,
    created_at: asString(row.created_at),
  };
}

export function shapeProjectFile(value: unknown): AgentHqProjectFile {
  const row = asRecord(value);
  const currentVersion = asNumber(row.current_version) ?? 1;
  return {
    id: asNumber(row.id) ?? 0,
    filename: asString(row.filename) ?? '',
    original_name: asString(row.original_name) ?? asString(row.filename) ?? '',
    mime_type: asString(row.mime_type) ?? 'application/octet-stream',
    size_bytes: asNumber(row.size_bytes) ?? 0,
    created_at: asString(row.created_at),
    uploaded_by: asString(row.uploaded_by),
    updated_at: asString(row.updated_at) ?? asString(row.created_at),
    updated_by: asString(row.updated_by) ?? asString(row.uploaded_by),
    current_version: currentVersion,
    current_version_id: asNumber(row.current_version_id),
    file_path: asString(row.file_path),
  };
}

export function shapeProjectFileVersion(value: unknown): AgentHqProjectFileVersion {
  const row = asRecord(value);
  return {
    id: asNumber(row.id) ?? 0,
    tenant_id: asNumber(row.tenant_id) ?? 0,
    project_id: asNumber(row.project_id) ?? 0,
    file_id: asNumber(row.file_id) ?? 0,
    version_number: asNumber(row.version_number) ?? 0,
    filename: asString(row.filename) ?? '',
    original_name: asString(row.original_name) ?? asString(row.filename) ?? '',
    mime_type: asString(row.mime_type) ?? 'application/octet-stream',
    size_bytes: asNumber(row.size_bytes) ?? 0,
    created_by: asString(row.created_by),
    created_at: asString(row.created_at),
    change_source: asString(row.change_source),
  };
}

export function shapeSprintSummary(value: unknown): AgentHqSprintSummary {
  const row = asRecord(value);
  return {
    id: asNumber(row.id) ?? 0,
    project_id: asNumber(row.project_id) ?? 0,
    project_name: asString(row.project_name),
    name: asString(row.name) ?? 'Untitled sprint',
    goal: asString(row.goal),
    status: asString(row.status),
    task_count: asNumber(row.task_count) ?? 0,
    tasks_done: asNumber(row.tasks_done) ?? 0,
    total_story_points: asNumber(row.total_story_points) ?? 0,
    done_story_points: asNumber(row.done_story_points) ?? 0,
    remaining_story_points: asNumber(row.remaining_story_points) ?? 0,
    created_at: asString(row.created_at),
    started_at: asString(row.started_at),
    ended_at: asString(row.ended_at),
  };
}

export function shapeTaskSummary(value: unknown): AgentHqTaskSummary {
  const row = asRecord(value);
  return {
    id: asNumber(row.id) ?? 0,
    title: asString(row.title) ?? 'Untitled task',
    status: asString(row.status),
    priority: asString(row.priority),
    task_type: asString(row.task_type),
    story_points: asNumber(row.story_points),
    project_id: asNumber(row.project_id),
    sprint_id: asNumber(row.sprint_id),
    sprint_name: asString(row.sprint_name),
    agent_id: asNumber(row.agent_id),
    agent_name: asString(row.agent_name),
    active_instance_id: asNumber(row.active_instance_id),
    updated_at: asString(row.updated_at),
    blockers: asArray(row.blockers).map(shapeTaskRef).filter((item): item is NonNullable<typeof item> => item !== null),
    blocking: asArray(row.blocking).map(shapeTaskRef).filter((item): item is NonNullable<typeof item> => item !== null),
  };
}

export function shapeTaskDetail(value: unknown): AgentHqTaskDetail {
  const row = asRecord(value);
  const summary = shapeTaskSummary(row);
  return {
    ...summary,
    description: asString(row.description),
    review_branch: asString(row.review_branch),
    review_commit: asString(row.review_commit),
    review_url: asString(row.review_url),
    qa_verified_commit: asString(row.qa_verified_commit),
    qa_tested_url: asString(row.qa_tested_url),
    merged_commit: asString(row.merged_commit),
    deployed_commit: asString(row.deployed_commit),
    deploy_target: asString(row.deploy_target),
    latest_run_stage: asString(row.latest_run_stage),
    latest_run_outcome: asString(row.latest_run_outcome),
    blocker_reason: asString(row.blocker_reason),
    integrity_state: asString(row.integrity_state),
    integrity_warnings: asStringArray(row.integrity_warnings),
    changed_files: asStringArray(row.changed_files),
  };
}

export function shapeTaskHistoryEntry(value: unknown): AgentHqTaskHistoryEntry {
  const row = asRecord(value);
  return {
    id: asNumber(row.id) ?? 0,
    field: asString(row.field),
    old_value: asString(row.old_value),
    new_value: asString(row.new_value),
    changed_by: asString(row.changed_by),
    created_at: asString(row.created_at),
  };
}

export const VALID_TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export const VALID_TASK_STORY_POINTS = [1, 2, 3, 5, 8, 13, 21] as const;
// Legacy/default seed list only. Workflow-specific task types are resolved from
// workflow definition config and must not be treated as a global enum.
export const VALID_TASK_TYPES = [
  'frontend',
  'backend',
  'fullstack',
  'qa',
  'design',
  'marketing',
  'pm',
  'pm_analysis',
  'pm_operational',
  'ops',
  'data',
  'adhoc',
  'other',
] as const;
export const VALID_TASK_STATUSES = TASK_STATUSES;

export class AgentHqApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey?: string | null,
  ) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    const opts: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);
    const text = await res.text();

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Agent HQ API returned non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      throw new AgentHqApiError(apiErrorMessage(data, `HTTP ${res.status}`), res.status, data);
    }

    return data as T;
  }

  private async requestMultipart<T>(
    method: string,
    path: string,
    body: FormData,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(url, { method, headers, body });
    const text = await res.text();

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Agent HQ API returned non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      throw new AgentHqApiError(apiErrorMessage(data, `HTTP ${res.status}`), res.status, data);
    }

    return data as T;
  }

  private async requestArrayBuffer(
    path: string,
  ): Promise<{ bytes: Buffer; contentType: string | null }> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'x-agent-hq-mcp-client': 'agent-hq-mcp',
    };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    const res = await fetch(url, { method: 'GET', headers });
    const contentType = res.headers.get('content-type');
    if (!res.ok) {
      const text = await res.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Agent HQ API returned HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      throw new AgentHqApiError(apiErrorMessage(data, `HTTP ${res.status}`), res.status, data);
    }

    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType,
    };
  }

  apiRequest(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown) {
    if (!path.startsWith('/api/v1/')) {
      throw new Error('path must start with /api/v1/');
    }
    return this.request<unknown>(method, path, body);
  }

  listProjects() {
    return this.request<unknown[]>('GET', '/api/v1/projects').then((rows) => rows.map(shapeProjectSummary));
  }

  getProject(id: number) {
    return this.request<unknown>('GET', `/api/v1/projects/${id}`).then(shapeProjectSummary);
  }

  createProject(data: {
    name: string;
    description?: string;
    context_md?: string;
    repo_path?: string | null;
    repo_url?: string | null;
    repo_access_mode?: 'worktree' | 'clone' | null;
  }) {
    return this.request<unknown>('POST', '/api/v1/projects', data);
  }

  updateProject(id: number, data: {
    name?: string;
    description?: string;
    context_md?: string;
    repo_path?: string | null;
    repo_url?: string | null;
    repo_access_mode?: 'worktree' | 'clone' | null;
  }) {
    return this.request<unknown>('PUT', `/api/v1/projects/${id}`, data);
  }

  deleteProject(id: number, force?: boolean) {
    const qs = new URLSearchParams();
    if (force) qs.set('force', 'true');
    return this.request<unknown>('DELETE', `/api/v1/projects/${id}${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  listProjectFiles(projectId: number) {
    return this.request<unknown[]>('GET', `/api/v1/projects/${projectId}/files`).then((rows) => rows.map(shapeProjectFile));
  }

  getProjectFile(projectId: number, fileId: number) {
    return this.request<unknown>('GET', `/api/v1/projects/${projectId}/files/${fileId}`).then(shapeProjectFile);
  }

  listProjectFileVersions(projectId: number, fileId: number) {
    return this.request<unknown[]>('GET', `/api/v1/projects/${projectId}/files/${fileId}/versions`).then((rows) => rows.map(shapeProjectFileVersion));
  }

  async downloadProjectFile(projectId: number, fileId: number, includeText = true): Promise<AgentHqProjectFileDownload> {
    const metadata = await this.getProjectFile(projectId, fileId);
    const { bytes, contentType } = await this.requestArrayBuffer(`/api/v1/projects/${projectId}/files/${fileId}/download`);
    const mimeType = metadata.mime_type || contentType;
    return {
      metadata,
      content_base64: bytes.toString('base64'),
      encoding: 'base64',
      text: includeText && isTextMimeType(mimeType) ? bytes.toString('utf8') : null,
    };
  }

  uploadProjectFile(projectId: number, data: {
    filename: string;
    content_base64: string;
    mime_type?: string;
    uploaded_by?: string;
  }) {
    const form = new FormData();
    const bytes = Uint8Array.from(Buffer.from(data.content_base64, 'base64'));
    form.append('file', new Blob([bytes], { type: data.mime_type ?? 'application/octet-stream' }), data.filename);
    if (data.uploaded_by) form.append('uploaded_by', data.uploaded_by);
    return this.requestMultipart<unknown>('POST', `/api/v1/projects/${projectId}/files`, form).then(shapeProjectFile);
  }

  replaceProjectFile(projectId: number, fileId: number, data: {
    filename: string;
    content_base64: string;
    mime_type?: string;
    uploaded_by?: string;
  }) {
    const form = new FormData();
    const bytes = Uint8Array.from(Buffer.from(data.content_base64, 'base64'));
    form.append('file', new Blob([bytes], { type: data.mime_type ?? 'application/octet-stream' }), data.filename);
    if (data.uploaded_by) form.append('uploaded_by', data.uploaded_by);
    return this.requestMultipart<unknown>('PUT', `/api/v1/projects/${projectId}/files/${fileId}`, form).then(shapeProjectFile);
  }

  deleteProjectFile(projectId: number, fileId: number) {
    return this.request<unknown>('DELETE', `/api/v1/projects/${projectId}/files/${fileId}`);
  }

  listSprints(params: { project_id?: number; include_closed?: boolean } = {}) {
    const qs = new URLSearchParams();
    if (params.project_id !== undefined) qs.set('project_id', String(params.project_id));
    if (params.include_closed) qs.set('include_closed', 'true');
    const q = qs.toString();
    return this.request<unknown[]>('GET', `/api/v1/sprints${q ? `?${q}` : ''}`).then((rows) => rows.map(shapeSprintSummary));
  }

  getSprint(id: number) {
    return this.request<unknown>('GET', `/api/v1/sprints/${id}`).then(shapeSprintSummary);
  }

  updateSprint(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/${id}`, data);
  }

  deleteSprint(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/${id}`);
  }

  listTasks(params: {
    project_id?: number;
    sprint_id?: number;
    status?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    const qs = new URLSearchParams();
    if (params.project_id !== undefined) qs.set('project_id', String(params.project_id));
    if (params.sprint_id !== undefined) qs.set('sprint_id', String(params.sprint_id));
    if (params.status) qs.set('status', params.status);
    qs.set('limit', String(Math.min(params.limit ?? 50, 100)));
    qs.set('offset', String(params.offset ?? 0));
    return this.request<unknown>('GET', `/api/v1/tasks?${qs.toString()}`).then((payload) => {
      const body = asRecord(payload);
      const tasks = Array.isArray(payload) ? payload : asArray(body.tasks);
      return {
        tasks: tasks.map(shapeTaskSummary),
        total: asNumber(body.total),
        hasMore: typeof body.hasMore === 'boolean' ? body.hasMore : null,
        limit: asNumber(body.limit),
        offset: asNumber(body.offset),
      };
    });
  }

  getTask(id: number) {
    return this.request<unknown>('GET', `/api/v1/tasks/${id}`).then(shapeTaskDetail);
  }

  getTaskContext(id: number, mode: AgentHqTaskContextMode = 'summary', options: AgentHqTaskContextOptions = {}) {
    const qs = new URLSearchParams();
    qs.set('mode', mode);

    const boolFields: Array<keyof Pick<AgentHqTaskContextOptions, 'includeNotes' | 'includeHistory' | 'includeRuns' | 'includeLease' | 'includeNoisyEvents'>> = [
      'includeNotes',
      'includeHistory',
      'includeRuns',
      'includeLease',
      'includeNoisyEvents',
    ];
    for (const key of boolFields) {
      const value = options[key];
      if (typeof value === 'boolean') qs.set(key, value ? 'true' : 'false');
    }

    const numberFields: Array<keyof Pick<AgentHqTaskContextOptions, 'recentNotesLimit' | 'recentHistoryLimit' | 'recentRunsLimit' | 'recentExternalEventsLimit' | 'timelineLimit' | 'sinceNoteId' | 'sinceHistoryId'>> = [
      'recentNotesLimit',
      'recentHistoryLimit',
      'recentRunsLimit',
      'recentExternalEventsLimit',
      'timelineLimit',
      'sinceNoteId',
      'sinceHistoryId',
    ];
    for (const key of numberFields) {
      const value = options[key];
      if (typeof value === 'number' && Number.isFinite(value)) qs.set(key, String(Math.trunc(value)));
    }

    if (options.sinceTimestamp) qs.set('sinceTimestamp', options.sinceTimestamp);

    return this.request<AgentHqTaskContextResponse>('GET', `/api/v1/tasks/${id}/context?${qs.toString()}`);
  }

  deleteTask(id: number, deletedBy?: string) {
    const qs = new URLSearchParams();
    if (deletedBy) qs.set('deleted_by', deletedBy);
    return this.request<unknown>('DELETE', `/api/v1/tasks/${id}${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  getTaskNotes(id: number) {
    return this.request<unknown[]>('GET', `/api/v1/tasks/${id}/notes`);
  }

  getTaskHistory(id: number) {
    return this.request<unknown[]>('GET', `/api/v1/tasks/${id}/history`).then((rows) => rows.map(shapeTaskHistoryEntry));
  }

  getTaskRelationshipTypes(id: number) {
    return this.request<unknown>('GET', `/api/v1/tasks/${id}/relationship-types`);
  }

  listTaskRelationships(id: number) {
    return this.request<unknown>('GET', `/api/v1/tasks/${id}/relationships`);
  }

  createTaskRelationship(id: number, data: {
    target_task_id: number;
    relationship_type_key: string;
    metadata?: Record<string, unknown>;
    created_by?: string;
  }) {
    return this.request<unknown>('POST', `/api/v1/tasks/${id}/relationships`, {
      target_task_id: data.target_task_id,
      relationship_type_key: data.relationship_type_key,
      metadata: data.metadata,
      created_by: data.created_by ?? 'Agent HQ MCP',
    });
  }

  deleteTaskRelationship(id: number, relationshipId: number) {
    return this.request<unknown>('DELETE', `/api/v1/tasks/${id}/relationships/${relationshipId}`);
  }

  createTask(data: {
    title: string;
    project_id: number;
    description?: string;
    sprint_id: number;
    priority?: string;
    task_type?: string;
    story_points?: number | null;
    custom_fields?: Record<string, unknown>;
    agent_id?: number | null;
    blockers?: number[];
    changed_by?: string;
    dry_run?: boolean;
  }) {
    if (data.dry_run) {
      return Promise.resolve({
        dry_run: true,
        preview: {
          method: 'POST',
          path: '/api/v1/tasks',
          body: {
            title: data.title,
            project_id: data.project_id,
            description: data.description ?? '',
            sprint_id: data.sprint_id,
            priority: data.priority ?? 'medium',
            task_type: data.task_type ?? 'backend',
            story_points: data.story_points ?? null,
            custom_fields: data.custom_fields ?? {},
            agent_id: data.agent_id ?? null,
            blockers: data.blockers ?? [],
            changed_by: data.changed_by ?? 'Agent HQ',
          },
        },
      });
    }
    return this.request<unknown>('POST', '/api/v1/tasks', {
      title: data.title,
      project_id: data.project_id,
      description: data.description,
      sprint_id: data.sprint_id,
      priority: data.priority,
      task_type: data.task_type,
      story_points: data.story_points,
      custom_fields: data.custom_fields,
      agent_id: data.agent_id,
      blockers: data.blockers,
      changed_by: data.changed_by ?? 'Agent HQ',
    });
  }

  updateTask(
    id: number,
    data: {
      title?: string;
      description?: string;
      priority?: string;
      sprint_id?: number;
      task_type?: string;
      story_points?: number | null;
      custom_fields?: Record<string, unknown>;
      agent_id?: number | null;
      changed_by?: string;
      dry_run?: boolean;
    },
  ) {
    if (data.dry_run) {
      return Promise.resolve({
        dry_run: true,
        preview: {
          method: 'PUT',
          path: `/api/v1/tasks/${id}`,
          body: {
            ...data,
            changed_by: data.changed_by ?? 'Agent HQ',
          },
        },
      });
    }
    return this.request<unknown>('PUT', `/api/v1/tasks/${id}`, {
      ...data,
      changed_by: data.changed_by ?? 'Agent HQ',
    });
  }

  addTaskNote(id: number, content: string, author: string = 'mcp-client') {
    return this.request<unknown>('POST', `/api/v1/tasks/${id}/notes`, {
      content,
      author,
      source: 'mcp',
    });
  }

  startInstance(id: number, data: {
    summary?: string;
    session_key?: string;
    notes?: string;
  } = {}) {
    return this.request<unknown>('PUT', `/api/v1/instances/${id}/start`, data);
  }

  checkInInstance(id: number, data: AgentHqLifecycleCheckIn) {
    return this.request<unknown>('POST', `/api/v1/instances/${id}/check-in`, data);
  }

  recordReviewEvidence(id: number, data: {
    review_branch: string;
    review_commit: string;
    review_url?: string;
    summary?: string;
  }) {
    return this.request<unknown>('PUT', `/api/v1/tasks/${id}/review-evidence`, data);
  }

  recordQaEvidence(id: number, data: {
    qa_verified_commit: string;
    qa_tested_url?: string;
    notes?: string;
  }) {
    return this.request<unknown>('PUT', `/api/v1/tasks/${id}/qa-evidence`, data);
  }

  recordDeployEvidence(id: number, data: {
    merged_commit?: string;
    deployed_commit: string;
    deploy_target: string;
    deployed_at?: string;
    summary?: string;
  }) {
    return this.request<unknown>('PUT', `/api/v1/tasks/${id}/deploy-evidence`, data);
  }

  recordLiveVerification(id: number, data: {
    live_verified_by: string;
    live_verified_at?: string;
    summary?: string;
  }) {
    return this.request<unknown>('PUT', `/api/v1/tasks/${id}/live-verification`, data);
  }

  postTaskOutcome(id: number, data: {
    outcome: string;
    summary?: string;
    payload?: Record<string, unknown>;
    dry_run?: boolean;
    // Legacy/admin REST callers may still pass explicit fields. The normal MCP
    // tool schema exposes only payload.
    changed_by?: string;
    instance_id?: number;
    review_branch?: string;
    review_commit?: string;
    review_url?: string;
    qa_verified_commit?: string;
    qa_tested_url?: string;
    merged_commit?: string;
    deployed_commit?: string;
    deploy_target?: string;
    deployed_at?: string;
    live_verified_by?: string;
    live_verified_at?: string;
    blocker_reason?: string;
    failure_detail?: string;
  }) {
    return this.request<unknown>('POST', `/api/v1/tasks/${id}/outcome`, data);
  }

  addBlocker(taskId: number, blockedByTaskId: number, dryRun?: boolean) {
    if (dryRun) {
      return Promise.resolve({
        dry_run: true,
        deprecation_warning: 'agent_hq_add_blocker is legacy compatibility. Prefer agent_hq_get_task_relationship_types plus agent_hq_create_task_relationship with a configured dispatch-blocking relationship type.',
        preview: {
          method: 'POST',
          path: `/api/v1/tasks/${taskId}/blockers`,
          body: { blocker_id: blockedByTaskId },
        },
      });
    }
    return this.request<unknown>('POST', `/api/v1/tasks/${taskId}/blockers`, {
      blocker_id: blockedByTaskId,
    });
  }

  removeBlocker(taskId: number, blockerId: number) {
    return this.request<unknown>('DELETE', `/api/v1/tasks/${taskId}/blockers/${blockerId}`);
  }

  createSprint(data: {
    project_id: number;
    name: string;
    goal?: string;
    sprint_type?: string;
    source_sprint_id?: number;
    status?: 'planning' | 'active' | 'paused' | 'complete' | 'closed';
    length_kind?: 'time' | 'runs';
    length_value?: string;
    started_at?: string | null;
    dry_run?: boolean;
  }) {
    if (data.dry_run) {
      return Promise.resolve({
        dry_run: true,
        preview: {
          method: 'POST',
          path: '/api/v1/sprints',
          body: {
            project_id: data.project_id,
            name: data.name,
            goal: data.goal ?? '',
            sprint_type: data.sprint_type,
            source_sprint_id: data.source_sprint_id,
            status: data.status ?? 'planning',
            length_kind: data.length_kind ?? 'time',
            length_value: data.length_value ?? '',
            started_at: data.started_at ?? null,
          },
        },
      });
    }
    return this.request<unknown>('POST', '/api/v1/sprints', data);
  }

  private async resolveConfiguredOutcomeForStatus(taskId: number, targetStatus: string): Promise<string | null> {
    let task: AgentHqTaskDetail;
    try {
      task = await this.getTask(taskId);
    } catch {
      return null;
    }

    if (!task.status || task.project_id == null || task.sprint_id == null) return null;

    let payload: unknown;
    try {
      payload = await this.listRoutingTransitions({ project_id: task.project_id, sprint_id: task.sprint_id });
    } catch {
      return null;
    }

    const transitions = asArray(asRecord(payload).transitions)
      .map(asRecord)
      .filter((transition) => {
        const enabled = transition.enabled;
        return asString(transition.from_status) === task.status
          && asString(transition.to_status) === targetStatus
          && asString(transition.outcome)
          && (enabled === undefined || enabled === null || enabled === true || enabled === 1 || enabled === '1')
          && (asString(transition.task_type) == null || asString(transition.task_type) === task.task_type);
      })
      .sort((left, right) => {
        const leftSpecific = asString(left.task_type) ? 1 : 0;
        const rightSpecific = asString(right.task_type) ? 1 : 0;
        if (leftSpecific !== rightSpecific) return rightSpecific - leftSpecific;
        return (asNumber(right.priority) ?? 0) - (asNumber(left.priority) ?? 0);
      });

    return asString(transitions[0]?.outcome);
  }

  async moveTask(
    id: number,
    data: {
      status: string;
      summary?: string;
      changed_by?: string;
      review_branch?: string;
      review_commit?: string;
      review_url?: string;
      qa_verified_commit?: string;
      qa_tested_url?: string;
      merged_commit?: string;
      deployed_commit?: string;
      deploy_target?: string;
      deployed_at?: string;
      live_verified_by?: string;
      live_verified_at?: string;
      failure_detail?: string;
      dry_run?: boolean;
    },
  ) {
    // Compatibility bridge for status-targeted MCP moves.
    // The canonical backend truth is still outcome-driven. These aliases only
    // cover the legacy/default lifecycle statuses, while sprint-type workflows
    // may expose different configured outcome keys.
    const statusToOutcome: Record<string, string> = {
      review: 'completed_for_review',
      dev_deploy_queued: 'dev_deploy_queued',
      qa_pass: 'qa_pass',
      deployed: 'deployed_live',
      done: 'live_verified',
    };

    const outcome = await this.resolveConfiguredOutcomeForStatus(id, data.status)
      ?? statusToOutcome[data.status];
    if (outcome) {
      const body = {
        outcome,
        summary: data.summary,
        changed_by: data.changed_by ?? 'Agent HQ',
        review_branch: data.review_branch,
        review_commit: data.review_commit,
        review_url: data.review_url,
        qa_verified_commit: data.qa_verified_commit,
        qa_tested_url: data.qa_tested_url,
        merged_commit: data.merged_commit,
        deployed_commit: data.deployed_commit,
        deploy_target: data.deploy_target,
        deployed_at: data.deployed_at,
        live_verified_by: data.live_verified_by,
        live_verified_at: data.live_verified_at,
        failure_detail: data.failure_detail,
      };
      if (data.dry_run) {
        return Promise.resolve({
          dry_run: true,
          preview: {
            method: 'POST',
            path: `/api/v1/tasks/${id}/outcome`,
            body,
          },
        });
      }
      return this.request<unknown>('POST', `/api/v1/tasks/${id}/outcome`, body);
    }

    const body = {
      status: data.status,
      changed_by: data.changed_by ?? 'Agent HQ',
    };
    if (data.dry_run) {
      return Promise.resolve({
        dry_run: true,
        preview: {
          method: 'PUT',
          path: `/api/v1/tasks/${id}`,
          body,
        },
      });
    }
    return this.request<unknown>('PUT', `/api/v1/tasks/${id}`, body);
  }

  listAgents(params: { project_id?: number } = {}) {
    const qs = new URLSearchParams();
    if (params.project_id !== undefined) qs.set('project_id', String(params.project_id));
    const q = qs.toString();
    return this.request<unknown[]>('GET', `/api/v1/agents${q ? `?${q}` : ''}`);
  }

  getAgent(id: number) {
    return this.request<unknown>('GET', `/api/v1/agents/${id}`);
  }

  createAgent(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/agents', data);
  }

  provisionFullAgent(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/agents/provision-full', data);
  }

  updateAgent(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/agents/${id}`, data);
  }

  deleteAgent(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/agents/${id}`);
  }

  getAgentDocs(id: number) {
    return this.request<unknown>('GET', `/api/v1/agents/${id}/docs`);
  }

  syncAgentMcp(id: number, workingDirectory?: string) {
    return this.request<unknown>('POST', `/api/v1/agents/${id}/mcp/sync`, workingDirectory ? { working_directory: workingDirectory } : {});
  }

  listTools() {
    return this.request<unknown[]>('GET', '/api/v1/tools');
  }

  getTool(id: number) {
    return this.request<unknown>('GET', `/api/v1/tools/${id}`);
  }

  createTool(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/tools', data);
  }

  updateTool(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/tools/${id}`, data);
  }

  deleteTool(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/tools/${id}`);
  }

  testTool(id: number, input: Record<string, unknown>) {
    return this.request<unknown>('POST', `/api/v1/tools/${id}/test`, { input });
  }

  listAgentTools(agentId: number) {
    return this.request<unknown[]>('GET', `/api/v1/agents/${agentId}/tools`);
  }

  assignToolToAgent(agentId: number, toolId: number, overrides?: Record<string, unknown>, enabled?: boolean) {
    return this.request<unknown>('POST', `/api/v1/agents/${agentId}/tools`, {
      tool_id: toolId,
      ...(overrides ? { overrides } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
  }

  removeToolFromAgent(agentId: number, toolId: number) {
    return this.request<unknown>('DELETE', `/api/v1/agents/${agentId}/tools/${toolId}`);
  }

  listSkills() {
    return this.request<unknown[]>('GET', '/api/v1/skills');
  }

  listAgentSkills(agentId: number) {
    return this.request<unknown>('GET', `/api/v1/agents/${agentId}/skills`);
  }

  assignSkillToAgent(agentId: number, input: { skill_name?: string; skill_id?: number }) {
    return this.request<unknown>('POST', `/api/v1/agents/${agentId}/skills`, input);
  }

  removeSkillFromAgent(agentId: number, skillIdentifier: string | number | { skill_name?: string; skill_id?: number | string }) {
    if (typeof skillIdentifier === 'object' && skillIdentifier !== null) {
      const identifier = skillIdentifier.skill_name ?? skillIdentifier.skill_id ?? '';
      return this.request<unknown>('DELETE', `/api/v1/agents/${agentId}/skills/${encodeURIComponent(String(identifier))}`, skillIdentifier);
    }
    return this.request<unknown>('DELETE', `/api/v1/agents/${agentId}/skills/${encodeURIComponent(String(skillIdentifier))}`);
  }

  getSkill(name: string) {
    return this.request<unknown>('GET', `/api/v1/skills/${encodeURIComponent(name)}`);
  }

  createSkill(data: { name: string; description?: string; content?: string }) {
    return this.request<unknown>('POST', '/api/v1/skills', data);
  }

  updateSkill(name: string, content: string) {
    return this.request<unknown>('PUT', `/api/v1/skills/${encodeURIComponent(name)}`, { content });
  }

  deleteSkill(name: string) {
    return this.request<unknown>('DELETE', `/api/v1/skills/${encodeURIComponent(name)}`);
  }

  listMcpServers() {
    return this.request<unknown[]>('GET', '/api/v1/mcp-servers');
  }

  getMcpServer(id: number) {
    return this.request<unknown>('GET', `/api/v1/mcp-servers/${id}`);
  }

  createMcpServer(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/mcp-servers', data);
  }

  updateMcpServer(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/mcp-servers/${id}`, data);
  }

  deleteMcpServer(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/mcp-servers/${id}`);
  }

  listAgentMcpServers(agentId: number) {
    return this.request<unknown[]>('GET', `/api/v1/agents/${agentId}/mcp-servers`);
  }

  assignMcpServerToAgent(agentId: number, mcpServerId: number, overrides?: Record<string, unknown>, enabled?: boolean) {
    return this.request<unknown>('POST', `/api/v1/agents/${agentId}/mcp-servers`, {
      mcp_server_id: mcpServerId,
      ...(overrides ? { overrides } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    });
  }

  removeMcpServerFromAgent(agentId: number, mcpServerId: number) {
    return this.request<unknown>('DELETE', `/api/v1/agents/${agentId}/mcp-servers/${mcpServerId}`);
  }

  listRoutingRules(params: { tenant_id?: number; project_id?: number; sprint_id?: number; sprint_type?: string; scope?: string; status?: string; task_type?: string | null } = {}) {
    return this.request<unknown>('GET', appendQuery('/api/v1/routing/rules', params));
  }

  listAssignmentRules(params: { tenant_id?: number; project_id?: number; sprint_id?: number; sprint_type?: string; scope?: string; status?: string; task_type?: string | null } = {}) {
    return this.request<unknown>('GET', appendQuery('/api/v1/routing/assignment-rules', params));
  }

  getRoutingRule(ruleId: number, params: { tenant_id?: number; project_id?: number; sprint_id?: number; sprint_type?: string; scope?: string; status?: string; task_type?: string | null } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/routing/rules/${ruleId}`, params));
  }

  getAssignmentRule(ruleId: number, params: { tenant_id?: number; project_id?: number; sprint_id?: number; sprint_type?: string; scope?: string; status?: string; task_type?: string | null } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/routing/assignment-rules/${ruleId}`, params));
  }

  createRoutingRule(data: Record<string, unknown>) {
    return this.request<unknown>('POST', appendQuery('/api/v1/routing/rules', tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  createAssignmentRule(data: Record<string, unknown>) {
    return this.request<unknown>('POST', appendQuery('/api/v1/routing/assignment-rules', tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  updateRoutingRule(ruleId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', appendQuery(`/api/v1/routing/rules/${ruleId}`, tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  updateAssignmentRule(ruleId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', appendQuery(`/api/v1/routing/assignment-rules/${ruleId}`, tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  deleteRoutingRule(ruleId: number, params: { tenant_id?: number; project_id?: number; sprint_id?: number; sprint_type?: string; scope?: string; status?: string; task_type?: string | null; dry_run?: boolean } = {}) {
    return this.request<unknown>('DELETE', appendQuery(`/api/v1/routing/rules/${ruleId}`, params));
  }

  deleteAssignmentRule(ruleId: number, params: { tenant_id?: number; project_id?: number; sprint_id?: number; sprint_type?: string; scope?: string; status?: string; task_type?: string | null; dry_run?: boolean } = {}) {
    return this.request<unknown>('DELETE', appendQuery(`/api/v1/routing/assignment-rules/${ruleId}`, params));
  }

  listWorkflowEventMappings(params: { tenant_id?: number; project_id?: number; source?: string; event_name?: string; task_type?: string } = {}) {
    return this.request<unknown>('GET', appendQuery('/api/v1/routing/workflow-event-mappings', params));
  }

  getWorkflowEventMapping(mappingId: number, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/routing/workflow-event-mappings/${mappingId}`, params));
  }

  createWorkflowEventMapping(data: Record<string, unknown>) {
    return this.request<unknown>('POST', appendQuery('/api/v1/routing/workflow-event-mappings', tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  updateWorkflowEventMapping(mappingId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', appendQuery(`/api/v1/routing/workflow-event-mappings/${mappingId}`, tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  deleteWorkflowEventMapping(mappingId: number, params: { tenant_id?: number; dry_run?: boolean } = {}) {
    return this.request<unknown>('DELETE', appendQuery(`/api/v1/routing/workflow-event-mappings/${mappingId}`, params));
  }

  getAgentDispatchContract(params: { sprint_type?: string; sprint_type_key?: string } = {}) {
    return this.request<unknown>('GET', appendQuery('/api/v1/routing/agent-contract', params));
  }

  updateAgentDispatchContract(data: { sprint_type?: string; sprint_type_key?: string; content: string }) {
    return this.request<unknown>('PUT', '/api/v1/routing/agent-contract', data);
  }

  listRoutingTransitions(params: { tenant_id?: number; sprint_id?: number; project_id?: number; sprint_type?: string } = {}) {
    return this.request<unknown>('GET', appendQuery('/api/v1/routing/transitions', {
      ...(params.tenant_id !== undefined ? { tenant_id: params.tenant_id } : {}),
      sprint_id: params.sprint_id,
      project_id: params.project_id,
      sprint_type: params.sprint_type,
    }));
  }

  getRoutingTransition(transitionId: number, params: { tenant_id?: number; sprint_id?: number; project_id?: number; sprint_type?: string } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/routing/transitions/${transitionId}`, {
      ...(params.tenant_id !== undefined ? { tenant_id: params.tenant_id } : {}),
      sprint_id: params.sprint_id,
      project_id: params.project_id,
      sprint_type: params.sprint_type,
    }));
  }

  createRoutingTransition(data: Record<string, unknown>) {
    return this.request<unknown>('POST', appendQuery('/api/v1/routing/transitions', tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  updateRoutingTransition(transitionId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', appendQuery(`/api/v1/routing/transitions/${transitionId}`, tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  deleteRoutingTransition(transitionId: number, data?: { tenant_id?: number; sprint_id?: number; project_id?: number; sprint_type?: string; dry_run?: boolean }) {
    return this.request<unknown>('DELETE', appendQuery(`/api/v1/routing/transitions/${transitionId}`, {
      ...(data?.tenant_id !== undefined ? { tenant_id: data.tenant_id } : {}),
      sprint_id: data?.sprint_id,
      project_id: data?.project_id,
      sprint_type: data?.sprint_type,
      dry_run: data?.dry_run,
    }));
  }

  listSprintTypes(params: { tenant_id?: number } = {}) {
    return this.request<unknown[]>('GET', appendQuery('/api/v1/sprints/types/list', params));
  }

  createSprintType(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/sprints/types', data);
  }

  updateSprintType(key: string, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(key)}`, data);
  }

  deleteSprintType(key: string) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/types/${encodeURIComponent(key)}`);
  }

  listSprintTypeTaskTypes(sprintTypeKey: string, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/task-types`, params));
  }

  updateSprintTypeTaskTypes(sprintTypeKey: string, taskTypes: string[]) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/task-types`, { task_types: taskTypes });
  }

  listTaskFieldSchemas(sprintTypeKey: string, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`, params));
  }

  getTaskFieldSchema(sprintTypeKey: string, schemaId: number, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${schemaId}`, params));
  }

  createTaskFieldSchema(sprintTypeKey: string, data: Record<string, unknown>) {
    return this.request<unknown>('POST', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`, data);
  }

  updateTaskFieldSchema(sprintTypeKey: string, schemaId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${schemaId}`, data);
  }

  deleteTaskFieldSchema(sprintTypeKey: string, schemaId: number) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${schemaId}`);
  }

  getWorkflowConfig() {
    return this.request<unknown>('GET', '/api/v1/sprints/config');
  }

  getWorkflowMetadata(params: { tenant_id?: number; sprint_id?: number; sprint_type?: string; task_type?: string } = {}) {
    return this.request<unknown>('GET', appendQuery('/api/v1/sprints/workflow-metadata', params));
  }

  listTransitionRequirementFields(params: { tenant_id?: number; sprint_id?: number; sprint_type?: string; task_type?: string } = {}) {
    return this.request<unknown>('GET', appendQuery('/api/v1/routing/transition-requirement-fields', params));
  }

  listSprintTypeStatuses(sprintTypeKey: string, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/statuses`, params));
  }

  getSprintTypeStatus(sprintTypeKey: string, statusKey: string, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/statuses/${encodeURIComponent(statusKey)}`, params));
  }

  createSprintTypeStatus(sprintTypeKey: string, data: Record<string, unknown>) {
    return this.request<unknown>('POST', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/statuses`, data);
  }

  updateSprintTypeStatus(sprintTypeKey: string, statusKey: string, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/statuses/${encodeURIComponent(statusKey)}`, data);
  }

  deleteSprintTypeStatus(sprintTypeKey: string, statusKey: string) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/statuses/${encodeURIComponent(statusKey)}`);
  }

  listSprintTypeOutcomes(sprintTypeKey: string, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/outcomes`, params));
  }

  getSprintTypeOutcome(sprintTypeKey: string, outcomeId: number, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/outcomes/${outcomeId}`, params));
  }

  createSprintTypeOutcome(sprintTypeKey: string, data: Record<string, unknown>) {
    return this.request<unknown>('POST', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/outcomes`, data);
  }

  updateSprintTypeOutcome(sprintTypeKey: string, outcomeId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/outcomes/${outcomeId}`, data);
  }

  deleteSprintTypeOutcome(sprintTypeKey: string, outcomeId: number) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/outcomes/${outcomeId}`);
  }

  listSprintTypeRelationshipTypes(sprintTypeKey: string, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/relationship-types`, params));
  }

  getSprintTypeRelationshipType(sprintTypeKey: string, relationshipTypeId: number, params: { tenant_id?: number } = {}) {
    return this.request<unknown>('GET', appendQuery(`/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/relationship-types/${relationshipTypeId}`, params));
  }

  createSprintTypeRelationshipType(sprintTypeKey: string, data: Record<string, unknown>) {
    return this.request<unknown>('POST', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/relationship-types`, data);
  }

  updateSprintTypeRelationshipType(sprintTypeKey: string, relationshipTypeId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/relationship-types/${relationshipTypeId}`, data);
  }

  deleteSprintTypeRelationshipType(sprintTypeKey: string, relationshipTypeId: number) {
    return this.request<unknown>('DELETE', `/api/v1/sprints/types/${encodeURIComponent(sprintTypeKey)}/relationship-types/${relationshipTypeId}`);
  }

  listTransitionRequirements(params: { tenant_id?: number; sprint_id?: number; project_id?: number; sprint_type?: string; task_type?: string; outcome?: string } = {}) {
    return this.request<unknown>('GET', appendQuery('/api/v1/routing/transition-requirements', params));
  }

  createTransitionRequirement(data: Record<string, unknown>) {
    return this.request<unknown>('POST', appendQuery('/api/v1/routing/transition-requirements', tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  updateTransitionRequirement(requirementId: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', appendQuery(`/api/v1/routing/transition-requirements/${requirementId}`, tenantSelectorQuery(data)), omitTenantSelector(data));
  }

  deleteTransitionRequirement(requirementId: number, params: { tenant_id?: number; sprint_id?: number; project_id?: number; sprint_type?: string; dry_run?: boolean } = {}) {
    return this.request<unknown>('DELETE', appendQuery(`/api/v1/routing/transition-requirements/${requirementId}`, params));
  }

  listModelRoutingRules(params?: { project_id?: number; sprint_id?: number; sprint_type?: string }) {
    const qs = new URLSearchParams();
    if (params?.project_id) qs.set('project_id', String(params.project_id));
    if (params?.sprint_id) qs.set('sprint_id', String(params.sprint_id));
    if (params?.sprint_type) qs.set('sprint_type', params.sprint_type);
    return this.request<unknown[]>('GET', `/api/v1/model-routing${qs.toString() ? `?${qs.toString()}` : ''}`);
  }

  listStoryPointRoutingRules() {
    return this.request<unknown[]>('GET', '/api/v1/story-point-routing');
  }

  getModelRoutingRule(id: number) {
    return this.request<unknown>('GET', `/api/v1/model-routing/${id}`);
  }

  getStoryPointRoutingRule(id: number) {
    return this.request<unknown>('GET', `/api/v1/story-point-routing/${id}`);
  }

  createModelRoutingRule(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/model-routing', data);
  }

  createStoryPointRoutingRule(data: Record<string, unknown>) {
    return this.request<unknown>('POST', '/api/v1/story-point-routing', data);
  }

  updateModelRoutingRule(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/model-routing/${id}`, data);
  }

  updateStoryPointRoutingRule(id: number, data: Record<string, unknown>) {
    return this.request<unknown>('PUT', `/api/v1/story-point-routing/${id}`, data);
  }

  deleteModelRoutingRule(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/model-routing/${id}`);
  }

  deleteStoryPointRoutingRule(id: number) {
    return this.request<unknown>('DELETE', `/api/v1/story-point-routing/${id}`);
  }
}
