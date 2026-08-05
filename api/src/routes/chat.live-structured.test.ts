import { setupTestDb, teardownTestDb } from '../db/testDb';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeEach, afterEach, jest } from '@jest/globals';

type SentRequest = {
  method: string;
  params: Record<string, unknown>;
};

const sentGatewayRequests: SentRequest[] = [];
const gatewaySockets: MockGatewaySocket[] = [];
const proxyClients: MockClientSocket[] = [];
let historyMessages: Array<Record<string, unknown>> = [];
let db: Db;
let openclawHome: string;
let previousOpenClawHome: string | undefined;

const TENANT_ID = 37;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

jest.mock('../lib/gatewaySettings', () => ({
  getConfiguredGatewayAuthToken: () => 'test-token',
  getConfiguredGatewayWsUrl: () => 'ws://gateway.test',
}));

jest.mock('../lib/openclawGatewayProtocol', () => ({
  resolveOpenClawGatewayProtocolVersion: () => 1,
}));

class MockGatewaySocket {
  static OPEN = 1;
  static CLOSED = 3;

  readyState = MockGatewaySocket.OPEN;
  private handlers = new Map<string, Array<(value?: unknown) => unknown>>();

  constructor() {
    gatewaySockets.push(this);
    setImmediate(() => {
      this.emit('message', Buffer.from(JSON.stringify({
        type: 'event',
        event: 'connect.challenge',
        payload: { nonce: 'nonce' },
      })));
    });
  }

  on(event: string, handler: (value?: unknown) => unknown): this {
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
    sentGatewayRequests.push({ method: frame.method, params: frame.params });

    const payload =
      frame.method === 'chat.history'
        ? { messages: historyMessages }
        : {};
    setImmediate(() => {
      this.emit('message', Buffer.from(JSON.stringify({
        type: 'res',
        id: frame.id,
        ok: true,
        payload,
      })));
    });
  }

  async close(): Promise<void> {
    this.readyState = MockGatewaySocket.CLOSED;
    await this.emit('close');
  }

  async emit(event: string, value?: unknown): Promise<void> {
    const handlers = this.handlers.get(event) ?? [];
    await Promise.all(handlers.map(handler => handler(value)));
  }
}

jest.mock('ws', () => ({
  WebSocket: MockGatewaySocket,
  WebSocketServer: class MockWebSocketServer {},
}));

import { setupChatProxy } from './chat';
import { type Db } from "../db/adapter/types";

class MockClientSocket {
  readyState = MockGatewaySocket.OPEN;
  sent: Array<Record<string, unknown>> = [];
  private handlers = new Map<string, Array<(value?: unknown) => unknown>>();

  on(event: string, handler: (value?: unknown) => unknown): this {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>);
  }

  async close(): Promise<void> {
    this.readyState = MockGatewaySocket.CLOSED;
    await this.emit('close');
  }

  async emit(event: string, value?: unknown): Promise<void> {
    const handlers = this.handlers.get(event) ?? [];
    await Promise.all(handlers.map(handler => handler(value)));
  }
}

async function setupDb(): Promise<void> {
  db = await setupTestDb();

  await db.run(`
    INSERT INTO tenants (id, name, slug, is_default)
    VALUES (?, 'Chat Test Tenant', 'chat-test', 1)
  `, TENANT_ID);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', ?), ('active_tenant_id', ?)
  `, TENANT_ID, TENANT_ID);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, runtime_type, session_key, openclaw_agent_id)
    VALUES (2, ?, 'Atlas', 'openclaw', 'agent:atlas:main', 'atlas')
  `, TENANT_ID);
}

function waitForAsyncFrames(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(() => {
      setImmediate(() => {
        setImmediate(resolve);
      });
    });
  });
}

function waitForPoll(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 850));
}

function writeDirectSessionJsonl(sessionKey: string, lines: Array<Record<string, unknown>>): string {
  const sessionsDir = path.join(openclawHome, 'agents', 'atlas', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, 'direct-session.jsonl');
  fs.writeFileSync(
    path.join(sessionsDir, 'sessions.json'),
    JSON.stringify({
      [sessionKey]: {
        sessionId: 'direct-session',
        sessionFile,
        updatedAt: Date.parse('2026-06-03T20:45:00.000Z'),
      },
    }),
  );
  fs.writeFileSync(sessionFile, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return sessionFile;
}

function connectProxyClient(): MockClientSocket {
  let connectionHandler: ((client: MockClientSocket, req: unknown) => void) | null = null;
  const server = {
    on: jest.fn((event: string, handler: (client: MockClientSocket, req: unknown) => void) => {
      if (event === 'connection') connectionHandler = handler;
      return server;
    }),
  };
  setupChatProxy(server as never);
  const client = new MockClientSocket();
  proxyClients.push(client);
  if (!connectionHandler) throw new Error('setupChatProxy did not register a connection handler');
  const handler = connectionHandler as (client: MockClientSocket, req: unknown) => void;
  handler(client, {});
  return client;
}

describe('chat websocket live structured persistence', () => {
  beforeEach(async () => {
    sentGatewayRequests.length = 0;
    gatewaySockets.length = 0;
    proxyClients.length = 0;
    historyMessages = [];
    previousOpenClawHome = process.env.OPENCLAW_HOME;
    openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-chat-jsonl-'));
    process.env.OPENCLAW_HOME = openclawHome;
    await setupDb();
  });

  afterEach(async () => {
    for (const client of proxyClients) {
      if (client.readyState === MockGatewaySocket.OPEN) await client.close();
    }
    await teardownTestDb();
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    fs.rmSync(openclawHome, { recursive: true, force: true });
  });

  it('ingests direct Atlas structured rows from JSONL before final without a history refresh', async () => {
    const sessionKey = 'agent:atlas:web:direct:8fa72628-c1d7-401c-a106-9190b2b623d6';
    const client = connectProxyClient();

    await waitForAsyncFrames();

    await client.emit('message', Buffer.from(JSON.stringify({
      type: 'chat.send',
      sessionKey,
      message: 'Inspect the current session state.',
    })));

    await waitForAsyncFrames();
    expect(sentGatewayRequests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: 'chat.send',
        params: expect.objectContaining({ sessionKey }),
      }),
    ]));

    const chatRun = await db.get(`
      SELECT id, durable_run_id
      FROM job_instances
      WHERE session_key = ?
      ORDER BY id DESC
      LIMIT 1
    `, sessionKey) as { id: number; durable_run_id: string };
    expect(chatRun?.id).toBeGreaterThan(0);

    writeDirectSessionJsonl(sessionKey, [
      {
        type: 'message',
        id: 'assistant-call',
        timestamp: '2026-06-03T20:45:00.000Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I should inspect the current session state.' },
            { type: 'toolCall', id: 'tool-1', name: 'exec_command', arguments: { cmd: 'pwd' } },
          ],
        },
      },
    ]);

    await waitForPoll();

    const midTurnRows = await db.all(`
      SELECT id, role, event_type, content, session_key
      FROM chat_messages
      WHERE session_key = ? AND event_type <> 'text'
      ORDER BY event_type ASC
    `, sessionKey);

    expect(midTurnRows).toEqual([
      expect.objectContaining({
        role: 'assistant',
        event_type: 'thought',
        content: 'I should inspect the current session state.',
        session_key: sessionKey,
      }),
      expect.objectContaining({
        role: 'assistant',
        event_type: 'tool_call',
        content: 'exec_command',
        session_key: sessionKey,
      }),
    ]);
    expect((midTurnRows[0] as { id: string }).id).toMatch(new RegExp(`^oc-jsonl-${chatRun.durable_run_id}-`));
    expect((midTurnRows[1] as { id: string }).id).toMatch(new RegExp(`^oc-jsonl-${chatRun.durable_run_id}-`));

    fs.appendFileSync(path.join(openclawHome, 'agents', 'atlas', 'sessions', 'direct-session.jsonl'), `${JSON.stringify(
      {
        type: 'message',
        id: 'assistant-text',
        timestamp: '2026-06-03T20:45:02.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
      },
    )}\n`);

    await gatewaySockets[0]?.emit('message', Buffer.from(JSON.stringify({
      type: 'event',
      event: 'chat',
      payload: {
        sessionKey,
        state: 'final',
        message: {
        role: 'assistant',
        timestamp: '2026-06-03T20:45:00.000Z',
        content: [{ type: 'text', text: 'Done.' }],
        },
      },
    })));
    await waitForAsyncFrames();

    const finalRows = await db.all(`
      SELECT id, role, event_type, content
      FROM chat_messages
      WHERE session_key = ?
      ORDER BY timestamp ASC, id ASC
    `, sessionKey);

    expect(sentGatewayRequests.filter(req => req.method === 'chat.history')).toEqual([]);
    const finalSummaries = finalRows.map(row => ({
      id: (row as { id: string }).id,
      role: (row as { role: string }).role,
      event_type: (row as { event_type: string }).event_type,
      content: (row as { content: string }).content,
    }));
    expect(finalSummaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', event_type: 'text', content: 'Inspect the current session state.' }),
      expect.objectContaining({ role: 'assistant', event_type: 'thought', content: 'I should inspect the current session state.' }),
      expect.objectContaining({ role: 'assistant', event_type: 'tool_call', content: 'exec_command' }),
      expect.objectContaining({ role: 'assistant', event_type: 'text', content: 'Done.' }),
    ]));
    expect(finalRows.filter(row => (row as { event_type: string; role: string }).event_type === 'text' && (row as { role: string }).role === 'assistant')).toHaveLength(1);
  });

  it('rotates a direct chat session even when the key has an existing chat-stage instance', async () => {
    const sessionKey = 'agent:atlas:web:direct:8fa72628-c1d7-401c-a106-9190b2b623d6';
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, task_id, session_key, status, run_stage, durable_run_id)
      VALUES (99974585, ?, 2, NULL, ?, 'done', 'chat', 'chat-existing')
    `, TENANT_ID, sessionKey);
    const client = connectProxyClient();

    await waitForAsyncFrames();

    await client.emit('message', Buffer.from(JSON.stringify({
      type: 'chat.new',
      sessionKey,
      channel: 'web',
    })));

    await waitForAsyncFrames();

    const errorMessages = client.sent.filter((msg) => msg.type === 'error');
    expect(errorMessages).toEqual([]);
    const rotation = client.sent.find((msg) => msg.type === 'chat.new') as { sessionKey?: string } | undefined;
    expect(rotation?.sessionKey).toMatch(/^agent:atlas:web:direct:/);
    expect(rotation?.sessionKey).not.toBe(sessionKey);
  });

  it('creates a fresh chat-stage job_instance for each direct chat send on one websocket', async () => {
    const sessionKey = 'agent:atlas:web:direct:8fa72628-c1d7-401c-a106-9190b2b623d6';
    const client = connectProxyClient();

    await waitForAsyncFrames();

    await client.emit('message', Buffer.from(JSON.stringify({
      type: 'chat.send',
      sessionKey,
      message: 'first turn',
    })));
    await waitForAsyncFrames();

    await client.emit('message', Buffer.from(JSON.stringify({
      type: 'chat.send',
      sessionKey,
      message: 'second turn',
    })));
    await waitForAsyncFrames();

    const chatRuns = await db.all(`
      SELECT agent_id, task_id, session_key, status, run_stage
      FROM job_instances
      WHERE session_key = ?
      ORDER BY id ASC
    `, sessionKey);

    expect(chatRuns).toHaveLength(2);
    expect(chatRuns).toEqual([
      expect.objectContaining({ agent_id: 2, task_id: null, session_key: sessionKey, status: 'done', run_stage: 'chat' }),
      expect.objectContaining({ agent_id: 2, task_id: null, session_key: sessionKey, status: 'running', run_stage: 'chat' }),
    ]);
  });
});
