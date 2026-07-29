import type Database from 'better-sqlite3';

/**
 * Foreign-key enforcement guard for the shared SQLite connection.
 *
 * db/client.ts hands out a process-wide singleton connection and
 * `PRAGMA foreign_keys` is per-connection, so a single leaked
 * `PRAGMA foreign_keys = OFF` disables ON DELETE CASCADE for every query the
 * process runs afterwards. That defect shipped: deletes stopped cascading and
 * orphan rows accumulated silently in production.
 *
 * This module owns both halves of the fix — the safe way to disable enforcement
 * temporarily, and the bookkeeping that lets the startup tripwire tell an
 * intentional disable window apart from a leak.
 *
 * It deliberately has no imports beyond the better-sqlite3 type: schema.ts,
 * lib/tenantContext.ts and db/startupVerifier.ts all depend on it, and anything
 * heavier would create an import cycle.
 */

/**
 * Depth of currently-open intentional disable windows.
 *
 * Schema and tenant migrations legitimately need enforcement off while they
 * rebuild tables, and those windows nest — initSchema() disables enforcement for
 * its legacy workflow-policy DDL and then calls ensureTenantSchema(), which runs
 * its own rebuilds. A counter rather than a boolean means an inner window closing
 * does not falsely signal that the outer one has finished.
 */
let disableDepth = 0;

/** True while a deliberate, tracked disable window is open. */
export function foreignKeyEnforcementIntentionallyDisabled(): boolean {
  return disableDepth > 0;
}

/**
 * Opens an intentional disable window WITHOUT touching the pragma.
 *
 * For callers that must issue `PRAGMA foreign_keys = OFF` themselves and restore
 * it far away in the same function — initSchema()'s legacy workflow-policy DDL
 * spans several hundred lines and cannot be expressed as a callback. Every call
 * must be paired with endIntentionalForeignKeyDisable() in a finally block.
 */
export function beginIntentionalForeignKeyDisable(): void {
  disableDepth++;
}

/** Closes a window opened by beginIntentionalForeignKeyDisable(). */
export function endIntentionalForeignKeyDisable(): void {
  disableDepth = Math.max(0, disableDepth - 1);
}

/** Reads the live PRAGMA foreign_keys state of a connection. */
export function foreignKeysEnabled(db: Database.Database): boolean {
  return Number(db.pragma('foreign_keys', { simple: true })) === 1;
}

/**
 * Runs `fn` with foreign-key enforcement disabled, then restores the PRIOR pragma
 * value — never a hardcoded ON — even if `fn` throws.
 *
 * Every table-rebuild site that needs enforcement off should go through this.
 *
 * SQLite treats `PRAGMA foreign_keys` as a NO-OP inside a transaction, so this must
 * be called OUTSIDE db.transaction(). Both the disable and the restore are verified
 * and reported loudly if they did not take effect.
 */
export function withForeignKeysDisabled<T>(db: Database.Database, fn: () => T): T {
  const wasEnabled = foreignKeysEnabled(db);
  if (wasEnabled) {
    db.pragma('foreign_keys = OFF');
    if (foreignKeysEnabled(db)) {
      console.error(
        '[db] PRAGMA foreign_keys = OFF did not take effect' +
        `${db.inTransaction ? ' (called inside a transaction, where the pragma is a no-op)' : ''}` +
        ' — the enclosed rebuild is running WITH foreign keys enforced.'
      );
    }
  }
  beginIntentionalForeignKeyDisable();
  try {
    return fn();
  } finally {
    endIntentionalForeignKeyDisable();
    if (wasEnabled) {
      db.pragma('foreign_keys = ON');
      if (!foreignKeysEnabled(db)) {
        console.error(
          '[db] FAILED to restore PRAGMA foreign_keys = ON' +
          `${db.inTransaction ? ' (still inside a transaction, where the pragma is a no-op)' : ''}` +
          ' — foreign-key enforcement is OFF for this connection.'
        );
      }
    }
  }
}
