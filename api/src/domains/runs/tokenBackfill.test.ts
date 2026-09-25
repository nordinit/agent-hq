import { execFile, spawnSync } from 'child_process';
import {
  backfillInstanceTokens,
  fetchHookSessionTokens,
  fetchHookSessionTokensAsync,
  resetTokenBackfillStateForTests,
} from './tokenBackfill';
import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';

jest.mock('child_process', () => ({
  spawnSync: jest.fn(),
  execFile: jest.fn(),
}));

const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;
const mockExecFile = execFile as unknown as jest.Mock;

const INSTANCE_ID = 4450;

/**
 * job_instances.agent_id is NOT NULL and a real foreign key in both baselines, which the old
 * hand-written CREATE TABLE in this file did not have — so the instance now needs an owner.
 */
async function seedInstance(): Promise<void> {
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
  await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1')`);
  const agent = await db.run(
    `INSERT INTO agents (tenant_id, name, session_key)
     VALUES (1, 'Token Backfill Agent', 'token-backfill-agent')`,
  );
  await db.run(
    `INSERT INTO job_instances (id, tenant_id, agent_id, status, created_at, session_key)
     VALUES (?, 1, ?, 'done', to_char(now() AT TIME ZONE 'utc' - interval '5 minutes', 'YYYY-MM-DD HH24:MI:SS'), 'run:4450:d6252a6b-6160-4f62-b288-4ad972449e65')`,
    INSTANCE_ID,
    Number(agent.lastInsertId),
  );
}

describe('backfillInstanceTokens', () => {
  beforeEach(async () => {
    await setupTestDb();
    mockSpawnSync.mockReset();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('persists token usage from canonical OpenClaw run sessions with durable suffixes', async () => {
    await seedInstance();

    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: JSON.stringify({
        sessions: [{
          key: 'agent:example-devops:run:4450:e5d24260-cd3c-46d5-a508-68380d9c8856',
          inputTokens: 1621,
          outputTokens: 115,
          totalTokens: 59349,
          totalTokensFresh: true,
        }],
      }),
      stderr: '',
      pid: 123,
      output: [],
      signal: null,
    });

    expect(await backfillInstanceTokens(getDb())).toBe(1);

    const row = await getDb().get(`
      SELECT token_input, token_output, token_total
      FROM job_instances
      WHERE id = ?
    `, INSTANCE_ID) as { token_input: number | null; token_output: number | null; token_total: number | null };

    expect(row).toEqual({
      token_input: 1621,
      token_output: 115,
      token_total: 59349,
    });
  });

  it('ignores runs owned by a runtime OpenClaw cannot report on', async () => {
    const db = getDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Test', 'test', 1)`);
    await db.run(`INSERT INTO app_settings (key, value) VALUES ('default_tenant_id', '1')`);
    const agent = await db.run(
      `INSERT INTO agents (tenant_id, name, session_key, runtime_type)
       VALUES (1, 'Atlas', 'atlas', 'claude-code')`,
    );
    await db.run(
      `INSERT INTO job_instances (id, tenant_id, agent_id, status, created_at, session_key)
       VALUES (?, 1, ?, 'done', to_char(now() AT TIME ZONE 'utc' - interval '5 minutes', 'YYYY-MM-DD HH24:MI:SS'), 'run:4450:d6252a6b-6160-4f62-b288-4ad972449e65')`,
      INSTANCE_ID,
      Number(agent.lastInsertId),
    );

    // A claude-code run can never appear in OpenClaw's sessions.list, so it used
    // to stay a candidate on every tick forever. With no candidates left there
    // is nothing to fetch for, and the gateway is not called at all.
    expect(await backfillInstanceTokens(getDb())).toBe(0);
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });
});

describe('sessions.list fetch', () => {
  const TOKEN = 'test-gateway-token-3f9c';
  const HOUR_MS = 60 * 60_000;
  // What the CLI printed on stdout in production once TLS verification came back on.
  const TRANSPORT_FAILURE_STDOUT = JSON.stringify({
    ok: false,
    error: {
      type: 'gateway_transport_error',
      kind: 'closed',
      message: 'gateway closed (1006 abnormal closure (no close frame)): no close reason\nGateway target: https://127.0.0.1:18789\nSource: env OPENCLAW_GATEWAY_URL',
    },
    gateway: { url: 'https://127.0.0.1:18789', urlSource: 'env OPENCLAW_GATEWAY_URL' },
  });
  const TRANSPORT_FAILURE_LOG = '[tokenBackfill] Failed to fetch sessions.list: exit 1; '
    + 'gateway_transport_error/closed: gateway closed (1006 abnormal closure (no close frame)): no close reason';
  const originalToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  const originalUrl = process.env.OPENCLAW_GATEWAY_URL;
  let warn: jest.SpyInstance;
  let now: jest.SpyInstance;
  let nowMs: number;

  function spawnResult(overrides: Partial<ReturnType<typeof spawnSync>>): ReturnType<typeof spawnSync> {
    return { status: 0, stdout: '', stderr: '', pid: 123, output: [], signal: null, ...overrides } as ReturnType<typeof spawnSync>;
  }

  function spawnCall(): { args: string[]; env: NodeJS.ProcessEnv; timeout: number } {
    const [, args, options] = mockSpawnSync.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; timeout: number }];
    return { args, env: options.env, timeout: options.timeout };
  }

  beforeEach(() => {
    process.env.OPENCLAW_GATEWAY_TOKEN = TOKEN;
    process.env.OPENCLAW_GATEWAY_URL = 'https://127.0.0.1:18789';
    resetTokenBackfillStateForTests();
    mockSpawnSync.mockReset();
    mockExecFile.mockReset();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    nowMs = Date.parse('2026-09-25T12:00:00Z');
    now = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    warn.mockRestore();
    now.mockRestore();
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
    else process.env.OPENCLAW_GATEWAY_TOKEN = originalToken;
    if (originalUrl === undefined) delete process.env.OPENCLAW_GATEWAY_URL;
    else process.env.OPENCLAW_GATEWAY_URL = originalUrl;
  });

  it('hands the CLI its token through the environment and lets it use its own loopback gateway', () => {
    mockSpawnSync.mockReturnValue(spawnResult({ stdout: JSON.stringify({ sessions: [] }) }));

    fetchHookSessionTokens();

    const call = spawnCall();
    expect(call.args.slice(0, 4)).toEqual(['gateway', 'call', 'sessions.list', '--json']);
    expect(call.args).not.toContain('--token');
    expect(call.args.join(' ')).not.toContain(TOKEN);
    expect(call.env.OPENCLAW_GATEWAY_TOKEN).toBe(TOKEN);
    expect(call.env.OPENCLAW_GATEWAY_URL).toBeUndefined();
    expect(call.timeout).toBe(15_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs the error the CLI printed on stdout, and stderr, without the token', () => {
    mockSpawnSync.mockReturnValue(spawnResult({
      status: 1,
      stdout: TRANSPORT_FAILURE_STDOUT,
      stderr: `Gateway call failed with token ${TOKEN}\nmore detail`,
    }));

    expect(fetchHookSessionTokens().size).toBe(0);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toBe(`${TRANSPORT_FAILURE_LOG}; stderr: Gateway call failed with token <redacted>`);
    expect(line).not.toContain(TOKEN);
  });

  it('logs a repeated failure once an hour, and a different failure straight away', () => {
    mockSpawnSync.mockReturnValue(spawnResult({ status: 1, stdout: TRANSPORT_FAILURE_STDOUT }));

    fetchHookSessionTokens();
    nowMs += 5 * 60_000;
    fetchHookSessionTokens();
    nowMs += 50 * 60_000;
    fetchHookSessionTokens();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith(TRANSPORT_FAILURE_LOG);

    mockSpawnSync.mockReturnValue(spawnResult({ status: 1, stderr: 'Gateway call failed: auth rejected' }));
    fetchHookSessionTokens();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('[tokenBackfill] Failed to fetch sessions.list: exit 1; stderr: Gateway call failed: auth rejected');

    mockSpawnSync.mockReturnValue(spawnResult({ status: 1, stdout: TRANSPORT_FAILURE_STDOUT }));
    nowMs += HOUR_MS;
    fetchHookSessionTokens();
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenLastCalledWith(`${TRANSPORT_FAILURE_LOG} (repeated 2 more time(s) since last logged)`);
  });

  it('logs a timeout as a timeout', () => {
    mockSpawnSync.mockReturnValue(spawnResult({
      status: null,
      signal: 'SIGTERM',
      error: Object.assign(new Error('spawnSync openclaw ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    }));

    fetchHookSessionTokens();

    expect(warn).toHaveBeenCalledWith('[tokenBackfill] Failed to fetch sessions.list: timed out after 15000ms');
  });

  it('logs a CLI that cannot be started', () => {
    mockSpawnSync.mockReturnValue(spawnResult({
      status: null,
      error: Object.assign(new Error('spawnSync openclaw ENOENT'), { code: 'ENOENT' }),
    }));

    fetchHookSessionTokens();

    expect(warn).toHaveBeenCalledWith('[tokenBackfill] Failed to fetch sessions.list: spawnSync openclaw ENOENT');
  });

  describe('async', () => {
    type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

    function execFileResponds(error: Error | null, stdout = '', stderr = ''): void {
      mockExecFile.mockImplementation((_command: string, _args: string[], _options: unknown, callback: ExecFileCallback) => {
        callback(error, stdout, stderr);
      });
    }

    it('reads sessions with the token in the environment only', async () => {
      execFileResponds(null, JSON.stringify({
        sessions: [{ key: 'run:4242', inputTokens: 10, outputTokens: 5, totalTokens: 15 }],
      }));

      const tokens = await fetchHookSessionTokensAsync();

      expect(tokens.get(4242)).toEqual({ input: 10, output: 5, total: 15 });
      const [, args, options] = mockExecFile.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv; timeout: number }];
      expect(args).not.toContain('--token');
      expect(options.env.OPENCLAW_GATEWAY_TOKEN).toBe(TOKEN);
      expect(options.env.OPENCLAW_GATEWAY_URL).toBeUndefined();
      expect(options.timeout).toBe(15_000);
      expect(warn).not.toHaveBeenCalled();
    });

    it('logs the CLI error from stdout when it exits non-zero', async () => {
      execFileResponds(Object.assign(new Error('Command failed: openclaw gateway call sessions.list'), { code: 1 }), TRANSPORT_FAILURE_STDOUT);

      expect((await fetchHookSessionTokensAsync()).size).toBe(0);

      expect(warn).toHaveBeenCalledWith(TRANSPORT_FAILURE_LOG);
    });

    it('logs a timeout as a timeout', async () => {
      execFileResponds(Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }));

      await fetchHookSessionTokensAsync();

      expect(warn).toHaveBeenCalledWith('[tokenBackfill] Failed to fetch sessions.list: timed out after 15000ms');
    });

    it('logs output that overflows the buffer as that, not as a timeout', async () => {
      execFileResponds(Object.assign(new Error('stdout maxBuffer length exceeded'), {
        killed: true,
        code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        signal: 'SIGTERM',
      }));

      await fetchHookSessionTokensAsync();

      expect(warn).toHaveBeenCalledWith('[tokenBackfill] Failed to fetch sessions.list: stdout maxBuffer length exceeded');
    });
  });
});
