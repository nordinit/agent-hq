/**
 * Durable storage for dispatch context bundles — see db/pg-migrations/22-dispatch-context-bundles.sql.
 *
 * Writes are best-effort by design. A bundle is an explanation of a dispatch, not part of it, so
 * failing to record one must never stop an agent from running; persistDispatchContextBundle()
 * logs and returns rather than throwing into the dispatch path.
 *
 * Reads redact. The stored prompt is raw so it stays equal to the fingerprint the runtime
 * boundary recorded, and every path that serves it to a human runs it through
 * redactContextBundleForRead() first.
 */

import { type Db } from '../../db/adapter/types';
import { tableExists } from '../../db/introspection';
import { redactSensitiveRuntimeText } from '../../runtimes/sensitiveText';
import {
  CONTEXT_BUNDLE_VERSION,
  fingerprintContextPrompt,
  type ContextBundle,
  type ContextSegment,
} from './prompt/contextBundle';

export interface StoredContextBundle {
  id: number;
  instanceId: number;
  durableRunId: string | null;
  taskId: number | null;
  agentId: number | null;
  bundleVersion: number;
  promptText: string;
  segments: ContextSegment[];
  promptChars: number;
  promptFingerprint: string;
  createdAt: string | null;
  /** True when redaction rewrote the served text, so the viewer can say so. */
  redacted: boolean;
}

export interface PersistContextBundleInput {
  tenantId: number | null;
  instanceId: number;
  durableRunId?: string | null;
  taskId?: number | null;
  agentId?: number | null;
  bundle: ContextBundle;
}

const availability = new WeakMap<Db, Promise<boolean>>();

/** Dispatch stays safe while rolling past a pre-migration database. */
export function contextBundleStoreAvailable(db: Db): Promise<boolean> {
  let pending = availability.get(db);
  if (!pending) {
    pending = tableExists(db, 'dispatch_context_bundles');
    availability.set(db, pending);
  }
  return pending;
}

/** Test/migration hook; normal processes verify migrations before accepting work. */
export function clearContextBundleStoreAvailabilityCache(db: Db): void {
  availability.delete(db);
}

/**
 * Record what this dispatch handed the agent.
 *
 * ON CONFLICT DO NOTHING: an instance is dispatched once, and a retry gets a new instance, so a
 * conflict means a duplicate write of the same run rather than a change worth keeping.
 */
export async function persistDispatchContextBundle(
  db: Db,
  input: PersistContextBundleInput,
): Promise<number | null> {
  try {
    if (input.tenantId == null) return null;
    if (!(await contextBundleStoreAvailable(db))) return null;

    const row = await db.get<{ id: number }>(`
      INSERT INTO dispatch_context_bundles (
        tenant_id, instance_id, durable_run_id, task_id, agent_id,
        bundle_version, prompt_text, segments_json, prompt_chars, prompt_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, instance_id) DO NOTHING
      RETURNING id
    `,
      input.tenantId,
      input.instanceId,
      input.durableRunId ?? null,
      input.taskId ?? null,
      input.agentId ?? null,
      input.bundle.version ?? CONTEXT_BUNDLE_VERSION,
      input.bundle.promptText,
      JSON.stringify(input.bundle.segments),
      input.bundle.totalChars,
      fingerprintContextPrompt(input.bundle.promptText),
    );
    return row ? Number(row.id) : null;
  } catch (err) {
    // An unexplainable dispatch is better than a blocked one.
    console.warn(
      `[context-bundle] Failed to record context for instance #${input.instanceId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

function parseSegments(value: unknown): ContextSegment[] {
  const parsed = typeof value === 'string' ? safeParse(value) : value;
  return Array.isArray(parsed) ? parsed as ContextSegment[] : [];
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function mapRow(row: Record<string, unknown>): StoredContextBundle {
  return {
    id: Number(row.id),
    instanceId: Number(row.instance_id),
    durableRunId: (row.durable_run_id as string | null) ?? null,
    taskId: row.task_id == null ? null : Number(row.task_id),
    agentId: row.agent_id == null ? null : Number(row.agent_id),
    bundleVersion: Number(row.bundle_version ?? CONTEXT_BUNDLE_VERSION),
    promptText: String(row.prompt_text ?? ''),
    segments: parseSegments(row.segments_json),
    promptChars: Number(row.prompt_chars ?? 0),
    promptFingerprint: String(row.prompt_fingerprint ?? ''),
    createdAt: (row.created_at as string | null) ?? null,
    redacted: false,
  };
}

/**
 * Redact the served copy without breaking the segment/slice invariant.
 *
 * redactSensitiveRuntimeText() changes length, so redacting the whole prompt in one pass would
 * leave every offset pointing at the wrong place. Instead each region — the gaps between
 * segments and the segments themselves — is redacted independently and the offsets are rebuilt
 * from the results, so `promptText.slice(start, end)` still returns exactly that segment.
 * Region boundaries are section boundaries separated by blank lines, so nothing a redaction
 * pattern matches can straddle one.
 */
export function redactContextBundleForRead(bundle: StoredContextBundle): StoredContextBundle {
  const ordered = [...bundle.segments]
    .filter(segment => segment.injected)
    .sort((left, right) => left.start - right.start);

  let redactedText = '';
  let cursor = 0;
  const remapped = new Map<ContextSegment, { start: number; end: number }>();

  for (const segment of ordered) {
    redactedText += redactSensitiveRuntimeText(bundle.promptText.slice(cursor, segment.start));
    const start = redactedText.length;
    redactedText += redactSensitiveRuntimeText(bundle.promptText.slice(segment.start, segment.end));
    remapped.set(segment, { start, end: redactedText.length });
    cursor = segment.end;
  }
  redactedText += redactSensitiveRuntimeText(bundle.promptText.slice(cursor));

  // Uninjected segments have no span; they collapse onto the nearest rebuilt boundary so the
  // outline still shows them in the right place.
  let lastEnd = 0;
  const segments = bundle.segments.map((segment) => {
    const span = remapped.get(segment);
    if (!span) return { ...segment, start: lastEnd, end: lastEnd, chars: 0 };
    lastEnd = span.end;
    return { ...segment, start: span.start, end: span.end, chars: span.end - span.start };
  });

  return {
    ...bundle,
    promptText: redactedText,
    segments,
    promptChars: redactedText.length,
    redacted: redactedText !== bundle.promptText,
  };
}

const SELECT_COLUMNS = `
  id, instance_id, durable_run_id, task_id, agent_id,
  bundle_version, prompt_text, segments_json, prompt_chars, prompt_fingerprint, created_at
`;

export async function loadContextBundleForInstance(
  db: Db,
  params: { instanceId: number; tenantId: number },
): Promise<StoredContextBundle | null> {
  if (!(await contextBundleStoreAvailable(db))) return null;
  const row = await db.get<Record<string, unknown>>(`
    SELECT ${SELECT_COLUMNS}
    FROM dispatch_context_bundles
    WHERE instance_id = ? AND tenant_id = ?
  `, params.instanceId, params.tenantId);
  return row ? mapRow(row) : null;
}

export interface ContextBundleSummary {
  instanceId: number;
  durableRunId: string | null;
  taskId: number | null;
  agentId: number | null;
  promptChars: number;
  promptFingerprint: string;
  createdAt: string | null;
  segmentCount: number;
}

/** Every captured run for one task, newest first — the viewer's run picker. */
export async function listContextBundlesForTask(
  db: Db,
  params: { taskId: number; tenantId: number; limit?: number },
): Promise<ContextBundleSummary[]> {
  if (!(await contextBundleStoreAvailable(db))) return [];
  const rows = await db.all<Record<string, unknown>>(`
    SELECT id, instance_id, durable_run_id, task_id, agent_id,
           prompt_chars, prompt_fingerprint, created_at,
           jsonb_array_length(segments_json) AS segment_count
    FROM dispatch_context_bundles
    WHERE task_id = ? AND tenant_id = ?
    ORDER BY id DESC
    LIMIT ?
  `, params.taskId, params.tenantId, Math.min(Math.max(params.limit ?? 50, 1), 200));

  return rows.map((row) => ({
    instanceId: Number(row.instance_id),
    durableRunId: (row.durable_run_id as string | null) ?? null,
    taskId: row.task_id == null ? null : Number(row.task_id),
    agentId: row.agent_id == null ? null : Number(row.agent_id),
    promptChars: Number(row.prompt_chars ?? 0),
    promptFingerprint: String(row.prompt_fingerprint ?? ''),
    createdAt: (row.created_at as string | null) ?? null,
    segmentCount: Number(row.segment_count ?? 0),
  }));
}

/**
 * The run captured immediately before this one for the same task — the diff baseline.
 *
 * Ordered by id rather than created_at: both are written at dispatch, and id is monotonic while
 * the timestamp is second-resolution text and ties on fast retries.
 */
export async function loadPreviousContextBundleForTask(
  db: Db,
  params: { taskId: number; beforeInstanceId: number; tenantId: number },
): Promise<StoredContextBundle | null> {
  if (!(await contextBundleStoreAvailable(db))) return null;
  const row = await db.get<Record<string, unknown>>(`
    SELECT ${SELECT_COLUMNS}
    FROM dispatch_context_bundles
    WHERE task_id = ?
      AND tenant_id = ?
      AND id < (SELECT id FROM dispatch_context_bundles WHERE instance_id = ? AND tenant_id = ?)
    ORDER BY id DESC
    LIMIT 1
  `, params.taskId, params.tenantId, params.beforeInstanceId, params.tenantId);
  return row ? mapRow(row) : null;
}
