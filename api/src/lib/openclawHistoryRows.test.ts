import { getDb } from '../db/client';
import { type Db } from '../db/adapter/types';
import { setupTestDb, teardownTestDb } from '../db/testDb';
import { openClawHistoryRowId, trimOpenClawHistoryRows } from './openclawHistoryRows';

// The real chat_messages carries a NOT NULL agent_id -> agents and an instance_id -> job_instances,
// which the hand-written stand-in this file used to build did not. Transcript rows therefore need a
// real agent and a real run behind them; both are created fresh per test.
let agentId = 0;
let instanceId = 0;

beforeEach(async () => {
  await setupTestDb();
  const db = getDb();
  const agent = await db.run(
    `INSERT INTO agents (name, session_key) VALUES ('OpenClaw History Agent', 'oc-hist-agent')`,
  );
  agentId = Number(agent.lastInsertId);
  const instance = await db.run(
    `INSERT INTO job_instances (agent_id, status) VALUES (?, 'running')`,
    agentId,
  );
  instanceId = Number(instance.lastInsertId);
});

afterEach(async () => { await teardownTestDb(); });

async function seed(ids: string[]): Promise<void> {
  const db = getDb();
  for (const id of ids) {
    await db.run(
      `INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
       VALUES (?, ?, ?, 'assistant', ?, '2026-01-01 00:00:00')`,
      id,
      agentId,
      instanceId,
      id,
    );
  }
}

async function idsIn(): Promise<string[]> {
  const rows = (await getDb().all('SELECT id FROM chat_messages ORDER BY id')) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

describe('openClawHistoryRowId', () => {
  it('builds the conventional id', () => {
    expect(openClawHistoryRowId(42, 3)).toBe('oc-hist-42-3');
    expect(openClawHistoryRowId('abc123', 0)).toBe('oc-hist-abc123-0');
  });
});

describe('trimOpenClawHistoryRows', () => {
  it('removes the tail left by a longer previous refresh', async () => {
    // A previous fetch wrote five rows; this refresh only produced two.
    await seed(['oc-hist-42-0', 'oc-hist-42-1', 'oc-hist-42-2', 'oc-hist-42-3', 'oc-hist-42-4']);

    const removed = await trimOpenClawHistoryRows(getDb(), 42, 2);

    expect(removed).toBe(3);
    expect(await idsIn()).toEqual(['oc-hist-42-0', 'oc-hist-42-1']);
  });

  it('keeps everything when the refresh was the same length', async () => {
    await seed(['oc-hist-42-0', 'oc-hist-42-1']);
    expect(await trimOpenClawHistoryRows(getDb(), 42, 2)).toBe(0);
    expect(await idsIn()).toHaveLength(2);
  });

  it('does not touch a different scope with a numerically similar prefix', async () => {
    // `oc-hist-42-%` must not match `oc-hist-421-…`; the char after 42 must be '-'.
    await seed(['oc-hist-42-0', 'oc-hist-42-1', 'oc-hist-421-0', 'oc-hist-421-1']);

    await trimOpenClawHistoryRows(getDb(), 42, 1);

    expect(await idsIn()).toEqual(['oc-hist-42-0', 'oc-hist-421-0', 'oc-hist-421-1']);
  });

  it('leaves live and stream rows alone', async () => {
    await seed(['oc-hist-42-0', 'oc-hist-42-1', 'oc-live-42-0', 'oc-stream-42']);

    await trimOpenClawHistoryRows(getDb(), 42, 0);

    // A history refresh owns only the history range; wiping live rows would
    // delete messages streamed by a run that is still going.
    expect(await idsIn()).toEqual(['oc-live-42-0', 'oc-stream-42']);
  });

  it('works for a non-numeric scope', async () => {
    await seed(['oc-hist-drun_abc-0', 'oc-hist-drun_abc-1', 'oc-hist-drun_abc-2']);
    expect(await trimOpenClawHistoryRows(getDb(), 'drun_abc', 1)).toBe(2);
    expect(await idsIn()).toEqual(['oc-hist-drun_abc-0']);
  });

  it('is a no-op when there is nothing to trim', async () => {
    expect(await trimOpenClawHistoryRows(getDb(), 99, 0)).toBe(0);
  });

  it('never throws when the query fails', async () => {
    const broken = {
      all: async () => {
        throw new Error('no such table');
      },
      run: async () => ({ changes: 0, lastInsertId: null }),
    } as unknown as Db;

    // A failed cleanup must not fail the transcript write that just succeeded.
    await expect(trimOpenClawHistoryRows(broken, 1, 0)).resolves.toBe(0);
  });
});
