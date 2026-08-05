import * as fs from 'fs';
import * as path from 'path';
import { OPENCLAW_HOME } from '../../config';
import { normalizeChatMessageRole } from '../../lib/chatMessageRoles';
import { extractGatewayStructuredEvents, unwrapGatewayMessage } from '../../lib/openclawMessageEvents';
import {
  buildGatewayRunSessionKey,
  parseAgentSessionKey,
  parseRunSessionKey,
  resolveRuntimeAgentSlug,
  toGatewaySessionKey,
} from '../../lib/sessionKeys';
import {
  nowTimestamp,
  parseTimestamp,
  timestampFromDate,
  timestampFromEpochMs,
  toCanonicalTimestamp,
} from '../../lib/timestamps';
import { type Db } from "../../db/adapter/types";
import { tableExists as sharedTableExists, columnExists as sharedColumnExists, tableColumns as sharedTableColumns, indexExists as sharedIndexExists } from "../../db/introspection";

interface BackfillInstanceRow {
  id: number;
  agent_id: number;
  task_id: number | null;
  session_key: string | null;
  run_stage?: string | null;
  durable_run_id?: string | null;
}

interface BackfillAgentRow {
  id: number;
  name: string | null;
  runtime_type: string | null;
  session_key: string | null;
  openclaw_agent_id: string | null;
}

interface SessionIndexEntry {
  sessionId?: unknown;
  sessionFile?: unknown;
  updatedAt?: unknown;
}

interface IngestStateRow {
  instance_id: number;
  session_file: string;
  last_line_index: number;
  last_event_at: string | null;
  last_heartbeat_at: string | null;
  last_meaningful_output_at: string | null;
}

interface ArtifactRow {
  task_id: number | null;
  started_at: string | null;
  last_agent_heartbeat_at: string | null;
  last_meaningful_output_at: string | null;
}

export interface OpenClawJsonlBackfillOptions {
  forceFull?: boolean;
  now?: Date;
  openclawHome?: string;
  structuredOnly?: boolean;
}

export interface OpenClawJsonlBackfillResult {
  attempted: boolean;
  backfilled: boolean;
  reason: string | null;
  sessionKey: string | null;
  sessionFile: string | null;
  processedLines: number;
  persistedEvents: number;
  latestEventAt: string | null;
  heartbeatAt: string | null;
  meaningfulOutputAt: string | null;
}

interface ResolvedSessionFile {
  sessionKey: string;
  sessionFile: string;
  kind: 'jsonl' | 'trajectory';
}

interface ParsedJsonlLine {
  parsed: Record<string, unknown>;
  lineIndex: number;
  timestamp: string;
}

const EMPTY_RESULT: OpenClawJsonlBackfillResult = {
  attempted: false,
  backfilled: false,
  reason: null,
  sessionKey: null,
  sessionFile: null,
  processedLines: 0,
  persistedEvents: 0,
  latestEventAt: null,
  heartbeatAt: null,
  meaningfulOutputAt: null,
};

async function tableHasColumn(db: Db, table: string, column: string): Promise<boolean> {
    return await sharedColumnExists(db, table, column);
}

function normalizeOpenClawHome(optionHome?: string): string {
  return optionHome ?? process.env.OPENCLAW_HOME ?? OPENCLAW_HOME;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function parseSessionsIndex(raw: string): Record<string, SessionIndexEntry> {
  const parsed = parseJsonObject(raw);
  if (!parsed) return {};
  const entries: Record<string, SessionIndexEntry> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object') continue;
    entries[key] = value as SessionIndexEntry;
  }
  return entries;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = asNonEmptyString(value);
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeTimestamp(raw: unknown, fallback: Date): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // JSONL emits seconds or milliseconds depending on the producer.
    const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
    return timestampFromEpochMs(ms) ?? timestampFromDate(fallback) ?? nowTimestamp();
  }

  return (
    toCanonicalTimestamp(raw) ?? timestampFromDate(fallback) ?? nowTimestamp()
  );
}

function timestampMs(value: string | null | undefined): number | null {
  // NB: must NOT use Date.parse() directly — it reads the offset-less
  // 'YYYY-MM-DD HH:MM:SS' form stored in the DB as *local* time, which on a
  // UTC-4 host makes every such value compare four hours later than it is.
  return parseTimestamp(value)?.getTime() ?? null;
}

// Keep the winning value's own canonical string rather than re-deriving it from
// epoch milliseconds — a round-trip through epoch-ms would silently drop
// sub-second precision that the source carried.
function maxIso(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs: number | null = null;
  for (const value of values) {
    const ms = timestampMs(value);
    if (ms === null) continue;
    if (bestMs === null || ms > bestMs) {
      bestMs = ms;
      best = toCanonicalTimestamp(value);
    }
  }
  return best;
}

function minIso(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs: number | null = null;
  for (const value of values) {
    const ms = timestampMs(value);
    if (ms === null) continue;
    if (bestMs === null || ms < bestMs) {
      bestMs = ms;
      best = toCanonicalTimestamp(value);
    }
  }
  return best;
}

function getRecordTimestamp(parsed: Record<string, unknown>, fallback: Date): string {
  const message = parsed.message;
  const nested = message && typeof message === 'object'
    ? message as Record<string, unknown>
    : null;
  return normalizeTimestamp(
    parsed.timestamp ?? parsed.ts ?? nested?.timestamp ?? parsed.createdAt ?? parsed.updatedAt,
    fallback,
  );
}

function getSourceRole(parsed: Record<string, unknown>): unknown {
  const unwrapped = unwrapGatewayMessage(parsed);
  return unwrapped?.role ?? parsed.role ?? parsed.type;
}

function getRawId(parsed: Record<string, unknown>): string | null {
  const unwrapped = unwrapGatewayMessage(parsed);
  return asNonEmptyString(unwrapped?.id)
    ?? asNonEmptyString(parsed.id)
    ?? asNonEmptyString(parsed.parentId);
}

function getCandidateSessionKeys(
  instance: BackfillInstanceRow,
  agent: BackfillAgentRow,
): string[] {
  const sessionKey = asNonEmptyString(instance.session_key);
  const parsedStored = parseRunSessionKey(sessionKey);
  const parsedAgentSession = parseAgentSessionKey(sessionKey);
  const durableRunId = getExpectedDurableRunId(instance, parsedStored);
  const directChatKeys = instance.run_stage === 'chat' && parsedAgentSession?.scope === 'direct'
    ? uniqueStrings([
        sessionKey,
        toGatewaySessionKey(sessionKey, agent),
      ])
    : [];

  if (!durableRunId) {
    return directChatKeys;
  }

  const durableShortKey = `run:${instance.id}:${durableRunId}`;
  const storedMatchesDurableRun = parsedStored
    && parsedStored.instanceId === instance.id
    && parsedStored.durableRunId === durableRunId;
  const runKeys = uniqueStrings([
    durableShortKey,
    storedMatchesDurableRun ? parsedStored.shortKey : null,
  ]);
  const fullKeys = runKeys.map((key) => buildGatewayRunSessionKey(agent, key));
  return uniqueStrings([
    ...directChatKeys,
    storedMatchesDurableRun ? sessionKey : null,
    ...runKeys,
    ...fullKeys,
  ]);
}

function getExpectedDurableRunId(
  instance: BackfillInstanceRow,
  parsedStored?: ReturnType<typeof parseRunSessionKey>,
): string | null {
  return asNonEmptyString(instance.durable_run_id)
    ?? (
      parsedStored?.instanceId === instance.id
        ? asNonEmptyString(parsedStored.durableRunId)
        : null
    );
}

function sessionFileFromEntry(sessionsDir: string, entry: SessionIndexEntry): string | null {
  const explicit = asNonEmptyString(entry.sessionFile);
  if (explicit) {
    return path.isAbsolute(explicit) ? explicit : path.join(sessionsDir, explicit);
  }

  const sessionId = asNonEmptyString(entry.sessionId);
  if (sessionId) return path.join(sessionsDir, `${sessionId}.jsonl`);
  return null;
}

function resolveTrajectoryFile(sessionFile: string): string | null {
  const ext = path.extname(sessionFile);
  const withoutExt = ext ? sessionFile.slice(0, -ext.length) : sessionFile;
  const candidates = uniqueStrings([
    `${withoutExt}.trajectory.jsonl`,
    `${sessionFile}.trajectory.jsonl`,
  ]);
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null;
}

function resolveExistingSessionFile(
  sessionKey: string,
  sessionFile: string | null,
): ResolvedSessionFile | null {
  if (!sessionFile) return null;
  if (fs.existsSync(sessionFile)) return { sessionKey, sessionFile, kind: 'jsonl' };
  const trajectoryFile = resolveTrajectoryFile(sessionFile);
  return trajectoryFile ? { sessionKey, sessionFile: trajectoryFile, kind: 'trajectory' } : null;
}

function trajectoryFileMatchesRun(params: {
  file: string;
  candidateKeys: string[];
  instance: BackfillInstanceRow;
}): boolean {
  const raw = fs.readFileSync(params.file, 'utf-8');
  const expectedDurableRunId = getExpectedDurableRunId(
    params.instance,
    parseRunSessionKey(asNonEmptyString(params.instance.session_key)),
  );

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parsed = parseJsonObject(line);
    if (!parsed) continue;
    const sessionKey = asNonEmptyString(parsed.sessionKey);
    if (sessionKey && params.candidateKeys.includes(sessionKey)) return true;

    const parsedKey = parseRunSessionKey(sessionKey);
    if (
      parsedKey
      && parsedKey.instanceId === params.instance.id
      && expectedDurableRunId
      && parsedKey.durableRunId === expectedDurableRunId
    ) {
      return true;
    }
  }

  return false;
}

function resolveSessionFile(params: {
  openclawHome: string;
  instance: BackfillInstanceRow;
  agent: BackfillAgentRow;
}): ResolvedSessionFile | null {
  const agentSlug = resolveRuntimeAgentSlug(params.agent);
  if (!agentSlug) return null;

  const sessionsDir = path.join(params.openclawHome, 'agents', agentSlug, 'sessions');
  const sessionsIndexPath = path.join(sessionsDir, 'sessions.json');
  const candidateKeys = getCandidateSessionKeys(params.instance, params.agent);
  if (!fs.existsSync(sessionsIndexPath)) {
    const trajectoryFiles = fs.existsSync(sessionsDir)
      ? fs.readdirSync(sessionsDir)
        .filter(name => name.endsWith('.trajectory.jsonl'))
        .map(name => path.join(sessionsDir, name))
      : [];
    const matchedTrajectory = trajectoryFiles.find(file => trajectoryFileMatchesRun({
      file,
      candidateKeys,
      instance: params.instance,
    }));
    return matchedTrajectory
      ? { sessionKey: candidateKeys[0] ?? params.instance.session_key ?? '', sessionFile: matchedTrajectory, kind: 'trajectory' }
      : null;
  }

  const sessions = parseSessionsIndex(fs.readFileSync(sessionsIndexPath, 'utf-8'));
  for (const key of candidateKeys) {
    const file = sessionFileFromEntry(sessionsDir, sessions[key] ?? {});
    const resolved = resolveExistingSessionFile(key, file);
    if (resolved) return resolved;
  }

  const expectedRun = params.instance.id;
  const parsedStored = parseRunSessionKey(asNonEmptyString(params.instance.session_key));
  const expectedDurableRunId = getExpectedDurableRunId(params.instance, parsedStored);
  if (!expectedDurableRunId) return null;

  const matchingEntries = Object.entries(sessions)
    .filter(([key]) => {
      const parsed = parseRunSessionKey(key);
      if (!parsed || parsed.instanceId !== expectedRun) return false;
      return parsed.durableRunId === expectedDurableRunId;
    })
    .sort(([, left], [, right]) => {
      const leftUpdated = typeof left.updatedAt === 'number' ? left.updatedAt : 0;
      const rightUpdated = typeof right.updatedAt === 'number' ? right.updatedAt : 0;
      return rightUpdated - leftUpdated;
    });

  const preferred = matchingEntries.find(([key]) => key.includes(`agent:${agentSlug}:`)) ?? matchingEntries[0];
  if (!preferred) return null;

  const [sessionKey, entry] = preferred;
  const file = sessionFileFromEntry(sessionsDir, entry);
  return resolveExistingSessionFile(sessionKey, file);
}

function isOpenClawAgent(agent: BackfillAgentRow): boolean {
  const runtimeType = asNonEmptyString(agent.runtime_type);
  return !runtimeType || runtimeType === 'openclaw';
}

async function readIngestState(db: Db, instanceId: number, sessionFile: string): Promise<IngestStateRow | null> {
  const row = await db.get(`
    SELECT instance_id, session_file, last_line_index, last_event_at,
           last_heartbeat_at, last_meaningful_output_at
      FROM openclaw_transcript_ingest_state
      WHERE instance_id = ?
  `, instanceId) as IngestStateRow | undefined;
  if (!row || row.session_file !== sessionFile) return null;
  return row;
}

async function writeIngestState(db: Db, params: {
  instanceId: number;
  sessionFile: string;
  lastLineIndex: number;
  latestEventAt: string | null;
  heartbeatAt: string | null;
  meaningfulOutputAt: string | null;
  now: string;
}): Promise<void> {
  await db.run(`
    INSERT INTO openclaw_transcript_ingest_state (
      instance_id, session_file, last_line_index, last_event_at,
      last_heartbeat_at, last_meaningful_output_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(instance_id) DO UPDATE SET
      session_file = excluded.session_file,
      last_line_index = excluded.last_line_index,
      last_event_at = excluded.last_event_at,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_meaningful_output_at = excluded.last_meaningful_output_at,
      updated_at = excluded.updated_at
  `, params.instanceId, params.sessionFile, params.lastLineIndex, params.latestEventAt, params.heartbeatAt, params.meaningfulOutputAt, params.now);
}

function classifyEvent(role: string, eventType: string, content: string, eventMeta: Record<string, unknown>): {
  heartbeat: boolean;
  meaningful: boolean;
} {
  const hasContent = content.trim().length > 0;
  if (eventType === 'tool_call' || eventType === 'thought') {
    return { heartbeat: true, meaningful: false };
  }
  if (eventType === 'tool_result') {
    return { heartbeat: true, meaningful: hasContent && eventMeta.is_error !== true };
  }
  if (role === 'assistant' && hasContent) {
    return { heartbeat: true, meaningful: true };
  }
  if (role === 'tool' && hasContent) {
    return { heartbeat: true, meaningful: eventMeta.is_error !== true };
  }
  return { heartbeat: false, meaningful: false };
}

async function updateInstanceArtifacts(db: Db, params: {
  instance: BackfillInstanceRow;
  heartbeatAt: string | null;
  meaningfulOutputAt: string | null;
  startedAt: string | null;
}): Promise<void> {
  if (!params.heartbeatAt && !params.meaningfulOutputAt && !params.startedAt) return;

  const existing = await db.get(`
    SELECT task_id, started_at, last_agent_heartbeat_at, last_meaningful_output_at
      FROM instance_artifacts
      WHERE instance_id = ?
  `, params.instance.id) as ArtifactRow | undefined;

  const taskId = existing?.task_id ?? params.instance.task_id;
  const startedAt = existing?.started_at ?? params.startedAt;
  const heartbeatAt = maxIso(existing?.last_agent_heartbeat_at, params.heartbeatAt);
  const meaningfulOutputAt = maxIso(existing?.last_meaningful_output_at, params.meaningfulOutputAt);
  const hasUpdatedAt = await tableHasColumn(db, 'instance_artifacts', 'updated_at');

  if (existing) {
    const sql = `
      UPDATE instance_artifacts
         SET task_id = COALESCE(task_id, ?),
             started_at = COALESCE(started_at, ?),
             last_agent_heartbeat_at = ?,
             last_meaningful_output_at = ?
             ${hasUpdatedAt ? ', updated_at = ?' : ''}
       WHERE instance_id = ?
    `;
    const paramsList: unknown[] = [taskId, startedAt, heartbeatAt, meaningfulOutputAt];
    if (hasUpdatedAt) paramsList.push(nowTimestamp());
    paramsList.push(params.instance.id);
    await db.run(sql, ...paramsList);
    return;
  }

  await db.run(`
    INSERT INTO instance_artifacts (
      instance_id, task_id, started_at, last_agent_heartbeat_at, last_meaningful_output_at
    )
    VALUES (?, ?, ?, ?, ?)
  `, params.instance.id, taskId, startedAt, heartbeatAt, meaningfulOutputAt);
}

function readJsonlLines(sessionFile: string, fromLineIndex: number, fallbackNow: Date): ParsedJsonlLine[] {
  const raw = fs.readFileSync(sessionFile, 'utf-8');
  return raw
    .split(/\r?\n/)
    .map((line, index) => ({ line, lineIndex: index + 1 }))
    .filter(({ line, lineIndex }) => lineIndex > fromLineIndex && line.trim().length > 0)
    .map(({ line, lineIndex }) => {
      const parsed = parseJsonObject(line);
      if (!parsed) return null;
      return {
        parsed,
        lineIndex,
        timestamp: getRecordTimestamp(parsed, fallbackNow),
      };
    })
    .filter((value): value is ParsedJsonlLine => value !== null);
}

function stringifyTrajectoryValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map(item => {
        const record = asRecord(item);
        return asNonEmptyString(record?.text)
          ?? asNonEmptyString(record?.content)
          ?? '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTrajectoryStructuredEvents(parsed: Record<string, unknown>): Array<{
  event_type: 'tool_call' | 'tool_result' | 'turn_end';
  content: string;
  event_meta: Record<string, unknown>;
}> {
  const type = asNonEmptyString(parsed.type)?.toLowerCase();
  const data = asRecord(parsed.data) ?? {};
  if (type === 'tool.call') {
    const name = asNonEmptyString(data.name) ?? 'unknown';
    return [{
      event_type: 'tool_call',
      content: name,
      event_meta: {
        name,
        args: data.arguments ?? data.args ?? data.input ?? {},
        id: asNonEmptyString(data.toolCallId) ?? asNonEmptyString(data.itemId),
        item_id: asNonEmptyString(data.itemId),
        turn_id: asNonEmptyString(data.turnId),
      },
    }];
  }

  if (type === 'tool.result') {
    const output = stringifyTrajectoryValue(data.output ?? data.result ?? data.content ?? '');
    const name = asNonEmptyString(data.name);
    const isError = data.isError === true || asNonEmptyString(data.status)?.toLowerCase() === 'error';
    return [{
      event_type: 'tool_result',
      content: output.slice(0, 4000),
      event_meta: {
        tool_use_id: asNonEmptyString(data.toolCallId) ?? asNonEmptyString(data.itemId),
        tool_name: name,
        output,
        is_error: isError || undefined,
        status: asNonEmptyString(data.status),
        item_id: asNonEmptyString(data.itemId),
        turn_id: asNonEmptyString(data.turnId),
      },
    }];
  }

  if (type === 'session.ended') {
    const status = asNonEmptyString(data.status ?? parsed.status)?.toLowerCase();
    const terminalReason = status === 'completed' || status === 'success' || status === 'ok'
      ? 'completed'
      : status === 'aborted' || status === 'cancelled' || status === 'canceled'
        ? 'aborted'
        : status === 'timeout' || status === 'timed_out'
          ? 'timeout'
          : 'error';
    const contentByReason = {
      completed: 'Run completed',
      aborted: 'Run aborted',
      timeout: 'Run timed out',
      error: 'Run failed',
    } as const;
    return [{
      event_type: 'turn_end',
      content: contentByReason[terminalReason],
      event_meta: {
        terminal_reason: terminalReason,
        openclaw_event_type: 'session.ended',
        status: status ?? null,
        reason: data.reason ?? data.stopReason ?? null,
        error: data.error ?? data.promptError ?? parsed.error ?? null,
      },
    }];
  }

  return [];
}

export async function isRunChatTranscriptSparse(db: Db, instanceId: number): Promise<boolean> {
  if (!await tableHasColumn(db, 'chat_messages', 'instance_id')) return false;
  const rows = await db.all(`
    SELECT id, role, content, event_type
      FROM chat_messages
      WHERE instance_id = ?
      ORDER BY timestamp ASC
  `, instanceId) as Array<{
    id: string;
    role: string;
    content: string;
    event_type: string | null;
  }>;

  if (rows.length === 0) return true;
  return !rows.some((row) => {
    const eventType = row.event_type ?? 'text';
    if (eventType !== 'text') return true;
    if (row.role === 'tool') return true;
    if (row.role !== 'assistant') return false;
    return !row.id.startsWith('oc-stream-') && row.content.trim().length > 0;
  });
}

export async function backfillOpenClawJsonlTranscript(
  db: Db,
  instanceId: number,
  options: OpenClawJsonlBackfillOptions = {},
): Promise<OpenClawJsonlBackfillResult> {
  const hasInstanceDurableRunId = await tableHasColumn(db, 'job_instances', 'durable_run_id');
  const hasRunStage = await tableHasColumn(db, 'job_instances', 'run_stage');
  const instance = await db.get(`
    SELECT id, agent_id, task_id, session_key, ${hasRunStage ? 'run_stage' : 'NULL AS run_stage'}${hasInstanceDurableRunId ? ', durable_run_id' : ''}
      FROM job_instances
      WHERE id = ?
  `, instanceId) as BackfillInstanceRow | undefined;
  if (!instance) return { ...EMPTY_RESULT, reason: 'instance_not_found' };

  const agent = await db.get(`
    SELECT id, name, runtime_type, session_key, openclaw_agent_id
      FROM agents
      WHERE id = ?
  `, instance.agent_id) as BackfillAgentRow | undefined;
  if (!agent) return { ...EMPTY_RESULT, reason: 'agent_not_found' };
  if (!isOpenClawAgent(agent)) return { ...EMPTY_RESULT, reason: 'not_openclaw_agent' };

  const resolved = resolveSessionFile({
    openclawHome: normalizeOpenClawHome(options.openclawHome),
    instance,
    agent,
  });
  if (!resolved) {
    const parsedStored = parseRunSessionKey(asNonEmptyString(instance.session_key));
    return {
      ...EMPTY_RESULT,
      attempted: true,
      reason: getExpectedDurableRunId(instance, parsedStored)
        ? 'durable_session_file_not_found'
        : 'durable_run_id_missing',
    };
  }

  const previousState = await readIngestState(db, instanceId, resolved.sessionFile);
  const fromLineIndex = options.forceFull ? 0 : previousState?.last_line_index ?? 0;
  const fallbackNow = options.now ?? new Date();
  const lines = readJsonlLines(resolved.sessionFile, fromLineIndex, fallbackNow);

  const hasChatDurableRunId = await tableHasColumn(db, 'chat_messages', 'durable_run_id');
  const provisionalTrajectoryRowPrefix = `oc-traj-${instance.durable_run_id ?? instanceId}-%`;
  const deleteProvisionalTrajectoryRowsSql = `
    DELETE FROM chat_messages
    WHERE instance_id = ?
      AND id LIKE ?
  `;
  const insertSql = `
    INSERT INTO chat_messages (
      id, agent_id, instance_id, ${hasChatDurableRunId ? 'durable_run_id, ' : ''}session_key, role, content, timestamp, event_type, event_meta
    )
    VALUES (?, ?, ?, ${hasChatDurableRunId ? '?, ' : ''}?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      agent_id = excluded.agent_id,
      instance_id = excluded.instance_id,
      ${hasChatDurableRunId ? 'durable_run_id = excluded.durable_run_id,' : ''}
      session_key = excluded.session_key,
      role = excluded.role,
      content = excluded.content,
      timestamp = excluded.timestamp,
      event_type = excluded.event_type,
      event_meta = excluded.event_meta
  `;

  let persistedEvents = 0;
  let latestEventAt = previousState?.last_event_at ?? null;
  let heartbeatAt = previousState?.last_heartbeat_at ?? null;
  let meaningfulOutputAt = previousState?.last_meaningful_output_at ?? null;
  let firstHeartbeatAt: string | null = null;

  await db.withTransaction(async (db) => {
    if (resolved.kind === 'jsonl') {
      await db.run(deleteProvisionalTrajectoryRowsSql, instanceId, provisionalTrajectoryRowPrefix);
    }

    for (const line of lines) {
      const sourceRole = getSourceRole(line.parsed);
      const rawId = getRawId(line.parsed);
      const events = resolved.kind === 'trajectory'
        ? extractTrajectoryStructuredEvents(line.parsed)
        : extractGatewayStructuredEvents(line.parsed);
      let eventIndex = 0;

      for (const event of events) {
        const content = event.content ?? '';
        if (options.structuredOnly && event.event_type === 'text') {
          eventIndex += 1;
          continue;
        }
        if (content.trim().length === 0 && (event.event_type === 'text' || event.event_type === 'thought')) {
          eventIndex += 1;
          continue;
        }

        const role = event.event_type === 'turn_end'
          ? 'system'
          : normalizeChatMessageRole(sourceRole, event.event_type);
        const eventMeta = {
          ...event.event_meta,
          source: resolved.kind === 'trajectory' ? 'openclaw-trajectory' : 'openclaw-jsonl',
          session_file: resolved.sessionFile,
          line_index: line.lineIndex,
          raw_id: rawId,
        };
        const rowId = resolved.kind === 'trajectory'
          ? `oc-traj-${instance.durable_run_id ?? instanceId}-${line.lineIndex}-${eventIndex}`
          : `oc-jsonl-${instance.durable_run_id ?? instanceId}-${line.lineIndex}-${eventIndex}`;

        const insertParams: unknown[] = [
          rowId,
          instance.agent_id,
          instance.id,
        ];
        if (hasChatDurableRunId) insertParams.push(instance.durable_run_id ?? null);
        insertParams.push(
          resolved.sessionKey,
          role,
          content,
          line.timestamp,
          event.event_type,
          JSON.stringify(eventMeta),
        );
        await db.run(insertSql, ...insertParams);
        persistedEvents += 1;
        latestEventAt = maxIso(latestEventAt, line.timestamp);

        const classification = classifyEvent(role, event.event_type, content, eventMeta);
        if (classification.heartbeat) {
          heartbeatAt = maxIso(heartbeatAt, line.timestamp);
          firstHeartbeatAt = minIso(firstHeartbeatAt, line.timestamp);
        }
        if (classification.meaningful) {
          meaningfulOutputAt = maxIso(meaningfulOutputAt, line.timestamp);
        }

        eventIndex += 1;
      }
    }

    const lastLineIndex = lines.length > 0
      ? lines[lines.length - 1]?.lineIndex ?? fromLineIndex
      : fromLineIndex;
    await writeIngestState(db, {
            instanceId,
            sessionFile: resolved.sessionFile,
            lastLineIndex,
            latestEventAt,
            heartbeatAt,
            meaningfulOutputAt,
            now: timestampFromDate(fallbackNow) ?? nowTimestamp(),
          });

    await updateInstanceArtifacts(db, {
            instance,
            heartbeatAt,
            meaningfulOutputAt,
            startedAt: firstHeartbeatAt ?? heartbeatAt ?? meaningfulOutputAt,
          });
  });

  return {
    attempted: true,
    backfilled: persistedEvents > 0,
    reason: persistedEvents > 0 ? null : 'no_new_events',
    sessionKey: resolved.sessionKey,
    sessionFile: resolved.sessionFile,
    processedLines: lines.length,
    persistedEvents,
    latestEventAt,
    heartbeatAt,
    meaningfulOutputAt,
  };
}
