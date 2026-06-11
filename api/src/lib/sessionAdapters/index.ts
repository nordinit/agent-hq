/**
 * sessionAdapters/index.ts — Adapter registry and factory.
 *
 * resolveSessionAdapter(runtime) returns the adapter for the given runtime.
 * ingestSession(source) attempts all applicable adapters if runtime is unknown.
 */

export type { SessionAdapter, AdapterSource, IngestResult, SessionUpsert, SessionMessageInput, LiveChatInfo } from './types';

import { OpenClawSessionAdapter } from './OpenClawSessionAdapter';
import { CronSessionAdapter } from './CronSessionAdapter';
import { ClaudeCodeSessionAdapter } from './ClaudeCodeSessionAdapter';
import type { SessionAdapter } from './types';

// ── Registry ─────────────────────────────────────────────────────────────────

const ADAPTERS: SessionAdapter[] = [
  new OpenClawSessionAdapter(),
  new CronSessionAdapter(),
  new ClaudeCodeSessionAdapter(),
];

const ADAPTER_MAP = new Map<string, SessionAdapter>(
  ADAPTERS.map(a => [a.runtime, a]),
);

/**
 * resolveSessionAdapter — get the adapter for a known runtime string.
 * Returns null if no adapter is registered for that runtime.
 */
export function resolveSessionAdapter(runtime: string): SessionAdapter | null {
  return ADAPTER_MAP.get(runtime) ?? null;
}

/**
 * resolveSessionAdapterForKey — infer the adapter from an externalKey format.
 *
 * Key patterns:
 *   claude-code:<uuid>    → ClaudeCodeSessionAdapter
 *   cron:<jobId>...       → CronSessionAdapter
 *   run:<instanceId>      → OpenClawSessionAdapter
 *   hook:atlas:jobrun:... → OpenClawSessionAdapter (legacy)
 *   agent:...:cron:...    → CronSessionAdapter (cron run via openclaw)
 *   anything else         → OpenClawSessionAdapter (default)
 */
export function resolveSessionAdapterForKey(externalKey: string): SessionAdapter {
  if (externalKey.startsWith('claude-code:')) {
    return ADAPTER_MAP.get('claude-code')!;
  }
  if (externalKey.startsWith('cron:')) {
    return ADAPTER_MAP.get('cron')!;
  }
  // OpenClaw-dispatched cron runs embed cron job id in the session key
  // format: agent:main:cron:<jobId>:run:<uuid>
  if (externalKey.includes(':cron:') && externalKey.includes(':run:')) {
    return ADAPTER_MAP.get('cron')!;
  }
  // Default: openclaw
  return ADAPTER_MAP.get('openclaw')!;
}

export { OpenClawSessionAdapter, CronSessionAdapter, ClaudeCodeSessionAdapter };
