import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  buildAgentHqRunContextBlock,
  ingestHermesTranscriptForRun,
} from './hermesTranscriptIngestion';
import { type Db } from "../db/adapter/types";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function setupDb(): Promise<Db> {
  const db = new Database(':memory:');
  await db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY,
      agent_id INTEGER NOT NULL,
      instance_id INTEGER,
      durable_run_id TEXT,
      session_key TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'text',
      event_meta TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

function writeSession(hermesHome: string, name: string, data: Record<string, unknown>): string {
  const sessionsDir = path.join(hermesHome, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const filePath = path.join(sessionsDir, name);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

describe('Hermes transcript ingestion', () => {
  it('parses user text, assistant text, tool calls, tool results, and plain reasoning into chat_messages', async () => {
    const db = await setupDb();
    const hermesHome = makeTempDir('hermes-ingest-');
    const context = {
      instanceId: 4806,
      durableRunId: 'c0b69cdf-a734-4faf-bf8e-9515d47c3640',
      sessionKey: 'run:4806:c0b69cdf-a734-4faf-bf8e-9515d47c3640',
    };

    writeSession(hermesHome, 'active.json', {
      prompt: `${buildAgentHqRunContextBlock(context)}\n\nDo the task`,
      created_at: '2026-06-03T06:40:00.000Z',
      messages: [
        { role: 'user', content: 'Do the task', timestamp: '2026-06-03T06:40:01.000Z' },
        {
          role: 'assistant',
          reasoning_content: 'I should inspect the repo first.',
          content: [{ type: 'text', text: 'I will inspect the repo.' }],
          tool_calls: [{ id: 'call_1', function: { name: 'exec_command', arguments: '{"cmd":"rg Hermes"}' } }],
          timestamp: '2026-06-03T06:40:02.000Z',
        },
        {
          role: 'tool',
          tool_call_id: 'call_1',
          content: 'api/src/runtimes/HermesRuntime.ts',
          timestamp: '2026-06-03T06:40:03.000Z',
        },
      ],
    });

    const result = await ingestHermesTranscriptForRun({
          db,
          agentId: 17,
          profile: 'cinder',
          hermesHome,
          ...context,
        });

    expect(result).toMatchObject({ imported: 5, skipped: null });
    const rows = await db.all('SELECT id, role, content, event_type, durable_run_id, session_key, event_meta FROM chat_messages ORDER BY timestamp, id') as Array<Record<string, string>>;
    expect(rows.map((row) => [row.role, row.event_type, row.content])).toEqual([
      ['user', 'text', 'Do the task'],
      ['assistant', 'thought', 'I should inspect the repo first.'],
      ['assistant', 'text', 'I will inspect the repo.'],
      ['assistant', 'tool_call', 'exec_command'],
      ['tool', 'tool_result', 'api/src/runtimes/HermesRuntime.ts'],
    ]);
    expect(rows.every((row) => row.durable_run_id === context.durableRunId)).toBe(true);
    expect(rows.every((row) => row.session_key === context.sessionKey)).toBe(true);
    expect(JSON.parse(rows[3].event_meta).tool_call_id).toBe('call_1');
  });

  it('does not import unmarked or ambiguous Hermes session files', async () => {
    const db = await setupDb();
    const hermesHome = makeTempDir('hermes-ambiguous-');
    const context = { instanceId: 4806, durableRunId: 'durable-4806', sessionKey: 'run:4806:durable-4806' };

    writeSession(hermesHome, 'unmarked.json', {
      messages: [{ role: 'assistant', content: 'wrong run' }],
    });

    expect(await ingestHermesTranscriptForRun({ db, agentId: 17, profile: 'cinder', hermesHome, ...context })).toMatchObject({
      imported: 0,
      skipped: 'no-marker',
    });

    writeSession(hermesHome, 'marked-1.json', {
      prompt: buildAgentHqRunContextBlock(context),
      messages: [{ role: 'assistant', content: 'first' }],
    });
    writeSession(hermesHome, 'marked-2.json', {
      prompt: buildAgentHqRunContextBlock(context),
      messages: [{ role: 'assistant', content: 'second' }],
    });

    expect(await ingestHermesTranscriptForRun({ db, agentId: 17, profile: 'cinder', hermesHome, ...context })).toMatchObject({
      imported: 0,
      skipped: 'ambiguous',
    });
    expect((await db.get('SELECT COUNT(*) AS n FROM chat_messages') as { n: number }).n).toBe(0);
  });

  it('is incremental and idempotent across repeated polls', async () => {
    const db = await setupDb();
    const hermesHome = makeTempDir('hermes-incremental-');
    const context = { instanceId: 4806, durableRunId: 'durable-4806', sessionKey: 'run:4806:durable-4806' };
    const filePath = writeSession(hermesHome, 'active.json', {
      prompt: buildAgentHqRunContextBlock(context),
      messages: [
        { role: 'user', content: 'hello', timestamp: '2026-06-03T06:40:01.000Z' },
      ],
    });

    await ingestHermesTranscriptForRun({ db, agentId: 17, profile: 'cinder', hermesHome, ...context });
    await ingestHermesTranscriptForRun({ db, agentId: 17, profile: 'cinder', hermesHome, ...context });
    expect((await db.get('SELECT COUNT(*) AS n FROM chat_messages') as { n: number }).n).toBe(1);

    fs.writeFileSync(filePath, JSON.stringify({
      prompt: buildAgentHqRunContextBlock(context),
      messages: [
        { role: 'user', content: 'hello', timestamp: '2026-06-03T06:40:01.000Z' },
        { role: 'assistant', content: 'world', timestamp: '2026-06-03T06:40:02.000Z' },
      ],
    }, null, 2), 'utf-8');

    await ingestHermesTranscriptForRun({ db, agentId: 17, profile: 'cinder', hermesHome, ...context });
    const rows = await db.all('SELECT id, content FROM chat_messages ORDER BY timestamp') as Array<{ id: string; content: string }>;
    expect(rows).toEqual([
      { id: 'hermes-json-4806-0-0', content: 'hello' },
      { id: 'hermes-json-4806-1-0', content: 'world' },
    ]);
  });
});
