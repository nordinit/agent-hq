import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

import { SqliteAdapter } from './adapter/SqliteAdapter';
import { type Db } from './adapter/types';
import { findCandidates, processCandidate, type Candidate } from './backfill-hermes-transcripts';
import { buildAgentHqRunContextBlock } from '../runtimes/hermesTranscriptIngestion';

const INSTANCE_ID = 4806;
const AGENT_ID = 17;
const CONTEXT = {
  instanceId: INSTANCE_ID,
  durableRunId: 'durable-4806',
  sessionKey: 'run:4806:durable-4806',
};

const FULL_TEXT = 'The complete assistant answer, streamed to the very end.';

async function setupDb(runtimeConfig: string): Promise<Db> {
  const db = new SqliteAdapter(new Database(':memory:'));
  await db.exec(`
    CREATE TABLE chat_messages (
      id TEXT PRIMARY KEY, agent_id INTEGER NOT NULL, instance_id INTEGER,
      durable_run_id TEXT, session_key TEXT NOT NULL DEFAULT '', role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '', timestamp TEXT NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'text', event_meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE job_instances (
      id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, durable_run_id TEXT, session_key TEXT
    );
    CREATE TABLE agents (id INTEGER PRIMARY KEY, runtime_config TEXT);
  `);
  await db.run(
    'INSERT INTO job_instances (id, agent_id, durable_run_id, session_key) VALUES (?, ?, ?, ?)',
    INSTANCE_ID,
    AGENT_ID,
    CONTEXT.durableRunId,
    CONTEXT.sessionKey,
  );
  await db.run('INSERT INTO agents (id, runtime_config) VALUES (?, ?)', AGENT_ID, runtimeConfig);
  return db;
}

/** A Hermes profile home holding the COMPLETE message the run actually produced. */
function makeProfileHome(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-backfill-'));
  const profileHome = path.join(root, 'profiles', 'cinder');
  fs.mkdirSync(path.join(profileHome, 'sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(profileHome, 'sessions', 'active.json'),
    JSON.stringify({
      prompt: buildAgentHqRunContextBlock(CONTEXT),
      messages: [{ role: 'assistant', content: FULL_TEXT, timestamp: '2026-06-03T06:40:02.000Z' }],
    }),
    'utf-8',
  );
  return root;
}

/** The truncated row the old DO NOTHING ingest would have left behind. */
async function seedTruncatedRow(db: Db): Promise<void> {
  await db.run(
    `INSERT INTO chat_messages (id, agent_id, instance_id, role, content, timestamp)
     VALUES (?, ?, ?, 'assistant', ?, '2026-06-03 06:40:02')`,
    `hermes-json-${INSTANCE_ID}-0-0`,
    AGENT_ID,
    INSTANCE_ID,
    'The complete',
  );
}

function candidateFor(runtimeConfig: string): Candidate {
  return {
    instanceId: INSTANCE_ID,
    agentId: AGENT_ID,
    durableRunId: CONTEXT.durableRunId,
    sessionKey: CONTEXT.sessionKey,
    runtimeConfig,
  };
}

async function contentOf(db: Db): Promise<string> {
  const row = (await db.get(
    'SELECT content FROM chat_messages WHERE id = ?',
    `hermes-json-${INSTANCE_ID}-0-0`,
  )) as { content: string };
  return row.content;
}

describe('Hermes transcript backfill', () => {
  it('finds instances that have Hermes transcript rows', async () => {
    const db = await setupDb(JSON.stringify({ profile: 'cinder' }));
    await seedTruncatedRow(db);

    const candidates = await findCandidates(db, null);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].instanceId).toBe(INSTANCE_ID);
    expect(candidates[0].agentId).toBe(AGENT_ID);
  });

  it('repairs a row the old ingest truncated', async () => {
    const root = makeProfileHome();
    const runtimeConfig = JSON.stringify({ profile: 'cinder', hermesHome: root });
    const db = await setupDb(runtimeConfig);
    await seedTruncatedRow(db);

    const outcome = await processCandidate(db, candidateFor(runtimeConfig), true);

    expect(outcome.status).toBe('repaired');
    expect(outcome.rowsGrown).toBe(1);
    expect(await contentOf(db)).toBe(FULL_TEXT);
  });

  it('changes nothing in dry-run mode', async () => {
    const root = makeProfileHome();
    const runtimeConfig = JSON.stringify({ profile: 'cinder', hermesHome: root });
    const db = await setupDb(runtimeConfig);
    await seedTruncatedRow(db);

    const outcome = await processCandidate(db, candidateFor(runtimeConfig), false);

    expect(outcome.status).toBe('unchanged');
    expect(await contentOf(db)).toBe('The complete');
  });

  it('is idempotent — a second apply reports no further growth', async () => {
    const root = makeProfileHome();
    const runtimeConfig = JSON.stringify({ profile: 'cinder', hermesHome: root });
    const db = await setupDb(runtimeConfig);
    await seedTruncatedRow(db);

    await processCandidate(db, candidateFor(runtimeConfig), true);
    const second = await processCandidate(db, candidateFor(runtimeConfig), true);

    // The grow-only guard means re-running can only ever lengthen a row, so this
    // is safe to run repeatedly — which is the property that makes it operable.
    expect(second.status).toBe('unchanged');
    expect(second.rowsGrown).toBe(0);
    expect(await contentOf(db)).toBe(FULL_TEXT);
  });

  it('reports honestly when the session file is gone', async () => {
    const runtimeConfig = JSON.stringify({
      profile: 'cinder',
      hermesHome: path.join(os.tmpdir(), 'definitely-not-here-12345'),
    });
    const db = await setupDb(runtimeConfig);
    await seedTruncatedRow(db);

    const outcome = await processCandidate(db, candidateFor(runtimeConfig), true);

    // Old runs usually no longer have their source on disk. Saying so beats
    // reporting them as repaired.
    expect(outcome.status).toBe('no-session-file');
    expect(await contentOf(db)).toBe('The complete');
  });

  it('reports a config it cannot use rather than throwing', async () => {
    const runtimeConfig = JSON.stringify({});
    const db = await setupDb(runtimeConfig);
    await seedTruncatedRow(db);

    const outcome = await processCandidate(db, candidateFor(runtimeConfig), true);
    expect(outcome.status).toBe('bad-config');
  });
});
