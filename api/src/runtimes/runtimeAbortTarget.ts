import type { RuntimeAbortTarget } from './types';

export function readRuntimeAbortTarget(value: unknown): RuntimeAbortTarget | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const target = parsed as Record<string, unknown>;
  if (![target.runtimeType, target.runId, target.sessionKey].every(
    part => typeof part === 'string' && part.trim().length > 0,
  )) return null;
  return target as unknown as RuntimeAbortTarget;
}

/** Older OpenClaw task dispatches saved the gateway run ID only in response. */
export function readLegacyRuntimeRunId(instance: Record<string, unknown>): string {
  if (typeof instance.run_id === 'string' && instance.run_id.trim()) return instance.run_id.trim();
  let response = instance.response;
  if (typeof response === 'string') {
    try { response = JSON.parse(response); } catch { return ''; }
  }
  if (!response || typeof response !== 'object') return '';
  const runId = (response as Record<string, unknown>).runId;
  return typeof runId === 'string' ? runId.trim() : '';
}
