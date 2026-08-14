import { setupTestDb, teardownTestDb } from '../../db/testDb';
import { type Db } from '../../db/adapter/types';
import { describeActivity, getInstanceActivity, prettifyToolName } from './activity';

describe('describeActivity', () => {
  it('reads the tool name from every runtime shape', () => {
    // claude-code / codex
    expect(describeActivity('tool_call', { tool_name: 'Bash', tool_input: {} }))
      .toEqual({ label: 'Using Bash', detail: 'Bash' });
    // hermes
    expect(describeActivity('tool_call', { source: 'hermes-json', name: 'patch', arguments: '{}' }))
      .toEqual({ label: 'Using patch', detail: 'patch' });
    // openclaw, fully-qualified per-agent MCP name
    expect(describeActivity('tool_call', { name: 'agent-hq__agent-99974437.agent_hq_post_task_outcome', args: {} }))
      .toEqual({ label: 'Using agent_hq_post_task_outcome', detail: 'agent_hq_post_task_outcome' });
  });

  it('describes what the agent is doing rather than naming the event', () => {
    expect(describeActivity('thought', {}).label).toBe('Thinking');
    expect(describeActivity('text', {}).label).toBe('Writing');
    expect(describeActivity('tool_result', {}).label).toBe('Reading results');
    expect(describeActivity('turn_end', {}).label).toBe('Finished');
  });

  it('falls back without a tool name and for unknown event types', () => {
    expect(describeActivity('tool_call', {})).toEqual({ label: 'Using a tool', detail: null });
    expect(describeActivity('something-new', {}).label).toBe('Working');
    expect(describeActivity(null, {}).label).toBe('Working');
  });
});

describe('prettifyToolName', () => {
  it('keeps a plain tool name intact', () => {
    expect(prettifyToolName('Bash')).toBe('Bash');
  });

  it('strips MCP qualification so no agent id reaches the UI', () => {
    expect(prettifyToolName('agent-hq__agent-99974437.agent_hq_post_task_outcome'))
      .toBe('agent_hq_post_task_outcome');
    expect(prettifyToolName('mcp__agent-hq__agent-99974448__agent_hq_trace_routing'))
      .toBe('agent_hq_trace_routing');
  });
});

describe('getInstanceActivity', () => {
  let db: Db;

  const NOW = new Date('2026-08-12T23:00:30.000Z');

  async function seedInstance(id: number, status: string): Promise<void> {
    await db.run(`
      INSERT INTO job_instances (id, agent_id, status, dispatched_at)
      VALUES (?, 1, ?, '2026-08-12 23:00:00')
    `, id, status);
  }

  async function seedEvent(instanceId: number, eventType: string, meta: string, ts: string): Promise<void> {
    await db.run(`
      INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp, event_type, event_meta, session_key)
      VALUES (?, 1, ?, 'assistant', 'x', ?, ?, ?, 'k')
    `, `${instanceId}-${eventType}-${ts}`, instanceId, ts, eventType, meta);
  }

  beforeEach(async () => {
    db = await setupTestDb();
    await db.run(`INSERT INTO tenants (id, name, slug, is_default) VALUES (1, 'T', 't', 1)`);
    await db.run(`
      INSERT INTO agents (id, name, role, session_key, status, runtime_type)
      VALUES (1, 'A', 'R', 'agent:a:main', 'idle', 'claude-code')
    `);
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('returns null for an instance that does not exist', async () => {
    expect(await getInstanceActivity(db, 424242, NOW)).toBeNull();
  });

  it('reports starting between dispatch and the first transcript row', async () => {
    await seedInstance(1, 'dispatched');
    const activity = await getInstanceActivity(db, 1, NOW);
    expect(activity).toMatchObject({ state: 'starting', activity: null, label: 'Starting up' });
  });

  it('reports the current tool while a turn is live', async () => {
    await seedInstance(2, 'running');
    await seedEvent(2, 'tool_call', '{"tool_name":"Bash"}', '2026-08-12 23:00:29');
    const activity = await getInstanceActivity(db, 2, NOW);
    expect(activity).toMatchObject({
      state: 'working',
      activity: 'tool_call',
      label: 'Using Bash',
      detail: 'Bash',
    });
    expect(activity?.last_event_at).toBe('2026-08-12T23:00:29.000Z');
  });

  it('uses the newest row when several were written', async () => {
    await seedInstance(3, 'running');
    await seedEvent(3, 'thought', '{}', '2026-08-12 23:00:20');
    await seedEvent(3, 'tool_call', '{"tool_name":"Read"}', '2026-08-12 23:00:28');
    expect(await getInstanceActivity(db, 3, NOW)).toMatchObject({ label: 'Using Read' });
  });

  it('goes stalled once the transcript stops advancing', async () => {
    await seedInstance(4, 'running');
    await seedEvent(4, 'thought', '{}', '2026-08-12 22:59:00');
    expect(await getInstanceActivity(db, 4, NOW)).toMatchObject({
      state: 'stalled',
      label: 'No recent activity',
      detail: null,
    });
  });

  it('keeps an outstanding tool call working through a long silence', async () => {
    // A tool writes one row when issued and the next when it returns, so a slow
    // command produces no rows for minutes while being the busiest part of a run.
    await seedInstance(8, 'running');
    await seedEvent(8, 'tool_call', '{"tool_name":"Bash"}', '2026-08-12 22:59:00');
    expect(await getInstanceActivity(db, 8, NOW)).toMatchObject({
      state: 'working',
      label: 'Using Bash',
    });
  });

  it('still stalls a tool call that has been outstanding far too long', async () => {
    await seedInstance(9, 'running');
    await seedEvent(9, 'tool_call', '{"tool_name":"Bash"}', '2026-08-12 22:55:00');
    expect(await getInstanceActivity(db, 9, NOW)).toMatchObject({ state: 'stalled' });
  });

  it('treats a terminal instance status as authoritative over a fresh event', async () => {
    // Hermes ingests on a poll, so a row can land after the run has ended.
    await seedInstance(5, 'done');
    await seedEvent(5, 'tool_call', '{"tool_name":"Bash"}', '2026-08-12 23:00:29');
    expect(await getInstanceActivity(db, 5, NOW)).toMatchObject({ state: 'done', label: 'Idle' });
  });

  it('treats turn_end as the end of the turn even while the status lags', async () => {
    await seedInstance(6, 'running');
    await seedEvent(6, 'turn_end', '{}', '2026-08-12 23:00:29');
    expect(await getInstanceActivity(db, 6, NOW)).toMatchObject({ state: 'done', label: 'Idle' });
  });

  it('parses fractional-second timestamps that openclaw writes', async () => {
    await seedInstance(7, 'running');
    await seedEvent(7, 'text', '{}', '2026-08-12 23:00:29.376');
    const activity = await getInstanceActivity(db, 7, NOW);
    expect(activity).toMatchObject({ state: 'working', label: 'Writing' });
    expect(activity?.last_event_at).toBe('2026-08-12T23:00:29.376Z');
  });
});
