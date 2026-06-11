import type { NextFunction, Request, Response } from 'express';

type JsonValue =
  | null
  | string
  | number
  | boolean
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

const REQUEST_FIELD_ALIASES: Array<[workflowField: string, sprintField: string]> = [
  ['workflow_id', 'sprint_id'],
  ['workflow_type', 'sprint_type'],
  ['workflow_type_key', 'sprint_type_key'],
  ['source_workflow_id', 'source_sprint_id'],
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function copyAliasFields(target: Record<string, unknown>): void {
  for (const [workflowField, sprintField] of REQUEST_FIELD_ALIASES) {
    if (target[sprintField] === undefined && target[workflowField] !== undefined) {
      target[sprintField] = target[workflowField];
    }
    delete target[workflowField];
  }
}

function normalizeRequestAliasObject(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) normalizeRequestAliasObject(item);
    return;
  }
  if (!isPlainObject(value)) return;
  copyAliasFields(value);
  for (const item of Object.values(value)) normalizeRequestAliasObject(item);
}

export function normalizeWorkflowRequestAliases(req: Request, _res: Response, next: NextFunction): void {
  normalizeRequestAliasObject(req.query);
  normalizeRequestAliasObject(req.body);
  next();
}

export function addWorkflowCompatibilityFields<T>(payload: T): T {
  if (Array.isArray(payload)) {
    return payload.map((item) => addWorkflowCompatibilityFields(item)) as T;
  }
  if (!isPlainObject(payload)) return payload;

  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    mapped[key] = addWorkflowCompatibilityFields(value as JsonValue);
  }

  if (mapped.workflow_id === undefined && mapped.sprint_id !== undefined) {
    mapped.workflow_id = mapped.sprint_id;
  }
  if (
    mapped.workflow_id === undefined
    && mapped.id !== undefined
    && (mapped.sprint_type !== undefined || mapped.project_name !== undefined || mapped.task_count !== undefined)
  ) {
    mapped.workflow_id = mapped.id;
  }
  if (mapped.workflow_type === undefined && mapped.sprint_type !== undefined) {
    mapped.workflow_type = mapped.sprint_type;
  }
  if (mapped.workflow_type_key === undefined && mapped.sprint_type_key !== undefined) {
    mapped.workflow_type_key = mapped.sprint_type_key;
  }
  if (mapped.source_workflow_id === undefined && mapped.source_sprint_id !== undefined) {
    mapped.source_workflow_id = mapped.source_sprint_id;
  }

  return mapped as T;
}

export function workflowAliasResponseMiddleware(_req: Request, res: Response, next: NextFunction): void {
  const originalJson = res.json.bind(res);
  res.json = ((body?: unknown) => originalJson(addWorkflowCompatibilityFields(body))) as Response['json'];
  next();
}
