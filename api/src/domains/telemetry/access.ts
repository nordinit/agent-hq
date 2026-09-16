import type { Request } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/adapter/types';
import { resolveTenantIdFromRequest } from '../../lib/tenantContext';

export class TelemetryError extends Error {
  constructor(public code: string, message: string, public status = 400, public details?: unknown) { super(message); }
}
export const scopeSchema = z.object({
  project_id: z.number().int().positive().optional(),
  workflow_id: z.number().int().positive().optional(),
  workflow_type: z.string().trim().min(1).max(128).optional(),
  task_type: z.string().trim().min(1).max(128).optional(),
  include_archived: z.boolean().optional(),
}).strict();
export type TelemetryScope = z.infer<typeof scopeSchema>;
export interface TelemetryAccess { tenantId: number; projectId: number | null; actor: string }
export async function telemetryAccess(db: Db, req: Request): Promise<TelemetryAccess> {
  const tenantId = await resolveTenantIdFromRequest(db, req);
  if (req.telemetryProjectId != null) return {tenantId,projectId:req.telemetryProjectId,actor:req.mcpIdentity?.auditActor??'local_operator'};
  if (!req.mcpIdentity) return { tenantId, projectId: null, actor: 'local_operator' };
  if (req.mcpIdentity.keyRole !== 'scoped') return { tenantId, projectId: null, actor: req.mcpIdentity.auditActor };
  const agent = await db.get<{ project_id: number | null }>('SELECT project_id FROM agents WHERE id = ? AND tenant_id = ?', req.mcpIdentity.agentId, tenantId);
  if (!agent?.project_id) throw new TelemetryError('forbidden', 'Telemetry requires an assigned project for this credential.', 403);
  return { tenantId, projectId: Number(agent.project_id), actor: req.mcpIdentity.auditActor };
}
export function scopeKey(scope: TelemetryScope): string {
  return JSON.stringify([scope.project_id ?? null, scope.workflow_id ?? null, scope.workflow_type ?? null, scope.task_type ?? null]);
}
export function queryScope(query: Record<string, unknown>): TelemetryScope {
  const result: Record<string, unknown> = {};
  for (const key of ['project_id','workflow_id','workflow_type','task_type']) {
    if (query[key] !== undefined && query[key] !== '') result[key] = key.endsWith('_id') ? Number(query[key]) : query[key];
  }
  if(query.include_archived!==undefined) {
    if(!['true','false',true,false].includes(query.include_archived as any)) throw new TelemetryError('invalid_definition','include_archived must be a boolean.');
    result.include_archived=query.include_archived===true||query.include_archived==='true';
  }
  return scopeSchema.parse(result);
}
export async function resolveScope(db: Db, access: TelemetryAccess, raw: unknown = {}, write = false): Promise<TelemetryScope> {
  const scope = scopeSchema.parse(raw);
  if(write) delete scope.include_archived;
  if (access.projectId != null) {
    if (scope.project_id != null && scope.project_id !== access.projectId) throw new TelemetryError('forbidden', 'Project is outside your telemetry scope.', 403);
    scope.project_id = access.projectId;
  }
  if (scope.project_id != null && !await db.get('SELECT id FROM projects WHERE id = ? AND tenant_id = ?', scope.project_id, access.tenantId)) throw new TelemetryError('not_found', 'Project not found.', 404);
  if (scope.workflow_id != null) {
    const workflow = await db.get<{project_id:number;sprint_type:string}>('SELECT project_id, sprint_type FROM sprints WHERE id = ? AND tenant_id = ?', scope.workflow_id, access.tenantId);
    if (!workflow || (scope.project_id != null && Number(workflow.project_id) !== scope.project_id)) throw new TelemetryError('not_found', 'Workflow not found in this scope.', 404);
    if (scope.workflow_type && scope.workflow_type !== workflow.sprint_type) throw new TelemetryError('invalid_definition', 'Workflow and workflow type disagree.');
    scope.project_id = Number(workflow.project_id); scope.workflow_type = workflow.sprint_type;
  }
  if (scope.workflow_type) {
    const type = await db.get<{project_id:number|null}>('SELECT project_id FROM sprint_types WHERE tenant_id = ? AND key = ?', access.tenantId, scope.workflow_type);
    if (!type) throw new TelemetryError('unknown_reference', 'Workflow type not found.', 404);
    if (type.project_id != null) {
      if (scope.project_id != null && Number(type.project_id) !== scope.project_id) throw new TelemetryError('forbidden', 'Workflow type belongs to another project.', 403);
      scope.project_id = Number(type.project_id);
    }
  }
  if (write && scope.task_type && !scope.workflow_type && !scope.workflow_id) throw new TelemetryError('invalid_definition', 'Task type bindings require a workflow type or workflow.');
  if (scope.task_type && scope.workflow_type && !await db.get('SELECT id FROM sprint_type_task_types WHERE tenant_id = ? AND sprint_type_key = ? AND task_type = ?', access.tenantId, scope.workflow_type, scope.task_type)) throw new TelemetryError('unknown_reference', 'Task type not found in this workflow type.');
  return scope;
}
/** A definition may narrow its caller's population, never widen it. */
export function intersectScopes(base: TelemetryScope, narrow: TelemetryScope): TelemetryScope {
  const merged = { ...base };
  for (const key of Object.keys(narrow) as (keyof TelemetryScope)[]) {
    if (base[key] !== undefined && base[key] !== narrow[key]) throw new TelemetryError('incompatible_scope', `Conflicting ${key} filters.`);
    Object.assign(merged, { [key]: narrow[key] });
  }
  return merged;
}
export function scopeMatches(binding: TelemetryScope, context: TelemetryScope): boolean {
  return (Object.keys(binding) as (keyof TelemetryScope)[]).filter(key=>key!=='include_archived').every(key => binding[key] === context[key]);
}
export function bindingRank(scope: TelemetryScope): number {
  if (scope.workflow_id) return scope.task_type ? 8 : 7;
  if (scope.project_id && scope.workflow_type) return scope.task_type ? 6 : 5;
  if (scope.workflow_type) return scope.task_type ? 4 : 3;
  return scope.project_id ? 2 : 1;
}
