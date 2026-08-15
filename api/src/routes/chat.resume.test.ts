import { setupTestDb, teardownTestDb } from '../db/testDb';
import express from 'express';
import { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Db;

jest.mock('../db/client', () => ({
  getDb: () => db,
}));

const dispatchInstance = jest.fn(async (_params: Record<string, unknown>) => undefined);
jest.mock('../services/dispatcher', () => ({
  dispatchInstance: (params: Record<string, unknown>) => dispatchInstance(params),
}));

import chatRouter from './chat';
import { type Db } from '../db/adapter/types';

const FIRST_SESSION = '11111111-1111-1111-1111-111111111111';

async function send(agentId: number, message: string): Promise<number> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/chat', chatRouter);
  const server = app.listen(0);
  try {
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/chat/agents/${agentId}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    return res.status;
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

/** The params of the most recent dispatch. */
function lastDispatch(): Record<string, unknown> {
  const call = dispatchInstance.mock.calls.at(-1);
  if (!call) throw new Error('dispatchInstance was not called');
  return call[0];
}

/** The resumeSessionId handed to the runtime on the most recent dispatch. */
function lastResumeSessionId(): unknown {
  return lastDispatch().resumeSessionId;
}

describe('chat send — session continuity', () => {
  /** The conversation anchor an established chat already has. */
  async function seedCanonicalSession(updatedAt: string): Promise<void> {
    await db.run(`
      INSERT INTO canonical_chat_sessions (agent_id, channel, session_key, created_at, updated_at)
      VALUES (1, 'web', 'agent:atlas:web:direct:abc', ?, ?)
    `, updatedAt, updatedAt);
  }

  beforeEach(async () => {
    db = await setupTestDb();
    dispatchInstance.mockClear();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
    await db.run(`
      INSERT INTO agents (id, tenant_id, name, session_key, runtime_type, enabled, timeout_seconds)
      VALUES (1, 1, 'Atlas', 'agent:atlas:main', 'claude-code', 1, 900)
    `);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('carries the previous turn’s session forward', async () => {
    // An ongoing conversation: the canonical row predates its turns. (A first-ever
    // send creates that row stamped now, which is why the cold-start case below
    // needs no anchor of its own.)
    await seedCanonicalSession('2026-08-14 09:00:00');
    // The previous turn, as the runtime leaves it: the instance's session key was
    // rewritten to the claude-code session that turn actually ran under.
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, status, run_stage, session_key, created_at)
      VALUES (900, 1, 1, 'done', 'chat', ?, '2026-08-14 10:00:00')
    `, `claude-code:${FIRST_SESSION}`);

    expect(await send(1, 'continue')).toBe(200);
    expect(dispatchInstance).toHaveBeenCalledTimes(1);
    expect(lastResumeSessionId()).toBe(FIRST_SESSION);
  });

  it('starts the first turn of a conversation cold', async () => {
    // Nothing to resume: the agent has never chatted, so the runtime mints a new
    // session rather than being handed one that does not exist.
    expect(await send(1, 'hello')).toBe(200);
    expect(lastResumeSessionId()).toBeNull();
  });

  it('never resumes the turn it is dispatching', async () => {
    // The turn opens its own instance before dispatch. Picking that up would ask
    // the run to continue the session it is about to create.
    await send(1, 'hello');

    expect(lastResumeSessionId()).toBeNull();
    expect(lastDispatch().instanceId).toEqual(expect.any(Number));
  });

  it('does not resume across a rotated chat session', async () => {
    // "New chat" rotates the canonical key and bumps its timestamp; turns from
    // before that point belong to a finished conversation.
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, status, run_stage, session_key, created_at)
      VALUES (900, 1, 1, 'done', 'chat', ?, '2026-08-10 10:00:00')
    `, `claude-code:${FIRST_SESSION}`);
    await db.run(`
      INSERT INTO canonical_chat_sessions (agent_id, channel, session_key, created_at, updated_at)
      VALUES (1, 'web', 'agent:atlas:web:direct:rotated', '2026-08-10 09:00:00', '2026-08-14 09:00:00')
    `);

    expect(await send(1, 'hello')).toBe(200);
    expect(lastResumeSessionId()).toBeNull();
  });

  it('does not resume a task run', async () => {
    // A dispatched task is its own conversation and must never inherit chat
    // history, even though it belongs to the same agent. Anchored inside the
    // conversation so run_stage is the only thing excluding it.
    await seedCanonicalSession('2026-08-14 09:00:00');
    await db.run(`
      INSERT INTO job_instances (id, tenant_id, agent_id, status, run_stage, session_key, created_at)
      VALUES (900, 1, 1, 'done', 'task', ?, '2026-08-14 10:00:00')
    `, `claude-code:${FIRST_SESSION}`);

    expect(await send(1, 'hello')).toBe(200);
    expect(lastResumeSessionId()).toBeNull();
  });
});
