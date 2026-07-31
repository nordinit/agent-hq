/**
 * lib/openclawHistoryRows.ts — shared cleanup for OpenClaw history transcript rows.
 *
 * `oc-hist-<scope>-<n>` rows are written by four different code paths, each of
 * which rewrites the WHOLE history from index 0. Two of them deleted the range
 * first; two did not. A refresh that produces fewer rows than the previous one
 * therefore left the tail behind, so a conversation that got shorter (a trimmed
 * gateway history, a re-fetch that returned less) kept showing stale messages
 * from the longer version, interleaved by index.
 *
 * The trim below is deliberately a tail trim rather than the delete-everything
 * approach the other two writers use. Rows 0..keepCount-1 are rewritten by the
 * caller's upsert anyway, so deleting them first only creates a window where the
 * transcript is empty or partial — visible to anything reading concurrently.
 * Removing just the orphaned tail is the smallest correct operation.
 */

import { type Db } from '../db/adapter/types';

/** Scope segment of the row id: an instance id, or a durable/derived chat scope. */
export type OpenClawHistoryScope = string | number;

export function openClawHistoryRowId(scope: OpenClawHistoryScope, index: number): string {
  return `oc-hist-${scope}-${index}`;
}

/**
 * Delete `oc-hist-<scope>-<n>` rows with n >= keepCount.
 *
 * Returns how many rows were removed. Never throws: a failed cleanup leaves
 * stale rows, which is strictly better than failing the transcript write that
 * just succeeded.
 */
export async function trimOpenClawHistoryRows(
  db: Db,
  scope: OpenClawHistoryScope,
  keepCount: number,
): Promise<number> {
  try {
    // The LIKE prefix is exact enough to avoid neighbouring scopes: the pattern
    // `oc-hist-42-%` cannot match `oc-hist-421-0`, because the character after
    // `42` must be the literal `-`.
    const rows = (await db.all(
      'SELECT id FROM chat_messages WHERE id LIKE ?',
      `${openClawHistoryRowId(scope, 0).slice(0, -1)}%`,
    )) as Array<{ id?: unknown }>;

    const stale: string[] = [];
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : null;
      if (!id) continue;
      const match = id.match(/-(\d+)$/);
      if (!match) continue;
      if (Number(match[1]) >= keepCount) stale.push(id);
    }

    for (const id of stale) {
      await db.run('DELETE FROM chat_messages WHERE id = ?', id);
    }
    return stale.length;
  } catch (err) {
    console.warn(
      `[openclaw-history] failed to trim stale rows for scope ${scope}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }
}
