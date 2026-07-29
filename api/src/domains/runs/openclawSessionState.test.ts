import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  decideOpenClawSessionTerminal,
  evaluateOpenClawInstanceSessionState,
  evaluateOpenClawSessionFile,
} from './openclawSessionState';

function writeJsonl(lines: Array<Record<string, unknown>>): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-session-state-'));
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return { dir, file };
}

function writeTrajectoryForSession(sessionFile: string, lines: Array<Record<string, unknown>>): string {
  const trajectoryFile = sessionFile.replace(/\.jsonl$/, '.trajectory.jsonl');
  fs.writeFileSync(trajectoryFile, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return trajectoryFile;
}

describe('OpenClaw raw session state', () => {
  const now = new Date('2026-05-14T12:05:00.000Z');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('treats Codex stop plus final_answer signature as terminal success', () => {
    const { dir, file } = writeJsonl([
      {
        type: 'message',
        timestamp: '2026-05-14T12:04:59.000Z',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          provider: 'openai-codex',
          api: 'openai-codex-responses',
          content: [
            {
              type: 'text',
              text: 'Done.',
              textSignature: JSON.stringify({ phase: 'final_answer' }),
            },
          ],
        },
      },
    ]);

    try {
      const state = evaluateOpenClawSessionFile(file, now);
      const decision = decideOpenClawSessionTerminal(state);

      expect(state.kind).toBe('final_answer');
      expect(state.lastAssistantPhases).toEqual(['final_answer']);
      expect(decision).toMatchObject({ terminal: true, success: true, reason: 'completed' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('defers terminal evaluation while a durable run session is not indexed', async () => {
    const db = new Database(':memory:');
    const openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-session-state-'));
    try {
      await db.exec(`
        CREATE TABLE agents (
          id INTEGER PRIMARY KEY,
          name TEXT,
          runtime_type TEXT,
          session_key TEXT,
          openclaw_agent_id TEXT
        );
        CREATE TABLE job_instances (
          id INTEGER PRIMARY KEY,
          agent_id INTEGER,
          task_id INTEGER,
          session_key TEXT,
          durable_run_id TEXT
        );
      `);
      await db.run(`
        INSERT INTO agents (id, name, runtime_type, session_key, openclaw_agent_id)
        VALUES (94, 'Cinder', 'openclaw', 'agent:cinder-backend:main', 'cinder-backend')
      `);
      await db.run(`
        INSERT INTO job_instances (id, agent_id, task_id, session_key, durable_run_id)
        VALUES (77, 94, 491, 'run:77:current-run', 'current-run')
      `);

      const sessionsDir = path.join(openclawHome, 'agents', 'cinder-backend', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const oldSessionFile = path.join(sessionsDir, 'old-77.jsonl');
      fs.writeFileSync(oldSessionFile, `${JSON.stringify({
        type: 'message',
        timestamp: '2026-05-13T10:00:00.000Z',
        message: { role: 'assistant', content: [{ type: 'text', text: 'old run' }] },
      })}\n`);
      fs.writeFileSync(
        path.join(sessionsDir, 'sessions.json'),
        JSON.stringify({
          'agent:cinder-backend:run:77': {
            sessionId: 'old-77',
            sessionFile: oldSessionFile,
            updatedAt: Date.parse('2026-05-13T10:00:00.000Z'),
          },
        }),
      );

      const result = await evaluateOpenClawInstanceSessionState(db, 77, {
              openclawHome,
              now,
              terminalQuiescenceMs: 5000,
            });

      expect(result).toMatchObject({
        state: null,
        sessionFile: null,
        backfillReason: 'durable_session_file_not_found',
        decision: {
          terminal: false,
          success: false,
          reason: 'completed',
          deferReason: 'openclaw_durable_session_not_indexed',
          retryAfterMs: 5000,
        },
      });
    } finally {
      db.close();
      fs.rmSync(openclawHome, { recursive: true, force: true });
    }
  });

  it('requires quiescence before treating unsigned provider stop as terminal', () => {
    const { dir, file } = writeJsonl([
      {
        type: 'message',
        timestamp: '2026-05-14T12:03:30.000Z',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          provider: 'anthropic',
          api: 'anthropic-messages',
          content: [{ type: 'text', text: 'Completed the review.' }],
        },
      },
    ]);

    try {
      const early = evaluateOpenClawSessionFile(file, new Date('2026-05-14T12:05:00.000Z'));
      expect(early.kind).toBe('stopped');
      expect(decideOpenClawSessionTerminal(early).terminal).toBe(false);

      const quiet = evaluateOpenClawSessionFile(file, new Date('2026-05-14T12:07:00.000Z'));
      expect(decideOpenClawSessionTerminal(quiet)).toMatchObject({
        terminal: true,
        success: true,
        reason: 'completed',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats latest toolUse as active until the tool-use timeout', () => {
    const { dir, file } = writeJsonl([
      {
        type: 'message',
        timestamp: '2026-05-14T12:04:00.000Z',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'explore_codebase',
              arguments: { query: 'OpenClaw runtime' },
            },
          ],
        },
      },
    ]);

    try {
      const active = evaluateOpenClawSessionFile(file, new Date('2026-05-14T12:05:00.000Z'));
      expect(active.kind).toBe('active_tool_use');
      expect(decideOpenClawSessionTerminal(active)).toMatchObject({
        terminal: false,
        deferReason: 'openclaw_tool_use_still_active',
      });

      const timedOut = evaluateOpenClawSessionFile(file, new Date('2026-05-14T12:08:01.000Z'));
      const decision = decideOpenClawSessionTerminal(timedOut);
      expect(decision).toMatchObject({ terminal: true, success: false, reason: 'timeout' });
      expect(decision.error).toContain('explore_codebase');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('classifies prompt-error plus aborted assistant as failed after quiescence', () => {
    const { dir, file } = writeJsonl([
      {
        type: 'custom',
        customType: 'openclaw:prompt-error',
        timestamp: '2026-05-14T12:00:00.000Z',
        data: { error: 'This operation was aborted' },
      },
      {
        type: 'message',
        timestamp: '2026-05-14T12:00:01.000Z',
        message: {
          role: 'assistant',
          stopReason: 'aborted',
          errorMessage: 'Request was aborted',
          content: [],
        },
      },
    ]);

    try {
      const state = evaluateOpenClawSessionFile(file, now);
      const decision = decideOpenClawSessionTerminal(state);

      expect(state.kind).toBe('assistant_aborted');
      expect(decision).toMatchObject({ terminal: true, success: false, reason: 'aborted' });
      expect(decision.error).toContain('aborted');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats trajectory session.ended promptError as immediate terminal failure', () => {
    const { dir, file } = writeJsonl([]);
    const trajectoryFile = file.replace(/\.jsonl$/, '.trajectory.jsonl');
    fs.writeFileSync(trajectoryFile, `${JSON.stringify({
      traceSchema: 'openclaw-trajectory',
      traceId: 'trace-123',
      type: 'session.ended',
      ts: '2026-05-14T12:04:59.000Z',
      sessionId: 'session-123',
      sessionKey: 'agent:anchor-devops:run:4581:durable',
      runId: 'run-123',
      provider: 'openai-codex',
      modelId: 'gpt-5.5',
      data: {
        status: 'error',
        promptError: JSON.stringify({
          type: 'error',
          error: {
            type: 'image_generation_user_error',
            code: 'invalid_value',
            message: "The model 'gpt-image-2' does not exist.",
            param: 'tools',
          },
          status: 400,
        }, null, 2),
      },
    })}
`);

    try {
      const state = evaluateOpenClawSessionFile(file, now);
      const decision = decideOpenClawSessionTerminal(state);

      expect(state.kind).toBe('trajectory_prompt_error');
      expect(state.trajectoryFile).toBe(trajectoryFile);
      expect(state.trajectorySessionId).toBe('session-123');
      expect(state.trajectoryRunId).toBe('run-123');
      expect(decision).toMatchObject({ terminal: true, success: false, reason: 'error' });
      expect(decision.error).toContain("gpt-image-2");
      expect(decision.metadata).toMatchObject({
        trajectory_terminal_authority: true,
        trajectory_session_id: 'session-123',
        trajectory_run_id: 'run-123',
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a later final answer supersede an earlier prompt error', () => {
    const { dir, file } = writeJsonl([
      {
        type: 'custom',
        customType: 'openclaw:prompt-error',
        timestamp: '2026-05-14T12:00:00.000Z',
        data: { error: 'transient provider issue' },
      },
      {
        type: 'message',
        timestamp: '2026-05-14T12:04:59.000Z',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [
            {
              type: 'text',
              text: 'Recovered and finished.',
              textSignature: JSON.stringify({ phase: 'final_answer' }),
            },
          ],
        },
      },
    ]);

    try {
      const state = evaluateOpenClawSessionFile(file, now);
      expect(state.kind).toBe('final_answer');
      expect(decideOpenClawSessionTerminal(state)).toMatchObject({
        terminal: true,
        success: true,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats adjacent trajectory session.ended status=error as terminal failure for a prompt-only session', () => {
    const { dir, file } = writeJsonl([
      {
        type: 'message',
        timestamp: '2026-06-02T23:23:57.214Z',
        message: {
          role: 'user',
          content: 'Dispatch prompt',
        },
      },
    ]);
    const trajectoryFile = writeTrajectoryForSession(file, [
      {
        traceSchema: 'openclaw-trajectory',
        type: 'session.ended',
        ts: '2026-06-02T23:23:57.211Z',
        data: {
          status: 'error',
          promptError: JSON.stringify({
            type: 'error',
            error: { message: "The model 'gpt-image-2' does not exist." },
            status: 400,
          }),
        },
      },
    ]);

    try {
      const state = evaluateOpenClawSessionFile(file, new Date('2026-06-02T23:24:00.000Z'));
      const decision = decideOpenClawSessionTerminal(state);

      expect(state).toMatchObject({
        kind: 'trajectory_prompt_error',
        trajectoryFile,
        trajectoryStatus: 'error',
        trajectoryEndedAt: '2026-06-02T23:23:57.211Z',
        trajectoryErrorMessage: "The model 'gpt-image-2' does not exist.",
      });
      expect(decision).toMatchObject({
        terminal: true,
        success: false,
        reason: 'error',
        error: "The model 'gpt-image-2' does not exist.",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
