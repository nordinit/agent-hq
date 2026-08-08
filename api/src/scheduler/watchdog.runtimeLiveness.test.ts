import { setupTestDb, teardownTestDb } from '../db/testDb';
import { runWatchdogPass } from './watchdog';
import { abortInstanceExecutionTransport } from '../domains/runs/stopInstanceExecution';
import { type Db } from '../db/adapter/types';

jest.mock('../integrations/telegram', () => ({
  notifyTelegram: jest.fn(),
}));

// Only the outbound abort is stubbed; transport selection stays real, since
// picking the wrong transport is exactly the bug these tests cover.
jest.mock('../domains/runs/stopInstanceExecution', () => {
  const actual = jest.requireActual('../domains/runs/stopInstanceExecution');
  return {
    ...actual,
    abortInstanceExecutionTransport: jest.fn(async () => ({
      transport: 'runtime' as const,
      runtimeType: 'claude-code',
      sessionKey: 'run:600',
      result: { attempted: true, ok: true, status: 'succeeded' as const },
    })),
  };
});

const NOW = new Date('2026-08-08T12:00:00.000Z');
const abortMock = abortInstanceExecutionTransport as jest.MockedFunction<typeof abortInstanceExecutionTransport>;

function agoTimestamp(ms: number): string {
  return new Date(NOW.getTime() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

let db: Db;

/** A claude-code run that is already past its timeout, so the watchdog wants to fail it. */
async function seedTimedOutRuntimeInstance(runtimeType = 'claude-code'): Promise<void> {
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
  await db.run(`
    INSERT INTO app_settings (key, value)
    VALUES ('default_tenant_id', '1'), ('active_tenant_id', '1')
  `);
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, job_title, runtime_type, session_key, timeout_seconds)
    VALUES (88, 1, 'Atlas', 'Chief of Staff', ?, 'agent:atlas:main', 900)
  `, runtimeType);
  await db.run(`
    INSERT INTO job_instances (id, tenant_id, agent_id, status, created_at, dispatched_at, started_at, session_key)
    VALUES (600, 1, 88, 'running', ?, ?, ?, 'run:600')
  `, agoTimestamp(60 * 60_000), agoTimestamp(60 * 60_000), agoTimestamp(60 * 60_000));
  await db.run(`
    INSERT INTO instance_artifacts (instance_id, started_at)
    VALUES (600, ?)
  `, agoTimestamp(60 * 60_000));
}

async function writeTranscriptEvent(eventType: string, agoMs: number, id = `ev-${eventType}-${agoMs}`): Promise<void> {
  await db.run(`
    INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
    VALUES (?, 1, 88, 600, 'run:600', 'assistant', 'x', ?, ?, '{}')
  `, id, agoTimestamp(agoMs), eventType);
}

async function instanceStatus(): Promise<string> {
  const row = await db.get(`SELECT status FROM job_instances WHERE id = 600`) as { status: string };
  return row.status;
}

beforeEach(async () => {
  db = await setupTestDb();
  abortMock.mockClear();
});

afterEach(async () => {
  await teardownTestDb();
});

describe('watchdog liveness for runtime-backed runs', () => {
  it('defers failing a claude-code run that is still writing transcript activity', async () => {
    await seedTimedOutRuntimeInstance();
    await writeTranscriptEvent('tool_call', 30_000);

    await runWatchdogPass(db, NOW);

    // Before the runtime liveness probe this was failed: the OpenClaw JSONL
    // probe finds nothing for a claude-code run, so the reprieve never fired.
    expect(await instanceStatus()).toBe('running');
    expect(abortMock).not.toHaveBeenCalled();
  });

  it('fails a claude-code run that has gone quiet, and asks the runtime to stop first', async () => {
    await seedTimedOutRuntimeInstance();
    await writeTranscriptEvent('tool_call', 30 * 60_000);

    await runWatchdogPass(db, NOW);

    expect(await instanceStatus()).toBe('failed');
    expect(abortMock).toHaveBeenCalledTimes(1);
    expect(abortMock.mock.calls[0][2]).toMatchObject({ instanceId: 600, tenantId: 1 });
  });

  it('fails a runtime run that never produced a transcript', async () => {
    await seedTimedOutRuntimeInstance();

    await runWatchdogPass(db, NOW);

    expect(await instanceStatus()).toBe('failed');
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('does not treat a finished turn as live work', async () => {
    await seedTimedOutRuntimeInstance();
    await writeTranscriptEvent('tool_call', 40_000, 'ev-tool');
    await writeTranscriptEvent('turn_end', 20_000, 'ev-end');

    await runWatchdogPass(db, NOW);

    expect(await instanceStatus()).toBe('failed');
  });

  it('still routes an OpenClaw run through the OpenClaw probe, not the transcript one', async () => {
    await seedTimedOutRuntimeInstance('openclaw');
    // Recent transcript rows must not spare an OpenClaw run; its own session
    // state is authoritative there, and it has none here.
    await writeTranscriptEvent('tool_call', 10_000);

    await runWatchdogPass(db, NOW);

    expect(await instanceStatus()).toBe('failed');
    expect(abortMock).toHaveBeenCalledTimes(1);
  });
});
