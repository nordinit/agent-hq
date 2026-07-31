import crypto from 'crypto';
import { WebSocket } from 'ws';
import type { RuntimeEndEvent } from '../types';
import { getDb } from '../../db/client';
import { openClawGatewayWsOptions } from '../../lib/openclawGatewayWs';
import { evaluateOpenClawInstanceSessionState } from '../../domains/runs/openclawSessionState';
import { resolveChatTerminalEvent } from './terminalEvents';
import {
  buildOpenClawGatewayConnectParams,
  GATEWAY_WS_URL,
} from './gatewayClient';
import { nowTimestamp, timestampFromEpochMs, toCanonicalTimestampOrNow } from '../../lib/timestamps';
import { trimOpenClawHistoryRows } from '../../lib/openclawHistoryRows';

const activeTerminalSignalCaptures = new Map<string, { stop: () => void }>();
const activeRawSessionTerminalPolls = new Map<number, { stop: () => void }>();

interface GatewayContentBlock {
  type?: string;
  kind?: string;
  text?: string;
  id?: string;
  name?: string;
  tool_name?: string;
  input?: unknown;
  args?: unknown;
  tool_use_id?: string;
  tool_call_id?: string;
  content?: unknown;
  output?: unknown;
  result?: unknown;
  thinking?: string;
  is_error?: boolean;
}

interface PersistedGatewayEvent {
  event_type: string;
  content: string;
  event_meta: Record<string, unknown>;
}

export function extractGatewayEvents(msg: Record<string, unknown>): PersistedGatewayEvent[] {
  const contentRaw = msg.content;
  const rawRole = typeof msg.role === 'string' ? msg.role : '';
  const loweredRole = rawRole.toLowerCase();

  if (Array.isArray(contentRaw)) {
    const events: PersistedGatewayEvent[] = [];

    for (const block of contentRaw as GatewayContentBlock[]) {
      const bType = block.type ?? block.kind ?? '';

      if (bType === 'text') {
        const text = block.text ?? (typeof block.content === 'string' ? block.content : '');
        if (text) events.push({ event_type: 'text', content: text, event_meta: {} });
      } else if (bType === 'thinking' || bType === 'thought') {
        const thinkingText = block.thinking ?? (block.text ?? '');
        events.push({ event_type: 'thought', content: thinkingText, event_meta: {} });
      } else if (bType === 'tool_use' || bType === 'tool_call') {
        const toolName = block.name ?? block.tool_name ?? 'unknown';
        const toolArgs = block.input ?? block.args ?? {};
        events.push({
          event_type: 'tool_call',
          content: toolName,
          event_meta: { name: toolName, args: toolArgs, id: block.id ?? null },
        });
      } else if (bType === 'tool_result') {
        const toolUseId = block.tool_use_id ?? block.tool_call_id ?? block.id ?? '';
        let outputContent: unknown = block.output ?? block.result ?? block.content ?? block.text ?? '';
        if (Array.isArray(outputContent)) {
          outputContent = (outputContent as GatewayContentBlock[])
            .filter(b => (b.type ?? b.kind ?? '') === 'text')
            .map(b => b.text ?? '')
            .join('\n');
        }
        const outputStr = typeof outputContent === 'string' ? outputContent : JSON.stringify(outputContent);
        events.push({
          event_type: 'tool_result',
          content: outputStr.slice(0, 4000),
          event_meta: { tool_use_id: toolUseId, output: outputStr, is_error: Boolean(block.is_error) },
        });
      }
    }

    if (events.length > 0) return events;
  }

  const topLevelToolCall = msg.tool_call as Record<string, unknown> | undefined;
  if (topLevelToolCall && typeof topLevelToolCall === 'object') {
    const toolName = String(topLevelToolCall.name ?? topLevelToolCall.tool_name ?? 'unknown');
    return [{
      event_type: 'tool_call',
      content: toolName,
      event_meta: {
        name: toolName,
        args: topLevelToolCall.args ?? topLevelToolCall.input ?? {},
        id: topLevelToolCall.id ?? null,
      },
    }];
  }

  const topLevelToolResult = msg.tool_result as Record<string, unknown> | undefined;
  if (topLevelToolResult && typeof topLevelToolResult === 'object') {
    const output = topLevelToolResult.output ?? topLevelToolResult.result ?? topLevelToolResult.content ?? '';
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    return [{
      event_type: 'tool_result',
      content: outputStr.slice(0, 4000),
      event_meta: {
        tool_use_id: topLevelToolResult.tool_use_id ?? topLevelToolResult.tool_call_id ?? topLevelToolResult.id ?? null,
        output: outputStr,
      },
    }];
  }

  const plainText = typeof contentRaw === 'string'
    ? contentRaw
    : (typeof msg.text === 'string' ? msg.text : '');

  if (loweredRole === 'toolresult' || loweredRole === 'tool_result') {
    return [{ event_type: 'tool_result', content: plainText, event_meta: { source_role: rawRole, output: plainText } }];
  }
  if (loweredRole === 'toolcall' || loweredRole === 'tool_call' || loweredRole === 'tooluse' || loweredRole === 'tool_use') {
    return [{ event_type: 'tool_call', content: plainText || 'tool_call', event_meta: { source_role: rawRole } }];
  }

  return [{ event_type: 'text', content: plainText, event_meta: {} }];
}

export async function persistGatewayHistory(instanceId: number, agentId: number, messages: Array<Record<string, unknown>>): Promise<void> {
  const db = getDb();
  const insertSql = `
    INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      content = excluded.content,
      timestamp = excluded.timestamp,
      event_type = excluded.event_type,
      event_meta = excluded.event_meta
  `;

  let rowIndex = 0;
  for (const m of messages) {
    const sourceRole = typeof m.role === 'string' ? m.role : 'assistant';
    const role = sourceRole === 'user' ? 'user' : 'assistant';
    const ts = typeof m.timestamp === 'number' ? (timestampFromEpochMs(m.timestamp) ?? nowTimestamp())
      : typeof m.timestamp === 'string' ? m.timestamp
      : nowTimestamp();

    for (const evt of extractGatewayEvents(m)) {
      const rowId = `oc-hist-${instanceId}-${rowIndex++}`;
      const meta = { ...evt.event_meta, ...(sourceRole !== role ? { source_role: sourceRole } : {}) };
      await db.run(insertSql, rowId, agentId, instanceId, role, evt.content, ts, evt.event_type, JSON.stringify(meta));
    }
  }

  // This is a full refresh from index 0. Without trimming, a history that came
  // back shorter than a previous fetch leaves the old tail behind and the
  // transcript shows stale messages from the longer version.
  await trimOpenClawHistoryRows(db, instanceId, rowIndex);
}

async function isInstanceStillActive(instanceId: number): Promise<boolean> {
  try {
    const db = getDb();
    const row = await db.get('SELECT status FROM job_instances WHERE id = ?', instanceId) as { status?: string } | undefined;
    return row?.status === 'dispatched' || row?.status === 'running';
  } catch {
    return false;
  }
}

export function stopOpenClawTerminalSignalCapture(sessionKey: string): void {
  activeTerminalSignalCaptures.get(sessionKey)?.stop();
}

export function stopOpenClawRawSessionTerminalPoll(instanceId: number): void {
  const poll = activeRawSessionTerminalPolls.get(instanceId);
  if (poll) poll.stop();
}

export function startTerminalSignalCapture(params: {
  sessionKey: string;
  runId?: string;
  timeoutMs?: number;
  onTurnEnd: (event: RuntimeEndEvent) => void;
}): { stop: () => void } {
  const existing = activeTerminalSignalCaptures.get(params.sessionKey);
  if (existing) return existing;

  let stopped = false;
  let ws: WebSocket | null = null;
  const pending = new Map<string, (frame: Record<string, unknown>) => void>();
  const timeout = setTimeout(() => stop(), params.timeoutMs ?? 960_000);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(timeout);
    activeTerminalSignalCaptures.delete(params.sessionKey);
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    ws = null;
  }

  function sendRpc(method: string, rpcParams: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        resolve({ error: 'WS not open' });
        return;
      }
      const id = crypto.randomUUID();
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: 'req', id, method, params: rpcParams }));
    });
  }

  ws = new WebSocket(GATEWAY_WS_URL, openClawGatewayWsOptions(GATEWAY_WS_URL));

  ws.on('message', async (raw) => {
    if (stopped) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (frame.type === 'res' && typeof frame.id === 'string') {
      const handler = pending.get(frame.id);
      if (handler) {
        pending.delete(frame.id);
        handler(frame);
      }
      return;
    }
    if (frame.type !== 'event') return;

    const event = frame.event as string;
    const payload = frame.payload as Record<string, unknown> | undefined;

    if (event === 'connect.challenge') {
      const nonce = (payload?.nonce as string) ?? '';
      const connectResult = await sendRpc('connect', buildOpenClawGatewayConnectParams({
        nonce,
        displayName: 'Agent HQ Runtime End Capture',
      }));

      if (connectResult.error) {
        stop();
        return;
      }

      await sendRpc('chat.history', { sessionKey: params.sessionKey, limit: 1 });
      return;
    }

    if (event !== 'chat') return;
    const eventSessionKey = payload?.sessionKey as string | undefined;
    if (eventSessionKey && eventSessionKey !== params.sessionKey) return;

    const terminalEvent = resolveChatTerminalEvent(payload, params.sessionKey, params.runId);
    if (terminalEvent) {
      params.onTurnEnd(terminalEvent);
      stop();
    }
  });

  ws.on('error', () => stop());
  ws.on('close', () => { if (!stopped) stop(); });

  const handle = { stop };
  activeTerminalSignalCaptures.set(params.sessionKey, handle);
  return handle;
}

export function startRawSessionTerminalPoll(params: {
  instanceId: number;
  sessionKey: string;
  timeoutMs: number;
  onTurnEnd: (event: RuntimeEndEvent) => void;
}): void {
  if (activeRawSessionTerminalPolls.has(params.instanceId)) return;

  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const startedAt = Date.now();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearTimeout(timer);
    activeRawSessionTerminalPolls.delete(params.instanceId);
  };

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(tick, delayMs);
  };

  const tick = async () => {
    if (stopped) return;
    try {
      if (!await isInstanceStillActive(params.instanceId)) {
        stop();
        return;
      }
      if (Date.now() - startedAt > params.timeoutMs) {
        stop();
        return;
      }

      const db = getDb();
      const evaluation = await evaluateOpenClawInstanceSessionState(db, params.instanceId);
      if (evaluation.decision?.terminal) {
        params.onTurnEnd({
          type: 'runEnded',
          source: 'openclaw',
          success: evaluation.decision.success,
          reason: evaluation.decision.reason,
          sessionKey: params.sessionKey,
          runId: evaluation.state?.trajectoryRunId ?? undefined,
          endedAt: toCanonicalTimestampOrNow(evaluation.state?.trajectoryEndedAt ?? evaluation.state?.lastEventAt),
          error: evaluation.decision.error,
          metadata: {
            raw_session_terminal_poll: true,
            ...(evaluation.decision.metadata ?? {}),
          },
        });
        stop();
        return;
      }
    } catch (err) {
      console.warn(
        `[OpenClawRuntime] Raw session terminal poll failed for instance #${params.instanceId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }

    schedule(1000);
  };

  activeRawSessionTerminalPolls.set(params.instanceId, { stop });
  schedule(0);
}
