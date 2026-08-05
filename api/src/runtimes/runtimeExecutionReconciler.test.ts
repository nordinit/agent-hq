const mockStoreAvailable = jest.fn(async (_db: unknown) => true);
const mockTerminal = jest.fn(async (_db: unknown, _input: unknown) => ({
  status: 'persisted', executionId: 41,
}));
const mockAppend = jest.fn(async (_db: unknown, _input: unknown) => ({
  status: 'persisted', executionId: 41, checkpointId: 2, sequence: 1,
}));
const mockApplyRuntimeEnd = jest.fn(async (_db: unknown, _input: unknown) => ({
  changed: true,
}));
const mockMarkRuntimeEnded = jest.fn(async (_db: unknown, _input: unknown) => undefined);

jest.mock('./runtimeExecutionStore', () => ({
  runtimeExecutionStoreAvailable: (db: unknown) => mockStoreAvailable(db),
  terminalRuntimeExecution: (db: unknown, input: unknown) => mockTerminal(db, input),
  appendRuntimeCheckpoint: (db: unknown, input: unknown) => mockAppend(db, input),
}));
jest.mock('../domains/runs/runtimeEnd', () => ({
  applyRuntimeEndToJobInstance: (db: unknown, input: unknown) => mockApplyRuntimeEnd(db, input),
  markRuntimeEnded: (db: unknown, input: unknown) => mockMarkRuntimeEnded(db, input),
}));

import {
  clearRuntimeExecutionReconcilerStateForTests,
  reconcileRuntimeExecutions,
} from './runtimeExecutionReconciler';

function dbWith(rows: unknown[], projection?: unknown, terminalRows: unknown[] = []) {
  return {
    all: jest.fn(async (sql: string) =>
      sql.includes("re.state IN ('succeeded', 'failed', 'cancelled', 'lost')")
        ? terminalRows
        : rows),
    get: jest.fn(async () => projection),
    run: jest.fn(async () => ({ changes: 1, lastInsertId: null })),
  } as never;
}

beforeEach(() => {
  mockStoreAvailable.mockClear();
  mockTerminal.mockClear();
  mockAppend.mockClear();
  mockApplyRuntimeEnd.mockClear();
  mockMarkRuntimeEnded.mockClear();
  clearRuntimeExecutionReconcilerStateForTests();
});

describe('reconcileRuntimeExecutions', () => {
  it('requires two missing observations before declaring a local process lost', async () => {
    const db = dbWith([{
      id: 41,
      instance_id: 7,
      runtime_type: 'codex',
      state: 'running',
      opaque_handle: JSON.stringify({ kind: 'local-process', pid: 999_001, processGroupId: 999_001, hostname: 'api-1' }),
    }]);
    let clock = 1_000;
    const options = {
      currentHostname: 'api-1',
      processExists: () => false,
      missingConfirmationMs: 15_000,
      now: () => clock,
    };

    await expect(reconcileRuntimeExecutions(db, options)).resolves.toMatchObject({
      pendingConfirmation: 1,
      lost: 0,
    });
    clock += 16_000;
    await expect(reconcileRuntimeExecutions(db, options)).resolves.toMatchObject({
      pendingConfirmation: 0,
      lost: 1,
    });
    expect(mockTerminal).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 7,
      state: 'lost',
      reason: 'local_process_missing_after_restart',
    }));
    expect(mockApplyRuntimeEnd).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 7,
      runtimeEndSource: 'runtime-reconciler',
      event: expect.objectContaining({
        success: false,
        source: 'runtime-reconciler',
        error: expect.stringContaining('process group 999001'),
      }),
    }));
    expect(mockAppend).toHaveBeenCalledWith(db, expect.objectContaining({
      executionId: 41,
      kind: 'reconciled',
      state: 'lost',
    }));
  });

  it('treats a reused PID as missing when its birth fingerprint changes', async () => {
    const db = dbWith([{
      id: 42,
      instance_id: 8,
      runtime_type: 'claude-code',
      state: 'running',
      opaque_handle: {
        kind: 'local-process', pid: 100, processGroupId: 100, hostname: 'api-1', processIdentity: 'sha256:original',
      },
    }]);
    let clock = 1_000;
    const options = {
      currentHostname: 'api-1',
      processExists: (target: number) => target < 0 ? false : true,
      processIdentity: () => 'sha256:replacement',
      missingConfirmationMs: 15_000,
      now: () => clock,
    };

    await reconcileRuntimeExecutions(db, options);
    clock += 16_000;
    await expect(reconcileRuntimeExecutions(db, options)).resolves.toMatchObject({ lost: 1 });
  });

  it('keeps fingerprinted live local processes and cross-host targets untouched', async () => {
    const db = dbWith([
      {
        id: 1, instance_id: 10, runtime_type: 'claude-code', state: 'running',
        opaque_handle: {
          kind: 'local-process', pid: 100, processGroupId: 100, hostname: 'api-1', processIdentity: 'sha256:original',
        },
      },
      {
        id: 2, instance_id: 11, runtime_type: 'codex', state: 'running',
        opaque_handle: { kind: 'local-process', pid: 101, processGroupId: 101, hostname: 'api-2' },
      },
    ]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: () => true,
      processIdentity: () => 'sha256:original',
    })).resolves.toMatchObject({ alive: 1, skipped: 1, lost: 0 });
    expect(mockTerminal).not.toHaveBeenCalled();
  });

  it('does not treat a live PID without a birth fingerprint as the original run', async () => {
    const db = dbWith([{
      id: 3,
      instance_id: 12,
      runtime_type: 'codex',
      state: 'running',
      opaque_handle: { kind: 'local-process', pid: 105, processGroupId: 105, hostname: 'api-1', processIdentity: null },
    }]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: () => true,
    })).resolves.toMatchObject({ alive: 0, quarantined: 1, lost: 0 });
    expect(mockTerminal).not.toHaveBeenCalled();
  });

  it('converges an active runtime row when the job runtime projection is already terminal', async () => {
    const processExists = jest.fn(() => false);
    const db = dbWith([{
      id: 43,
      instance_id: 9,
      runtime_type: 'codex',
      state: 'running',
      opaque_handle: { kind: 'local-process', pid: 102, processGroupId: 102, hostname: 'api-1' },
      runtime_ended_at: '2026-08-05 10:11:12',
      runtime_end_success: 1,
      runtime_end_error: null,
      job_status: 'done',
      session_key: 'codex:thread-9',
      run_id: 'codex:9',
    }]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists,
    })).resolves.toMatchObject({ converged: 1, lost: 0, errors: 0 });

    expect(processExists).toHaveBeenCalledWith(-102);
    expect(mockApplyRuntimeEnd).not.toHaveBeenCalled();
    expect(mockTerminal).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 9,
      state: 'succeeded',
      reason: 'job_runtime_projection_terminal',
      endedAt: '2026-08-05 10:11:12',
    }));
    expect(mockAppend).toHaveBeenCalledWith(db, expect.objectContaining({
      executionId: 41,
      kind: 'reconciled',
      state: 'succeeded',
      sessionId: 'codex:thread-9',
    }));
  });

  it('does not terminalize the durable execution when the workflow projection fails', async () => {
    const db = dbWith([{
      id: 44,
      instance_id: 10,
      runtime_type: 'claude-code',
      state: 'running',
      opaque_handle: { kind: 'local-process', pid: 103, processGroupId: 103, hostname: 'api-1' },
      runtime_ended_at: null,
      runtime_end_success: null,
      runtime_end_error: null,
      job_status: 'running',
      session_key: 'claude-code:session-10',
      run_id: 'claude-code:10',
    }]);
    let clock = 1_000;
    const options = {
      currentHostname: 'api-1',
      processExists: () => false,
      missingConfirmationMs: 1_000,
      now: () => clock,
    };

    await reconcileRuntimeExecutions(db, options);
    clock += 2_000;
    mockApplyRuntimeEnd.mockRejectedValueOnce(new Error('projection unavailable'));

    await expect(reconcileRuntimeExecutions(db, options)).resolves.toMatchObject({
      lost: 0,
      errors: 1,
    });
    expect(mockTerminal).not.toHaveBeenCalled();
  });

  it('respects a concurrent successful runtime projection instead of overwriting it as lost', async () => {
    const db = dbWith([{
      id: 45,
      instance_id: 11,
      runtime_type: 'codex',
      state: 'running',
      opaque_handle: { kind: 'local-process', pid: 104, processGroupId: 104, hostname: 'api-1' },
      runtime_ended_at: null,
      runtime_end_success: null,
      runtime_end_error: null,
      job_status: 'running',
      session_key: 'codex:thread-11',
      run_id: 'codex:11',
    }], {
      runtime_ended_at: '2026-08-05 12:00:00',
      runtime_end_success: 1,
      runtime_end_error: null,
      status: 'done',
    });
    let clock = 1_000;
    const options = {
      currentHostname: 'api-1',
      processExists: () => false,
      missingConfirmationMs: 1_000,
      now: () => clock,
    };
    await reconcileRuntimeExecutions(db, options);
    clock += 2_000;
    mockApplyRuntimeEnd.mockResolvedValueOnce({ changed: false });

    await expect(reconcileRuntimeExecutions(db, options)).resolves.toMatchObject({
      converged: 1,
      lost: 0,
      errors: 0,
    });
    expect(mockTerminal).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 11,
      state: 'succeeded',
      reason: 'job_runtime_projection_terminal',
    }));
    expect(mockMarkRuntimeEnded).not.toHaveBeenCalled();
  });

  it('quarantines a leaderless surviving group without signalling or terminalizing it', async () => {
    const terminateDurableProcess = jest.fn();
    const db = dbWith([{
      id: 46, instance_id: 12, runtime_type: 'claude-code', state: 'running',
      opaque_handle: {
        kind: 'local-process', pid: 106, processGroupId: 106,
        hostname: 'api-1', processIdentity: 'sha256:leader',
      },
      runtime_ended_at: '2026-08-05 12:30:00', runtime_end_success: 1,
      runtime_end_error: null, job_status: 'done',
      session_key: 'claude-code:12', run_id: 'claude-code:12',
    }]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: (target) => target < 0,
      terminateDurableProcess,
    })).resolves.toMatchObject({ quarantined: 1, converged: 0, lost: 0 });

    expect(terminateDurableProcess).not.toHaveBeenCalled();
    expect(mockTerminal).not.toHaveBeenCalled();
    expect(mockAppend).toHaveBeenCalledWith(db, expect.objectContaining({
      executionId: 46,
      kind: 'reconciled',
      data: expect.objectContaining({
        decision: 'quarantined',
        reason: 'leader_exited_process_group_survives',
        signal_attempted: false,
      }),
    }));
  });

  it('identity-safely stops a live terminal-projected group before convergence', async () => {
    const terminateDurableProcess = jest.fn(async () => ({
      attempted: true, ok: true, confirmed: true, status: 'signalled' as const,
    }));
    const db = dbWith([{
      id: 47, instance_id: 13, runtime_type: 'codex', state: 'running',
      opaque_handle: {
        kind: 'local-process', pid: 107, processGroupId: 107,
        hostname: 'api-1', processIdentity: 'sha256:leader',
      },
      runtime_ended_at: '2026-08-05 12:31:00', runtime_end_success: 1,
      runtime_end_error: null, job_status: 'done', session_key: 'codex:13', run_id: 'codex:13',
    }]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: () => true,
      processIdentity: () => 'sha256:leader',
      terminateDurableProcess,
    })).resolves.toMatchObject({ converged: 1, quarantined: 0 });
    expect(terminateDurableProcess).toHaveBeenCalledTimes(1);
    expect(mockTerminal).toHaveBeenCalledWith(db, expect.objectContaining({ state: 'succeeded' }));
  });

  it('quarantines when identity-safe group teardown cannot be confirmed', async () => {
    const db = dbWith([{
      id: 48, instance_id: 14, runtime_type: 'codex', state: 'running',
      opaque_handle: {
        kind: 'local-process', pid: 108, processGroupId: 108,
        hostname: 'api-1', processIdentity: 'sha256:leader',
      },
      runtime_ended_at: '2026-08-05 12:32:00', runtime_end_success: 1,
      runtime_end_error: null, job_status: 'done', session_key: 'codex:14', run_id: 'codex:14',
    }]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: () => true,
      processIdentity: () => 'sha256:leader',
      terminateDurableProcess: async () => ({
        attempted: true, ok: false, confirmed: false, status: 'failed',
      }),
    })).resolves.toMatchObject({ quarantined: 1, converged: 0 });
    expect(mockTerminal).not.toHaveBeenCalled();
  });

  it('repairs a running job from durable terminal truth after the process group is absent', async () => {
    const terminalRow = {
      id: 49,
      instance_id: 15,
      runtime_type: 'claude-code',
      state: 'succeeded',
      opaque_handle: {
        kind: 'local-process', pid: 109, processGroupId: 109,
        hostname: 'api-1', processIdentity: 'sha256:leader',
      },
      terminal_reason: 'completed',
      terminal_error: null,
      terminal_metadata: JSON.stringify({ exit_code: 0 }),
      ended_at: '2026-08-05 12:33:00',
      runtime_ended_at: null,
      runtime_end_success: null,
      runtime_end_error: null,
      job_status: 'running',
      session_key: 'claude-code:15',
      run_id: 'claude-code:15',
    };
    const db = dbWith([], undefined, [terminalRow]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: () => false,
    })).resolves.toMatchObject({ inspected: 1, converged: 1, errors: 0 });

    expect(mockApplyRuntimeEnd).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 15,
      runtimeName: 'claude-code',
      runtimeEndSource: 'runtime-reconciler',
      event: expect.objectContaining({
        success: true,
        reason: 'completed',
        endedAt: '2026-08-05 12:33:00',
        metadata: expect.objectContaining({
          exit_code: 0,
          projection: 'durable_terminal_execution',
          process_group_absent: true,
        }),
      }),
    }));
    expect(mockMarkRuntimeEnded).not.toHaveBeenCalled();
  });

  it('overwrites a partial nonterminal projection with authoritative durable terminal truth', async () => {
    const db = dbWith([], undefined, [{
      id: 55,
      instance_id: 21,
      runtime_type: 'codex',
      state: 'succeeded',
      opaque_handle: {
        kind: 'local-process', pid: 115, processGroupId: 115,
        hostname: 'api-1', processIdentity: 'sha256:leader',
      },
      terminal_reason: 'completed', terminal_error: null, terminal_metadata: {},
      ended_at: '2026-08-05 12:39:00',
      // A prior half-write recorded transport time but left a contradictory
      // success value and active workflow status.
      runtime_ended_at: '2026-08-05 12:38:59',
      runtime_end_success: 0,
      runtime_end_error: 'stale error',
      job_status: 'running',
      session_key: 'codex:thread-21', run_id: 'codex:21',
    }]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: () => false,
    })).resolves.toMatchObject({ converged: 1, errors: 0 });

    expect(mockApplyRuntimeEnd).not.toHaveBeenCalled();
    const run = (db as unknown as { run: jest.Mock }).run;
    expect(run).toHaveBeenCalledWith(
      expect.stringContaining('runtime_end_success = ?'),
      'done',
      '2026-08-05 12:39:00',
      '2026-08-05 12:39:00',
      '2026-08-05 12:39:00',
      1,
      null,
      21,
    );
    expect(mockMarkRuntimeEnded).not.toHaveBeenCalled();
  });

  it('identity-safely cleans a live group before repairing a durable terminal projection', async () => {
    const terminateDurableProcess = jest.fn(async () => ({
      attempted: true, ok: true, confirmed: true, status: 'signalled' as const,
    }));
    const db = dbWith([], undefined, [{
      id: 50,
      instance_id: 16,
      runtime_type: 'codex',
      state: 'failed',
      opaque_handle: {
        kind: 'local-process', pid: 110, processGroupId: 110,
        hostname: 'api-1', processIdentity: 'sha256:leader',
      },
      terminal_reason: 'error',
      terminal_error: 'codex exited 1',
      terminal_metadata: {},
      ended_at: '2026-08-05 12:34:00',
      runtime_ended_at: null,
      runtime_end_success: null,
      runtime_end_error: null,
      job_status: 'running',
      session_key: 'codex:thread-16',
      run_id: 'codex:16',
    }]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: () => true,
      processIdentity: () => 'sha256:leader',
      terminateDurableProcess,
    })).resolves.toMatchObject({ converged: 1, quarantined: 0, errors: 0 });

    expect(terminateDurableProcess).toHaveBeenCalledTimes(1);
    expect(mockApplyRuntimeEnd).toHaveBeenCalledWith(db, expect.objectContaining({
      event: expect.objectContaining({ success: false, error: 'codex exited 1' }),
    }));
  });

  it('quarantines a leaderless terminal process group instead of hiding it behind job completion', async () => {
    const terminateDurableProcess = jest.fn();
    const db = dbWith([], undefined, [{
      id: 51,
      instance_id: 17,
      runtime_type: 'claude-code',
      state: 'succeeded',
      opaque_handle: {
        kind: 'local-process', pid: 111, processGroupId: 111,
        hostname: 'api-1', processIdentity: 'sha256:leader',
      },
      terminal_reason: 'completed', terminal_error: null, terminal_metadata: {},
      ended_at: '2026-08-05 12:35:00', runtime_ended_at: null,
      runtime_end_success: null, runtime_end_error: null, job_status: 'running',
      session_key: 'claude-code:17', run_id: 'claude-code:17',
    }]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: (target) => target < 0,
      terminateDurableProcess,
    })).resolves.toMatchObject({ converged: 0, quarantined: 1 });

    expect(terminateDurableProcess).not.toHaveBeenCalled();
    expect(mockApplyRuntimeEnd).not.toHaveBeenCalled();
    expect(mockAppend).toHaveBeenCalledWith(db, expect.objectContaining({
      executionId: 51,
      data: expect.objectContaining({
        decision: 'quarantined',
        reason: 'terminal_projection_leader_exited_process_group_survives',
      }),
    }));
  });

  it('quarantines a live terminal PID when its birth identity cannot prove reuse', async () => {
    const db = dbWith([], undefined, [{
      id: 53,
      instance_id: 19,
      runtime_type: 'codex',
      state: 'succeeded',
      opaque_handle: {
        kind: 'local-process', pid: 113, processGroupId: 113,
        hostname: 'api-1', processIdentity: null,
      },
      terminal_reason: 'completed', terminal_error: null, terminal_metadata: {},
      ended_at: '2026-08-05 12:37:00', runtime_ended_at: null,
      runtime_end_success: null, runtime_end_error: null, job_status: 'running',
      session_key: 'codex:thread-19', run_id: 'codex:19',
    }]);

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: (target) => target > 0,
      processIdentity: () => null,
    })).resolves.toMatchObject({ converged: 0, quarantined: 1 });

    expect(mockApplyRuntimeEnd).not.toHaveBeenCalled();
    expect(mockAppend).toHaveBeenCalledWith(db, expect.objectContaining({
      executionId: 53,
      data: expect.objectContaining({
        reason: 'terminal_projection_live_pid_identity_unverified_outside_persisted_process_group',
      }),
    }));
  });

  it('contains a terminal process cleanup failure and retries on a later tick', async () => {
    const terminalRow = {
      id: 54,
      instance_id: 20,
      runtime_type: 'claude-code',
      state: 'failed',
      opaque_handle: {
        kind: 'local-process', pid: 114, processGroupId: 114,
        hostname: 'api-1', processIdentity: 'sha256:leader',
      },
      terminal_reason: 'error', terminal_error: 'failed', terminal_metadata: {},
      ended_at: '2026-08-05 12:38:00', runtime_ended_at: null,
      runtime_end_success: null, runtime_end_error: null, job_status: 'running',
      session_key: 'claude-code:20', run_id: 'claude-code:20',
    };
    const db = dbWith([], undefined, [terminalRow]);
    const terminateDurableProcess = jest.fn()
      .mockRejectedValueOnce(new Error('signal transport unavailable'))
      .mockResolvedValueOnce({
        attempted: true, ok: true, confirmed: true, status: 'signalled' as const,
      });
    const options = {
      currentHostname: 'api-1',
      processExists: () => true,
      processIdentity: () => 'sha256:leader',
      terminateDurableProcess,
    };

    await expect(reconcileRuntimeExecutions(db, options))
      .resolves.toMatchObject({ converged: 0, errors: 1 });
    await expect(reconcileRuntimeExecutions(db, options))
      .resolves.toMatchObject({ converged: 1, errors: 0 });

    expect(mockApplyRuntimeEnd).toHaveBeenCalledTimes(1);
  });

  it('reports a transient durable-terminal projection failure and retries it on the next tick', async () => {
    const terminalRow = {
      id: 52,
      instance_id: 18,
      runtime_type: 'codex',
      state: 'failed',
      opaque_handle: {
        kind: 'local-process', pid: 112, processGroupId: 112,
        hostname: 'api-1', processIdentity: 'sha256:leader',
      },
      terminal_reason: 'error', terminal_error: 'boom', terminal_metadata: {},
      ended_at: '2026-08-05 12:36:00', runtime_ended_at: null,
      runtime_end_success: null, runtime_end_error: null, job_status: 'running',
      session_key: 'codex:thread-18', run_id: 'codex:18',
    };
    const db = dbWith([], undefined, [terminalRow]);
    mockApplyRuntimeEnd.mockRejectedValueOnce(new Error('projection temporarily unavailable'));

    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: () => false,
    })).resolves.toMatchObject({ converged: 0, errors: 1 });
    await expect(reconcileRuntimeExecutions(db, {
      currentHostname: 'api-1',
      processExists: () => false,
    })).resolves.toMatchObject({ converged: 1, errors: 0 });

    expect(mockApplyRuntimeEnd).toHaveBeenCalledTimes(2);
  });
});
