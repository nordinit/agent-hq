/**
 * runtimes/WebhookRuntime.ts — Generic HTTP webhook AgentRuntime adapter.
 *
 * Dispatches tasks by POSTing a structured payload to any configured URL.
 * Designed for future runtimes that expose an HTTP endpoint (e.g. a self-hosted
 * Claude Code server, a custom agent framework, etc.).
 *
 * Dispatch payload:
 *   { message, agentId, sessionKey, timeoutSeconds, name, instanceId, taskId }
 *
 * The remote endpoint MUST respond with { runId: string }.
 *
 * Abort (optional): POST to abortUrl with { runId, sessionKey }.
 * If abortUrl is not configured, abort() is a no-op.
 */

import type { AgentRuntime, DispatchParams, PrepareAuthProfilesParams, RuntimeAuthProfileSyncResult } from './types';
import { skippedRuntimeAuthProfileSync } from './types';

// ── Config ───────────────────────────────────────────────────────────────────

export interface WebhookRuntimeConfig {
  /** POST endpoint to dispatch agent runs (required). */
  dispatchUrl: string;
  /** Optional Authorization header value, e.g. "Bearer sk-..." */
  authHeader?: string;
  /** Optional URL to POST abort requests. If absent, abort() is a no-op. */
  abortUrl?: string;
  /** Request timeout in milliseconds (default: 30 000). */
  timeoutMs?: number;
  /** Additional arbitrary config fields. */
  [key: string]: unknown;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface DispatchPayload {
  message: string;
  agentId: string;
  sessionKey: string;
  timeoutSeconds: number;
  name: string;
  instanceId: number | null;
  taskId: number | null;
}

interface AbortPayload {
  runId: string;
  sessionKey: string;
}

interface DispatchResponse {
  runId: string;
}

// ── Runtime ──────────────────────────────────────────────────────────────────

export class WebhookRuntime implements AgentRuntime {
  private config: WebhookRuntimeConfig;

  constructor(config: WebhookRuntimeConfig) {
    if (!config.dispatchUrl) {
      throw new Error('WebhookRuntime: dispatchUrl is required in runtime_config');
    }
    if (config.lifecycleProxy !== undefined) {
      throw new Error(
        'WebhookRuntime: runtime_config.lifecycleProxy is no longer supported; use Agent HQ MCP/capability lifecycle tools instead',
      );
    }
    this.config = config;
  }

  async prepareAuthProfiles(_params: PrepareAuthProfilesParams): Promise<RuntimeAuthProfileSyncResult> {
    return skippedRuntimeAuthProfileSync('Webhook runtime does not use local runtime auth profiles.');
  }

  /**
   * dispatch — POST dispatchUrl with the task payload.
   *
   * Expects { runId: string } in the response body.
   * Throws on network errors or non-2xx responses so the dispatcher can retry.
   * Semantic lifecycle outcomes are not inferred from response text; remote
   * agents must report through Agent HQ MCP/capability tools.
   */
  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    const {
      message,
      agentSlug,
      sessionKey,
      timeoutSeconds,
      name,
      instanceId,
      taskId,
    } = params;

    const body: DispatchPayload = {
      message,
      agentId: agentSlug,
      sessionKey,
      timeoutSeconds,
      name,
      instanceId: instanceId ?? null,
      taskId: taskId ?? null,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.authHeader) {
      headers['Authorization'] = this.config.authHeader;
    }

    const timeoutMs = this.config.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let resp: Response;
    try {
      resp = await fetch(this.config.dispatchUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `WebhookRuntime: POST ${this.config.dispatchUrl} failed — ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `WebhookRuntime: POST ${this.config.dispatchUrl} returned ${resp.status}: ${text.slice(0, 500)}`,
      );
    }

    const result = (await resp.json().catch(() => ({}))) as Partial<DispatchResponse>;
    const runId = typeof result.runId === 'string' ? result.runId : '';

    return { runId };
  }

  /**
   * abort — POST abortUrl with { runId, sessionKey } if configured.
   *
   * Resolves (does not throw) even if the remote is unreachable or the run is
   * already gone, so the dispatcher is never blocked by abort failures.
   */
  async abort(runId: string, sessionKey: string): Promise<void> {
    if (!this.config.abortUrl) {
      return;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.authHeader) {
      headers['Authorization'] = this.config.authHeader;
    }

    const body: AbortPayload = { runId, sessionKey };
    const timeoutMs = this.config.timeoutMs ?? 30_000;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        await fetch(this.config.abortUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Best-effort abort: dispatcher should not fail because abort transport failed.
    }
  }
}
