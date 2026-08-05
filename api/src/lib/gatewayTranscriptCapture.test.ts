type SentRequest = {
  method: string;
  params: Record<string, unknown>;
};

const sentRequests: SentRequest[] = [];
const mockSockets: Array<{
  emit(event: string, value?: unknown): void;
}> = [];
let mockHistoryMessages: Array<Record<string, unknown>> = [];
let mockHistoryResponses: Array<Record<string, unknown>> = [];

// Only the gateway URL is faked. The rest of ../config is spread through because the shared
// fixture pulls in db/schema.ts, which imports NODE_BIN_DIR from here — a factory returning
// this one key alone leaves every other consumer with undefined.
jest.mock('../config', () => ({
  ...jest.requireActual('../config'),
  OPENCLAW_GATEWAY_WS_URL: 'ws://gateway.test',
}));

jest.mock('./openclawGatewayProtocol', () => ({
  resolveOpenClawGatewayProtocolVersion: () => 1,
}));

jest.mock('ws', () => {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;

    readyState = MockWebSocket.OPEN;
    private handlers = new Map<string, Array<(value?: unknown) => void>>();

    constructor() {
      mockSockets.push(this);
      setImmediate(() => {
        this.emit('message', Buffer.from(JSON.stringify({
          type: 'event',
          event: 'connect.challenge',
          payload: { nonce: 'nonce' },
        })));
      });
    }

    on(event: string, handler: (value?: unknown) => void): this {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
      return this;
    }

    send(raw: string): void {
      const frame = JSON.parse(raw) as {
        id: string;
        method: string;
        params: Record<string, unknown>;
      };
      sentRequests.push({ method: frame.method, params: frame.params });

      const response: Record<string, unknown> = {
        type: 'res',
        id: frame.id,
        payload: {},
      };
      if (frame.method === 'chat.history') {
        const nextResponse = mockHistoryResponses.shift();
        if (nextResponse) {
          Object.assign(response, nextResponse);
        } else {
          response.payload = {
            messages: mockHistoryMessages,
          };
        }
      }

      setImmediate(() => {
        this.emit('message', Buffer.from(JSON.stringify(response)));
      });
    }

    close(): void {
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }

    emit(event: string, value?: unknown): void {
      const handlers = this.handlers.get(event) ?? [];
      for (const handler of handlers) {
        handler(value);
      }
    }
  }

  return { WebSocket: MockWebSocket };
});

import { getActiveCaptureCount, startTranscriptCapture, stopTranscriptCapture } from './gatewayTranscriptCapture';
import { getDb } from '../db/client';
import { setupTestDb, teardownTestDb } from '../db/testDb';

const SESSION_KEY = 'agent:cinder-backend:run:4698:durable-4698';

async function seedRunFixtures(): Promise<void> {
  const db = getDb();
  // The real baseline declares chat_messages.agent_id -> agents.id and
  // job_instances.agent_id -> agents.id as genuine foreign keys. The minimal schema this test
  // used to hand-build had neither, so agent 94 never had to exist for the capture's writes to
  // land. It does now.
  await db.run(`INSERT INTO agents (id, name, session_key) VALUES (94, 'Cinder Backend', 'agent:cinder-backend')`);
  await db.run(`INSERT INTO job_instances (id, agent_id, durable_run_id) VALUES (4698, 94, 'durable-4698')`);
}

/**
 * Drains the event loop until the capture's in-flight persistence has settled.
 *
 * This used to be four chained setImmediate frames, which was enough only because every write
 * was a synchronous better-sqlite3 call that resolved on the microtask queue. On PostgreSQL a
 * single history persist is a dozen socket round trips — two introspection queries, a
 * checkout, BEGIN, a DELETE, one INSERT per row, COMMIT — so a fixed frame count no longer
 * bounds the work it is waiting for. Yielding repeatedly for a wall-clock budget does, and
 * setImmediate resolves after the poll phase, so socket replies are processed each turn.
 */
const SETTLE_MS = 150;

async function waitForAsyncFrames(): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('gatewayTranscriptCapture', () => {
  beforeEach(async () => {
    sentRequests.length = 0;
    mockSockets.length = 0;
    mockHistoryResponses = [];
    mockHistoryMessages = [
      {
        role: 'assistant',
        timestamp: '2026-06-03T03:00:00.000Z',
        content: [
          { type: 'text', text: 'Working through the task' },
          { type: 'tool_use', id: 'tool-1', name: 'exec_command', input: { cmd: 'pwd' } },
        ],
      },
      {
        role: 'tool_result',
        timestamp: '2026-06-03T03:00:01.000Z',
        toolCallId: 'tool-1',
        toolName: 'exec_command',
        content: 'command output',
      },
    ];
    await setupTestDb();
    await seedRunFixtures();
  });

  afterEach(async () => {
    // Quiesce BEFORE teardown. A capture that saw a terminal event kicks off one last
    // chat.history persist that nothing in the test awaits; teardown ends the connection pool,
    // and that write would then fail into the module's catch-and-warn and disappear.
    await waitForAsyncFrames();
    await stopTranscriptCapture(SESSION_KEY);
    await teardownTestDb();
  });

  it('subscribes with the routed agent run key and persists assistant/tool history rows', async () => {
    await startTranscriptCapture(4698, 94, SESSION_KEY);

    await waitForAsyncFrames();

    expect(sentRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'chat.history',
        params: expect.objectContaining({
          sessionKey: SESSION_KEY,
          limit: 200,
        }),
      }),
    ]));

    const rows = await getDb().all(`
      SELECT role, event_type, content, session_key, durable_run_id
      FROM chat_messages
      WHERE instance_id = 4698
      ORDER BY timestamp ASC, id ASC
    `);
    expect(rows).toEqual([
      {
        role: 'assistant',
        event_type: 'text',
        content: 'Working through the task',
        session_key: SESSION_KEY,
        durable_run_id: 'durable-4698',
      },
      {
        role: 'assistant',
        event_type: 'tool_call',
        content: 'exec_command',
        session_key: SESSION_KEY,
        durable_run_id: 'durable-4698',
      },
      {
        role: 'tool',
        event_type: 'tool_result',
        content: 'command output',
        session_key: SESSION_KEY,
        durable_run_id: 'durable-4698',
      },
    ]);
  });

  it('persists short live deltas and live tool events before the run finishes', async () => {
    mockHistoryMessages = [];
    await startTranscriptCapture(4698, 94, SESSION_KEY);

    await waitForAsyncFrames();

    mockSockets[0]?.emit('message', Buffer.from(JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: SESSION_KEY,
        state: 'delta',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Short update' }],
        },
      },
    })));
    mockSockets[0]?.emit('message', Buffer.from(JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: SESSION_KEY,
        state: 'tool_call',
        message: {
          role: 'assistant',
          timestamp: '2026-06-03T03:00:02.000Z',
          content: [
            { type: 'tool_use', id: 'tool-2', name: 'exec_command', input: { cmd: 'date' } },
          ],
        },
      },
    })));

    // The gateway 'message' handler is async: emitting only starts the persistence
    // work. Let the in-flight writes settle before asserting on the rows.
    await waitForAsyncFrames();

    const rows = await getDb().all(`
      SELECT id, role, event_type, content, session_key, durable_run_id
      FROM chat_messages
      WHERE instance_id = 4698
      ORDER BY id ASC
    `);

    expect(rows).toEqual([
      {
        id: 'oc-live-4698-0',
        role: 'assistant',
        event_type: 'tool_call',
        content: 'exec_command',
        session_key: SESSION_KEY,
        durable_run_id: 'durable-4698',
      },
      {
        id: 'oc-stream-4698',
        role: 'assistant',
        event_type: 'text',
        content: 'Short update',
        session_key: SESSION_KEY,
        durable_run_id: 'durable-4698',
      },
    ]);
  });

  it('force-refreshes an existing capture after chat.send indexes the session', async () => {
    mockHistoryMessages = [];
    await startTranscriptCapture(4698, 94, SESSION_KEY, {
            historyRetryCount: 0,
          });

    await waitForAsyncFrames();

    expect(sentRequests.filter((req) => req.method === 'chat.history')).toHaveLength(1);
    expect(await getDb().get('SELECT COUNT(*) AS count FROM chat_messages WHERE instance_id = 4698')).toEqual({ count: 0 });

    mockHistoryMessages = [
      {
        role: 'assistant',
        timestamp: '2026-06-03T03:00:02.000Z',
        content: [
          { type: 'tool_use', id: 'tool-3', name: 'exec_command', input: { cmd: 'date' } },
        ],
      },
    ];
    await startTranscriptCapture(4698, 94, SESSION_KEY, {
            forceHistoryRefresh: true,
            historyRetryCount: 0,
          });

    await waitForAsyncFrames();

    expect(sentRequests.filter((req) => req.method === 'chat.history')).toHaveLength(2);
    const rows = await getDb().all(`
      SELECT id, role, event_type, content
      FROM chat_messages
      WHERE instance_id = 4698
      ORDER BY id ASC
    `);
    expect(rows).toEqual([
      {
        id: 'oc-hist-4698-0',
        role: 'assistant',
        event_type: 'tool_call',
        content: 'exec_command',
      },
    ]);
  });

  it('routes terminal events over the existing transcript socket after run id refresh', async () => {
    mockHistoryMessages = [];
    const onTurnEnd = jest.fn();

    await startTranscriptCapture(4698, 94, SESSION_KEY, {
            onTurnEnd,
            historyRetryCount: 0,
          });
    await waitForAsyncFrames();

    await startTranscriptCapture(4698, 94, SESSION_KEY, {
            forceHistoryRefresh: true,
            runId: 'run-4698',
            onTurnEnd,
            historyRetryCount: 0,
          });
    await waitForAsyncFrames();

    expect(mockSockets).toHaveLength(1);

    mockSockets[0]?.emit('message', Buffer.from(JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:other:run:4698:durable-4698',
        state: 'final',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'wrong session' }],
        },
      },
    })));
    expect(onTurnEnd).not.toHaveBeenCalled();

    mockSockets[0]?.emit('message', Buffer.from(JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: SESSION_KEY,
        state: 'final',
        message: {
          role: 'assistant',
          timestamp: '2026-06-03T03:00:04.000Z',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    })));

    expect(onTurnEnd).toHaveBeenCalledTimes(1);
    expect(onTurnEnd.mock.calls[0][0]).toEqual(expect.objectContaining({
      source: 'openclaw',
      success: true,
      reason: 'completed',
      sessionKey: SESSION_KEY,
      runId: 'run-4698',
    }));
  });

  it('cleans up the shared capture on gateway disconnect', async () => {
    mockHistoryMessages = [];
    await startTranscriptCapture(4698, 94, SESSION_KEY);

    await waitForAsyncFrames();
    expect(getActiveCaptureCount()).toBe(1);

    mockSockets[0]?.emit('close');

    expect(getActiveCaptureCount()).toBe(0);
  });

  it('closes the shared capture when abort cleanup stops the transcript capture', async () => {
    mockHistoryMessages = [];
    await startTranscriptCapture(4698, 94, SESSION_KEY);

    await waitForAsyncFrames();
    expect(getActiveCaptureCount()).toBe(1);

    await stopTranscriptCapture(SESSION_KEY);

    expect(getActiveCaptureCount()).toBe(0);
    expect(mockSockets[0]).toEqual(expect.objectContaining({ readyState: 3 }));
  });

  it('retries initial not-indexed chat.history responses and persists later history', async () => {
    mockHistoryResponses = [
      { ok: false, error: 'session not indexed' },
      {
        payload: {
          messages: [
            {
              role: 'assistant',
              timestamp: '2026-06-03T03:00:03.000Z',
              content: [
                { type: 'tool_use', id: 'tool-4', name: 'exec_command', input: { cmd: 'pwd' } },
              ],
            },
          ],
        },
      },
    ];

    await startTranscriptCapture(4698, 94, SESSION_KEY, {
            historyRetryCount: 1,
            historyRetryDelayMs: 1,
          });

    await waitForAsyncFrames();
    await delay(10);
    await waitForAsyncFrames();

    expect(sentRequests.filter((req) => req.method === 'chat.history')).toHaveLength(2);
    const rows = await getDb().all(`
      SELECT id, role, event_type, content
      FROM chat_messages
      WHERE instance_id = 4698
      ORDER BY id ASC
    `);
    expect(rows).toEqual([
      {
        id: 'oc-hist-4698-0',
        role: 'assistant',
        event_type: 'tool_call',
        content: 'exec_command',
      },
    ]);
  });
});
