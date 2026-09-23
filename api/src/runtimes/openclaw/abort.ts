import type { RuntimeAbortContext, RuntimeAbortResult } from '../types';
import { gatewayRpcCall } from './gatewayClient';

export function resolveOpenClawSessionKey(sessionKey: string, agentSessionKey?: string | null): string | null {
  const key = sessionKey.trim();
  if (/^agent:[^:]+:.+/.test(key)) return key;
  // Never fall back to the agent's main session when the instance has no target.
  const slug = agentSessionKey?.match(/^agent:([^:]+)(?::|$)/)?.[1];
  return key && slug ? `agent:${slug}:${key}` : null;
}

/** RPC acceptance is not cancellation: OpenClaw can return ok with aborted=false. */
export async function abortOpenClawRun(
  runId: string,
  sessionKey: string,
  context?: RuntimeAbortContext,
): Promise<RuntimeAbortResult> {
  const canonicalKey = resolveOpenClawSessionKey(sessionKey,
    context?.agentRuntimeSlug ? `agent:${context.agentRuntimeSlug}:main` : context?.agentSessionKey);
  if (!runId.trim() || !canonicalKey) {
    return {
      attempted: false, ok: false, confirmed: false, status: 'not_found',
      error: 'OpenClaw cancellation requires an exact run ID and agent-scoped session key',
    };
  }
  try {
    const result = await gatewayRpcCall({
      method: 'chat.abort',
      rpcParams: { sessionKey: canonicalKey, runId },
      timeoutMs: 10_000,
      displayName: 'Agent HQ Runtime',
      ...(context?.target?.endpoint ? { gatewayUrl: context.target.endpoint } : {}),
    });
    if (!result.ok) throw new Error(result.error ?? 'chat.abort failed');
    const payload = (result.payload ?? result.result) as Record<string, unknown> | undefined;
    if (payload?.ok === true && payload.aborted === true
      && Array.isArray(payload.runIds) && payload.runIds.includes(runId)) {
      return { attempted: true, ok: true, confirmed: true, status: 'signalled' };
    }
    if (payload?.ok === true && payload.aborted === false && Array.isArray(payload.runIds) && payload.runIds.length === 0) {
      // A no-op abort alone proves nothing. Ask for an exact-run terminal
      // snapshot; gateway cache misses/timeouts remain explicitly uncertain.
      const inspection = await gatewayRpcCall({
        method: 'agent.wait', rpcParams: { runId, timeoutMs: 0 }, timeoutMs: 2_000,
        ...(context?.target?.endpoint ? { gatewayUrl: context.target.endpoint } : {}),
      });
      const terminal = (inspection.payload ?? inspection.result) as Record<string, unknown> | undefined;
      if (inspection.ok && terminal?.runId === runId
        && (terminal.status === 'ok' || terminal.status === 'error')
        && typeof terminal.endedAt === 'number' && Number.isFinite(terminal.endedAt) && terminal.endedAt > 0) {
        return { attempted: true, ok: true, confirmed: true, status: 'already_gone' };
      }
    }
    return {
      attempted: true, ok: false, confirmed: false, status: 'not_found',
      error: 'OpenClaw did not confirm cancellation of the requested run; runtime state is uncertain',
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      attempted: true, ok: false, confirmed: false,
      status: /timed?\s*out|timeout|ETIMEDOUT/i.test(error) ? 'timed_out' : 'failed',
      error,
    };
  }
}
