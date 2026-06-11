import Database from 'better-sqlite3';
import { OpenClawRuntime } from './OpenClawRuntime';
import { recordRunCheckIn } from '../domains/runs/observability';
import { markTaskNeedsAttentionForMissingSemanticHandoff } from '../domains/runs/lifecycleHandoff';
import { applyConfiguredRuntimeFailedEvent } from '../domains/runs/runtimeFailureEvent';
import { evaluateOpenClawInstanceSessionState } from '../domains/runs/openclawSessionState';
import { scheduleEndedActiveInstanceLinkageCleanup } from '../lib/taskLifecycle';
import { ensureCanonicalSessionForInstance } from '../lib/canonicalSessions';

jest.mock('../db/client', () => ({
  getDb: jest.fn(),
}));

jest.mock('../domains/runs/observability', () => ({
  recordRunCheckIn: jest.fn(),
}));

jest.mock('../domains/runs/runtimeFailureEvent', () => ({
  applyConfiguredRuntimeFailedEvent: jest.fn(),
}));

jest.mock('../lib/taskLifecycle', () => ({
  scheduleEndedActiveInstanceLinkageCleanup: jest.fn(),
}));

jest.mock('../lib/canonicalSessions', () => ({
  ensureCanonicalSessionForInstance: jest.fn(async () => null),
}));

jest.mock('../domains/runs/lifecycleHandoff', () => ({
  taskRequiresSemanticOutcome: jest.fn(() => true),
  markTaskNeedsAttentionForMissingSemanticHandoff: jest.fn(),
}));

jest.mock('../domains/runs/openclawSessionState', () => ({
  OPENCLAW_TERMINAL_QUIESCENCE_MS: 180000,
  evaluateOpenClawInstanceSessionState: jest.fn(() => ({
    state: null,
    decision: null,
    sessionFile: null,
    backfillReason: 'session_file_not_found',
  })),
}));

describe('OpenClawRuntime terminal failure handling', () => {
  let db: Pick<Database.Database, 'prepare'>;

  beforeEach(() => {
    jest.clearAllMocks();
    const { taskRequiresSemanticOutcome } = jest.requireMock('../domains/runs/lifecycleHandoff') as { taskRequiresSemanticOutcome: jest.Mock };
    taskRequiresSemanticOutcome.mockReturnValue(true);
    (evaluateOpenClawInstanceSessionState as jest.Mock).mockReturnValue({
      state: null,
      decision: null,
      sessionFile: null,
      backfillReason: 'session_file_not_found',
    });

    const statements = new Map<string, { get?: jest.Mock; run?: jest.Mock }>([
      [
        `
        SELECT status, lifecycle_outcome_posted_at, task_outcome, task_id, session_key
        FROM job_instances
        WHERE id = ?
      `,
        {
          get: jest.fn().mockReturnValue({
            status: 'running',
            lifecycle_outcome_posted_at: null,
            task_outcome: null,
            task_id: 383,
            session_key: 'agent:test:hook:atlas:jobrun:1757',
          }),
        },
      ],
      [
        `
    SELECT content
    FROM chat_messages
    WHERE instance_id = ?
      AND role = 'assistant'
    ORDER BY timestamp DESC
    LIMIT 8
  `,
        {
          all: jest.fn?.(),
        } as never,
      ],
      [
        `
        UPDATE job_instances
        SET status = ?,
            started_at = COALESCE(started_at, ?),
            completed_at = COALESCE(completed_at, ?),
            runtime_ended_at = COALESCE(runtime_ended_at, ?),
            runtime_end_success = COALESCE(runtime_end_success, ?),
            runtime_end_error = COALESCE(?, runtime_end_error),
            runtime_end_source = COALESCE(?, runtime_end_source),
            token_input = COALESCE(?, token_input),
            token_output = COALESCE(?, token_output),
            token_total = COALESCE(?, token_total)
        WHERE id = ?
          AND status IN ('running', 'dispatched')
          AND runtime_ended_at IS NULL
      `,
        {
          run: jest.fn().mockReturnValue({ changes: 1 }),
        },
      ],
      [
        `
        INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta)
        SELECT ?, agent_id, id, 'system', ?, ?, 'turn_end', ?
        FROM job_instances
        WHERE id = ?
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          timestamp = excluded.timestamp,
          event_type = excluded.event_type,
          event_meta = excluded.event_meta
      `,
        {
          run: jest.fn(),
        },
      ],
      [
        `
        UPDATE job_instances
        SET response = json_set(COALESCE(response, '{}'), '$.runtimeEnd', json(?))
        WHERE id = ?
      `,
        {
          run: jest.fn(),
        },
      ],
      [
        `
          SELECT ji.task_id, ji.agent_id,
                 t.status AS task_status,
                 t.project_id,
                 t.agent_id AS task_agent_id,
                 t.task_type,
                 t.sprint_id,
                 s.sprint_type,
                 t.review_branch,
                 t.review_commit,
                 t.review_url,
                 t.qa_verified_commit,
                 t.qa_tested_url,
                 t.merged_commit,
                 t.deployed_commit,
                 t.deploy_target,
                 t.deployed_at
          FROM job_instances ji
          LEFT JOIN tasks t ON t.id = ji.task_id
          LEFT JOIN sprints s ON s.id = t.sprint_id
          WHERE ji.id = ?
        `,
        {
          get: jest.fn().mockReturnValue({
            task_id: 383,
            agent_id: 42,
            task_status: 'review',
            project_id: 86,
            task_agent_id: 42,
            task_type: null,
            sprint_id: 9,
            sprint_type: 'enhancement',
            review_branch: 'cinder-backend/task-403-prevent-outcome-less-run-completions-fro',
            review_commit: '27bf9e9fb2f32af10d3f8cbd067f76a59b535240',
            review_url: 'http://localhost:3510/tasks/403',
            qa_verified_commit: '27bf9e9fb2f32af10d3f8cbd067f76a59b535240',
            qa_tested_url: 'http://localhost:3510/tasks/403',
            merged_commit: null,
            deployed_commit: null,
            deploy_target: null,
            deployed_at: null,
          }),
        },
      ],
    ]);

    db = {
      prepare: jest.fn((sql: string) => {
        const stmt = statements.get(sql);
        if (!stmt) throw new Error(`Unexpected SQL: ${sql}`);
        return stmt;
      }),
    } as unknown as Pick<Database.Database, 'prepare'>;

    const { getDb } = jest.requireMock('../db/client') as { getDb: jest.Mock };
    getDb.mockReturnValue(db);

    (db.prepare(`
    SELECT content
    FROM chat_messages
    WHERE instance_id = ?
      AND role = 'assistant'
    ORDER BY timestamp DESC
    LIMIT 8
  `) as unknown as { all: jest.Mock }).all.mockReturnValue([]);
  });

  it('quarantines missing lifecycle handoff after runtime success on lifecycle-managed workflow states', async () => {
    const runtime = new OpenClawRuntime();
    const handleTurnEnd = (runtime as unknown as {
      handleTurnEnd: (instanceId: number, event: { success: boolean; reason: string; sessionKey: string; endedAt: string; type: string }, onRuntimeEnd?: jest.Mock) => Promise<void>;
    }).handleTurnEnd.bind(runtime);

    await handleTurnEnd(1757, {
      type: 'runEnded',
      success: true,
      reason: 'completed',
      sessionKey: 'agent:test:hook:atlas:jobrun:1757',
      endedAt: new Date().toISOString(),
    });

    expect(recordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 1757,
      stage: 'completion',
      runtimeEndSuccess: true,
      outcome: 'completed',
      summary: 'OpenClaw runtime ended without required lifecycle outcome',
    }));
    expect(applyConfiguredRuntimeFailedEvent).not.toHaveBeenCalled();
    expect(scheduleEndedActiveInstanceLinkageCleanup).toHaveBeenCalledWith(db, 383, 1757, {
      changedBy: 'task_lifecycle',
    });
    expect(ensureCanonicalSessionForInstance).toHaveBeenCalledWith(1757, {
      forceIngest: true,
      sessionKey: 'agent:test:hook:atlas:jobrun:1757',
    });
    expect(markTaskNeedsAttentionForMissingSemanticHandoff).toHaveBeenCalledWith(db, expect.objectContaining({
      taskId: 383,
      instanceId: 1757,
      workflowPhase: 'review',
      priorTaskStatus: 'review',
      reviewQaDeployEvidenceRecorded: 'yes',
    }));
  });

  it('persists token usage from OpenClaw terminal metadata', async () => {
    const runtime = new OpenClawRuntime();
    const handleTurnEnd = (runtime as unknown as {
      handleTurnEnd: (instanceId: number, event: { success: boolean; reason: string; sessionKey: string; endedAt: string; type: string; metadata?: Record<string, unknown> }, onRuntimeEnd?: jest.Mock) => Promise<void>;
    }).handleTurnEnd.bind(runtime);

    await handleTurnEnd(1757, {
      type: 'runEnded',
      success: true,
      reason: 'completed',
      sessionKey: 'agent:test:hook:atlas:jobrun:1757',
      endedAt: new Date().toISOString(),
      metadata: {
        usage: {
          input_tokens: 101,
          output_tokens: 202,
          total_tokens: 303,
        },
      },
    });

    const runtimeStateUpdate = db.prepare(`
        UPDATE job_instances
        SET status = ?,
            started_at = COALESCE(started_at, ?),
            completed_at = COALESCE(completed_at, ?),
            runtime_ended_at = COALESCE(runtime_ended_at, ?),
            runtime_end_success = COALESCE(runtime_end_success, ?),
            runtime_end_error = COALESCE(?, runtime_end_error),
            runtime_end_source = COALESCE(?, runtime_end_source),
            token_input = COALESCE(?, token_input),
            token_output = COALESCE(?, token_output),
            token_total = COALESCE(?, token_total)
        WHERE id = ?
          AND status IN ('running', 'dispatched')
          AND runtime_ended_at IS NULL
      `) as unknown as { run: jest.Mock };
    expect(runtimeStateUpdate.run).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      1,
      null,
      'instance_complete',
      101,
      202,
      303,
      1757,
    );
  });

  it('posts a failed task outcome when provider-limit failure is detected behind a successful terminal event', async () => {
    const { taskRequiresSemanticOutcome } = jest.requireMock('../domains/runs/lifecycleHandoff') as { taskRequiresSemanticOutcome: jest.Mock };
    taskRequiresSemanticOutcome.mockReturnValue(false);
    (db.prepare(`
    SELECT content
    FROM chat_messages
    WHERE instance_id = ?
      AND role = 'assistant'
    ORDER BY timestamp DESC
    LIMIT 8
  `) as unknown as { all: jest.Mock }).all.mockReturnValue([
      { content: 'Agent failed before reply: provider rate limit exceeded (429 too many requests)' },
    ]);

    const runtime = new OpenClawRuntime();
    const handleTurnEnd = (runtime as unknown as {
      handleTurnEnd: (instanceId: number, event: { success: boolean; reason: string; sessionKey: string; endedAt: string; type: string }, onRuntimeEnd?: jest.Mock) => Promise<void>;
    }).handleTurnEnd.bind(runtime);

    await handleTurnEnd(1757, {
      type: 'runEnded',
      success: true,
      reason: 'completed',
      sessionKey: 'agent:test:hook:atlas:jobrun:1757',
      endedAt: new Date().toISOString(),
    });

    expect(recordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 1757,
      stage: 'completion',
      runtimeEndSuccess: false,
      outcome: 'failed',
      summary: expect.stringContaining('rate limit exceeded'),
    }));
    expect(applyConfiguredRuntimeFailedEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      taskId: 383,
      instanceId: 1757,
      projectId: 86,
      agentId: 42,
      runtimeEndError: expect.stringContaining('rate limit exceeded'),
    }));
    expect(scheduleEndedActiveInstanceLinkageCleanup).toHaveBeenCalledWith(db, 383, 1757, {
      changedBy: 'task_lifecycle',
    });
  });

  it('marks an immediate trajectory promptError terminal as failed with identifiers', async () => {
    const { taskRequiresSemanticOutcome } = jest.requireMock('../domains/runs/lifecycleHandoff') as { taskRequiresSemanticOutcome: jest.Mock };
    taskRequiresSemanticOutcome.mockReturnValue(false);
    (evaluateOpenClawInstanceSessionState as jest.Mock).mockReturnValue({
      state: {
        kind: 'trajectory_prompt_error',
        lastEventAt: null,
        trajectoryEndedAt: '2026-06-02T23:23:57.211Z',
        trajectorySessionId: '8c91a2de-8f6f-42ea-a6d0-6f1b1f55c101',
        trajectoryRunId: 'e5d90133-6f86-4430-8f09-83fd0c18f605',
      },
      decision: {
        terminal: true,
        success: false,
        reason: 'error',
        error: "The model 'gpt-image-2' does not exist.",
        metadata: {
          trajectory_terminal_authority: true,
          trajectory_session_id: '8c91a2de-8f6f-42ea-a6d0-6f1b1f55c101',
          trajectory_run_id: 'e5d90133-6f86-4430-8f09-83fd0c18f605',
        },
      },
      sessionFile: '/tmp/8c91a2de-8f6f-42ea-a6d0-6f1b1f55c101.jsonl',
      backfillReason: null,
    });

    const runtime = new OpenClawRuntime();
    const handleTurnEnd = (runtime as unknown as {
      handleTurnEnd: (instanceId: number, event: { success: boolean; reason: string; sessionKey: string; endedAt: string; type: string }, onRuntimeEnd?: jest.Mock) => Promise<void>;
    }).handleTurnEnd.bind(runtime);

    await handleTurnEnd(1757, {
      type: 'runEnded',
      success: true,
      reason: 'completed',
      sessionKey: 'agent:anchor-devops:run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
      endedAt: '2026-06-02T23:23:57.211Z',
    });

    expect(recordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 1757,
      stage: 'completion',
      runtimeEndSuccess: false,
      outcome: 'failed',
      summary: expect.stringContaining("gpt-image-2"),
    }));
    expect(applyConfiguredRuntimeFailedEvent).toHaveBeenCalledWith(db, expect.objectContaining({
      taskId: 383,
      instanceId: 1757,
      runtimeEndError: "The model 'gpt-image-2' does not exist.",
    }));
    const responseUpdate = db.prepare(`
        UPDATE job_instances
        SET response = json_set(COALESCE(response, '{}'), '$.runtimeEnd', json(?))
        WHERE id = ?
      `) as unknown as { run: jest.Mock };
    expect(JSON.parse(responseUpdate.run.mock.calls[0][0])).toMatchObject({
      success: false,
      error: "The model 'gpt-image-2' does not exist.",
      metadata: expect.objectContaining({
        trajectory_terminal_authority: true,
        trajectory_session_id: '8c91a2de-8f6f-42ea-a6d0-6f1b1f55c101',
        trajectory_run_id: 'e5d90133-6f86-4430-8f09-83fd0c18f605',
      }),
    });
  });

  it('defers gateway runtime end while raw JSONL shows active tool use', async () => {
    jest.useFakeTimers();
    (evaluateOpenClawInstanceSessionState as jest.Mock).mockReturnValue({
      state: {
        kind: 'active_tool_use',
        lastEventAt: '2026-05-14T00:54:58.000Z',
      },
      decision: {
        terminal: false,
        success: false,
        reason: 'timeout',
        deferReason: 'openclaw_tool_use_still_active',
        retryAfterMs: 120000,
        metadata: {},
      },
      sessionFile: '/tmp/session.jsonl',
      backfillReason: null,
    });

    try {
      const runtime = new OpenClawRuntime();
      const handleTurnEnd = (runtime as unknown as {
        handleTurnEnd: (instanceId: number, event: { success: boolean; reason: string; sessionKey: string; endedAt: string; type: string }, onRuntimeEnd?: jest.Mock) => Promise<void>;
      }).handleTurnEnd.bind(runtime);

      await handleTurnEnd(1757, {
        type: 'runEnded',
        success: false,
        reason: 'error',
        sessionKey: 'agent:test:hook:atlas:jobrun:1757',
        endedAt: '2026-05-14T00:46:30.000Z',
      });

      expect(recordRunCheckIn).not.toHaveBeenCalled();
      expect(markTaskNeedsAttentionForMissingSemanticHandoff).not.toHaveBeenCalled();
      expect(applyConfiguredRuntimeFailedEvent).not.toHaveBeenCalled();
    } finally {
      jest.clearAllTimers();
      jest.useRealTimers();
    }
  });

  it('lets raw final_answer override a gateway error terminal event', async () => {
    (evaluateOpenClawInstanceSessionState as jest.Mock).mockReturnValue({
      state: {
        kind: 'final_answer',
        lastEventAt: '2026-05-14T00:56:00.000Z',
      },
      decision: {
        terminal: true,
        success: true,
        reason: 'completed',
        metadata: { raw_session_state: 'final_answer' },
      },
      sessionFile: '/tmp/session.jsonl',
      backfillReason: null,
    });

    const runtime = new OpenClawRuntime();
    const handleTurnEnd = (runtime as unknown as {
      handleTurnEnd: (instanceId: number, event: { success: boolean; reason: string; sessionKey: string; endedAt: string; type: string }, onRuntimeEnd?: jest.Mock) => Promise<void>;
    }).handleTurnEnd.bind(runtime);

    await handleTurnEnd(1757, {
      type: 'runEnded',
      success: false,
      reason: 'error',
      sessionKey: 'agent:test:hook:atlas:jobrun:1757',
      endedAt: '2026-05-14T00:46:30.000Z',
    });

    expect(recordRunCheckIn).toHaveBeenCalledWith(db, expect.objectContaining({
      instanceId: 1757,
      stage: 'completion',
      runtimeEndSuccess: true,
      outcome: 'completed',
      summary: 'OpenClaw runtime ended without required lifecycle outcome',
    }));
    expect(markTaskNeedsAttentionForMissingSemanticHandoff).toHaveBeenCalledWith(db, expect.objectContaining({
      runtimeEnd: expect.objectContaining({
        success: true,
        endedAt: '2026-05-14T00:56:00.000Z',
      }),
    }));
  });
});
