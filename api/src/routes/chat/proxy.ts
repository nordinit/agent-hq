import { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';
import { WebSocket as WsClient, WebSocketServer } from 'ws';
import { getDb } from '../../db/client';
import { resolveAgentRowForSessionKey, buildDerivedDirectSessionKey } from '../../domains/chat/sessions';
import { backfillOpenClawJsonlTranscript } from '../../domains/runs/openclawJsonlBackfill';
import { summarizeGatewayErrorForUi } from '../../lib/chatGatewayErrors';
import { isPairingRequiredClose, isPairingRequiredText } from '../../lib/openclawAutoPair';
import { openClawGatewayWsOptions } from '../../lib/openclawGatewayWs';
import { toGatewaySessionKey } from '../../lib/sessionKeys';
import { buildOpenClawGatewayConnectParams, loadDeviceIdentity } from '../../runtimes/openclaw/gatewayClient';
import { getDefaultGatewayUrl, resolveGatewayUrl } from './gatewayUrl';
import { completeChatRunInstance, persistFinalMessage, persistHistoryMessages, persistLiveStructuredMessage, persistStreamDelta, persistUserChatMessage, startChatRunInstance } from './persistence';
import { resolveSessionContext, SessionContext } from './sessionContext';
import { extractText, gatewayMsgToUi } from './structuredEvents';

const startupDeviceIdentity = loadDeviceIdentity();
if (startupDeviceIdentity) {
  console.log('[chat-proxy] Loaded device identity:', startupDeviceIdentity.deviceId);
} else {
  console.warn('[chat-proxy] No device identity found — connect will use token-only auth (scopes may be stripped)');
}

function findNestedString(value: unknown, keys: string[], seen = new Set<unknown>()): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (seen.has(value)) {
    return null;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findNestedString(entry, keys, seen);
      if (nested) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  for (const nestedValue of Object.values(record)) {
    const nested = findNestedString(nestedValue, keys, seen);
    if (nested) return nested;
  }

  return null;
}

const CHAT_JSONL_POLL_MS = 750;

// ─── WebSocket Proxy ──────────────────────────────────────────────────────────

export function setupChatProxy(wss: WebSocketServer): void {
  wss.on('connection', async (clientWs: WsClient, _req: IncomingMessage) => {
    // Connect to the host gateway initially; may switch to a container gateway on first chat.history
    let currentGatewayUrl = await getDefaultGatewayUrl();
    let gatewayWs = new WsClient(currentGatewayUrl, openClawGatewayWsOptions(currentGatewayUrl));
    let pairingRetryAttempted = false;
    let pairingRetryInFlight = false;

    // Track pending requests: reqId → method name
    const pending = new Map<string, string>();
    // Track streaming state for delta computation
    let streamText = '';
    let pendingAssistantResponse = false;
    // Chat-run instance for the in-flight turn (so chats are saved like other agent runs)
    let currentChatInstanceId: number | null = null;
    // Track which session the UI is currently viewing
    let activeSessionKey: string | null = null;
    // Transcript capture state
    let sessionCtx: SessionContext | null = null;
    let assistantMsgIndex = 0;
    let lastStreamFlushLen = 0;
    let jsonlPollTimer: ReturnType<typeof setInterval> | null = null;
    let jsonlPollInstanceId: number | null = null;
    const STREAM_FLUSH_THRESHOLD = 200; // chars between DB flushes
    // Queue messages received from client before gateway auth completes
    let gatewayReady = false;
    const clientMsgQueue: Array<Record<string, unknown>> = [];

    function retryGatewayAfterPairing(): boolean {
      if (pairingRetryAttempted || pairingRetryInFlight) return false;
      pairingRetryAttempted = true;
      pairingRetryInFlight = true;
      console.warn(`[chat-proxy] Pairing is manual for ${currentGatewayUrl}. Approve the pending request with openclaw devices list/approve, then retry.`);
      pairingRetryInFlight = false;
      return false;
    }

    async function ingestJsonlStructuredRows(instanceId: number): Promise<void> {
      try {
        await backfillOpenClawJsonlTranscript(getDb(), instanceId, { structuredOnly: true });
      } catch (err) {
        console.warn('[chat-proxy] Failed to ingest OpenClaw JSONL transcript:', err instanceof Error ? err.message : String(err));
      }
    }

    async function startJsonlIngestPolling(instanceId: number): Promise<void> {
      await stopJsonlIngestPolling();
      jsonlPollInstanceId = instanceId;
      await ingestJsonlStructuredRows(instanceId);
      jsonlPollTimer = setInterval(async () => await ingestJsonlStructuredRows(instanceId), CHAT_JSONL_POLL_MS);
    }

    async function stopJsonlIngestPolling(finalPoll = false): Promise<void> {
      const instanceId = jsonlPollInstanceId;
      if (jsonlPollTimer) {
        clearInterval(jsonlPollTimer);
        jsonlPollTimer = null;
      }
      jsonlPollInstanceId = null;
      if (finalPoll && instanceId != null) {
        await ingestJsonlStructuredRows(instanceId);
      }
    }

    // ── Gateway → Client ──────────────────────────────────────────────────

    /** Attach gateway event handlers. Re-called when gateway is switched. */
    function attachGatewayHandlers(gw: WsClient): void {
    gw.on('message', async (raw) => {
      if (clientWs.readyState !== WsClient.OPEN) return;
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const frameType = frame.type as string;

      if (frameType === 'event') {
        const event = frame.event as string;
        const payload = frame.payload as Record<string, unknown> | undefined;

        if (event === 'connect.challenge') {
          // Respond with proper connect request
          const nonce = payload?.nonce as string ?? '';
          const connectId = randomUUID();
          pending.set(connectId, 'connect');
          const connectReq = {
            type: 'req',
            id: connectId,
            method: 'connect',
            params: buildOpenClawGatewayConnectParams({
              nonce,
              displayName: 'Agent HQ',
            }),
          };
          console.log('[chat-proxy] Responding to challenge with nonce:', nonce);
          gatewayWs.send(JSON.stringify(connectReq));
          return;
        }

        if (event === 'chat') {
          // Only forward chat events for the session the UI is currently viewing
          const eventSessionKey = payload?.sessionKey as string | undefined;
          if (eventSessionKey && activeSessionKey && eventSessionKey !== activeSessionKey) {
            return; // Belongs to a different session — drop it
          }

          // Translate gateway chat event to UI format
          const state = payload?.state as string;
          if (state === 'delta') {
            pendingAssistantResponse = true;
            if (sessionCtx && payload?.message && typeof payload.message === 'object') {
              await persistLiveStructuredMessage(sessionCtx, payload.message as Record<string, unknown>);
            }
            const newText = extractText(payload?.message);
            // Gateway sends cumulative text; compute incremental delta
            const delta = newText.startsWith(streamText) ? newText.slice(streamText.length) : newText;
            streamText = newText;
            if (delta) {
              clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta, done: false }));
            }
            // Persist streaming content periodically
            if (sessionCtx && streamText.length - lastStreamFlushLen >= STREAM_FLUSH_THRESHOLD) {
              await persistStreamDelta(sessionCtx, streamText);
              lastStreamFlushLen = streamText.length;
            }
          } else if (state === 'final') {
            pendingAssistantResponse = false;
            if (sessionCtx && payload?.message && typeof payload.message === 'object') {
              await persistLiveStructuredMessage(sessionCtx, payload.message as Record<string, unknown>);
            }
            // Final event contains the complete text — flush any remaining delta
            const finalText = extractText(payload?.message);
            if (finalText) {
              const remaining = finalText.startsWith(streamText)
                ? finalText.slice(streamText.length)
                : (streamText ? '' : finalText);  // if stream diverged, don't double-send
              if (remaining) {
                clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta: remaining, done: false }));
              }
            }
            // Persist final assistant message
            if (sessionCtx) {
              await persistFinalMessage(sessionCtx, finalText || streamText, assistantMsgIndex++);
              lastStreamFlushLen = 0;
              await stopJsonlIngestPolling(true);
            }
            if (currentChatInstanceId != null) {
              await completeChatRunInstance(currentChatInstanceId, 'done');
              currentChatInstanceId = null;
            }
            streamText = '';
            clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta: '', done: true }));
          } else if (state === 'aborted' || state === 'error') {
            pendingAssistantResponse = false;
            if (sessionCtx && payload?.message && typeof payload.message === 'object') {
              await persistLiveStructuredMessage(sessionCtx, payload.message as Record<string, unknown>);
            }
            // Persist whatever was streamed before abort
            if (sessionCtx && streamText) {
              await persistFinalMessage(sessionCtx, streamText, assistantMsgIndex++);
              lastStreamFlushLen = 0;
            }
            await stopJsonlIngestPolling(true);
            if (currentChatInstanceId != null) {
              await completeChatRunInstance(currentChatInstanceId, state === 'aborted' ? 'cancelled' : 'failed');
              currentChatInstanceId = null;
            }
            const hadPartialStream = Boolean(streamText);
            streamText = '';
            if (hadPartialStream || state === 'aborted') {
              clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta: '', done: true }));
            }
            if (state === 'error') {
              clientWs.send(JSON.stringify({
                type: 'error',
                message: summarizeGatewayErrorForUi(payload),
              }));
            }
          } else if (sessionCtx && payload?.message && typeof payload.message === 'object') {
            await persistLiveStructuredMessage(sessionCtx, payload.message as Record<string, unknown>);
          }
          return;
        }

        const customType = findNestedString(frame, ['customType']);
        if (pendingAssistantResponse && customType === 'openclaw:prompt-error') {
          const eventSessionKey = findNestedString(frame, ['sessionKey']);
          if (eventSessionKey && activeSessionKey && eventSessionKey !== activeSessionKey) {
            return;
          }

          // Preserve any streamed partial response before surfacing the provider error.
          if (sessionCtx && streamText) {
            await persistFinalMessage(sessionCtx, streamText, assistantMsgIndex++);
            lastStreamFlushLen = 0;
          }
          await stopJsonlIngestPolling(true);
          if (currentChatInstanceId != null) {
            await completeChatRunInstance(currentChatInstanceId, 'failed');
            currentChatInstanceId = null;
          }
          const hadPartialStream = Boolean(streamText);
          pendingAssistantResponse = false;
          streamText = '';
          if (hadPartialStream) {
            clientWs.send(JSON.stringify({ type: 'chat', role: 'assistant', delta: '', done: true }));
          }
          clientWs.send(JSON.stringify({
            type: 'error',
            message: summarizeGatewayErrorForUi(frame),
          }));
          return;
        }

        // Other events: pass through as-is (future use)
        return;
      }

      if (frameType === 'res') {
        const id = frame.id as string;
        const ok = frame.ok as boolean;
        const method = pending.get(id);
        pending.delete(id);

        if (method === 'connect') {
          // Connect ack — gateway is now ready
          if (!ok) {
            const errMsg = (frame.error as Record<string, unknown>)?.message ?? 'connect failed';
            if (isPairingRequiredText(String(errMsg)) && retryGatewayAfterPairing()) {
              return;
            }
            clientWs.send(JSON.stringify({
              type: 'error',
              message: summarizeGatewayErrorForUi(frame.error ?? errMsg),
            }));
            clientWs.close();
          } else {
            // Flush any messages that arrived before auth completed
            gatewayReady = true;
            for (const queued of clientMsgQueue) {
              await processClientMessage(queued);
            }
            clientMsgQueue.length = 0;
          }
          return;
        }

        if (method === 'chat.send') {
          if (ok) {
            pendingAssistantResponse = true;
            streamText = '';
            clientWs.send(JSON.stringify({ type: 'chat.send' }));
          } else {
            pendingAssistantResponse = false;
            const errMsg = (frame.error as Record<string, unknown>)?.message ?? 'chat.send failed';
            clientWs.send(JSON.stringify({
              type: 'error',
              message: summarizeGatewayErrorForUi(frame.error ?? errMsg),
            }));
          }
          return;
        }

        if (method === 'chat.history') {
          if (ok) {
            const payload = frame.payload as Record<string, unknown> ?? {};
            const msgs = Array.isArray(payload.messages) ? payload.messages : [];
            const uiMessages = msgs.map((m: unknown, i: number) => gatewayMsgToUi(m, i));
            clientWs.send(JSON.stringify({ type: 'chat.history', messages: uiMessages }));
            // Persist history to chat_messages for transcript API
            if (sessionCtx && msgs.length > 0) {
              await persistHistoryMessages(sessionCtx, msgs as Array<Record<string, unknown>>);
              assistantMsgIndex = msgs.filter((m: unknown) =>
                typeof m === 'object' && m !== null && (m as Record<string, unknown>).role === 'assistant'
              ).length;
            }
          } else {
            clientWs.send(JSON.stringify({ type: 'chat.history', messages: [] }));
          }
          return;
        }

        if (method === 'chat.abort') {
          pendingAssistantResponse = false;
          streamText = '';
          // Nothing to do for abort ack
          return;
        }

        // Unknown method response — pass through
      }
    });

    gw.on('error', async (err) => {
      console.error('[chat-proxy] Gateway WS error:', err.message);
      await stopJsonlIngestPolling(true);
      if (currentChatInstanceId != null) {
        await completeChatRunInstance(currentChatInstanceId, 'failed');
        currentChatInstanceId = null;
      }
      if (clientWs.readyState === WsClient.OPEN) {
        const message = pendingAssistantResponse
          ? 'Connection to Atlas was interrupted before a response completed. Retry.'
          : 'Gateway connection failed';
        pendingAssistantResponse = false;
        streamText = '';
        clientWs.send(JSON.stringify({
          type: 'error',
          message,
        }));
        clientWs.close();
      }
    });

    gw.on('close', async (code, reason) => {
      if (gw !== gatewayWs || clientWs.readyState !== WsClient.OPEN) return;
      if (isPairingRequiredClose(code, reason) && retryGatewayAfterPairing()) {
        return;
      }
      if (pendingAssistantResponse) {
        await stopJsonlIngestPolling(true);
        pendingAssistantResponse = false;
        streamText = '';
        clientWs.send(JSON.stringify({
          type: 'error',
          message: 'Connection to Atlas was interrupted before a response completed. Retry.',
        }));
      }
      clientWs.close();
    });

    } // end attachGatewayHandlers

    // Attach handlers to the initial gateway connection
    attachGatewayHandlers(gatewayWs);

    // ── Client → Gateway ──────────────────────────────────────────────────

    /** Process a parsed client message once gateway is authenticated */
    async function processClientMessage(msg: Record<string, unknown>): Promise<void> {
      if (gatewayWs.readyState !== WsClient.OPEN) return;

      const type = msg.type as string;

      if (type === 'chat.history') {
        const sessionKey = msg.sessionKey as string | undefined;
        if (sessionKey) {
          activeSessionKey = sessionKey;
          sessionCtx = await resolveSessionContext(sessionKey);
          assistantMsgIndex = 0;
          lastStreamFlushLen = 0;
        }

        // Resolve correct gateway — container agents have their own WS endpoint
        const targetUrl = await resolveGatewayUrl(sessionKey ?? null);
        if (targetUrl !== currentGatewayUrl) {
          console.log(`[chat-proxy] Switching gateway ${currentGatewayUrl} → ${targetUrl} for "${sessionKey}"`);
          const oldGw = gatewayWs;
          currentGatewayUrl = targetUrl;
          gatewayReady = false;
          const newGw = new WsClient(targetUrl, openClawGatewayWsOptions(targetUrl));
          gatewayWs = newGw;
          // Attach same event handlers to new gateway
          attachGatewayHandlers(newGw);
          oldGw.close();
          // Queue this message to replay after new gateway authenticates
          clientMsgQueue.push(msg);
          return;
        }

        const reqId = randomUUID();
        pending.set(reqId, 'chat.history');
        const gatewaySessionKey = toGatewaySessionKey(
          msg.sessionKey as string | null | undefined,
          await resolveAgentRowForSessionKey(msg.sessionKey as string | null | undefined),
        );
        gatewayWs.send(JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'chat.history',
          params: {
            sessionKey: gatewaySessionKey ?? msg.sessionKey,
            limit: 200,
          },
        }));
        return;
      }

      if (type === 'chat.new') {
        const currentKey = typeof msg.sessionKey === 'string' ? msg.sessionKey : activeSessionKey;
        const channel = typeof msg.channel === 'string' && msg.channel.trim() ? msg.channel.trim() : 'web';
        if (!currentKey) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'No active session to rotate' }));
          return;
        }
        const currentCtx = await resolveSessionContext(currentKey);
        if (!currentCtx || currentCtx.instanceId !== null) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'Session rotation only supports direct chats' }));
          return;
        }

        const newSessionKey = await buildDerivedDirectSessionKey(currentKey, channel, currentCtx.agentId, true);
        if (!newSessionKey) {
          clientWs.send(JSON.stringify({ type: 'error', message: 'Session rotation only supports agent direct chats' }));
          return;
        }

        activeSessionKey = newSessionKey;
        sessionCtx = await resolveSessionContext(newSessionKey);
        assistantMsgIndex = 0;
        lastStreamFlushLen = 0;
        streamText = '';
        pendingAssistantResponse = false;

        clientWs.send(JSON.stringify({ type: 'chat.new', sessionKey: newSessionKey }));
        return;
      }

      if (type === 'chat.send') {
        // Track which session the UI is currently viewing
        if (msg.sessionKey) activeSessionKey = msg.sessionKey as string;

        // Resolve attachment_ids into metadata and append to message text
        let fullMessage = typeof msg.message === 'string' ? msg.message : '';
        const attachmentIds: number[] = Array.isArray(msg.attachment_ids)
          ? (msg.attachment_ids as unknown[]).map(Number).filter(n => !isNaN(n))
          : [];
        if (attachmentIds.length > 0) {
          try {
            const db = getDb();
            const placeholders = attachmentIds.map(() => '?').join(',');
            const attachments = await db.all(`SELECT * FROM chat_attachments WHERE id IN (${placeholders})`, ...attachmentIds) as Array<Record<string, unknown>>;
            for (const a of attachments) {
              const apiPort = process.env.AGENT_HQ_API_PORT ?? '3501';
              const url = `http://localhost:${apiPort}/api/v1/chat/attachments/${a.id as number}/download`;
              const mime = a.mime_type as string ?? '';
              const label = mime.startsWith('image/')
                ? `[image: ${a.filename as string}](${url})`
                : `[file: ${a.filename as string}](${url})`;
              fullMessage = [fullMessage, label].filter(Boolean).join('\n');
            }
          } catch (e) {
            console.warn('[chat-proxy] Failed to resolve attachments:', e);
          }
        }

        // Persist user message to chat_messages
        if (activeSessionKey) sessionCtx = await resolveSessionContext(activeSessionKey);
        // Save this chat turn as a job_instance (like every other agent run) so it picks
        // up the instance-based transcript/capture machinery. Only for instance-less
        // direct/agent chats — sessions that are already a run keep their instance.
        if (sessionCtx && sessionCtx.instanceId === null) {
          const chatRun = await startChatRunInstance(sessionCtx);
          if (chatRun) {
            sessionCtx = { ...sessionCtx, instanceId: chatRun.instanceId, durableRunId: chatRun.durableRunId };
            currentChatInstanceId = chatRun.instanceId;
            assistantMsgIndex = 0;
            await startJsonlIngestPolling(chatRun.instanceId);
          }
        }
        if (sessionCtx && fullMessage) {
          await persistUserChatMessage(sessionCtx, fullMessage);
        }
        const gatewaySessionKey = toGatewaySessionKey(msg.sessionKey as string | null | undefined, await resolveAgentRowForSessionKey(msg.sessionKey as string | null | undefined));
        const reqId = randomUUID();
        pending.set(reqId, 'chat.send');
        const chatSendParams: Record<string, unknown> = {
          sessionKey: gatewaySessionKey ?? msg.sessionKey,
          message: fullMessage || msg.message,
          deliver: false,
          idempotencyKey: msg.idempotencyKey ?? randomUUID(),
        };
        if (typeof msg.cwd === 'string' && msg.cwd.trim()) {
          chatSendParams.cwd = msg.cwd.trim();
        }
        if (msg.metadata && typeof msg.metadata === 'object' && !Array.isArray(msg.metadata)) {
          chatSendParams.metadata = msg.metadata;
        }
        gatewayWs.send(JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'chat.send',
          params: chatSendParams,
        }));
        return;
      }

      if (type === 'chat.abort') {
        pendingAssistantResponse = false;
        streamText = '';
        const gatewaySessionKey = toGatewaySessionKey(msg.sessionKey as string | null | undefined, await resolveAgentRowForSessionKey(msg.sessionKey as string | null | undefined));
        const reqId = randomUUID();
        pending.set(reqId, 'chat.abort');
        gatewayWs.send(JSON.stringify({
          type: 'req',
          id: reqId,
          method: 'chat.abort',
          params: {
            sessionKey: gatewaySessionKey ?? msg.sessionKey,
          },
        }));
        return;
      }

      // Unknown message type from UI — ignore
      console.warn('[chat-proxy] Unknown client message type:', type);
    }

    clientWs.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      const type = msg.type as string;

      // Intercept connect from UI — proxy handles auth internally
      if (type === 'connect') {
        return;
      }

      if (!gatewayReady) {
        // Gateway auth still in progress — queue and replay after connect ack
        clientMsgQueue.push(msg);
        return;
      }

      await processClientMessage(msg);
    });

    // ── Error / Close handling ─────────────────────────────────────────────

    clientWs.on('close', async () => {
      // Don't leave a chat run 'running' if the client disconnects mid-turn.
      await stopJsonlIngestPolling(true);
      if (currentChatInstanceId != null) {
        await completeChatRunInstance(currentChatInstanceId, pendingAssistantResponse ? 'failed' : 'done');
        currentChatInstanceId = null;
      }
      if (gatewayWs.readyState === WsClient.OPEN) gatewayWs.close();
    });

    clientWs.on('error', async (err) => {
      console.error('[chat-proxy] Client WS error:', err.message);
      await stopJsonlIngestPolling(true);
      if (gatewayWs.readyState === WsClient.OPEN) gatewayWs.close();
    });
  });
}
