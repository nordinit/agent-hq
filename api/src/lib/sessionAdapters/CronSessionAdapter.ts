/**
 * sessionAdapters/CronSessionAdapter.ts
 *
 * Adapter for cron-dispatched isolated runs (agentTurn jobs).
 *
 * Source of truth:
 *   ~/.openclaw/cron/runs/<jobId>.jsonl
 *
 * Each line is a JSON object with the run completion record:
 *   { ts, jobId, action, status, summary, sessionId, sessionKey, runAtMs,
 *     durationMs, model, provider, usage, ... }
 *
 * Session key format:
 *   cron:<jobId>:<timestamp>  (Agent HQ canonical key for cron runs)
 *   agent:main:cron:<jobId>:run:<uuid>  (OpenClaw native key stored in run JSONL)
 *
 * Live chat: not supported — cron runs are non-interactive.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { SessionAdapter, AdapterSource, IngestResult, LiveChatInfo, SessionUpsert, SessionMessageInput } from './types';

const HOME = process.env.HOME ?? os.homedir();
const OPENCLAW_DIR = process.env.OPENCLAW_DIR ?? path.join(HOME, '.openclaw');
const CRON_RUNS_DIR = path.join(OPENCLAW_DIR, 'cron', 'runs');

interface CronRunRecord {
  ts?: number;
  jobId?: string;
  action?: string;
  status?: string;
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  model?: string;
  provider?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  deliveryStatus?: string;
  delivered?: boolean;
  nextRunAtMs?: number;
}

function parseJsonLine(line: string): CronRunRecord | null {
  try { return JSON.parse(line) as CronRunRecord; }
  catch { return null; }
}

function mapCronStatus(record: CronRunRecord): 'active' | 'completed' | 'failed' | 'abandoned' {
  if (record.action === 'finished') {
    return record.status === 'ok' ? 'completed' : 'failed';
  }
  return 'active';
}

/**
 * Resolve job ID from an externalKey.
 * Accepted formats:
 *   cron:<jobId>:<timestamp>  (Agent HQ canonical)
 *   cron:<jobId>              (partial)
 *   <jobId>                   (bare UUID, used when we know we're in CronAdapter)
 */
function extractJobId(externalKey: string): string | null {
  // Agent HQ canonical: cron:<jobId>:<ts>
  const canonicalMatch = externalKey.match(/^cron:([^:]+)(?::\d+)?$/);
  if (canonicalMatch) return canonicalMatch[1];
  // If it looks like a plain UUID (no colons)
  if (/^[0-9a-f-]{36}$/i.test(externalKey)) return externalKey;
  return null;
}

function buildCanonicalKey(jobId: string, runAtMs: number): string {
  return `cron:${jobId}:${runAtMs}`;
}

export class CronSessionAdapter implements SessionAdapter {
  readonly runtime = 'cron';

  async ingest(source: AdapterSource): Promise<IngestResult | null> {
    const { externalKey } = source;

    const jobId = extractJobId(externalKey);
    if (!jobId) return null;

    const jsonlPath = path.join(CRON_RUNS_DIR, `${jobId}.jsonl`);
    if (!fs.existsSync(jsonlPath)) return null;

    const raw = fs.readFileSync(jsonlPath, 'utf-8');
    const lines = raw.split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;

    // The last line is the most recent (and typically only) completion record
    const record = parseJsonLine(lines[lines.length - 1]);
    if (!record) return null;

    const runAtMs = record.runAtMs ?? record.ts ?? Date.now();
    const canonicalKey = buildCanonicalKey(jobId, runAtMs);
    const effectiveKey = externalKey === canonicalKey ? externalKey : canonicalKey;

    const status = mapCronStatus(record);
    const startedAt = new Date(runAtMs).toISOString();
    const endedAt = record.ts ? new Date(record.ts).toISOString() : undefined;

    const tokenInput = (record.usage?.input_tokens ?? 0) + (record.usage?.cache_creation_input_tokens ?? 0);
    const tokenOutput = record.usage?.output_tokens ?? 0;

    const session: SessionUpsert = {
      externalKey: effectiveKey,
      runtime: this.runtime,
      agentId: source.agentId ?? null,
      taskId: source.taskId ?? null,
      instanceId: source.instanceId ?? null,
      projectId: source.projectId ?? null,
      status,
      title: `Cron run ${jobId.slice(0, 8)}`,
      startedAt,
      endedAt,
      tokenInput: tokenInput > 0 ? tokenInput : undefined,
      tokenOutput: tokenOutput > 0 ? tokenOutput : undefined,
      metadata: {
        job_id: jobId,
        session_key: record.sessionKey ?? null,
        session_id: record.sessionId ?? null,
        model: record.model ?? null,
        provider: record.provider ?? null,
        cron_status: record.status ?? null,
        delivery_status: record.deliveryStatus ?? null,
      },
    };

    // Build messages from the run records (one per JSONL line)
    const messages: SessionMessageInput[] = [];
    lines.forEach((line, idx) => {
      const r = parseJsonLine(line);
      if (!r) return;

      const ts = r.ts ? new Date(r.ts).toISOString() : new Date(r.runAtMs ?? Date.now()).toISOString();

      // Summary is the primary human-readable content
      if (r.summary) {
        messages.push({
          ordinal: idx * 2,
          role: 'assistant',
          eventType: 'text',
          content: r.summary,
          eventMeta: {
            model: r.model,
            provider: r.provider,
            usage: r.usage,
          },
          rawPayload: line,
          timestamp: ts,
        });
      }

      // Error as a separate event if present
      if (r.error) {
        messages.push({
          ordinal: idx * 2 + 1,
          role: 'system',
          eventType: 'error',
          content: r.error,
          eventMeta: { job_id: r.jobId, delivery_status: r.deliveryStatus },
          rawPayload: line,
          timestamp: ts,
        });
      }

      // If no summary or error, emit a system event with the raw record
      if (!r.summary && !r.error && r.action) {
        messages.push({
          ordinal: idx * 2,
          role: 'system',
          eventType: 'system',
          content: `Cron run ${r.action}: ${r.status ?? 'unknown'}`,
          eventMeta: { job_id: r.jobId, action: r.action, status: r.status },
          rawPayload: line,
          timestamp: ts,
        });
      }
    });

    return { session, messages };
  }

  async resolveLiveChat(_externalKey: string): Promise<LiveChatInfo | null> {
    // Cron runs are non-interactive
    return null;
  }
}
