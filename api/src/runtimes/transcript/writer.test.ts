const mockTableHasColumn = jest.fn(async (_db: unknown, _t: string, column: string) =>
  column !== 'tenant_id',
);

jest.mock('../../domains/routing/scope', () => ({
  ...(jest.requireActual('../../domains/routing/scope') as object),
  tableHasColumn: (...args: unknown[]) => mockTableHasColumn(...(args as [unknown, string, string])),
}));

import { RuntimeTranscriptWriter, resolveRole } from './writer';
import type { RuntimeTranscriptEvent } from './events';
import type { Db } from '../../db/adapter/types';

interface Recorded {
  sql: string;
  params: unknown[];
}

function createMockDb(onRun?: (sql: string) => void) {
  const runs: Recorded[] = [];
  const db = {
    runs,
    dialect: 'sqlite' as const,
    inTransaction: false,
    get: jest.fn(async () => undefined),
    all: jest.fn(async () => []),
    value: jest.fn(async () => undefined),
    run: jest.fn(async (sql: string, ...params: unknown[]) => {
      onRun?.(sql);
      runs.push({ sql, params });
      return { changes: 1, lastInsertId: null };
    }),
    exec: jest.fn(async () => undefined),
    withTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(null)),
    close: jest.fn(async () => undefined),
  };
  return db;
}

function makeWriter(db: ReturnType<typeof createMockDb>, overrides = {}) {
  return new RuntimeTranscriptWriter({
    db: db as unknown as Db,
    agentId: 42,
    instanceId: 7,
    idPrefix: 'claude-code',
    sessionKey: 'claude-code:uuid',
    durableRunId: 'drun_1',
    ...overrides,
  });
}

const TEXT: RuntimeTranscriptEvent = { kind: 'text', role: 'assistant', content: 'hello' };

beforeEach(() => {
  mockTableHasColumn.mockClear();
  mockTableHasColumn.mockImplementation(async (_db, _t, column) => column !== 'tenant_id');
});

describe('RuntimeTranscriptWriter', () => {
  it('mints deterministic, monotonically indexed ids', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);

    writer.enqueue([TEXT, { ...TEXT, content: 'second' }]);
    writer.enqueue([{ ...TEXT, content: 'third' }]);
    await writer.drain();

    expect(db.runs.map((r: Recorded) => r.params[0])).toEqual([
      'claude-code-7-0',
      'claude-code-7-1',
      'claude-code-7-2',
    ]);
  });

  it('preserves order across interleaved enqueues from a stream handler', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);

    // Simulates two stdout chunks arriving back-to-back: indices must be
    // assigned at enqueue time, not inside the async write, or rows race.
    for (let i = 0; i < 20; i += 1) writer.enqueue([{ ...TEXT, content: `m${i}` }]);
    await writer.drain();

    expect(db.runs).toHaveLength(20);
    expect(db.runs.map((r: Recorded) => r.params[r.params.length - 4])).toEqual(
      Array.from({ length: 20 }, (_, i) => `m${i}`),
    );
  });

  it('upserts with DO UPDATE so a re-written row is not frozen', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);
    writer.enqueue([TEXT]);
    await writer.drain();

    // Hermes uses DO NOTHING on a repeating poll, which permanently freezes the
    // first snapshot of a still-streaming message.
    expect(db.runs[0].sql).toContain('ON CONFLICT(id) DO UPDATE');
    expect(db.runs[0].sql).not.toContain('DO NOTHING');
  });

  it('includes only the optional columns that exist', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);
    writer.enqueue([TEXT]);
    await writer.drain();

    // tenant_id is absent by default; durable_run_id and session_key exist.
    expect(db.runs[0].sql).toContain('durable_run_id');
    expect(db.runs[0].sql).toContain('session_key');
    expect(db.runs[0].sql).not.toContain('tenant_id');
  });

  it('omits a column the database genuinely lacks', async () => {
    mockTableHasColumn.mockImplementation(async (_db, _t, column) => column === 'session_key');
    const db = createMockDb();
    const writer = makeWriter(db);
    writer.enqueue([TEXT]);
    await writer.drain();

    // Keep the writer defensive when a caller exposes a reduced adapter schema.
    expect(db.runs[0].sql).not.toContain('durable_run_id');
    expect(db.runs[0].sql).toContain('session_key');
  });

  it('probes the schema once, not per row', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);
    writer.enqueue([TEXT, TEXT, TEXT]);
    await writer.drain();

    expect(db.runs).toHaveLength(3);
    expect(mockTableHasColumn).toHaveBeenCalledTimes(2); // durable_run_id, session_key
  });

  it('writes tenant_id only when explicitly opted in', async () => {
    mockTableHasColumn.mockImplementation(async () => true);
    const db = createMockDb();
    const writer = makeWriter(db, { tenantId: 9 });
    writer.enqueue([TEXT]);
    await writer.drain();

    expect(db.runs[0].sql).toContain('tenant_id');
    expect(db.runs[0].params).toContain(9);
  });

  it('never writes raw_payload', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);
    writer.enqueue([TEXT]);
    await writer.drain();

    // raw_payload doubles as the dedupe key for
    // syncSessionMessagesFromChatMessages; writing real JSON there makes every
    // sync re-append the whole transcript.
    expect(db.runs[0].sql).not.toContain('raw_payload');
  });

  it('serializes meta and records the event kind as event_type', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);
    writer.enqueue([
      { kind: 'tool_call', role: 'assistant', content: 'Bash', meta: { tool_name: 'Bash' } },
    ]);
    await writer.drain();

    const params = db.runs[0].params;
    expect(params).toContain('tool_call');
    expect(params).toContain(JSON.stringify({ tool_name: 'Bash' }));
  });

  it('writes {} rather than null when an event has no meta', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);
    writer.enqueue([TEXT]);
    await writer.drain();

    // event_meta is `text NOT NULL DEFAULT '{}'` in PostgreSQL, so a null
    // violates the constraint instead of falling back to the default. A live run
    // lost 4 of 6 transcript rows to exactly this before it was fixed; the mock
    // db accepts anything, so only the constraint value itself can be asserted.
    const params = db.runs[0].params;
    expect(params[params.length - 1]).toBe('{}');
    expect(params).not.toContain(null);
  });

  it('counts a failed write instead of throwing', async () => {
    const db = createMockDb((sql) => {
      if (sql.includes('INSERT INTO chat_messages')) throw new Error('disk full');
    });
    const writer = makeWriter(db);
    writer.enqueue([TEXT, TEXT]);

    // Losing a transcript row must never take down the run that produced it.
    const result = await writer.drain();
    expect(result.written).toBe(0);
    expect(result.failed).toBe(2);
  });

  it('reports written counts so a caller can fall back', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);
    writer.enqueue([TEXT, TEXT]);
    const result = await writer.drain();

    expect(result).toEqual({ written: 2, failed: 0 });
    expect(writer.written).toBe(2);
  });

  it('is a no-op for an empty batch', async () => {
    const db = createMockDb();
    const writer = makeWriter(db);
    writer.enqueue([]);
    expect(await writer.drain()).toEqual({ written: 0, failed: 0 });
    expect(db.runs).toHaveLength(0);
  });
});

describe('resolveRole', () => {
  it('forces turn_end to system', () => {
    // normalizeChatMessageRole maps an unknown role to 'assistant', so without
    // this special case every migrated writer would silently flip turn_end rows
    // from 'system' to 'assistant'. openclawJsonlBackfill hard-codes the same
    // correction inline; keeping it in the funnel is what makes that safe to drop.
    expect(resolveRole({ kind: 'turn_end', content: '' })).toBe('system');
    expect(resolveRole({ kind: 'turn_end', role: 'assistant', content: '' })).toBe('system');
  });

  it('forces system events to system', () => {
    expect(resolveRole({ kind: 'system', role: 'assistant', content: '' })).toBe('system');
  });

  it('maps tool_result to the tool role', () => {
    expect(resolveRole({ kind: 'tool_result', role: 'user', content: 'x' })).toBe('tool');
  });

  it('passes through the standard roles', () => {
    expect(resolveRole({ kind: 'text', role: 'user', content: 'x' })).toBe('user');
    expect(resolveRole({ kind: 'text', role: 'assistant', content: 'x' })).toBe('assistant');
  });

  it('only ever returns a CHECK-legal role', () => {
    const legal = new Set(['user', 'assistant', 'system', 'tool']);
    for (const role of ['weird', '', undefined, null, 42]) {
      expect(legal.has(resolveRole({ kind: 'text', role: role as never, content: 'x' }))).toBe(true);
    }
  });
});
