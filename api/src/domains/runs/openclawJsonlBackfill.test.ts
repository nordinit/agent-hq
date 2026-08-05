import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  backfillOpenClawJsonlTranscript,
  isRunChatTranscriptSparse,
} from './openclawJsonlBackfill';
import { type Db } from "../../db/adapter/types";
import { setupTestDb, teardownTestDb } from "../../db/testDb";

/**
 * The run the backfill is pointed at.
 *
 * The real schema carries genuine foreign keys the hand-written fixture did not: the
 * instance's task_id lands in instance_artifacts.task_id, so task 491 has to exist, and a
 * task needs a sprint which needs a project. They are seeded for referential integrity only —
 * nothing in these tests reads them.
 */
async function seedRun(db: Db): Promise<void> {
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (11, 'Backfill Tenant', 'backfill', 1)`);
  const project = await db.run(`INSERT INTO projects (tenant_id, name) VALUES (11, 'Backfill Project')`);
  const sprint = await db.run(
    `INSERT INTO sprints (tenant_id, project_id, name) VALUES (11, ?, 'Backfill Sprint')`,
    project.lastInsertId,
  );
  await db.run(
    `INSERT INTO tasks (id, tenant_id, title, sprint_id) VALUES (491, 11, 'Backfilled run', ?)`,
    sprint.lastInsertId,
  );
  await db.run(`
    INSERT INTO agents (id, tenant_id, name, runtime_type, session_key, openclaw_agent_id)
    VALUES (94, 11, 'Cinder', 'openclaw', 'agent:cinder-backend:main', 'cinder-backend')
  `);
  await db.run(`
    INSERT INTO job_instances (id, tenant_id, agent_id, task_id, session_key, durable_run_id)
    VALUES (77, 11, 94, 491, 'run:77:current-run', 'current-run')
  `);
}

function writeSession(openclawHome: string, lines: Array<Record<string, unknown>>): string {
  const sessionsDir = path.join(openclawHome, 'agents', 'cinder-backend', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, 'session-77.jsonl');
  fs.writeFileSync(
    path.join(sessionsDir, 'sessions.json'),
    JSON.stringify({
      'agent:cinder-backend:run:77': {
        sessionId: 'session-77',
        sessionFile,
        updatedAt: Date.parse('2026-05-13T10:58:45.000Z'),
      },
      'agent:cinder-backend:run:77:current-run': {
        sessionId: 'session-77',
        sessionFile,
        updatedAt: Date.parse('2026-05-13T10:59:45.000Z'),
      },
    }),
  );
  fs.writeFileSync(sessionFile, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return sessionFile;
}

function writeIndexedTrajectoryOnly(openclawHome: string, lines: Array<Record<string, unknown>>): {
  sessionFile: string;
  trajectoryFile: string;
} {
  const sessionsDir = path.join(openclawHome, 'agents', 'cinder-backend', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, 'live-session.jsonl');
  const trajectoryFile = path.join(sessionsDir, 'live-session.trajectory.jsonl');
  fs.writeFileSync(
    path.join(sessionsDir, 'sessions.json'),
    JSON.stringify({
      'agent:cinder-backend:run:77:current-run': {
        sessionId: 'live-session',
        sessionFile,
        updatedAt: Date.parse('2026-05-13T10:59:45.000Z'),
      },
    }),
  );
  fs.writeFileSync(trajectoryFile, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
  return { sessionFile, trajectoryFile };
}

describe('OpenClaw JSONL transcript backfill', () => {
  let db: Db;
  let openclawHome: string;

  beforeEach(async () => {
    db = await setupTestDb();
    await seedRun(db);
    openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-openclaw-'));
  });

  it('does not import a historical session for the same numeric instance when durable run id differs', async () => {
    const sessionsDir = path.join(openclawHome, 'agents', 'cinder-backend', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const oldSessionFile = path.join(sessionsDir, 'old-77.jsonl');
    const currentSessionFile = path.join(sessionsDir, 'current-77.jsonl');
    fs.writeFileSync(oldSessionFile, `${JSON.stringify({
      type: 'message',
      id: 'old',
      timestamp: '2026-05-13T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'old restored DB history' }] },
    })}\n`);
    fs.writeFileSync(currentSessionFile, `${JSON.stringify({
      type: 'message',
      id: 'current',
      timestamp: '2026-05-13T11:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'current run history' }] },
    })}\n`);
    fs.writeFileSync(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:cinder-backend:run:77:old-run': { sessionId: 'old-77', sessionFile: oldSessionFile, updatedAt: Date.parse('2026-05-13T10:00:00.000Z') },
        'agent:cinder-backend:run:77:current-run': { sessionId: 'current-77', sessionFile: currentSessionFile, updatedAt: Date.parse('2026-05-13T11:00:00.000Z') },
      }),
    );

    const result = await backfillOpenClawJsonlTranscript(db, 77, { openclawHome, forceFull: true });

    expect(result.persistedEvents).toBe(1);
    const rows = await db.all(`
      SELECT tenant_id, durable_run_id, content
      FROM chat_messages
      WHERE instance_id = 77
    `) as Array<{ tenant_id: number; durable_run_id: string | null; content: string }>;
    expect(rows).toEqual([{ tenant_id: 11, durable_run_id: 'current-run', content: 'current run history' }]);
  });

  it('does not fall back to legacy numeric run sessions before the durable run is indexed', async () => {
    const sessionsDir = path.join(openclawHome, 'agents', 'cinder-backend', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const oldSessionFile = path.join(sessionsDir, 'old-77.jsonl');
    fs.writeFileSync(oldSessionFile, `${JSON.stringify({
      type: 'message',
      id: 'old',
      timestamp: '2026-05-13T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'old restored DB history' }] },
    })}\n`);
    fs.writeFileSync(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:cinder-backend:run:77': {
          sessionId: 'old-77',
          sessionFile: oldSessionFile,
          updatedAt: Date.parse('2026-05-13T10:00:00.000Z'),
        },
        'agent:cinder-backend:hook:atlas:jobrun:77': {
          sessionId: 'old-77',
          sessionFile: oldSessionFile,
          updatedAt: Date.parse('2026-05-13T10:00:00.000Z'),
        },
      }),
    );

    const result = await backfillOpenClawJsonlTranscript(db, 77, { openclawHome, forceFull: true });

    expect(result).toMatchObject({
      attempted: true,
      reason: 'durable_session_file_not_found',
      sessionFile: null,
      persistedEvents: 0,
    });
    expect(await db.get(`SELECT COUNT(*) AS count FROM chat_messages`)).toEqual({ count: 0 });
  });

  it('requires the new durable run id format instead of importing legacy-only session keys', async () => {
    await db.run(`
      UPDATE job_instances
      SET session_key = 'run:77',
          durable_run_id = NULL
      WHERE id = 77
    `);

    const sessionsDir = path.join(openclawHome, 'agents', 'cinder-backend', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const oldSessionFile = path.join(sessionsDir, 'old-77.jsonl');
    fs.writeFileSync(oldSessionFile, `${JSON.stringify({
      type: 'message',
      id: 'old',
      timestamp: '2026-05-13T10:00:00.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'legacy-only run history' }] },
    })}\n`);
    fs.writeFileSync(
      path.join(sessionsDir, 'sessions.json'),
      JSON.stringify({
        'agent:cinder-backend:run:77': {
          sessionId: 'old-77',
          sessionFile: oldSessionFile,
          updatedAt: Date.parse('2026-05-13T10:00:00.000Z'),
        },
        'agent:cinder-backend:hook:atlas:jobrun:77': {
          sessionId: 'old-77',
          sessionFile: oldSessionFile,
          updatedAt: Date.parse('2026-05-13T10:00:00.000Z'),
        },
      }),
    );

    const result = await backfillOpenClawJsonlTranscript(db, 77, { openclawHome, forceFull: true });

    expect(result).toMatchObject({
      attempted: true,
      reason: 'durable_run_id_missing',
      sessionFile: null,
      persistedEvents: 0,
    });
    expect(await db.get(`SELECT COUNT(*) AS count FROM chat_messages`)).toEqual({ count: 0 });
  });

  afterEach(async () => {
    await teardownTestDb();
    fs.rmSync(openclawHome, { recursive: true, force: true });
  });

  it('materializes tool calls and tool results from raw OpenClaw JSONL', async () => {
    const sessionFile = writeSession(openclawHome, [
      { type: 'session', timestamp: '2026-05-13T10:58:00.000Z' },
      {
        type: 'message',
        id: 'user-raw',
        timestamp: '2026-05-13T10:58:10.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Dispatch prompt' }] },
      },
      {
        type: 'message',
        id: 'assistant-call',
        timestamp: '2026-05-13T10:59:00.000Z',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'call-1',
              name: 'explore_codebase',
              arguments: { focus: 'routing' },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'tool-result',
        timestamp: '2026-05-13T10:59:30.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'explore_codebase',
          content: [{ type: 'text', text: 'Found routing files' }],
          isError: false,
        },
      },
    ]);

    const result = await backfillOpenClawJsonlTranscript(db, 77, {
          openclawHome,
          now: new Date('2026-05-13T11:00:00.000Z'),
        });

    expect(result.backfilled).toBe(true);
    expect(result.sessionFile).toBe(sessionFile);
    expect(result.persistedEvents).toBe(3);
    expect(result.heartbeatAt).toBe('2026-05-13 10:59:30.000');
    expect(result.meaningfulOutputAt).toBe('2026-05-13 10:59:30.000');

    const rows = await db.all(`
      SELECT id, role, content, event_type, event_meta
        FROM chat_messages
        ORDER BY timestamp ASC, id ASC
    `) as Array<{ id: string; role: string; content: string; event_type: string; event_meta: string }>;
    expect(rows.map(row => [row.role, row.event_type, row.content])).toEqual([
      ['user', 'text', 'Dispatch prompt'],
      ['assistant', 'tool_call', 'explore_codebase'],
      ['tool', 'tool_result', 'Found routing files'],
    ]);
    expect(JSON.parse(rows[1]?.event_meta ?? '{}')).toMatchObject({
      source: 'openclaw-jsonl',
      line_index: 3,
      raw_id: 'assistant-call',
      name: 'explore_codebase',
    });

    const artifact = await db.get(`
      SELECT started_at, last_agent_heartbeat_at, last_meaningful_output_at
        FROM instance_artifacts
        WHERE instance_id = 77
    `) as {
      started_at: string | null;
      last_agent_heartbeat_at: string | null;
      last_meaningful_output_at: string | null;
    };
    expect(artifact.started_at).toBe('2026-05-13 10:59:00.000');
    expect(artifact.last_agent_heartbeat_at).toBe('2026-05-13 10:59:30.000');
    expect(artifact.last_meaningful_output_at).toBe('2026-05-13 10:59:30.000');

    const second = await backfillOpenClawJsonlTranscript(db, 77, {
          openclawHome,
          now: new Date('2026-05-13T11:01:00.000Z'),
        });
    expect(second.persistedEvents).toBe(0);
    expect(await db.get(`SELECT COUNT(*) AS count FROM chat_messages`)).toEqual({ count: 3 });
  });

  it('treats oc-stream-only rows as sparse until structured rows are present', async () => {
    expect(await isRunChatTranscriptSparse(db, 77)).toBe(true);

    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
      VALUES ('oc-user-77', 94, 77, 'user', 'Dispatch', '2026-05-13T10:58:00.000Z')
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
      VALUES ('oc-stream-77', 94, 77, 'assistant', 'Working...', '2026-05-13T10:58:30.000Z')
    `);
    expect(await isRunChatTranscriptSparse(db, 77)).toBe(true);

    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type)
      VALUES ('oc-jsonl-77-3-0', 94, 77, 'assistant', 'explore_codebase', '2026-05-13T10:59:00.000Z', 'tool_call')
    `);
    expect(await isRunChatTranscriptSparse(db, 77)).toBe(false);
  });

  it('materializes live tool activity from trajectory JSONL before the normal session JSONL exists', async () => {
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, durable_run_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES ('oc-user-77', 94, 77, 'current-run', 'agent:cinder-backend:run:77:current-run', 'user', 'Dispatch prompt', '2026-05-13T10:58:00.000Z', 'text', '{}')
    `);
    const { sessionFile, trajectoryFile } = writeIndexedTrajectoryOnly(openclawHome, [
      {
        traceSchema: 'openclaw-trajectory',
        type: 'session.started',
        ts: '2026-05-13T10:58:00.000Z',
        seq: 1,
        sessionId: 'live-session',
        sessionKey: 'agent:cinder-backend:run:77:current-run',
        data: {},
      },
      {
        traceSchema: 'openclaw-trajectory',
        type: 'tool.call',
        ts: '2026-05-13T10:59:00.000Z',
        seq: 2,
        sessionId: 'live-session',
        sessionKey: 'agent:cinder-backend:run:77:current-run',
        data: {
          toolCallId: 'call-1',
          itemId: 'call-1',
          name: 'exec_command',
          arguments: { cmd: 'npm test' },
        },
      },
      {
        traceSchema: 'openclaw-trajectory',
        type: 'tool.result',
        ts: '2026-05-13T10:59:30.000Z',
        seq: 3,
        sessionId: 'live-session',
        sessionKey: 'agent:cinder-backend:run:77:current-run',
        data: {
          toolCallId: 'call-1',
          itemId: 'call-1',
          name: 'exec_command',
          status: 'completed',
          output: 'Tests passed',
        },
      },
      {
        traceSchema: 'openclaw-trajectory',
        type: 'session.ended',
        ts: '2026-05-13T11:00:00.000Z',
        seq: 4,
        sessionId: 'live-session',
        sessionKey: 'agent:cinder-backend:run:77:current-run',
        data: { status: 'completed' },
      },
    ]);

    const result = await backfillOpenClawJsonlTranscript(db, 77, {
          openclawHome,
          now: new Date('2026-05-13T11:00:01.000Z'),
        });

    expect(result).toMatchObject({
      backfilled: true,
      sessionFile: trajectoryFile,
      persistedEvents: 3,
      heartbeatAt: '2026-05-13 10:59:30.000',
      meaningfulOutputAt: '2026-05-13 10:59:30.000',
    });
    expect(await isRunChatTranscriptSparse(db, 77)).toBe(false);

    const rows = await db.all(`
      SELECT id, role, content, event_type, event_meta
        FROM chat_messages
        WHERE id LIKE 'oc-traj-%'
        ORDER BY timestamp ASC, id ASC
    `) as Array<{ id: string; role: string; content: string; event_type: string; event_meta: string }>;
    expect(rows.map(row => [row.role, row.event_type, row.content])).toEqual([
      ['assistant', 'tool_call', 'exec_command'],
      ['tool', 'tool_result', 'Tests passed'],
      ['system', 'turn_end', 'Run completed'],
    ]);
    expect(JSON.parse(rows[0]?.event_meta ?? '{}')).toMatchObject({
      source: 'openclaw-trajectory',
      name: 'exec_command',
      id: 'call-1',
    });
  });

  it('replaces provisional trajectory rows when canonical session JSONL becomes available', async () => {
    const { sessionFile } = writeIndexedTrajectoryOnly(openclawHome, [
      {
        traceSchema: 'openclaw-trajectory',
        type: 'tool.call',
        ts: '2026-05-13T10:59:00.000Z',
        seq: 2,
        sessionId: 'live-session',
        sessionKey: 'agent:cinder-backend:run:77:current-run',
        data: { toolCallId: 'call-1', name: 'exec_command', arguments: { cmd: 'npm test' } },
      },
      {
        traceSchema: 'openclaw-trajectory',
        type: 'tool.result',
        ts: '2026-05-13T10:59:30.000Z',
        seq: 3,
        sessionId: 'live-session',
        sessionKey: 'agent:cinder-backend:run:77:current-run',
        data: { toolCallId: 'call-1', name: 'exec_command', output: 'Provisional output' },
      },
    ]);

    expect((await backfillOpenClawJsonlTranscript(db, 77, { openclawHome })).persistedEvents).toBe(2);
    expect((await db.get(`SELECT COUNT(*) AS count FROM chat_messages WHERE id LIKE 'oc-traj-%'`) as { count: number }).count).toBe(2);

    fs.writeFileSync(sessionFile, `${[
      {
        type: 'message',
        id: 'assistant-call',
        timestamp: '2026-05-13T10:59:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-1', name: 'exec_command', arguments: { cmd: 'npm test -- --runInBand' } }],
        },
      },
      {
        type: 'message',
        id: 'tool-result',
        timestamp: '2026-05-13T10:59:30.000Z',
        message: {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'exec_command',
          content: [{ type: 'text', text: 'Canonical output' }],
        },
      },
    ].map(line => JSON.stringify(line)).join('\n')}\n`);

    const canonical = await backfillOpenClawJsonlTranscript(db, 77, {
          openclawHome,
          forceFull: true,
        });

    expect(canonical).toMatchObject({
      backfilled: true,
      sessionFile,
      persistedEvents: 2,
    });
    expect((await db.get(`SELECT COUNT(*) AS count FROM chat_messages WHERE id LIKE 'oc-traj-%'`) as { count: number }).count).toBe(0);
    const rows = await db.all(`
      SELECT id, content, event_type, event_meta
        FROM chat_messages
        ORDER BY timestamp ASC, id ASC
    `) as Array<{ id: string; content: string; event_type: string; event_meta: string }>;
    expect(rows.map(row => [row.id.startsWith('oc-jsonl-'), row.event_type, row.content])).toEqual([
      [true, 'tool_call', 'exec_command'],
      [true, 'tool_result', 'Canonical output'],
    ]);
    expect(JSON.parse(rows[1]?.event_meta ?? '{}')).toMatchObject({ source: 'openclaw-jsonl' });
  });
});
