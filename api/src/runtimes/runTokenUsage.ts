import type { Db } from '../db/adapter/types';

export interface RuntimeTokenCounts {
  inputTokens: number;
  outputTokens: number;
  /** Kept separately because Codex includes cache reads in input and Claude Code reports them separately. */
  cachedInputTokens: number | null;
}

export type RuntimeTokenUsage =
  | { status: 'recorded'; counts: RuntimeTokenCounts }
  | { status: 'partial'; counts: RuntimeTokenCounts; reason: string }
  | { status: 'unavailable'; reason: string };

export function runtimeTokenUsage(
  final: RuntimeTokenCounts | null,
  partial: RuntimeTokenCounts | null = null,
): RuntimeTokenUsage {
  if (final) return { status: 'recorded', counts: final };
  if (partial) return { status: 'partial', counts: partial, reason: 'final_usage_not_reported' };
  return { status: 'unavailable', reason: 'runtime_usage_not_reported' };
}

/** Replace a per-run snapshot independently of semantic outcome and runtime lifecycle status. */
export async function persistRunTokenUsage(db: Db, instanceId: number, usage: RuntimeTokenUsage): Promise<void> {
  const counts = 'counts' in usage ? usage.counts : null;
  await db.run(`
    UPDATE job_instances
    SET token_input = COALESCE(?, token_input),
        token_output = COALESCE(?, token_output),
        token_total = COALESCE(?, token_total),
        token_cached_input = COALESCE(?, token_cached_input),
        token_usage_status = ?,
        token_usage_reason = ?
    WHERE id = ?
      AND (COALESCE(token_usage_status, '') <> 'recorded' OR ? = 'recorded')
      AND (? <> 'unavailable' OR (token_input IS NULL AND token_output IS NULL AND token_total IS NULL))
  `, counts?.inputTokens ?? null, counts?.outputTokens ?? null,
  counts ? counts.inputTokens + counts.outputTokens : null, counts?.cachedInputTokens ?? null,
  usage.status, 'reason' in usage ? usage.reason : null, instanceId, usage.status, usage.status);
}

/** Serialize stream writes, and retry the last snapshot on process exit if its write failed. */
export function createRunTokenUsageReporter(
  db: Db | null,
  instanceId: number | null,
  onError: (error: unknown) => void,
): (usage: RuntimeTokenUsage) => Promise<void> {
  let pending = Promise.resolve();
  let persisted: string | null = null;
  return usage => {
    if (!db || instanceId == null) return pending;
    const snapshot = JSON.stringify(usage);
    pending = pending.then(async () => {
      if (persisted === snapshot) return;
      try {
        await persistRunTokenUsage(db, instanceId, usage);
        persisted = snapshot;
      } catch (error) {
        onError(error);
      }
    });
    return pending;
  };
}
