/**
 * The operator-facing view of a dispatch: what was in the prompt, what surrounded it, and what
 * changed since the previous run of the same task.
 *
 * One request rather than three. The viewer needs the prompt, the runtime boundary, and the diff
 * together or not at all, and splitting them would mean three round trips to answer one question.
 * This mirrors the precedent set by GET /api/teams/:id/context-preview, whose whole purpose is
 * turning "why did the agent do that" into a single request.
 */

import type { Db } from '../../db/adapter/types';
import { columnExists, tableExists } from '../../db/introspection';
import {
  listContextBundlesForTask,
  loadContextBundleForInstance,
  loadPreviousContextBundleForTask,
  redactContextBundleForRead,
  type ContextBundleSummary,
  type StoredContextBundle,
} from '../../services/dispatch/contextBundleStore';
import { diffContextBundles, type ContextBundleDiff } from './contextDiff';
import { mapRuntimeExecutionRow } from '../runtimes/runtimeView';

export interface InstanceContextRunHeader {
  instanceId: number;
  durableRunId: string | null;
  taskId: number | null;
  taskTitle: string | null;
  agentId: number | null;
  agentName: string | null;
  jobTitle: string | null;
  status: string | null;
  dispatchedAt: string | null;
  completedAt: string | null;
}

export interface InstanceContextView {
  instanceId: number;
  /** False when this run predates bundle capture, or capture failed. */
  captured: boolean;
  run: InstanceContextRunHeader;
  prompt: (Omit<StoredContextBundle, 'instanceId' | 'durableRunId' | 'taskId' | 'agentId'>) | null;
  /** Non-prompt context Agent HQ delivered: tools, skills, model policy, workspace. Redacted. */
  runtime: Record<string, unknown> | null;
  diff: ContextBundleDiff | null;
  /** Sibling runs of the same task that also have captured context, newest first. */
  runs: ContextBundleSummary[];
}

async function loadRunHeader(
  db: Db,
  instanceId: number,
  tenantId: number,
): Promise<InstanceContextRunHeader | null> {
  const jobInstancesHaveTenant = await columnExists(db, 'job_instances', 'tenant_id');
  const row = await db.get<Record<string, unknown>>(`
    SELECT
      ji.id, ji.agent_id, ji.task_id, ji.status, ji.dispatched_at, ji.completed_at,
      ji.durable_run_id,
      a.name AS agent_name,
      a.job_title AS job_title,
      t.title AS task_title
    FROM job_instances ji
    LEFT JOIN agents a ON a.id = ji.agent_id
    LEFT JOIN tasks t ON t.id = ji.task_id
    WHERE ji.id = ?
      AND ${jobInstancesHaveTenant ? 'ji.tenant_id' : 'a.tenant_id'} = ?
  `, instanceId, tenantId);

  if (!row) return null;
  return {
    instanceId: Number(row.id),
    durableRunId: (row.durable_run_id as string | null) ?? null,
    taskId: row.task_id == null ? null : Number(row.task_id),
    taskTitle: (row.task_title as string | null) ?? null,
    agentId: row.agent_id == null ? null : Number(row.agent_id),
    agentName: (row.agent_name as string | null) ?? null,
    jobTitle: (row.job_title as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    dispatchedAt: (row.dispatched_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
  };
}

async function loadRuntimeContext(
  db: Db,
  instanceId: number,
  tenantId: number,
  status: string | null,
): Promise<Record<string, unknown> | null> {
  if (!(await tableExists(db, 'runtime_executions'))) return null;
  const row = await db.get<Record<string, unknown>>(`
    SELECT *
    FROM runtime_executions
    WHERE instance_id = ? AND tenant_id = ?
    ORDER BY id DESC
    LIMIT 1
  `, instanceId, tenantId);
  if (!row) return null;

  // mapRuntimeExecutionRow already redacts credentials and sensitive config.
  return mapRuntimeExecutionRow(row, {
    instanceId,
    runtimeType: typeof row.runtime_type === 'string' ? row.runtime_type : 'openclaw',
    state: typeof row.state === 'string' ? row.state : (status ?? 'unknown'),
  });
}

export async function getInstanceContextView(
  db: Db,
  params: { instanceId: number; tenantId: number; includeDiff?: boolean },
): Promise<InstanceContextView | null> {
  const run = await loadRunHeader(db, params.instanceId, params.tenantId);
  if (!run) return null;

  const stored = await loadContextBundleForInstance(db, {
    instanceId: params.instanceId,
    tenantId: params.tenantId,
  });
  const bundle = stored ? redactContextBundleForRead(stored) : null;

  const taskId = bundle?.taskId ?? run.taskId;
  const runs = taskId
    ? await listContextBundlesForTask(db, { taskId, tenantId: params.tenantId })
    : [];

  let diff: ContextBundleDiff | null = null;
  if (bundle && taskId && params.includeDiff !== false) {
    const previousStored = await loadPreviousContextBundleForTask(db, {
      taskId,
      beforeInstanceId: params.instanceId,
      tenantId: params.tenantId,
    });
    if (previousStored) {
      // Both sides redacted before diffing, so a rotated secret never shows as a content change.
      const previous = redactContextBundleForRead(previousStored);
      diff = diffContextBundles(
        {
          instanceId: previous.instanceId,
          createdAt: previous.createdAt,
          promptText: previous.promptText,
          segments: previous.segments,
        },
        {
          instanceId: bundle.instanceId,
          createdAt: bundle.createdAt,
          promptText: bundle.promptText,
          segments: bundle.segments,
        },
      );
    }
  }

  return {
    instanceId: params.instanceId,
    captured: Boolean(bundle),
    run,
    prompt: bundle
      ? {
        id: bundle.id,
        bundleVersion: bundle.bundleVersion,
        promptText: bundle.promptText,
        segments: bundle.segments,
        promptChars: bundle.promptChars,
        promptFingerprint: bundle.promptFingerprint,
        createdAt: bundle.createdAt,
        redacted: bundle.redacted,
      }
      : null,
    runtime: await loadRuntimeContext(db, params.instanceId, params.tenantId, run.status),
    diff,
    runs,
  };
}

export interface TaskContextIndex {
  taskId: number;
  runs: ContextBundleSummary[];
  /** The newest captured run, which the viewer opens by default. */
  latestInstanceId: number | null;
}

export async function getTaskContextIndex(
  db: Db,
  params: { taskId: number; tenantId: number },
): Promise<TaskContextIndex> {
  const runs = await listContextBundlesForTask(db, { taskId: params.taskId, tenantId: params.tenantId });
  return {
    taskId: params.taskId,
    runs,
    latestInstanceId: runs.length ? runs[0].instanceId : null,
  };
}
