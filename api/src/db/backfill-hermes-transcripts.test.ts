import fs from 'fs';
import os from 'os';
import path from 'path';

import { getDb } from './client';
import { setupTestDb, teardownTestDb } from './testDb';
import { type Db } from './adapter/types';
import { findCandidates, processCandidate, type Candidate } from './backfill-hermes-transcripts';
import { buildAgentHqRunContextBlock } from '../runtimes/hermesTranscriptIngestion';

const INSTANCE_ID = 4806;
const AGENT_ID = 17;
const TENANT_ID = 23;
const CONTEXT = {
  instanceId: INSTANCE_ID,
  durableRunId: 'durable-4806',
  sessionKey: 'run:4806:durable-4806',
};

const FULL_TEXT = 'The complete assistant answer, streamed to the very end.';

/**
 * The run the backfill will be pointed at: a real agent and a real job_instance, because
 * chat_messages carries genuine foreign keys to both and findCandidates joins through them.
 */
async function seedRun(runtimeConfig: string): Promise<Db> {
  const db = getDb();
  await db.run(
    `INSERT INTO tenants (id, name, slug, is_default)
     VALUES (?, 'Hermes Backfill', 'hermes-backfill', 1)`,
    TENANT_ID,
  );
  await db.run(
    `INSERT INTO agents (id, tenant_id, name, session_key, runtime_type, runtime_config)
     VALUES (?, ?, 'Cinder', 'hermes-backfill-agent', 'hermes', ?)`,
    AGENT_ID,
    TENANT_ID,
    runtimeConfig,
  );
  await db.run(
    'INSERT INTO job_instances (id, tenant_id, agent_id, durable_run_id, session_key) VALUES (?, ?, ?, ?, ?)',
    INSTANCE_ID,
    TENANT_ID,
    AGENT_ID,
    CONTEXT.durableRunId,
    CONTEXT.sessionKey,
  );
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
    `INSERT INTO chat_messages (id, tenant_id, agent_id, instance_id, role, content, timestamp)
     VALUES (?, ?, ?, ?, 'assistant', ?, '2026-06-03 06:40:02')`,
    `hermes-json-${INSTANCE_ID}-0-0`,
    TENANT_ID,
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

async function tenantOf(db: Db): Promise<number> {
  const row = (await db.get(
    'SELECT tenant_id FROM chat_messages WHERE id = ?',
    `hermes-json-${INSTANCE_ID}-0-0`,
  )) as { tenant_id: number };
  return row.tenant_id;
}

describe('Hermes transcript backfill', () => {
  beforeEach(async () => {
    await setupTestDb();
  });

  afterEach(async () => {
    await teardownTestDb();
  });

  it('finds instances that have Hermes transcript rows', async () => {
    const db = await seedRun(JSON.stringify({ profile: 'cinder' }));
    await seedTruncatedRow(db);

    const candidates = await findCandidates(db, null);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].instanceId).toBe(INSTANCE_ID);
    expect(candidates[0].agentId).toBe(AGENT_ID);
  });

  it('repairs a row the old ingest truncated', async () => {
    const root = makeProfileHome();
    const runtimeConfig = JSON.stringify({ profile: 'cinder', hermesHome: root });
    const db = await seedRun(runtimeConfig);
    await seedTruncatedRow(db);

    const outcome = await processCandidate(db, candidateFor(runtimeConfig), true);

    expect(outcome.status).toBe('repaired');
    expect(outcome.rowsGrown).toBe(1);
    expect(await contentOf(db)).toBe(FULL_TEXT);
    expect(await tenantOf(db)).toBe(TENANT_ID);
  });

  it('changes nothing in dry-run mode', async () => {
    const root = makeProfileHome();
    const runtimeConfig = JSON.stringify({ profile: 'cinder', hermesHome: root });
    const db = await seedRun(runtimeConfig);
    await seedTruncatedRow(db);

    const outcome = await processCandidate(db, candidateFor(runtimeConfig), false);

    expect(outcome.status).toBe('unchanged');
    expect(await contentOf(db)).toBe('The complete');
  });

  it('is idempotent — a second apply reports no further growth', async () => {
    const root = makeProfileHome();
    const runtimeConfig = JSON.stringify({ profile: 'cinder', hermesHome: root });
    const db = await seedRun(runtimeConfig);
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
    const db = await seedRun(runtimeConfig);
    await seedTruncatedRow(db);

    const outcome = await processCandidate(db, candidateFor(runtimeConfig), true);

    // Old runs usually no longer have their source on disk. Saying so beats
    // reporting them as repaired.
    expect(outcome.status).toBe('no-session-file');
    expect(await contentOf(db)).toBe('The complete');
  });

  it('reports a config it cannot use rather than throwing', async () => {
    const runtimeConfig = JSON.stringify({});
    const db = await seedRun(runtimeConfig);
    await seedTruncatedRow(db);

    const outcome = await processCandidate(db, candidateFor(runtimeConfig), true);
    expect(outcome.status).toBe('bad-config');
  });
});
