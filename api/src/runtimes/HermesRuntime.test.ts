import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { jest } from '@jest/globals';

const mockSpawn = jest.fn();
const mockMaterializeAgentMcpConfig = jest.fn(() => ({ ok: true, count: 1, path: '/tmp/.mcp.json', bundlePath: '/tmp/.openclaw/extensions/agent-hq-mcp/.mcp.json', warnings: [] }));
const mockMaterializeHermesMcpConfig = jest.fn(() => ({ ok: true, count: 1, path: '/tmp/hermes-profile/config.yaml', serverNames: ['agent-hq__agent-17'], warnings: [] }));
const mockResolveOAuthCredentialForProvider = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockRecordRunCheckIn = jest.fn();
const mockTaskRequiresSemanticOutcome = jest.fn(() => false);
const mockScheduleEndedActiveInstanceLinkageCleanup = jest.fn();
const mockMarkTaskNeedsAttentionForMissingSemanticHandoff = jest.fn();
const mockApplyConfiguredRuntimeFailedEvent = jest.fn(async () => undefined);
const mockIngestHermesTranscriptForRun = jest.fn(() => ({ imported: 0, matchedFile: null, skipped: 'no-session-dir' }));
const mockResolveWorkflow = jest.fn(() => ({ workflowPhase: 'implementation', requiresSemanticOutcome: false }));

jest.mock('child_process', () => ({
  spawn: mockSpawn,
}));

jest.mock('./mcpMaterialization', () => ({
  materializeAgentMcpConfig: mockMaterializeAgentMcpConfig,
  materializeHermesMcpConfig: mockMaterializeHermesMcpConfig,
}));

jest.mock('../lib/openclawOAuthProfiles', () => ({
  resolveOAuthCredentialForProvider: (...args: unknown[]) => mockResolveOAuthCredentialForProvider(...args),
}));

jest.mock('./hermesTranscriptIngestion', () => {
  const actual = jest.requireActual<typeof import('./hermesTranscriptIngestion')>('./hermesTranscriptIngestion');
  return {
    ...actual,
    ingestHermesTranscriptForRun: mockIngestHermesTranscriptForRun,
  };
});

jest.mock('../domains/runs/observability', () => ({
  recordRunCheckIn: mockRecordRunCheckIn,
}));

jest.mock('../domains/runs/lifecycleHandoff', () => ({
  taskRequiresSemanticOutcome: mockTaskRequiresSemanticOutcome,
  markTaskNeedsAttentionForMissingSemanticHandoff: mockMarkTaskNeedsAttentionForMissingSemanticHandoff,
}));

jest.mock('../domains/runs/runtimeFailureEvent', () => ({
  applyConfiguredRuntimeFailedEvent: mockApplyConfiguredRuntimeFailedEvent,
}));

jest.mock('../lib/taskLifecycle', () => ({
  scheduleEndedActiveInstanceLinkageCleanup: mockScheduleEndedActiveInstanceLinkageCleanup,
}));

jest.mock('../services/contracts/workflowContract', () => ({
  resolveWorkflow: mockResolveWorkflow,
}));

import { HermesRuntime, validateHermesRuntimeConfig } from './HermesRuntime';
import type { DispatchParams } from './types';

function createMockDb(options: {
  existingInstance?: Record<string, unknown>;
  taskRow?: Record<string, unknown>;
  terminalClaimChanges?: number;
} = {}) {
  const statements: Array<{ sql: string; run: jest.Mock; get: jest.Mock; all: jest.Mock }> = [];
  const defaultExisting = {
    status: 'running',
    lifecycle_outcome_posted_at: null,
    task_outcome: null,
    task_id: 507,
    session_key: 'run:2940',
    ...(options.existingInstance ?? {}),
  };
  const defaultTaskRow = {
    task_id: 507,
    agent_id: 17,
    task_status: 'ready',
    project_id: 3,
    task_agent_id: 17,
    task_type: null,
    sprint_id: null,
    sprint_type: null,
    review_branch: null,
    review_commit: null,
    review_url: null,
    qa_verified_commit: null,
    qa_tested_url: null,
    merged_commit: null,
    deployed_commit: null,
    deploy_target: null,
    deployed_at: null,
    ...(options.taskRow ?? {}),
  };

  // Presents the async PostgreSQL Db interface. The canned-result logic below is
  // unchanged; __statements is still populated, keyed by SQL, so findPreparedRun()
  // keeps working.
  //
  // Statements are deduped by exact SQL rather than pushed per call, which is what lets an
  // assertion see every invocation on ONE jest.Mock instead of only the first.
  const statementFor = (sql: string) => {
    const existing = statements.find((entry) => entry.sql === sql);
    if (existing) return existing;
    const stmt = {
      sql,
      run: jest.fn(() => {
        if (
          sql.includes('UPDATE job_instances') &&
          sql.includes('runtime_ended_at') &&
          sql.includes("status IN ('queued', 'dispatched', 'running')")
        ) {
          return { changes: options.terminalClaimChanges ?? 1 };
        }
        return { changes: 1 };
      }),
      get: jest.fn(() => {
        if (sql.includes('SELECT agent_id FROM job_instances')) return { agent_id: 17 };
        if (sql.includes('SELECT status, lifecycle_outcome_posted_at, task_outcome, task_id, session_key')) return defaultExisting;
        if (sql.includes('SELECT ji.task_id, ji.agent_id')) return defaultTaskRow;
        return undefined;
      }),
      all: jest.fn(() => []),
    };
    statements.push(stmt);
    return stmt;
  };

  const db: Record<string, unknown> = {
    __statements: statements,
    dialect: 'postgres',
    inTransaction: false,
    get: jest.fn(async (sql: string, ...params: unknown[]) => statementFor(sql).get(...params)),
    all: jest.fn(async (sql: string, ...params: unknown[]) => statementFor(sql).all(...params)),
    value: jest.fn(async (sql: string, ...params: unknown[]) => statementFor(sql).get(...params)),
    run: jest.fn(async (sql: string, ...params: unknown[]) => {
      const result = statementFor(sql).run(...params) as { changes?: number };
      return { changes: result?.changes ?? 0, lastInsertId: null };
    }),
    exec: jest.fn(async () => undefined),
    withTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    close: jest.fn(async () => undefined),
  };
  return db as any;
}

function findPreparedRun(db: any, fragment: string): jest.Mock {
  const stmt = db.__statements.find((entry: { sql: string }) => entry.sql.includes(fragment));
  if (!stmt) throw new Error(`Prepared statement not found for ${fragment}`);
  return stmt.run;
}

function createMockChild() {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = jest.fn(() => true);
  child.pid = 1234;
  return child;
}

function buildParams(overrides: Partial<DispatchParams> = {}): DispatchParams {
  return {
    message: 'Implement Hermes adapter',
    agentSlug: 'cinder-backend',
    sessionKey: 'run:2940',
    timeoutSeconds: 30,
    name: 'Agent HQ: Task 507',
    instanceId: 2940,
    taskId: 507,
    activeRepoRoot: '/tmp/task-507',
    workspaceRoot: '/tmp',
    db: createMockDb(),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('HermesRuntime', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
    mockMaterializeAgentMcpConfig.mockClear();
    mockMaterializeHermesMcpConfig.mockClear();
    mockResolveOAuthCredentialForProvider.mockReset();
    mockResolveOAuthCredentialForProvider.mockResolvedValue({
      ok: true,
      provider: 'openai-codex',
      profileKey: 'openai-codex:default',
      source: 'provider-config',
      refreshed: false,
      expiresAt: Date.now() + 3600_000,
      credential: {
        type: 'oauth',
        provider: 'openai-codex',
        access: 'agent-hq-access',
        refresh: 'agent-hq-refresh',
        expires: Date.now() + 3600_000,
        accountId: 'acct-agent-hq',
      },
    });
    mockRecordRunCheckIn.mockClear();
    mockTaskRequiresSemanticOutcome.mockReset();
    mockTaskRequiresSemanticOutcome.mockReturnValue(false);
    mockScheduleEndedActiveInstanceLinkageCleanup.mockClear();
    mockMarkTaskNeedsAttentionForMissingSemanticHandoff.mockClear();
    mockApplyConfiguredRuntimeFailedEvent.mockClear();
    mockIngestHermesTranscriptForRun.mockClear();
    mockIngestHermesTranscriptForRun.mockReturnValue({ imported: 0, matchedFile: null, skipped: 'no-session-dir' });
    mockResolveWorkflow.mockClear();
    mockResolveWorkflow.mockReturnValue({ workflowPhase: 'implementation', requiresSemanticOutcome: false });
  });

  it('rejects missing Hermes profile config clearly', () => {
    expect(validateHermesRuntimeConfig({})).toBe('runtime_config.profile is required for hermes runtime');
  });

  it('rejects removed Hermes lifecycle mode config clearly', () => {
    expect(validateHermesRuntimeConfig({ profile: 'agent-hq-cinder', ['lifecycle' + 'Mode']: 'proxy' })).toContain('no longer supported');
  });

  it('rejects non-boolean fast mode config clearly', () => {
    expect(validateHermesRuntimeConfig({ profile: 'agent-hq-cinder', fastMode: 'true' as never })).toBe('runtime_config.fastMode must be a boolean when provided');
  });

  it('syncs Agent HQ-managed Codex OAuth into configured Hermes profile auth before dispatch', async () => {
    const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-auth-sync-'));
    try {
      const runtime = new HermesRuntime({ profile: 'agent-hq-cinder', hermesHome, heartbeatIntervalMs: 0 });

      const result = await runtime.prepareAuthProfiles({
        agentSlug: 'cinder-backend',
        preferredProvider: 'openai-codex',
        runtimeConfig: { profile: 'agent-hq-cinder', hermesHome },
      });

      const authPath = path.join(hermesHome, 'profiles', 'agent-hq-cinder', 'auth.json');
      const auth = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as Record<string, any>;
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        status: 'synced',
        providersSynced: ['openai-codex'],
        runtimeAuthPath: authPath,
      }));
      expect(auth.providers['openai-codex'].tokens).toEqual(expect.objectContaining({
        access_token: 'agent-hq-access',
        refresh_token: 'agent-hq-refresh',
        account_id: 'acct-agent-hq',
      }));
      expect(auth.credential_pool['openai-codex'][0]).toEqual(expect.objectContaining({
        auth_type: 'oauth',
        access_token: 'agent-hq-access',
        refresh_token: 'agent-hq-refresh',
      }));
    } finally {
      fs.rmSync(hermesHome, { recursive: true, force: true });
    }
  });

  it('fails Hermes credential preparation before launch when Agent HQ Codex OAuth is unavailable', async () => {
    mockResolveOAuthCredentialForProvider.mockResolvedValue({
      ok: false,
      provider: 'openai-codex',
      profileKey: 'openai-codex:default',
      source: 'none',
      refreshed: false,
      error: 'No OAuth profile "openai-codex:default" with a refresh token was found.',
    });
    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder', hermesHome: '/tmp/hermes-profile', heartbeatIntervalMs: 0 });

    const result = await runtime.prepareAuthProfiles({
      agentSlug: 'cinder-backend',
      preferredProvider: 'openai-codex',
      runtimeConfig: { profile: 'agent-hq-cinder', hermesHome: '/tmp/run-hermes-home' },
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      status: 'failed',
      runtimeAuthPath: '/tmp/run-hermes-home/profiles/agent-hq-cinder/auth.json',
      error: 'No OAuth profile "openai-codex:default" with a refresh token was found.',
    }));
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns Hermes in one-shot mode without injecting lifecycle parser instructions', async () => {
    const child = createMockChild();
    const onRuntimeEnd = jest.fn(async () => undefined);
    const db = createMockDb();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });

    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder', hermesHome: '/tmp/hermes-profile', heartbeatIntervalMs: 0 });
    const run = await runtime.dispatch(buildParams({ db, onRuntimeEnd, fastMode: true }));

    expect(run.runId).toBe('hermes:2940');
    expect(mockMaterializeAgentMcpConfig).toHaveBeenCalledWith(expect.objectContaining({ agentId: 17, workingDirectory: '/tmp/task-507' }));
    expect(mockMaterializeAgentMcpConfig).toHaveBeenCalledWith(expect.objectContaining({ agentId: 17, workingDirectory: '/tmp/hermes-profile/profiles/agent-hq-cinder' }));
    expect(mockMaterializeHermesMcpConfig).toHaveBeenCalledWith(expect.objectContaining({ agentId: 17, hermesHome: '/tmp/hermes-profile/profiles/agent-hq-cinder' }));

    const [bin, args, options] = mockSpawn.mock.calls[0] as [string, string[], { cwd: string; env: Record<string, string> }];
    expect(bin).toBe('hermes');
    expect(args[0]).toBe('--profile');
    expect(args[1]).toBe('agent-hq-cinder');
    expect(args).toContain('-z');
    expect(args[args.length - 1]).toContain('instance_id: 2940');
    expect(args[args.length - 1]).toContain('task_id: 507');
    expect(args[args.length - 1]).toContain('session_key: run:2940');
    expect(args[args.length - 1]).toContain('Implement Hermes adapter');
    expect(options.cwd).toBe('/tmp/task-507');
    expect(options.env.AGENT_HQ_TASK_ID).toBe('507');
    expect(options.env.AGENT_HQ_ACTIVE_REPO_ROOT).toBe('/tmp/task-507');
    expect(options.env.AGENT_HQ_FAST_MODE).toBe('true');
    expect(options.env.HERMES_FAST_MODE).toBe('true');
    expect(options.env.HERMES_HOME).toBe('/tmp/hermes-profile/profiles/agent-hq-cinder');

    child.stdout.write('Done');
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    expect(onRuntimeEnd).toHaveBeenCalledWith(expect.objectContaining({
      type: 'runEnded',
      source: 'hermes',
      success: true,
      reason: 'completed',
      metadata: expect.objectContaining({ fast_mode: true }),
    }));
    const runtimeStateUpdate = findPreparedRun(db, 'runtime_ended_at');
    expect(runtimeStateUpdate).toHaveBeenCalledWith(
      'done',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      1,
      null,
      'hermes',
      null,
      null,
      null,
      2940,
    );
    expect(mockRecordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 2940,
      stage: 'completion',
      outcome: 'completed',
      runtimeEndSuccess: true,
      runtimeEndSource: 'hermes',
    }));
    expect(mockScheduleEndedActiveInstanceLinkageCleanup).toHaveBeenCalledWith(db, 507, 2940, {
      changedBy: 'task_lifecycle',
    });
  });

  it('polls Hermes native transcript while running and performs final ingest before runtime-end persistence', async () => {
    const child = createMockChild();
    const db = createMockDb();
    const order: string[] = [];
    mockIngestHermesTranscriptForRun.mockImplementation(() => {
      order.push('ingest');
      return { imported: 0, matchedFile: null, skipped: 'no-session-dir' };
    });
    // Watches for the runtime-end write on db.run, which is what the code calls now. The
    // previous version wrapped db.prepare — absent from the adapter — so originalPrepare
    // was undefined and this interceptor silently never fired, which is why 'runtime-end'
    // was missing from the ordering rather than genuinely not happening.
    const originalRun = db.run;
    db.run = jest.fn(async (sql: string, ...values: unknown[]) => {
      if (
        sql.includes('hermes-runtime-end-')
        || (sql.includes('INSERT INTO chat_messages') && sql.includes('turn_end'))
      ) {
        order.push('runtime-end');
      }
      return originalRun(sql, ...values);
    }) as typeof db.run;
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });

    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder', heartbeatIntervalMs: 0 });
    await runtime.dispatch(buildParams({ db, durableRunId: 'durable-2940' }));

    expect(mockIngestHermesTranscriptForRun).toHaveBeenCalledWith(expect.objectContaining({
      instanceId: 2940,
      durableRunId: 'durable-2940',
      sessionKey: 'run:2940',
      profile: 'agent-hq-cinder',
    }));

    child.stdout.write('Done');
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    expect(mockIngestHermesTranscriptForRun).toHaveBeenCalledTimes(2);
    expect(order).toEqual(['ingest', 'ingest', 'runtime-end']);
  });

  it('marks Hermes process failures as terminal failed instance state', async () => {
    const child = createMockChild();
    const db = createMockDb();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });

    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder', heartbeatIntervalMs: 0 });
    await runtime.dispatch(buildParams({ db }));

    child.stderr.write('provider unavailable');
    child.stderr.end();
    child.emit('close', 2, null);
    await flush();

    const runtimeStateUpdate = findPreparedRun(db, 'runtime_ended_at');
    expect(runtimeStateUpdate).toHaveBeenCalledWith(
      'failed',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      0,
      expect.stringContaining('Hermes exited with code 2'),
      'hermes',
      null,
      null,
      null,
      2940,
    );
    expect(mockRecordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 2940,
      stage: 'completion',
      summary: expect.stringContaining('Hermes runtime failed'),
      outcome: 'failed',
      runtimeEndSuccess: false,
      runtimeEndSource: 'hermes',
    }));
    expect(mockApplyConfiguredRuntimeFailedEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      taskId: 507,
      instanceId: 2940,
      runtimeEndSource: 'hermes',
      runtimeEndError: expect.stringContaining('Hermes exited with code 2'),
    }));
  });

  it('classifies zero-exit Hermes provider rate limits as runtime failures', async () => {
    mockTaskRequiresSemanticOutcome.mockReturnValue(true);
    mockResolveWorkflow.mockReturnValue({ workflowPhase: 'implementation', requiresSemanticOutcome: true });
    const child = createMockChild();
    const db = createMockDb({ taskRow: { task_status: 'in_progress' } });
    const onRuntimeEnd = jest.fn(async () => undefined);
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });

    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder', heartbeatIntervalMs: 0 });
    await runtime.dispatch(buildParams({ db, onRuntimeEnd }));

    child.stdout.write("API call failed after 3 retries: HTTP 429: Error code: 429 - {'detail': 'Rate limit exceeded'}");
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    const runtimeStateUpdate = findPreparedRun(db, 'runtime_ended_at');
    expect(runtimeStateUpdate).toHaveBeenCalledWith(
      'failed',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      0,
      expect.stringContaining('Rate limit exceeded'),
      'hermes',
      null,
      null,
      null,
      2940,
    );
    expect(onRuntimeEnd).toHaveBeenCalledWith(expect.objectContaining({
      type: 'runEnded',
      source: 'hermes',
      success: false,
      reason: 'error',
      error: expect.stringContaining('HTTP 429'),
      metadata: expect.objectContaining({
        provider_limit_failure_detected: true,
        hermes_process_success: true,
      }),
    }));
    expect(mockRecordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 2940,
      stage: 'completion',
      summary: expect.stringContaining('Hermes runtime failed'),
      outcome: 'failed',
      runtimeEndSuccess: false,
      runtimeEndError: expect.stringContaining('Rate limit exceeded'),
      runtimeEndSource: 'hermes',
    }));
    expect(mockApplyConfiguredRuntimeFailedEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      taskId: 507,
      instanceId: 2940,
      runtimeEndSource: 'hermes',
      runtimeEndError: expect.stringContaining('HTTP 429'),
    }));
    expect(mockMarkTaskNeedsAttentionForMissingSemanticHandoff).not.toHaveBeenCalled();

    const assistantInsert = findPreparedRun(db, "VALUES (?, ?, ?, 'assistant'");
    expect(assistantInsert).toHaveBeenCalledWith(
      'hermes-asst-2940',
      17,
      2940,
      expect.stringContaining('HTTP 429'),
      expect.any(String),
    );

    const responseUpdate = findPreparedRun(db, "'{runtimeEnd}'");
    const [runtimeEndJson] = responseUpdate.mock.calls[0] as [string, number];
    expect(JSON.parse(runtimeEndJson)).toEqual(expect.objectContaining({
      success: false,
      reason: 'error',
      error: expect.stringContaining('Rate limit exceeded'),
    }));
  });

  it('moves Hermes success to missing-handoff policy when a semantic outcome is required', async () => {
    mockTaskRequiresSemanticOutcome.mockReturnValue(true);
    mockResolveWorkflow.mockReturnValue({ workflowPhase: 'implementation', requiresSemanticOutcome: true });
    const child = createMockChild();
    const db = createMockDb({ taskRow: { task_status: 'in_progress', review_branch: 'cinder-backend/task-721' } });
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });

    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder', heartbeatIntervalMs: 0 });
    await runtime.dispatch(buildParams({ db }));

    child.stdout.write('Done');
    child.stdout.end();
    child.emit('close', 0, null);
    await flush();

    const runtimeStateUpdate = findPreparedRun(db, 'runtime_ended_at');
    expect(runtimeStateUpdate).toHaveBeenCalledWith(
      'failed',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      1,
      null,
      'hermes',
      null,
      null,
      null,
      2940,
    );
    expect(mockRecordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      summary: 'Hermes runtime ended without required lifecycle outcome',
      runtimeEndSuccess: true,
      runtimeEndError: 'Hermes runtime ended without required lifecycle outcome',
    }));
    expect(mockMarkTaskNeedsAttentionForMissingSemanticHandoff).toHaveBeenCalledWith(db, expect.objectContaining({
      taskId: 507,
      instanceId: 2940,
      workflowPhase: 'implementation',
      runtimeEnd: expect.objectContaining({
        source: 'hermes',
        success: true,
      }),
    }));
    expect(mockApplyConfiguredRuntimeFailedEvent).not.toHaveBeenCalled();
  });

  it('throws when Hermes fails before spawn completes without posting lifecycle callbacks', async () => {
    const child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('error', new Error('spawn ENOENT')));
      return child;
    });

    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder', heartbeatIntervalMs: 0 });

    await expect(runtime.dispatch(buildParams())).rejects.toThrow('Hermes runtime failed to launch: spawn ENOENT');
  });

  it('terminates the active Hermes child on abort', async () => {
    const child = createMockChild();
    mockSpawn.mockImplementation(() => {
      setImmediate(() => child.emit('spawn'));
      return child;
    });

    const runtime = new HermesRuntime({ profile: 'agent-hq-cinder', heartbeatIntervalMs: 0, killGraceMs: 5 });
    await runtime.dispatch(buildParams());

    await runtime.abort('hermes:2940', 'run:2940');
    child.emit('close', null, 'SIGTERM');
    await flush();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
