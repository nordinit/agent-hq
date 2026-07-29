/**
 * gatewayTranscriptCapture.ts — Background WebSocket subscriber that persists
 * gateway chat events to chat_messages in real-time for dispatched agent runs.
 *
 * WHY THIS EXISTS:
 *   The WS proxy in routes/chat.ts already has transcript persistence logic
 *   (persistStreamDelta, persistFinalMessage, persistHistoryMessages) but it
 *   only fires when a UI client is actively viewing a session. For headless
 *   dispatched runs (no browser tab open), nothing persists — leaving transcripts
 *   empty until the retroactive gateway.chat.history fetch, which fails for
 *   short-lived or failed/watchdog-killed runs.
 *
 * HOW IT WORKS:
 *   1. startTranscriptCapture() is called from OpenClawRuntime.dispatch() before
 *      and after chat.send. Repeated calls can force a chat.history refresh so
 *      fast/new sessions subscribe after OpenClaw indexes the agent session.
 *   2. Opens a dedicated background WS connection to the gateway.
 *   3. Authenticates with operator/admin scope (same flow as the WS proxy).
 *   4. Sends chat.history for the session — this:
 *        a) Returns any messages already in the gateway buffer
 *        b) Registers this WS connection as a listener for future events
 *   5. Persists structured history (text + tool_call + tool_result + thought) from
 *      the initial history fetch.
 *   6. Listens for live chat events (state=delta|final|aborted|error):
 *        - delta: updates the rolling assistant stream row
 *        - final: writes the complete final message row, then does a
 *                 full chat.history re-fetch to capture structured tool call rows
 *        - aborted|error: flushes whatever streamed before the abort
 *   7. Shuts down cleanly:
 *        - After receiving a final/aborted/error event
 *        - When stopTranscriptCapture() is called (e.g., on instance abort)
 *        - After an absolute timeout (instance timeout_seconds + 120s buffer)
 *
 * CAPTURE SOCKET MODEL:
 *   Before task #892, OpenClawRuntime.startCapture() opened two long-lived gateway
 *   subscription sockets per run:
 *     - startTranscriptCapture() in this file for chat.history + live transcript
 *       persistence.
 *     - startTerminalSignalCapture() in runtimes/openclaw/transcript.ts for the
 *       same chat.history subscription, but only to route agent_end/final/error
 *       terminal events into runtime-end handling.
 *   Terminal chat events now route through this capture socket via onTurnEnd.
 *   The short-lived GatewayConnectionPool remains separate because RPC calls and
 *   event subscriptions have different lifecycle, backpressure, and cleanup rules.
 *
 * DEDUPLICATION:
 *   Uses the same stable ID patterns as the WS proxy:
 *     oc-stream-<instanceId>       rolling stream row (upserted on every delta)
 *     oc-asst-<instanceId>-<n>     stable final message rows
 *     oc-hist-<instanceId>-<n>     history rows from chat.history fetch
 *   ON CONFLICT DO UPDATE ensures idempotent writes — both this module and the
 *   UI WS proxy can write to the same rows without conflicts.
 */

import { WebSocket } from 'ws';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { OPENCLAW_GATEWAY_WS_URL } from '../config';
import { getDb } from '../db/client';
import { normalizeChatMessageRole } from './chatMessageRoles';
import { tableHasColumn } from './durableRunIdentity';
import { extractGatewayStructuredEvents, extractTextFromGatewayMessage } from './openclawMessageEvents';
import { openClawGatewayWsOptions } from './openclawGatewayWs';
import { resolveOpenClawGatewayProtocolVersion } from './openclawGatewayProtocol';
import type { RuntimeEndEvent } from '../runtimes/types';
import { resolveChatTerminalEvent } from '../runtimes/openclaw/terminalEvents';
import { nowTimestamp, timestampFromEpochMs } from './timestamps';

// ── Config ────────────────────────────────────────────────────────────────────

const GATEWAY_WS_URL = OPENCLAW_GATEWAY_WS_URL;

// Read gateway auth token from openclaw config
function readGatewayTokenFromConfig(): string | null {
  try {
    const OPENCLAW_CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH
      ?? path.join(os.homedir(), '.openclaw', 'openclaw.json');
    const raw = fs.readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8');
    const cfg = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const token = cfg.gateway?.auth?.token;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function getGatewayAuthToken(): string {
  return process.env.OPENCLAW_GATEWAY_TOKEN ?? readGatewayTokenFromConfig() ?? '';
}

function normalizeChatRole(role: unknown, eventType?: unknown) {
  return normalizeChatMessageRole(role, eventType);
}

// ── Device Identity (for signed connect) ─────────────────────────────────────

interface DeviceIdentity {
  version: number;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

function loadDeviceIdentity(): DeviceIdentity | null {
  try {
    const identityPath = path.join(os.homedir(), '.openclaw', 'identity', 'device.json');
    const raw = fs.readFileSync(identityPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed?.version === 1 &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.publicKeyPem === 'string' &&
      typeof parsed.privateKeyPem === 'string'
    ) {
      return parsed as DeviceIdentity;
    }
    return null;
  } catch {
    return null;
  }
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function publicKeyRawBase64Url(publicKeyPem: string): string {
  const spki = crypto
    .createPublicKey(publicKeyPem)
    .export({ type: 'spki', format: 'der' }) as Buffer;
  if (spki.length >= 44) return base64UrlEncode(spki.slice(spki.length - 32));
  return base64UrlEncode(spki);
}

function signPayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  const signature = crypto.sign(null, Buffer.from(payload, 'utf8'), key);
  return base64UrlEncode(signature as Buffer);
}


// ── Content block types ───────────────────────────────────────────────────────

interface GatewayContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  thinking?: string;
}

interface OpenClawTerminalEvent {
  type?: string;
  error?: unknown;
  aborted?: unknown;
  timedOut?: unknown;
  timeout?: unknown;
  reason?: unknown;
  stopReason?: unknown;
  source?: unknown;
  [key: string]: unknown;
}

interface StructuredEvent {
  event_type: string;
  content: string;
  event_meta: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractText(message: unknown): string {
  return extractTextFromGatewayMessage(message);
}

function classifyTerminalReason(event: OpenClawTerminalEvent): 'completed' | 'aborted' | 'timeout' | 'error' {
  if (event.error != null) return 'error';
  if (event.timedOut === true || event.timeout === true) return 'timeout';
  if (event.aborted === true) return 'aborted';
  const reason = String(event.reason ?? event.stopReason ?? '').toLowerCase();
  if (reason.includes('timeout')) return 'timeout';
  if (reason.includes('abort') || reason.includes('cancel')) return 'aborted';
  if (reason.includes('error') || reason.includes('fail')) return 'error';
  return 'completed';
}

function buildTurnEndEvent(event: OpenClawTerminalEvent): StructuredEvent {
  const terminalReason = classifyTerminalReason(event);
  const contentByReason = {
    completed: 'Run completed',
    aborted: 'Run aborted',
    timeout: 'Run timed out',
    error: 'Run failed',
  } as const;

  return {
    event_type: 'turn_end',
    content: contentByReason[terminalReason],
    event_meta: {
      terminal_reason: terminalReason,
      openclaw_event_type: event.type ?? 'agent_end',
      source: event.source ?? 'openclaw-native',
      reason: event.reason ?? event.stopReason ?? null,
      aborted: event.aborted === true,
      timed_out: event.timedOut === true || event.timeout === true,
      error: event.error ?? null,
      raw: event,
    },
  };
}

function extractStructuredEvents(msg: Record<string, unknown>): StructuredEvent[] {
  const contentRaw = msg.content;
  const openclawEvent = msg.event as OpenClawTerminalEvent | undefined;
  const openclawEventType = typeof openclawEvent?.type === 'string' ? openclawEvent.type : '';

  if (openclawEventType === 'agent_end' && openclawEvent) {
    return [buildTurnEndEvent(openclawEvent)];
  }

  const events = extractGatewayStructuredEvents(msg);
  const hasStructuredContent = events.some(evt =>
    evt.event_type !== 'text' || evt.content.trim().length > 0,
  );
  if (hasStructuredContent) {
    return events;
  }

  const plainText =
    typeof contentRaw === 'string'
      ? contentRaw
      : extractTextFromGatewayMessage(msg);
  return [{ event_type: 'text', content: plainText, event_meta: {} }];
}

// ── DB write helpers ──────────────────────────────────────────────────────────

interface CaptureContext {
  instanceId: number;
  agentId: number;
  sessionKey: string;
  durableRunId: string | null;
}

async function resolveDurableRunId(instanceId: number): Promise<string | null> {
  try {
    const db = getDb();
    if (!await tableHasColumn(db, 'job_instances', 'durable_run_id')) return null;
    const row = await db.get('SELECT durable_run_id FROM job_instances WHERE id = ?', instanceId) as { durable_run_id?: string | null } | undefined;
    return row?.durable_run_id ?? null;
  } catch {
    return null;
  }
}

async function chatMessageIdentityColumns(
  db: ReturnType<typeof getDb>,
  ctx: CaptureContext,
): Promise<{
  insertColumnSql: string;
  valueSql: string;
  updateSql: string;
  values: unknown[];
}> {
  const columns: string[] = [];
  const values: unknown[] = [];

  if (await tableHasColumn(db, 'chat_messages', 'durable_run_id')) {
    columns.push('durable_run_id');
    values.push(ctx.durableRunId);
  }
  if (await tableHasColumn(db, 'chat_messages', 'session_key')) {
    columns.push('session_key');
    values.push(ctx.sessionKey);
  }

  return {
    insertColumnSql: columns.length ? `${columns.join(', ')}, ` : '',
    valueSql: columns.length ? `${columns.map(() => '?').join(', ')}, ` : '',
    updateSql: columns.map((column) => `${column} = excluded.${column},`).join('\n        '),
    values,
  };
}

async function persistHistoryMessages(
  ctx: CaptureContext,
  messages: Array<Record<string, unknown>>,
): Promise<number> {
  try {
    const db = getDb();
    const identity = await chatMessageIdentityColumns(db, ctx);
    const insertSql = `
      INSERT INTO chat_messages (id, agent_id, instance_id, ${identity.insertColumnSql}role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ${identity.valueSql}?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ${identity.updateSql}
        role = excluded.role,
        content = excluded.content,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        event_meta = excluded.event_meta
    `;

    // ONE transaction around the delete-then-reinsert.
    //
    // Before the async conversion the DELETE and the whole insert loop ran in a single
    // uninterrupted better-sqlite3 tick, so no reader could observe the gap. Now every await
    // yields the event loop, and this is a full refresh: it deletes every oc-hist-* and
    // oc-live-* row for the instance and rebuilds them one statement at a time. A concurrent
    // reader — routes/chat/persistence.ts and routes/sessions.ts both SELECT from
    // chat_messages on ordinary HTTP requests, and a refresh fires on every
    // final/aborted/error chat event — would render an empty or truncated transcript.
    return await db.withTransaction(async (tx) => {
      await tx.run('DELETE FROM chat_messages WHERE id LIKE ? OR id LIKE ?', `oc-hist-${ctx.instanceId}-%`, `oc-live-${ctx.instanceId}-%`);

      let rowIndex = 0;
      for (const m of messages) {
        const baseRole = m.role;
        const ts =
          typeof m.timestamp === 'number'
            ? (timestampFromEpochMs(m.timestamp) ?? nowTimestamp())
            : typeof m.timestamp === 'string'
              ? m.timestamp
              : nowTimestamp();

        for (const evt of extractStructuredEvents(m)) {
          const rowId = `oc-hist-${ctx.instanceId}-${rowIndex++}`;
          await tx.run(
            insertSql,
            rowId,
            ctx.agentId,
            ctx.instanceId,
            ...identity.values,
            normalizeChatRole(baseRole, evt.event_type),
            evt.content,
            ts,
            evt.event_type,
            JSON.stringify(evt.event_meta),
          );
        }
      }
      return rowIndex;
    });
  } catch (err) {
    console.warn(
      `[GatewayCapture] Failed to persist history for instance ${ctx.instanceId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

async function persistStreamDelta(ctx: CaptureContext, cumulativeText: string): Promise<void> {
  try {
    const db = getDb();
    const now = nowTimestamp();
    const identity = await chatMessageIdentityColumns(db, ctx);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, ${identity.insertColumnSql}role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ${identity.valueSql}'assistant', ?, ?, 'text', '{}')
      ON CONFLICT(id) DO UPDATE SET
        ${identity.updateSql}
        content = excluded.content,
        timestamp = excluded.timestamp
    `, `oc-stream-${ctx.instanceId}`, ctx.agentId, ctx.instanceId, ...identity.values, cumulativeText, now);
  } catch { /* non-critical */ }
}

async function persistFinalMessage(ctx: CaptureContext, text: string, msgIndex: number): Promise<void> {
  try {
    const db = getDb();
    const now = nowTimestamp();
    const identity = await chatMessageIdentityColumns(db, ctx);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, ${identity.insertColumnSql}role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ${identity.valueSql}'assistant', ?, ?, 'text', '{}')
      ON CONFLICT(id) DO UPDATE SET
        ${identity.updateSql}
        content = excluded.content,
        timestamp = excluded.timestamp
    `, `oc-asst-${ctx.instanceId}-${msgIndex}`, ctx.agentId, ctx.instanceId, ...identity.values, text, now);
    // Remove the rolling stream row — final message replaces it
    await db.run('DELETE FROM chat_messages WHERE id = ?', `oc-stream-${ctx.instanceId}`);
  } catch { /* non-critical */ }
}

async function persistLiveStructuredMessage(
  ctx: CaptureContext,
  message: Record<string, unknown>,
  rowIndex: number,
): Promise<number> {
  try {
    const db = getDb();
    const identity = await chatMessageIdentityColumns(db, ctx);
    const ts =
      typeof message.timestamp === 'number'
        ? (timestampFromEpochMs(message.timestamp) ?? nowTimestamp())
        : typeof message.timestamp === 'string'
          ? message.timestamp
          : nowTimestamp();
    const events = extractStructuredEvents(message).filter(evt =>
      evt.event_type !== 'text' || evt.content.trim().length > 0,
    );
    if (!events.length) return rowIndex;

    const insertSql = `
      INSERT INTO chat_messages (id, agent_id, instance_id, ${identity.insertColumnSql}role, content, timestamp, event_type, event_meta)
      VALUES (?, ?, ?, ${identity.valueSql}?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        ${identity.updateSql}
        role = excluded.role,
        content = excluded.content,
        timestamp = excluded.timestamp,
        event_type = excluded.event_type,
        event_meta = excluded.event_meta
    `;

    let nextIndex = rowIndex;
    for (const evt of events) {
      await db.run(
        insertSql,
        `oc-live-${ctx.instanceId}-${nextIndex++}`,
        ctx.agentId,
        ctx.instanceId,
        ...identity.values,
        normalizeChatRole(message.role, evt.event_type),
        evt.content,
        ts,
        evt.event_type,
        JSON.stringify(evt.event_meta),
      );
    }
    return nextIndex;
  } catch (err) {
    console.warn(
      `[GatewayCapture] Failed to persist live event for instance ${ctx.instanceId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return rowIndex;
  }
}

// ── GatewayTranscriptCapture ──────────────────────────────────────────────────

export interface CaptureOptions {
  /** Absolute timeout in ms — capture is force-stopped after this. Default: 960_000 (16 min) */
  timeoutMs?: number;
  /** Force an existing capture to re-run chat.history/subscription registration. */
  forceHistoryRefresh?: boolean;
  /** Bounded retry count for initial empty/not-indexed chat.history responses. */
  historyRetryCount?: number;
  /** Delay between chat.history retries. Default: 750ms. */
  historyRetryDelayMs?: number;
  /** OpenClaw run id attached to terminal runtime-end events once chat.send resolves. */
  runId?: string;
  /** Route terminal chat events from the shared transcript subscription. */
  onTurnEnd?: (event: RuntimeEndEvent) => void;
}

interface GatewayTranscriptCaptureHandle {
  stop(): void;
}

/**
 * GatewayTranscriptCapture — maintains one background WS connection per instance,
 * subscribing to chat events for a single session and writing them to chat_messages.
 */
class GatewayTranscriptCapture {
  private ws: WebSocket | null = null;
  private stopped = false;
  private stopTimeout: ReturnType<typeof setTimeout> | null = null;
  private readonly ctx: CaptureContext;
  private readonly sessionKey: string;
  private streamText = '';
  private assistantMsgIndex = 0;
  private liveRowIndex = 0;
  /**
   * Serialises chat-event handling. liveRowIndex is read-modify-written across an await, so
   * concurrent handlers collide on the same row id and lose messages. See the dispatch site.
   */
  private chatEventQueue: Promise<void> = Promise.resolve();
  private lastStreamFlushText = '';
  private readonly pending = new Map<string, (frame: Record<string, unknown>) => void>();
  private historyRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private historyRefreshInFlight = false;
  private historyRefreshQueued = false;
  private readonly historyRetryCount: number;
  private readonly historyRetryDelayMs: number;
  private runId?: string;
  private onTurnEnd?: (event: RuntimeEndEvent) => void;

  constructor(ctx: CaptureContext, sessionKey: string, opts: CaptureOptions = {}) {
    this.ctx = ctx;
    this.sessionKey = sessionKey;
    this.historyRetryCount = Math.max(0, Math.floor(opts.historyRetryCount ?? 6));
    this.historyRetryDelayMs = Math.max(1, Math.floor(opts.historyRetryDelayMs ?? 750));
    this.runId = opts.runId;
    this.onTurnEnd = opts.onTurnEnd;

    const timeoutMs = opts.timeoutMs ?? 960_000; // 16 min default
    this.stopTimeout = setTimeout(() => {
      console.log(
        `[GatewayCapture] Timeout for instance ${ctx.instanceId} — stopping capture`,
      );
      this.stop();
    }, timeoutMs);

    this.connect();
  }

  updateOptions(opts: CaptureOptions): void {
    if (opts.runId !== undefined) this.runId = opts.runId;
    if (opts.onTurnEnd !== undefined) this.onTurnEnd = opts.onTurnEnd;
  }

  /** Stop the capture and close the WS connection */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }
    if (this.historyRetryTimer) {
      clearTimeout(this.historyRetryTimer);
      this.historyRetryTimer = null;
    }

    if (this.streamText) {
      // Flush any partial stream before stopping
      await persistFinalMessage(this.ctx, this.streamText, this.assistantMsgIndex++);
      this.streamText = '';
    }

    this.resolvePending({ error: 'Gateway capture stopped' });

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;

    console.log(`[GatewayCapture] Stopped capture for instance ${this.ctx.instanceId}`);
  }

  private sendRpc(
    method: string,
    rpcParams: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve({ error: 'WS not open' });
        return;
      }
      const id = crypto.randomUUID();
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ type: 'req', id, method, params: rpcParams }));
    });
  }

  private resolvePending(frame: Record<string, unknown>): void {
    for (const resolve of this.pending.values()) {
      resolve(frame);
    }
    this.pending.clear();
  }

  private connect(): void {
    if (this.stopped) return;

    const ws = new WebSocket(GATEWAY_WS_URL, openClawGatewayWsOptions(GATEWAY_WS_URL));
    this.ws = ws;

    ws.on('error', (err) => {
      if (!this.stopped) {
        console.warn(
          `[GatewayCapture] WS error for instance ${this.ctx.instanceId}:`,
          err.message,
        );
        this.stop();
      }
    });

    ws.on('close', () => {
      if (!this.stopped) {
        console.log(`[GatewayCapture] WS closed for instance ${this.ctx.instanceId}`);
        this.stop();
      }
    });

    ws.on('message', async (raw) => {
      if (this.stopped) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const frameType = frame.type as string;

      // ── RPC response ──────────────────────────────────────────────────────
      if (frameType === 'res') {
        const id = frame.id as string;
        const handler = this.pending.get(id);
        if (handler) {
          this.pending.delete(id);
          handler(frame);
        }
        return;
      }

      // ── Gateway events ────────────────────────────────────────────────────
      if (frameType === 'event') {
        const event = frame.event as string;
        const payload = frame.payload as Record<string, unknown> | undefined;

        if (event === 'connect.challenge') {
          await this.handleChallenge(payload);
          return;
        }

        if (event === 'chat') {
          const eventSessionKey = payload?.sessionKey as string | undefined;
          // Filter to only our session
          if (eventSessionKey && eventSessionKey !== this.sessionKey) return;

          const terminalEvent = resolveChatTerminalEvent(payload, this.sessionKey, this.runId);
          if (terminalEvent) {
            this.onTurnEnd?.(terminalEvent);
          }

          const state = payload?.state as string;
          // SERIALISED, not merely fire-and-forget. handleChatEvent performs a
          // read-modify-write on this.liveRowIndex that straddles an await
          // (persistLiveStructuredMessage). Dispatching concurrently — which is what two
          // chat frames arriving in one socket read do — lets both invocations read the same
          // index, insert the same `oc-live-<instance>-<n>` id, and the ON CONFLICT DO UPDATE
          // makes the second silently OVERWRITE the first. Reproduced: two tool_call frames
          // produced 2 transcript rows before the async conversion and 1 after.
          //
          // The chain keeps the handler off this callback's critical path (the socket must
          // not block) while guaranteeing one-at-a-time execution. The catch is required:
          // without it a rejection here is unhandled and terminates the process.
          this.chatEventQueue = this.chatEventQueue
            .then(() => this.handleChatEvent(state, payload?.message))
            .catch((err) => {
              console.warn(`[gatewayCapture] chat event handling failed for ${this.sessionKey}:`, err);
            });
          return;
        }
      }
    });
  }

  private async handleChallenge(
    payload: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (this.stopped) return;

    const nonce = (payload?.nonce as string) ?? '';
    const role = 'operator';
    const scopes = ['operator.read', 'operator.write', 'operator.admin'];
    const signedAtMs = Date.now();
    const gatewayAuthToken = getGatewayAuthToken();
    const deviceIdentity = loadDeviceIdentity();

    let device: Record<string, unknown> | undefined;
    if (deviceIdentity) {
      const sigPayload = [
        'v3',
        deviceIdentity.deviceId,
        'gateway-client',
        'ui',
        role,
        scopes.join(','),
        String(signedAtMs),
        gatewayAuthToken,
        nonce,
        process.platform,
        '',
      ].join('|');

      device = {
        id: deviceIdentity.deviceId,
        publicKey: publicKeyRawBase64Url(deviceIdentity.publicKeyPem),
        signature: signPayload(deviceIdentity.privateKeyPem, sigPayload),
        signedAt: signedAtMs,
        nonce,
      };
    }

    const connectResult = await this.sendRpc('connect', {
      minProtocol: resolveOpenClawGatewayProtocolVersion(),
      maxProtocol: resolveOpenClawGatewayProtocolVersion(),
      client: {
        id: 'gateway-client',
        displayName: 'Agent HQ Transcript Capture',
        version: '1.0.0',
        platform: process.platform,
        mode: 'ui',
        instanceId: crypto.randomUUID(),
      },
      caps: [],
      role,
      scopes,
      auth: { token: gatewayAuthToken },
      ...(device ? { device } : {}),
    });

    if (connectResult.error) {
      console.warn(
        `[GatewayCapture] Connect failed for instance ${this.ctx.instanceId}:`,
        JSON.stringify(connectResult.error),
      );
      this.stop();
      return;
    }

    // Connected — fetch initial history to:
    //   a) Persist any messages already in the buffer
    //   b) Register this WS connection as a chat event subscriber for this session
    if (!this.stopped) {
      await this.fetchAndPersistHistory({ retriesRemaining: this.historyRetryCount });
    }
  }

  /** Send chat.history and persist the results */
  refreshHistory(): void {
    if (this.historyRetryTimer) {
      clearTimeout(this.historyRetryTimer);
      this.historyRetryTimer = null;
    }
    if (this.historyRefreshInFlight) {
      this.historyRefreshQueued = true;
      return;
    }
    void this.fetchAndPersistHistory({ retriesRemaining: this.historyRetryCount });
  }

  private async fetchAndPersistHistory(options: { retriesRemaining?: number } = {}): Promise<void> {
    if (this.stopped || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.historyRefreshInFlight) return;
    this.historyRefreshInFlight = true;

    try {
      const histResult = await this.sendRpc('chat.history', {
        sessionKey: this.sessionKey,
        limit: 200,
      });

      if (this.stopped) return;

      if (histResult.ok === false) {
        // Non-fatal: the session may not be indexed yet. Retry so this WS can
        // register as a listener while the instance is still running.
        this.scheduleHistoryRetry(options.retriesRemaining ?? 0);
        return;
      }

      const histPayload = histResult.payload as Record<string, unknown> | undefined ?? {};
      const msgs = Array.isArray(histPayload.messages) ? histPayload.messages : [];

      if (msgs.length > 0) {
        await persistHistoryMessages(
                    this.ctx,
                    msgs as Array<Record<string, unknown>>,
                  );
        // Track how many assistant messages are already persisted
        const assistantCount = msgs.filter(
          (m: unknown) =>
            typeof m === 'object' &&
            m !== null &&
            (m as Record<string, unknown>).role === 'assistant',
        ).length;
        if (assistantCount > this.assistantMsgIndex) {
          this.assistantMsgIndex = assistantCount;
        }
      } else {
        // Empty history can mean OpenClaw has not indexed the just-created
        // session yet. Retrying chat.history is also the subscription retry.
        this.scheduleHistoryRetry(options.retriesRemaining ?? 0);
      }
    } finally {
      this.historyRefreshInFlight = false;
      if (this.historyRefreshQueued && !this.stopped) {
        this.historyRefreshQueued = false;
        void this.fetchAndPersistHistory({ retriesRemaining: this.historyRetryCount });
      }
    }
  }

  private scheduleHistoryRetry(retriesRemaining: number): void {
    if (this.stopped || retriesRemaining <= 0 || this.historyRetryTimer) return;
    this.historyRetryTimer = setTimeout(() => {
      this.historyRetryTimer = null;
      void this.fetchAndPersistHistory({ retriesRemaining: retriesRemaining - 1 });
    }, this.historyRetryDelayMs);
  }

  private async handleChatEvent(state: string, message: unknown): Promise<void> {
    if (this.stopped) return;

    if (state === 'delta') {
      const newText = extractText(message);
      // Gateway sends cumulative text; update rolling stream
      this.streamText = newText;
      // Persist every non-empty delta so live polling is not gated on long output.
      if (this.streamText && this.streamText !== this.lastStreamFlushText) {
        await persistStreamDelta(this.ctx, this.streamText);
        this.lastStreamFlushText = this.streamText;
      }
    } else if (state === 'final') {
      const finalText = extractText(message);
      const textToSave = finalText || this.streamText;

      // Persist the final text message
      if (textToSave) {
        await persistFinalMessage(this.ctx, textToSave, this.assistantMsgIndex++);
      }
      this.streamText = '';
      this.lastStreamFlushText = '';

      // Do a full history re-fetch to capture structured events (tool calls, thoughts,
      // and native agent_end terminal events) that aren't visible in plain-text streaming.
      void this.fetchAndPersistHistory().then(() => {
        this.stop();
      });

    } else if (state === 'aborted' || state === 'error') {
      // Flush whatever partial text was streamed before abort
      if (this.streamText) {
        await persistFinalMessage(this.ctx, this.streamText, this.assistantMsgIndex++);
        this.streamText = '';
        this.lastStreamFlushText = '';
      }
      // Do a final history fetch to capture partial structured content
      void this.fetchAndPersistHistory().then(() => {
        // Stop after partial flush for failed/aborted runs
        this.stop();
      });
    } else if (message && typeof message === 'object') {
      this.liveRowIndex = await persistLiveStructuredMessage(
              this.ctx,
              message as Record<string, unknown>,
              this.liveRowIndex,
            );
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Active captures keyed by sessionKey */
const activeCaptures = new Map<string, GatewayTranscriptCapture>();

/**
 * startTranscriptCapture — begin background real-time transcript persistence
 * for a dispatched OpenClaw instance.
 *
 * Safe to call multiple times for the same session. Subsequent calls can force
 * a chat.history refresh/subscription retry for sessions that were not indexed
 * when the first capture started.
 *
 * @param instanceId   job_instances.id
 * @param agentId      agents.id
 * @param sessionKey   Full gateway session key (e.g. "agent:<project>:<agent>:<role>:run:<id>")
 * @param opts         Optional: timeoutMs override
 */
export async function startTranscriptCapture(
  instanceId: number,
  agentId: number,
  sessionKey: string,
  opts: CaptureOptions = {},
): Promise<GatewayTranscriptCaptureHandle> {
  // Idempotent: if already capturing this session, return existing handle
  const existing = activeCaptures.get(sessionKey);
  if (existing) {
    existing.updateOptions(opts);
    if (opts.forceHistoryRefresh) {
      existing.refreshHistory();
    }
    return { stop: () => existing.stop() };
  }

  console.log(
    `[GatewayCapture] Starting transcript capture for instance ${instanceId} session="${sessionKey}"`,
  );

  const capture = new GatewayTranscriptCapture({
    instanceId,
    agentId,
    sessionKey,
    durableRunId: await resolveDurableRunId(instanceId),
  }, sessionKey, opts);
  activeCaptures.set(sessionKey, capture);

  // Auto-remove from registry when stopped
  const originalStop = capture.stop.bind(capture);
  const wrappedStop = () => {
    activeCaptures.delete(sessionKey);
    originalStop();
  };
  // Patch stop on the instance (TypeScript: access via any for private override)
  (capture as unknown as Record<string, unknown>).stop = wrappedStop;

  return { stop: wrappedStop };
}

/**
 * stopTranscriptCapture — stop a background capture by session key.
 * Called on instance abort or when the run is complete.
 */
export function stopTranscriptCapture(sessionKey: string): void {
  const capture = activeCaptures.get(sessionKey);
  if (capture) {
    capture.stop();
    activeCaptures.delete(sessionKey);
  }
}

/**
 * getActiveCaptureCount — for monitoring/tests.
 */
export function getActiveCaptureCount(): number {
  return activeCaptures.size;
}
