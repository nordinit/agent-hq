/**
 * db/backfill-hermes-transcripts.ts — repair Hermes transcripts that were
 * truncated by the old `ON CONFLICT DO NOTHING` ingest.
 *
 * Why this exists: Hermes ingests on a 2s poll and its row ids are positional,
 * so under the previous clause the FIRST partial snapshot of a streaming message
 * claimed the id and the finished text was discarded permanently. Switching to a
 * grow-only upsert fixes new runs but does nothing for rows already stored — the
 * fix only applies the next time that row is written.
 *
 * Re-running ingestion is exactly that next write: the session JSON on disk
 * still holds the complete message, and the grow-only guard means re-ingesting
 * can only ever lengthen a row, never damage one. That makes this safe to re-run.
 *
 *   npx tsx src/db/backfill-hermes-transcripts.ts              # report only
 *   npx tsx src/db/backfill-hermes-transcripts.ts --apply
 *   npx tsx src/db/backfill-hermes-transcripts.ts --apply --instance 4806
 *
 * Reports instances whose session file is gone rather than pretending they were
 * repaired — for old runs the source is usually unavailable, and that is the
 * honest outcome.
 */

import { getDb } from './client';
import { ingestHermesTranscriptForRun } from '../runtimes/hermesTranscriptIngestion';
import { resolveHermesProfileHome } from '../runtimes/hermes/HermesRuntime';
import { normalizeHermesRuntimeConfig, type HermesRuntimeConfig } from '../runtimes/hermes/config';
import { parseRuntimeConfigObject } from '../domains/agents/runtimeConfig';
import { type Db } from './adapter/types';
import * as fs from 'fs';
import * as path from 'path';

interface Candidate {
  instanceId: number;
  agentId: number;
  durableRunId: string | null;
  sessionKey: string | null;
  runtimeConfig: string | null;
}

interface Outcome {
  instanceId: number;
  status: 'repaired' | 'unchanged' | 'no-session-file' | 'bad-config' | 'error';
  rowsGrown?: number;
  charsRecovered?: number;
  detail?: string;
}

async function findCandidates(db: Db, onlyInstance: number | null): Promise<Candidate[]> {
  const rows = (await db.all(
    `SELECT DISTINCT ji.id AS "instanceId",
            ji.agent_id  AS "agentId",
            ji.durable_run_id AS "durableRunId",
            ji.session_key    AS "sessionKey",
            a.runtime_config  AS "runtimeConfig"
     FROM chat_messages cm
     JOIN job_instances ji ON ji.id = cm.instance_id
     JOIN agents a ON a.id = ji.agent_id
     WHERE cm.id LIKE 'hermes-json-%'
       ${onlyInstance != null ? 'AND ji.id = ?' : ''}
     ORDER BY ji.id`,
    ...(onlyInstance != null ? [onlyInstance] : []),
  )) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    instanceId: Number(row.instanceId),
    agentId: Number(row.agentId),
    durableRunId: (row.durableRunId as string | null) ?? null,
    sessionKey: (row.sessionKey as string | null) ?? null,
    runtimeConfig: (row.runtimeConfig as string | null) ?? null,
  }));
}

/** Content length per row id, so growth can be measured rather than assumed. */
async function snapshot(db: Db, instanceId: number): Promise<Map<string, number>> {
  const rows = (await db.all(
    "SELECT id, length(content) AS len FROM chat_messages WHERE instance_id = ? AND id LIKE 'hermes-json-%'",
    instanceId,
  )) as Array<{ id: string; len: number }>;
  return new Map(rows.map((r) => [r.id, Number(r.len)]));
}

async function processCandidate(db: Db, candidate: Candidate, apply: boolean): Promise<Outcome> {
  let hermesHome: string;
  let profile: string;
  try {
    const config = normalizeHermesRuntimeConfig(
      (parseRuntimeConfigObject(candidate.runtimeConfig) ?? {}) as HermesRuntimeConfig,
    );
    profile = config.profile;
    hermesHome = resolveHermesProfileHome(config);
  } catch (err) {
    return {
      instanceId: candidate.instanceId,
      status: 'bad-config',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!fs.existsSync(path.join(hermesHome, 'sessions'))) {
    return { instanceId: candidate.instanceId, status: 'no-session-file', detail: hermesHome };
  }

  if (!apply) {
    return { instanceId: candidate.instanceId, status: 'unchanged', detail: 'dry run' };
  }

  const before = await snapshot(db, candidate.instanceId);
  try {
    await ingestHermesTranscriptForRun({
      db,
      agentId: candidate.agentId,
      profile,
      hermesHome,
      instanceId: candidate.instanceId,
      durableRunId: candidate.durableRunId,
      sessionKey: candidate.sessionKey ?? '',
    });
  } catch (err) {
    return {
      instanceId: candidate.instanceId,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const after = await snapshot(db, candidate.instanceId);
  let rowsGrown = 0;
  let charsRecovered = 0;
  for (const [id, length] of after) {
    const previous = before.get(id) ?? 0;
    if (length > previous) {
      rowsGrown += 1;
      charsRecovered += length - previous;
    }
  }

  return {
    instanceId: candidate.instanceId,
    status: rowsGrown > 0 ? 'repaired' : 'unchanged',
    rowsGrown,
    charsRecovered,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const instanceFlag = argv.indexOf('--instance');
  const onlyInstance = instanceFlag >= 0 ? Number(argv[instanceFlag + 1]) : null;

  const db = getDb();
  const candidates = await findCandidates(db, Number.isFinite(onlyInstance) ? onlyInstance : null);

  console.log(
    `[backfill] ${candidates.length} instance(s) with Hermes transcript rows; mode=${apply ? 'APPLY' : 'dry-run'}`,
  );

  const outcomes: Outcome[] = [];
  for (const candidate of candidates) {
    const outcome = await processCandidate(db, candidate, apply);
    outcomes.push(outcome);
    const extra =
      outcome.status === 'repaired'
        ? ` (+${outcome.rowsGrown} row(s), +${outcome.charsRecovered} chars)`
        : outcome.detail
          ? ` (${outcome.detail})`
          : '';
    console.log(`  instance ${outcome.instanceId}: ${outcome.status}${extra}`);
  }

  const tally = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.status] = (acc[o.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[backfill] ${JSON.stringify(tally)}`);
  if (!apply && candidates.length > 0) {
    console.log('[backfill] re-run with --apply to write repairs');
  }

  await db.close();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[backfill] failed:', err);
    process.exit(1);
  });
}

export { findCandidates, processCandidate };
export type { Candidate, Outcome };
