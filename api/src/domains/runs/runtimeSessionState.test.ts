import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { evaluateRuntimeInstanceLiveness, RUNTIME_TERMINAL_QUIESCENCE_MS } from './runtimeSessionState';
import { type Db } from '../../db/adapter/types';

const NOW = new Date('2026-08-08T12:00:00.000Z');

function agoTimestamp(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

let db: Db;

async function seedInstance(): Promise<void> {
  await db.run(`
    INSERT INTO agents (id, name, job_title, runtime_type, session_key)
    VALUES (77, 'Atlas', 'Chief of Staff', 'claude-code', 'agent:atlas:main')
  `);
  await db.run(`
    INSERT INTO job_instances (id, agent_id, status, created_at, session_key)
    VALUES (500, 77, 'running', ?, 'run:500')
  `, agoTimestamp(30 * 60_000));
}

async function writeEvent(params: {
  id: string;
  eventType: string;
  role?: string;
  agoMs: number;
}): Promise<void> {
  await db.run(`
    INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
    VALUES (?, 77, 500, 'run:500', ?, 'x', ?, ?, '{}')
  `, params.id, params.role ?? 'assistant', agoTimestamp(params.agoMs), params.eventType);
}

beforeEach(async () => {
  db = await setupTestDb();
  await seedInstance();
});

afterEach(async () => {
  await teardownTestDb();
});

describe('evaluateRuntimeInstanceLiveness', () => {
  it('treats a recent tool call as work in progress', async () => {
    await writeEvent({ id: 'e1', eventType: 'tool_call', agoMs: 30_000 });

    const liveness = await evaluateRuntimeInstanceLiveness(db, 500, { now: NOW });

    expect(liveness.active).toBe(true);
    expect(liveness.lastToolUseAtMs).not.toBeNull();
    expect(liveness.quietForMs).toBeLessThan(RUNTIME_TERMINAL_QUIESCENCE_MS);
  });

  it('stops treating the run as active once it goes quiet past the quiescence window', async () => {
    await writeEvent({ id: 'e1', eventType: 'tool_call', agoMs: RUNTIME_TERMINAL_QUIESCENCE_MS + 60_000 });

    const liveness = await evaluateRuntimeInstanceLiveness(db, 500, { now: NOW });

    expect(liveness.active).toBe(false);
    expect(liveness.quietForMs).toBeGreaterThan(RUNTIME_TERMINAL_QUIESCENCE_MS);
  });

  it('does not count the user message that started the turn as agent activity', async () => {
    await writeEvent({ id: 'e1', eventType: 'text', role: 'user', agoMs: 5_000 });

    const liveness = await evaluateRuntimeInstanceLiveness(db, 500, { now: NOW });

    expect(liveness.active).toBe(false);
    expect(liveness.lastActivityAtMs).toBeNull();
    expect(liveness.lastEventAtMs).not.toBeNull();
  });

  it('is never active after the runtime wrote a terminal event, however recent', async () => {
    await writeEvent({ id: 'e1', eventType: 'tool_call', agoMs: 20_000 });
    await writeEvent({ id: 'e2', eventType: 'turn_end', agoMs: 10_000 });

    const liveness = await evaluateRuntimeInstanceLiveness(db, 500, { now: NOW });

    expect(liveness.sawTerminalEvent).toBe(true);
    expect(liveness.active).toBe(false);
  });

  it('reports no activity for a run that never wrote a transcript', async () => {
    const liveness = await evaluateRuntimeInstanceLiveness(db, 500, { now: NOW });

    expect(liveness.active).toBe(false);
    expect(liveness.lastEventAtMs).toBeNull();
    expect(liveness.quietForMs).toBeNull();
  });
});
