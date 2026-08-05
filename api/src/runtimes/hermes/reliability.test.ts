import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

const mockSpawn = jest.fn();
const mockApplyRuntimeEnd = jest.fn(async (..._a: unknown[]) => ({ changed: true }));
const mockRecordRunCheckIn = jest.fn(async (..._a: unknown[]) => ({ taskId: null, noteCreated: false }));
const TENANT_ID = 23;

jest.mock('child_process', () => ({
  ...(jest.requireActual('child_process') as object),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock('../../domains/runs/runtimeEnd', () => ({
  applyRuntimeEndToJobInstance: (...args: unknown[]) => mockApplyRuntimeEnd(...args),
}));

jest.mock('../../domains/runs/observability', () => ({
  recordRunCheckIn: (...args: unknown[]) => mockRecordRunCheckIn(...args),
}));

jest.mock('../mcpMaterialization', () => ({
  materializeAgentMcpConfig: jest.fn(async () => ({ ok: true, count: 0, serverNames: [], warnings: [] })),
  materializeHermesMcpConfig: jest.fn(async () => ({ ok: true, count: 0, serverNames: [], warnings: [] })),
}));

jest.mock('../hermesTranscriptIngestion', () => ({
  ingestHermesTranscriptForRun: jest.fn(async () => ({ imported: 0, matchedFile: null, skipped: null })),
  prependAgentHqRunContext: (prompt: string) => prompt,
}));

import { HermesRuntime } from './HermesRuntime';
import type { DispatchParams } from '../types';

function createMockChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    kill: jest.Mock;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn(() => true);
  return child;
}

function createMockDb() {
  const runs: Array<{ sql: string; params: unknown[] }> = [];
  return {
    runs,
    dialect: 'postgres' as const,
    inTransaction: false,
    get: jest.fn(async (sql: string) => {
      if (sql.includes('information_schema.columns') || sql.includes('information_schema.tables')) {
        return { found: 1 };
      }
      if (sql.includes('SELECT agent_id FROM job_instances')) return { agent_id: 17 };
      if (sql.includes('FROM job_instances ji')) {
        return {
          instance_tenant_id: TENANT_ID,
          task_tenant_id: TENANT_ID,
          agent_tenant_id: TENANT_ID,
        };
      }
      if (sql.includes('SELECT tenant_id FROM agents')) return { tenant_id: TENANT_ID };
      return undefined;
    }),
    all: jest.fn(async () => []),
    value: jest.fn(async () => undefined),
    run: jest.fn(async (sql: string, ...params: unknown[]) => {
      runs.push({ sql, params });
      return { changes: 1, lastInsertId: null };
    }),
    exec: jest.fn(async () => undefined),
    withTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(null)),
    close: jest.fn(async () => undefined),
  };
}

function baseParams(overrides: Partial<DispatchParams> = {}): DispatchParams {
  return {
    message: 'do work',
    agentSlug: 'cinder',
    sessionKey: 'agent:cinder:run:1',
    timeoutSeconds: 0,
    name: 'Cinder',
    instanceId: 4242,
    taskId: 7,
    durableRunId: 'drun_x',
    activeRepoRoot: '/repo',
    runtimeConfig: { profile: 'agent-hq-cinder' },
    ...overrides,
  } as DispatchParams;
}

async function flush(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

beforeEach(() => jest.clearAllMocks());

describe('Hermes launch failure', () => {
  it('persists a terminal record before rethrowing', async () => {
    const child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('error', new Error('spawn hermes ENOENT')));
      return child;
    });

    const db = createMockDb();
    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder' });

    await expect(runtime.dispatch(baseParams({ db: db as never }))).rejects.toThrow(/failed to launch/);
    await flush();

    // This path runs before the run is registered and before monitorRun, so it
    // previously produced no RuntimeEndEvent at all — leaving the watchdog's
    // crash-recovery path with nothing to read.
    expect(mockApplyRuntimeEnd).toHaveBeenCalledTimes(1);
    const [, args] = mockApplyRuntimeEnd.mock.calls[0] as [unknown, { event: Record<string, unknown> }];
    expect(args.event.success).toBe(false);
    expect(args.event.reason).toBe('error');
    expect(String(args.event.error)).toMatch(/ENOENT/);
    expect((args.event.metadata as Record<string, unknown>).spawn_failed).toBe(true);

    const promptInsert = db.runs.find((entry) => entry.sql.includes("'user'"));
    expect(promptInsert?.sql).toContain('tenant_id');
    expect(promptInsert?.params[1]).toBe(TENANT_ID);
  });

  it('writes the turn_end row the watchdog reads back', async () => {
    const child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('error', new Error('boom')));
      return child;
    });

    const db = createMockDb();
    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder' });
    await expect(runtime.dispatch(baseParams({ db: db as never }))).rejects.toThrow();
    await flush();

    expect(db.runs.filter((r) => r.sql.includes("'turn_end'"))).toHaveLength(1);
    expect(db.runs.filter((r) => r.sql.includes("'{runtimeEnd}'"))).toHaveLength(1);
  });

  it('still rethrows so the dispatcher can classify the startup failure', async () => {
    const child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('error', new Error('nope')));
      return child;
    });

    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder' });
    // No db: persistence is skipped, but the throw is the dispatcher's contract.
    await expect(runtime.dispatch(baseParams({ db: undefined }))).rejects.toThrow(
      /Hermes runtime failed to launch/,
    );
  });
});

describe('Hermes heartbeat', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('reports process liveness on the configured interval', async () => {
    const child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });

    const db = createMockDb();
    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder' });
    const dispatched = runtime.dispatch(
      baseParams({ db: db as never, runtimeConfig: { profile: 'p', heartbeatIntervalMs: 1000 } }),
    );
    await jest.advanceTimersByTimeAsync(0);
    await dispatched;

    expect(mockRecordRunCheckIn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1000);

    // heartbeatIntervalMs was validated and defaulted but never wired to a timer,
    // so docs/hermes-runtime.md documented a cadence that did not exist. The
    // watchdog judges staleness from instance_artifacts.last_agent_heartbeat_at,
    // which only agent-side check-ins wrote — so a quiet but healthy run could be
    // marked stale.
    expect(mockRecordRunCheckIn).toHaveBeenCalledTimes(1);
    const [, input] = mockRecordRunCheckIn.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(input.stage).toBe('heartbeat');
    expect(input.instanceId).toBe(4242);
    expect(input.suppressNote).toBe(true);
  });

  it('stops once the process has exited', async () => {
    const child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });

    const db = createMockDb();
    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder' });
    const dispatched = runtime.dispatch(
      baseParams({ db: db as never, runtimeConfig: { profile: 'p', heartbeatIntervalMs: 1000 } }),
    );
    await jest.advanceTimersByTimeAsync(0);
    await dispatched;

    child.stdout.end();
    child.emit('close', 0, null);
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(5000);

    expect(mockRecordRunCheckIn).not.toHaveBeenCalled();
  });

  it('is disabled when the interval is zero', async () => {
    const child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });

    const db = createMockDb();
    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder' });
    const dispatched = runtime.dispatch(
      baseParams({ db: db as never, runtimeConfig: { profile: 'p', heartbeatIntervalMs: 0 } }),
    );
    await jest.advanceTimersByTimeAsync(0);
    await dispatched;

    await jest.advanceTimersByTimeAsync(10_000);
    expect(mockRecordRunCheckIn).not.toHaveBeenCalled();
  });
});
