/**
 * runtimes/transcript/writer.ts — the shared chat_messages write path.
 *
 * Six code paths currently mint chat_messages rows with hand-rolled upsert SQL,
 * hand-rolled optional-column probing, and their own role handling. This is the
 * part that is genuinely common; ./events.ts covers the other (block decoding).
 *
 * Deliberate non-goals, each because the spec work turned up a way it bites:
 *
 *  - It does NOT touch `raw_payload`. That column carries two incompatible
 *    meanings — real source JSON from one path, and `String(chat_messages.id)`
 *    from `syncSessionMessagesFromChatMessages`, which USES IT AS THE DEDUPE KEY.
 *    Writing real JSON there for a runtime that also writes chat_messages makes
 *    that dedupe stop matching and every sync re-appends the whole transcript.
 *
 *  - It derives `tenant_id` from the owning instance/agent when the schema has
 *    that column. Runtime transcript rows are tenant-owned operational data;
 *    they must never fall back to the active/default tenant.
 *
 *  - It does NOT own discovery, resume offsets, or session_messages ordinals.
 */

import { type Db } from '../../db/adapter/types';
import { normalizeChatMessageRole } from '../../lib/chatMessageRoles';
import { nowTimestamp, toCanonicalTimestampOrNow } from '../../lib/timestamps';
import { requireRuntimeTenantId } from '../../lib/runtimeTenantScope';
import { tableHasColumn } from '../../domains/routing/scope';
import type { RuntimeTranscriptEvent } from './events';

export interface TranscriptWriterOptions {
  db: Db;
  agentId: number;
  instanceId: number;
  /** Prefix for deterministic row ids, e.g. `claude-code`. */
  idPrefix: string;
  sessionKey?: string | null;
  durableRunId?: string | null;
  /** Explicit ownership when the caller already loaded it; otherwise derived strictly. */
  tenantId?: number | null;
}

export interface TranscriptWriteResult {
  written: number;
  failed: number;
}

/**
 * Buffered, order-preserving writer for one run's transcript.
 *
 * `write()` is safe to call from a stream handler: calls are serialized onto an
 * internal promise chain so two chunks cannot interleave their row indices, and
 * a failure is logged rather than thrown — losing a transcript row must never
 * take down the run that produced it.
 */
export class RuntimeTranscriptWriter {
  private readonly options: TranscriptWriterOptions;
  private nextIndex = 0;
  private queue: Promise<void> = Promise.resolve();
  private optionalColumns: { durableRunId: boolean; sessionKey: boolean; tenantId: boolean } | null =
    null;
  private resolvedTenantId: number | null = null;
  private writtenCount = 0;
  private failedCount = 0;

  constructor(options: TranscriptWriterOptions) {
    this.options = options;
  }

  /** Rows successfully written so far. */
  get written(): number {
    return this.writtenCount;
  }

  /** Rows that could not be written. Non-zero means the transcript is lossy. */
  get failed(): number {
    return this.failedCount;
  }

  /**
   * Enqueue events. Returns immediately; await `drain()` for completion.
   *
   * Row indices are assigned synchronously here rather than inside the async
   * body, so ids reflect arrival order even under concurrent callers.
   */
  enqueue(events: readonly RuntimeTranscriptEvent[]): void {
    if (events.length === 0) return;
    const indexed = events.map((event) => ({ event, index: this.nextIndex++ }));
    this.queue = this.queue.then(async () => {
      for (const { event, index } of indexed) {
        await this.writeOne(event, index);
      }
    });
  }

  /** Wait for every enqueued write to finish. */
  async drain(): Promise<TranscriptWriteResult> {
    await this.queue;
    return { written: this.writtenCount, failed: this.failedCount };
  }

  /**
   * Probe which optional columns exist.
   *
   * Keep optional-column probing for narrow compatibility fixtures and imported historical
   * rows. The production PostgreSQL schema itself is owned by numbered migrations.
   */
  private async resolveOptionalColumns(): Promise<{
    durableRunId: boolean;
    sessionKey: boolean;
    tenantId: boolean;
  }> {
    if (this.optionalColumns) return this.optionalColumns;
    const { db } = this.options;
    const hasTenantColumn = await tableHasColumn(db, 'chat_messages', 'tenant_id');
    if (hasTenantColumn) {
      this.resolvedTenantId = this.options.tenantId ?? await requireRuntimeTenantId(db, {
        instanceId: this.options.instanceId,
        agentId: this.options.agentId,
      });
    }
    this.optionalColumns = {
      durableRunId: await tableHasColumn(db, 'chat_messages', 'durable_run_id'),
      sessionKey: await tableHasColumn(db, 'chat_messages', 'session_key'),
      tenantId: hasTenantColumn,
    };
    return this.optionalColumns;
  }

  private async writeOne(event: RuntimeTranscriptEvent, index: number): Promise<void> {
    const { db, agentId, instanceId, idPrefix } = this.options;

    try {
      const columns = await this.resolveOptionalColumns();

      const optionalNames: string[] = [];
      const optionalValues: unknown[] = [];
      if (columns.durableRunId) {
        optionalNames.push('durable_run_id');
        optionalValues.push(this.options.durableRunId ?? null);
      }
      if (columns.sessionKey) {
        optionalNames.push('session_key');
        optionalValues.push(this.options.sessionKey ?? '');
      }
      if (columns.tenantId) {
        optionalNames.push('tenant_id');
        optionalValues.push(this.resolvedTenantId);
      }
      const optionalSql = optionalNames.length > 0 ? `${optionalNames.join(', ')}, ` : '';
      const optionalPlaceholders = optionalNames.map(() => '?').join(', ');
      const optionalValuesSql = optionalNames.length > 0 ? `${optionalPlaceholders}, ` : '';

      // DO UPDATE, not DO NOTHING. Hermes uses DO NOTHING on a repeating poll,
      // which permanently freezes the first snapshot of a still-streaming
      // message — longer content for the same id is discarded forever.
      const sql = `
        INSERT INTO chat_messages (id, agent_id, instance_id, ${optionalSql}role, content, timestamp, event_type, event_meta)
        VALUES (?, ?, ?, ${optionalValuesSql}?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          content = excluded.content,
          timestamp = excluded.timestamp,
          event_type = excluded.event_type,
          event_meta = excluded.event_meta
      `;

      await db.run(
        sql,
        `${idPrefix}-${instanceId}-${index}`,
        agentId,
        instanceId,
        ...optionalValues,
        resolveRole(event),
        event.content,
        event.timestamp ? toCanonicalTimestampOrNow(event.timestamp) : nowTimestamp(),
        event.kind,
        // `event_meta` is `text NOT NULL DEFAULT '{}'` in BOTH engines, so a
        // null here fails the constraint at insert time rather than defaulting.
        // An explicit '{}' is the only correct "no metadata" value.
        event.meta ? JSON.stringify(event.meta) : '{}',
      );
      this.writtenCount += 1;
    } catch (err) {
      this.failedCount += 1;
      console.warn(
        `[transcript] failed to write ${idPrefix}-${instanceId}-${index} (${event.kind}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

/**
 * Funnel a source role into one the CHECK constraint accepts.
 *
 * `turn_end` is special-cased here rather than at each call site.
 * normalizeChatMessageRole maps an unknown/absent role to 'assistant', so a
 * turn_end row would land as 'assistant'; openclawJsonlBackfill already
 * hard-codes the same correction inline. Keeping it in the shared funnel is what
 * stops each migrated writer from silently flipping turn_end rows to 'assistant'.
 */
export function resolveRole(event: RuntimeTranscriptEvent): string {
  if (event.kind === 'turn_end' || event.kind === 'system') return 'system';

  // A tool_result is role `tool` by definition, whatever the source said. This
  // is not redundant with the funnel below: normalizeChatMessageRole returns
  // early on `role === 'user'` before it ever looks at the event type, and
  // tool_result blocks arrive inside USER messages. Relying on each decoder to
  // set the hint correctly would make one omission silently mis-role every tool
  // output in that runtime's transcript.
  if (event.kind === 'tool_result') return 'tool';

  return normalizeChatMessageRole(event.role, event.kind);
}
