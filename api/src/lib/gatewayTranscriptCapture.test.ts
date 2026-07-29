import Database from 'better-sqlite3';

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
let db: Db;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

jest.mock('../config', () => ({
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
import { type Db } from "../db/adapter/types";
import { SqliteAdapter } from "../db/adapter/SqliteAdapter";

async function setupDb(): Promise<void> {
  db = new SqliteAdapter(new Database(':memory:'));
  await db.exec(`
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY,
      durable_run_id TEXT
    );

    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      instance_id INTEGER,
      durable_run_id TEXT,
      session_key TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'text',
      event_meta TEXT NOT NULL DEFAULT '{}'
    );
  `);
}

function waitForAsyncFrames(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      setImmediate(() => {
        setImmediate(() => {
          setImmediate(resolve);
        });
      });
    });
  });
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
    await setupDb();
    await db.run(`INSERT INTO job_instances (id, durable_run_id) VALUES (4698, 'durable-4698')`);
  });

  afterEach(async () => {
    stopTranscriptCapture('agent:cinder-backend:run:4698:durable-4698');
    await db.close();
  });

  it('subscribes with the routed agent run key and persists assistant/tool history rows', async () => {
    await startTranscriptCapture(4698, 94, 'agent:cinder-backend:run:4698:durable-4698');

    await waitForAsyncFrames();

    expect(sentRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'chat.history',
        params: expect.objectContaining({
          sessionKey: 'agent:cinder-backend:run:4698:durable-4698',
          limit: 200,
        }),
      }),
    ]));

    const rows = await db.all(`
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
        session_key: 'agent:cinder-backend:run:4698:durable-4698',
        durable_run_id: 'durable-4698',
      },
      {
        role: 'assistant',
        event_type: 'tool_call',
        content: 'exec_command',
        session_key: 'agent:cinder-backend:run:4698:durable-4698',
        durable_run_id: 'durable-4698',
      },
      {
        role: 'tool',
        event_type: 'tool_result',
        content: 'command output',
        session_key: 'agent:cinder-backend:run:4698:durable-4698',
        durable_run_id: 'durable-4698',
      },
    ]);
  });

  it('persists short live deltas and live tool events before the run finishes', async () => {
    mockHistoryMessages = [];
    await startTranscriptCapture(4698, 94, 'agent:cinder-backend:run:4698:durable-4698');

    await waitForAsyncFrames();

    mockSockets[0]?.emit('message', Buffer.from(JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey: 'agent:cinder-backend:run:4698:durable-4698',
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
        sessionKey: 'agent:cinder-backend:run:4698:durable-4698',
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

    const rows = await db.all(`
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
        session_key: 'agent:cinder-backend:run:4698:durable-4698',
        durable_run_id: 'durable-4698',
      },
      {
        id: 'oc-stream-4698',
        role: 'assistant',
        event_type: 'text',
        content: 'Short update',
        session_key: 'agent:cinder-backend:run:4698:durable-4698',
        durable_run_id: 'durable-4698',
      },
    ]);
  });

  it('force-refreshes an existing capture after chat.send indexes the session', async () => {
    mockHistoryMessages = [];
    await startTranscriptCapture(4698, 94, 'agent:cinder-backend:run:4698:durable-4698', {
            historyRetryCount: 0,
          });

    await waitForAsyncFrames();

    expect(sentRequests.filter((req) => req.method === 'chat.history')).toHaveLength(1);
    expect(await db.get('SELECT COUNT(*) AS count FROM chat_messages WHERE instance_id = 4698')).toEqual({ count: 0 });

    mockHistoryMessages = [
      {
        role: 'assistant',
        timestamp: '2026-06-03T03:00:02.000Z',
        content: [
          { type: 'tool_use', id: 'tool-3', name: 'exec_command', input: { cmd: 'date' } },
        ],
      },
    ];
    await startTranscriptCapture(4698, 94, 'agent:cinder-backend:run:4698:durable-4698', {
            forceHistoryRefresh: true,
            historyRetryCount: 0,
          });

    await waitForAsyncFrames();

    expect(sentRequests.filter((req) => req.method === 'chat.history')).toHaveLength(2);
    const rows = await db.all(`
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

    await startTranscriptCapture(4698, 94, 'agent:cinder-backend:run:4698:durable-4698', {
            onTurnEnd,
            historyRetryCount: 0,
          });
    await waitForAsyncFrames();

    await startTranscriptCapture(4698, 94, 'agent:cinder-backend:run:4698:durable-4698', {
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
        sessionKey: 'agent:cinder-backend:run:4698:durable-4698',
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
      sessionKey: 'agent:cinder-backend:run:4698:durable-4698',
      runId: 'run-4698',
    }));
  });

  it('cleans up the shared capture on gateway disconnect', async () => {
    mockHistoryMessages = [];
    await startTranscriptCapture(4698, 94, 'agent:cinder-backend:run:4698:durable-4698');

    await waitForAsyncFrames();
    expect(getActiveCaptureCount()).toBe(1);

    mockSockets[0]?.emit('close');

    expect(getActiveCaptureCount()).toBe(0);
  });

  it('closes the shared capture when abort cleanup stops the transcript capture', async () => {
    mockHistoryMessages = [];
    await startTranscriptCapture(4698, 94, 'agent:cinder-backend:run:4698:durable-4698');

    await waitForAsyncFrames();
    expect(getActiveCaptureCount()).toBe(1);

    stopTranscriptCapture('agent:cinder-backend:run:4698:durable-4698');

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

    await startTranscriptCapture(4698, 94, 'agent:cinder-backend:run:4698:durable-4698', {
            historyRetryCount: 1,
            historyRetryDelayMs: 1,
          });

    await waitForAsyncFrames();
    await delay(10);
    await waitForAsyncFrames();

    expect(sentRequests.filter((req) => req.method === 'chat.history')).toHaveLength(2);
    const rows = await db.all(`
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
