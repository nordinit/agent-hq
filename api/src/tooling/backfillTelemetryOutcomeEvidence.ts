import { getDb, closeDb } from '../db/client';

/** Upgrade existing history in short transactions; new rows are trigger-filled. */
async function main() {
  const db = getDb(); let count = 0;
  for (;;) {
    const rows = await db.all<{ id: number }>(`WITH batch AS (
      SELECT id FROM telemetry_observations WHERE outcome_evidence IS NULL
      ORDER BY id LIMIT 500 FOR UPDATE SKIP LOCKED
    ) UPDATE telemetry_observations o SET outcome_evidence=telemetry_outcome_evidence(o.payload)
      FROM batch WHERE o.id=batch.id RETURNING o.id`);
    count += rows.length;
    if (!rows.length) break;
    if (count % 10000 === 0) console.log(`Projected ${count} observations`);
  }
  const pending = await db.value<string>('SELECT count(*)::text FROM telemetry_observations WHERE outcome_evidence IS NULL');
  console.log(JSON.stringify({ projected: count, pending: Number(pending) }));
  if (Number(pending)) process.exitCode = 1;
}
main().catch(error => { console.error('Telemetry evidence backfill failed', error.code ?? 'unknown'); process.exitCode = 1; }).finally(closeDb);
