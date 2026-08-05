import { setupTestDb, teardownTestDb } from '../db/testDb';
import { getDb } from '../db/client';
import { ensureCanonicalSessionForInstance } from './canonicalSessions';

const mockGetTranscript = jest.fn<Promise<{
  sessionKey: string | null;
  source: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: string;
    event_type?: string;
    event_meta?: Record<string, unknown>;
  }>;
  in_progress: boolean;
}>, [number]>(async () => ({
  sessionKey: null,
  source: 'test-empty-transcript',
  messages: [],
  in_progress: false,
}));

jest.mock('../domains/runs/transcriptProvider', () => ({
  resolveTranscriptProvider: () => ({
    getTranscript: mockGetTranscript,
  }),
}));

async function resetDb(): Promise<void> {
  await setupTestDb();
  const db = getDb();
  await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'Default Tenant', 'default', 1)`);
  await db.run(`INSERT INTO projects (id, tenant_id, name) VALUES (56, 1, 'Agent HQ Bugs')`);
  await db.run(`INSERT INTO sprints (id, tenant_id, project_id, name, sprint_type) VALUES (56, 1, 56, 'Agent HQ Bugs', 'generic')`);
}

describe('ensureCanonicalSessionForInstance failure placeholders', () => {
  beforeEach(async () => {
    await resetDb();
    mockGetTranscript.mockReset();
    mockGetTranscript.mockResolvedValue({
      sessionKey: null,
      source: 'test-empty-transcript',
      messages: [],
      in_progress: false,
    });
  });
  afterEach(async () => {
    await teardownTestDb();
  });

  it('creates a visible failed-run session when startup failed before transcript output', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, runtime_type) VALUES (94, 1, 'Cinder', 'agent:cinder-backend:main', 'openclaw')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (715, 1, 'Anchor recovery', 56, 56)`);
    await db.run(`
      INSERT INTO job_instances (
        id, agent_id, task_id, status, session_key, created_at, completed_at,
        runtime_ended_at, runtime_end_success, runtime_end_error, runtime_end_source
      ) VALUES (
        4610, 94, 715, 'failed', NULL, '2026-06-03T01:40:00.000Z', '2026-06-03T01:51:40.000Z',
        '2026-06-03T01:51:40.000Z', 0, 'Requested agent harness "codex" is not registered', 'instance_complete'
      )
    `);

    const session = await ensureCanonicalSessionForInstance(4610);

    expect(session).toMatchObject({
      external_key: 'failed-run:4610',
      status: 'failed',
      agent_id: 94,
      task_id: 715,
      instance_id: 4610,
      project_id: 56,
      message_count: 1,
    });

    const message = await db.get(`SELECT role, event_type, content, event_meta FROM session_messages WHERE session_id = ?`, session!.id) as {
      role: string;
      event_type: string;
      content: string;
      event_meta: string;
    };
    expect(message.role).toBe('system');
    expect(message.event_type).toBe('error');
    expect(message.content).toContain('Runtime failure: Requested agent harness "codex" is not registered');
    expect(message.content).toContain('Instance ID: 4610');
    expect(message.content).toContain('Task ID: 715');
    expect(message.content).toContain('Agent: Cinder');
    expect(message.content).toContain('Session key: unavailable');
    expect(JSON.parse(message.event_meta)).toMatchObject({
      source: 'job_instance_runtime_failure',
      instance_id: 4610,
      task_id: 715,
      runtime_end_source: 'instance_complete',
    });
  });

  it('repairs a completed instance whose canonical session stayed active with zero messages', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, runtime_type) VALUES (94, 1, 'Cinder', 'agent:cinder-backend:main', 'openclaw')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (732, 1, 'Fix live transcript handoff after Task #719', 56, 56)`);
    await db.run(`
      INSERT INTO job_instances (
        id, agent_id, task_id, status, session_key, created_at, dispatched_at, started_at,
        completed_at, runtime_ended_at, runtime_end_success, runtime_end_source
      ) VALUES (
        4692, 94, 732, 'done', 'agent:cinder-backend:run:4692:durable-4692',
        '2026-06-03T02:00:00.000Z', '2026-06-03T02:00:01.000Z', '2026-06-03T02:00:02.000Z',
        '2026-06-03T02:12:00.000Z', '2026-06-03T02:12:00.000Z', 1, 'instance_complete'
      )
    `);
    await db.run(`
      INSERT INTO sessions (
        id, external_key, runtime, agent_id, task_id, instance_id, project_id, status,
        title, started_at, message_count
      ) VALUES (
        12719, 'agent:cinder-backend:run:4692:durable-4692', 'openclaw', 94, 732, 4692, 56,
        'active', 'Fix live transcript handoff after Task #719', '2026-06-03T02:00:02.000Z', 0
      )
    `);
    const insertChat = async (id: string, role: string, content: string, timestamp: string, eventType: string, eventMeta: string): Promise<void> => {
      await db.run(`
        INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
        VALUES (?, 94, 4692, 'agent:cinder-backend:run:4692:durable-4692', ?, ?, ?, ?, ?)
      `, id, role, content, timestamp, eventType, eventMeta);
    };
    await insertChat('oc-user-4692', 'user', 'Start task #732', '2026-06-03T02:00:02.000Z', 'text', '{}');
    await insertChat('oc-hist-4692-1', 'assistant', 'Inspecting transcript code paths', '2026-06-03T02:00:05.000Z', 'text', '{}');
    await insertChat('oc-hist-4692-2', 'assistant', 'exec_command', '2026-06-03T02:00:06.000Z', 'tool_call', '{"name":"exec_command"}');
    await insertChat('oc-hist-4692-3', 'tool', 'test output', '2026-06-03T02:00:07.000Z', 'tool_result', '{"output":"test output"}');
    await insertChat('oc-turn-end-4692', 'system', 'Run completed', '2026-06-03T02:12:00.000Z', 'turn_end', '{"success":true}');

    const session = await ensureCanonicalSessionForInstance(4692, { forceIngest: true });

    expect(session).toMatchObject({
      id: 12719,
      status: 'completed',
      message_count: 5,
      // Stored canonically (offset-less UTC) rather than as the ISO-Z the
      // fixture supplies — see lib/timestamps.ts. Same instant, one format.
      ended_at: '2026-06-03 02:12:00.000',
    });
    const messages = await db.all(`
      SELECT ordinal, role, event_type, content
      FROM session_messages
      WHERE session_id = ?
      ORDER BY ordinal
    `, 12719);
    expect(messages).toEqual([
      { ordinal: 0, role: 'user', event_type: 'text', content: 'Start task #732' },
      { ordinal: 1, role: 'assistant', event_type: 'text', content: 'Inspecting transcript code paths' },
      { ordinal: 2, role: 'assistant', event_type: 'tool_call', content: 'exec_command' },
      { ordinal: 3, role: 'tool', event_type: 'tool_result', content: 'test output' },
      { ordinal: 4, role: 'system', event_type: 'turn_end', content: 'Run completed' },
    ]);
  });

  it('uses the transcript provider for completed OpenClaw sessions with only a dispatch prompt in chat_messages', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, runtime_type) VALUES (94, 1, 'Cinder', 'agent:cinder-backend:main', 'openclaw')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (738, 1, 'Fix completed OpenClaw transcripts that import only the dispatch prompt', 56, 56)`);
    await db.run(`
      INSERT INTO job_instances (
        id, agent_id, task_id, status, session_key, created_at, dispatched_at, started_at,
        completed_at, runtime_ended_at, runtime_end_success, runtime_end_source
      ) VALUES (
        4782, 94, 738, 'done', 'agent:cinder-backend:run:4782:durable-4782',
        '2026-06-03T02:00:00.000Z', '2026-06-03T02:00:01.000Z', '2026-06-03T02:00:02.000Z',
        '2026-06-03T02:12:00.000Z', '2026-06-03T02:12:00.000Z', 1, 'instance_complete'
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES ('oc-user-4782', 94, 4782, 'agent:cinder-backend:run:4782:durable-4782', 'user', 'Dispatch prompt only', '2026-06-03T02:00:02.000Z', 'text', '{}')
    `);
    mockGetTranscript.mockResolvedValue({
      sessionKey: 'agent:cinder-backend:run:4782:durable-4782',
      source: 'openclaw-jsonl',
      in_progress: false,
      messages: [
        {
          id: 'oc-user-4782',
          role: 'user',
          content: 'Dispatch prompt only',
          timestamp: '2026-06-03T02:00:02.000Z',
          event_type: 'text',
          event_meta: {},
        },
        {
          id: 'oc-jsonl-4782-1',
          role: 'assistant',
          content: 'I am inspecting the raw JSONL transcript.',
          timestamp: '2026-06-03T02:00:05.000Z',
          event_type: 'text',
          event_meta: { source: 'openclaw-jsonl' },
        },
        {
          id: 'oc-jsonl-4782-2',
          role: 'tool',
          content: 'test output',
          timestamp: '2026-06-03T02:00:06.000Z',
          event_type: 'tool_result',
          event_meta: { output: 'test output' },
        },
      ],
    });

    const session = await ensureCanonicalSessionForInstance(4782);

    expect(mockGetTranscript).toHaveBeenCalledWith(4782);
    expect(session).toMatchObject({
      status: 'completed',
      message_count: 3,
    });
    const messages = await db.all(`
      SELECT ordinal, role, event_type, content, event_meta
      FROM session_messages
      WHERE session_id = ?
      ORDER BY ordinal
    `, session!.id) as Array<{ ordinal: number; role: string; event_type: string; content: string; event_meta: string }>;
    expect(messages.map(({ ordinal, role, event_type, content }) => ({ ordinal, role, event_type, content }))).toEqual([
      { ordinal: 0, role: 'user', event_type: 'text', content: 'Dispatch prompt only' },
      { ordinal: 1, role: 'assistant', event_type: 'text', content: 'I am inspecting the raw JSONL transcript.' },
      { ordinal: 2, role: 'tool', event_type: 'tool_result', content: 'test output' },
    ]);
    expect(JSON.parse(messages[1].event_meta)).toEqual({ source: 'openclaw-jsonl' });
  });

  it('keeps active OpenClaw prompt-only sessions visible while runtime output is pending', async () => {
    const db = getDb();
    await db.run(`INSERT INTO agents (id, tenant_id, name, session_key, runtime_type) VALUES (94, 1, 'Cinder', 'agent:cinder-backend:main', 'openclaw')`);
    await db.run(`INSERT INTO tasks (id, tenant_id, title, project_id, sprint_id) VALUES (739, 1, 'Pending OpenClaw run', 56, 56)`);
    await db.run(`
      INSERT INTO job_instances (
        id, agent_id, task_id, status, session_key, created_at, dispatched_at, started_at
      ) VALUES (
        4790, 94, 739, 'running', 'agent:cinder-backend:run:4790:durable-4790',
        '2026-06-03T02:20:00.000Z', '2026-06-03T02:20:01.000Z', '2026-06-03T02:20:02.000Z'
      )
    `);
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type, event_meta)
      VALUES ('oc-user-4790', 94, 4790, 'agent:cinder-backend:run:4790:durable-4790', 'user', 'Start running task', '2026-06-03T02:20:02.000Z', 'text', '{}')
    `);

    const session = await ensureCanonicalSessionForInstance(4790);

    expect(session).toMatchObject({
      status: 'active',
      message_count: 1,
    });
    const messages = await db.all(`
      SELECT ordinal, role, event_type, content
      FROM session_messages
      WHERE session_id = ?
      ORDER BY ordinal
    `, session!.id);
    expect(messages).toEqual([
      { ordinal: 0, role: 'user', event_type: 'text', content: 'Start running task' },
    ]);
  });
});
