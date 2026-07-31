import Database from 'better-sqlite3';
import { SqliteAdapter } from '../db/adapter/SqliteAdapter';
import { type Db } from '../db/adapter/types';
import { openClawHistoryRowId, trimOpenClawHistoryRows } from './openclawHistoryRows';

async function setupDb(): Promise<Db> {
  const db = new SqliteAdapter(new Database(':memory:'));
  await db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      instance_id INTEGER,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'text',
      event_meta TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

async function seed(db: Db, ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.run(
      `INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
       VALUES (?, 1, 42, 'assistant', ?, '2026-01-01 00:00:00')`,
      id,
      id,
    );
  }
}

async function idsIn(db: Db): Promise<string[]> {
  const rows = (await db.all('SELECT id FROM chat_messages ORDER BY id')) as Array<{ id: string }>;
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
    const db = await setupDb();
    // A previous fetch wrote five rows; this refresh only produced two.
    await seed(db, ['oc-hist-42-0', 'oc-hist-42-1', 'oc-hist-42-2', 'oc-hist-42-3', 'oc-hist-42-4']);

    const removed = await trimOpenClawHistoryRows(db, 42, 2);

    expect(removed).toBe(3);
    expect(await idsIn(db)).toEqual(['oc-hist-42-0', 'oc-hist-42-1']);
  });

  it('keeps everything when the refresh was the same length', async () => {
    const db = await setupDb();
    await seed(db, ['oc-hist-42-0', 'oc-hist-42-1']);
    expect(await trimOpenClawHistoryRows(db, 42, 2)).toBe(0);
    expect(await idsIn(db)).toHaveLength(2);
  });

  it('does not touch a different scope with a numerically similar prefix', async () => {
    const db = await setupDb();
    // `oc-hist-42-%` must not match `oc-hist-421-…`; the char after 42 must be '-'.
    await seed(db, ['oc-hist-42-0', 'oc-hist-42-1', 'oc-hist-421-0', 'oc-hist-421-1']);

    await trimOpenClawHistoryRows(db, 42, 1);

    expect(await idsIn(db)).toEqual(['oc-hist-42-0', 'oc-hist-421-0', 'oc-hist-421-1']);
  });

  it('leaves live and stream rows alone', async () => {
    const db = await setupDb();
    await seed(db, ['oc-hist-42-0', 'oc-hist-42-1', 'oc-live-42-0', 'oc-stream-42']);

    await trimOpenClawHistoryRows(db, 42, 0);

    // A history refresh owns only the history range; wiping live rows would
    // delete messages streamed by a run that is still going.
    expect(await idsIn(db)).toEqual(['oc-live-42-0', 'oc-stream-42']);
  });

  it('works for a non-numeric scope', async () => {
    const db = await setupDb();
    await seed(db, ['oc-hist-drun_abc-0', 'oc-hist-drun_abc-1', 'oc-hist-drun_abc-2']);
    expect(await trimOpenClawHistoryRows(db, 'drun_abc', 1)).toBe(2);
    expect(await idsIn(db)).toEqual(['oc-hist-drun_abc-0']);
  });

  it('is a no-op when there is nothing to trim', async () => {
    const db = await setupDb();
    expect(await trimOpenClawHistoryRows(db, 99, 0)).toBe(0);
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
