import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

let db: Database.Database;
const mockGatewayGetHistory = jest.fn();

jest.mock('../../db/client', () => ({
  getDb: () => db,
}));

// transcriptProvider only imports gatewayGetHistory from OpenClawRuntime.
jest.mock('../../runtimes/OpenClawRuntime', () => ({
  gatewayGetHistory: (...args: unknown[]) => mockGatewayGetHistory(...args),
}));

// Force the "sparse transcript" path so a terminal run would otherwise reach the gateway.
jest.mock('./openclawJsonlBackfill', () => ({
  isRunChatTranscriptSparse: () => true,
  backfillOpenClawJsonlTranscript: () => ({ backfilled: false }),
}));

import { OpenClawTranscriptProvider } from './transcriptProvider';

function setupSchema(): void {
  db.exec(`
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY, session_key TEXT, agent_id INTEGER, status TEXT,
      runtime_ended_at TEXT, run_id TEXT
    );
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT, session_key TEXT, runtime_type TEXT);
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, agent_id INTEGER, instance_id INTEGER, session_key TEXT,
      role TEXT, content TEXT, timestamp TEXT, event_type TEXT, event_meta TEXT
    );
  `);
  db.prepare(`INSERT INTO agents (id, name, session_key, runtime_type) VALUES (5, 'Atlas', 'agent:atlas:main', 'openclaw')`).run();
}

beforeEach(() => {
  db = new Database(':memory:');
  setupSchema();
  mockGatewayGetHistory.mockReset();
});

afterEach(() => {
  db.close();
});

describe('OpenClawTranscriptProvider.getTranscript — terminal runs skip the gateway', () => {
  it('does not call the gateway for a done run and returns local chat_messages', async () => {
    db.prepare(`INSERT INTO job_instances (id, session_key, agent_id, status, runtime_ended_at) VALUES (700, 'run:700:abc', 5, 'done', '2026-06-01T00:00:00Z')`).run();
    db.prepare(`INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type) VALUES ('u1', 5, 700, 'run:700:abc', 'user', 'the prompt', '2026-06-01T00:00:00Z', 'text')`).run();

    const result = await new OpenClawTranscriptProvider().getTranscript(700);

    expect(mockGatewayGetHistory).not.toHaveBeenCalled();
    expect(result.messages.map(m => m.id)).toEqual(['u1']);
  });

  it.each(['failed', 'cancelled', 'stopped'])('does not call the gateway for a %s run', async (status) => {
    db.prepare(`INSERT INTO job_instances (id, session_key, agent_id, status) VALUES (701, 'run:701:abc', 5, ?)`).run(status);
    db.prepare(`INSERT INTO chat_messages (id, agent_id, instance_id, session_key, role, content, timestamp, event_type) VALUES ('u2', 5, 701, 'run:701:abc', 'user', 'p', '2026-06-01T00:00:00Z', 'text')`).run();

    await new OpenClawTranscriptProvider().getTranscript(701);

    expect(mockGatewayGetHistory).not.toHaveBeenCalled();
  });

  it('still calls the gateway for a non-terminal (dispatched) run', async () => {
    mockGatewayGetHistory.mockResolvedValue({ ok: true, messages: [] } as never);
    db.prepare(`INSERT INTO job_instances (id, session_key, agent_id, status) VALUES (702, 'run:702:abc', 5, 'dispatched')`).run();

    await new OpenClawTranscriptProvider().getTranscript(702);

    expect(mockGatewayGetHistory).toHaveBeenCalled();
  });
});
