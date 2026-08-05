/**
 * runtimes/OpenClawRuntime.ts — AgentRuntime backed by the OpenClaw gateway.
 *
 * Contains the dispatch and abort logic previously inlined in dispatcher.ts
 * (fireAgentRun) and integrations/openclaw.ts (abortChatRunBySessionKey).
 * The dispatcher now calls this via the AgentRuntime interface.
 */

import { spawnSync } from 'child_process';
import type {
  AgentRuntime,
  DispatchParams,
  PrepareAuthProfilesParams,
  RuntimeAuthProfileSyncResult,
  RuntimeEndEvent,
} from '../types';
import { skippedRuntimeAuthProfileSync } from '../types';
import { getDb } from '../../db/client';
import { startTranscriptCapture, stopTranscriptCapture } from '../../lib/gatewayTranscriptCapture';
import { tableHasColumn } from '../../lib/durableRunIdentity';
import { syncOAuthProviderForOpenClawAgent } from '../../lib/openclawOAuthProfiles';
import { abortChatRunBySessionKey } from './abort';
import {
  gatewayWsGetEffectiveTools,
  gatewayWsPatchSession,
  gatewayWsSend,
  reloadOpenClawSecretsRuntimeForAuthSync,
} from './gatewayClient';
import { handleOpenClawRuntimeEnd } from './runtimeEnd';
import {
  startRawSessionTerminalPoll,
} from './transcript';
import { requireRuntimeTenantId } from '../../lib/runtimeTenantScope';
import { nowTimestamp } from '../../lib/timestamps';

function normalizeRepoContextValue(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function buildOpenClawRepoContextSection(params: {
  activeRepoRoot?: string | null;
  workspaceRoot?: string | null;
  repoAccessMode?: DispatchParams['repoAccessMode'];
  repoSource?: string | null;
  repoWorkspacePath?: string | null;
  repoBranch?: string | null;
  pathMetadata?: DispatchParams['pathMetadata'];
}): string | null {
  const activeRepoRoot = normalizeRepoContextValue(params.activeRepoRoot);
  const workspaceRoot = normalizeRepoContextValue(params.workspaceRoot);
  const repoWorkspacePath = normalizeRepoContextValue(params.repoWorkspacePath);
  const repoSource = normalizeRepoContextValue(params.repoSource);
  const repoBranch = normalizeRepoContextValue(params.repoBranch);
  const worktreeRoot = normalizeRepoContextValue(params.pathMetadata?.worktreeRoot);
  const runtimeConfigWorkingDirectory = normalizeRepoContextValue(params.pathMetadata?.runtimeConfigWorkingDirectory);
  const repoRootSource = params.pathMetadata?.repoRootSource ?? null;
  const workspaceRootSource = params.pathMetadata?.workspaceRootSource ?? null;
  const pathMode = params.pathMetadata?.pathMode
    ?? (activeRepoRoot ? 'active-repo-root' : workspaceRoot ? 'workspace-root' : null);
  const effectiveRepoRoot = activeRepoRoot ?? repoWorkspacePath ?? workspaceRoot;
  if (!effectiveRepoRoot) return null;

  const lines = [
    '## Active Repo Context',
    'Use this path as the current working directory for repo, file, and git operations:',
    effectiveRepoRoot,
    '',
  ];

  if (params.repoAccessMode) lines.push(`Repo access mode: ${params.repoAccessMode}`);
  if (pathMode) lines.push(`Path mode: ${pathMode}`);
  if (repoSource) lines.push(`Repo source: ${repoSource}`);
  if (repoWorkspacePath) lines.push(`Prepared repo workspace: ${repoWorkspacePath}`);
  if (repoBranch) lines.push(`Branch: ${repoBranch}`);
  if (activeRepoRoot) lines.push(`Active repo root: ${activeRepoRoot}`);
  if (workspaceRoot) lines.push(`Parent workspace root: ${workspaceRoot}`);
  if (worktreeRoot) lines.push(`Worktree root: ${worktreeRoot}`);
  if (runtimeConfigWorkingDirectory) lines.push(`Runtime config working directory: ${runtimeConfigWorkingDirectory}`);
  if (repoRootSource) lines.push(`Repo root source: ${repoRootSource}`);
  if (workspaceRootSource) lines.push(`Workspace root source: ${workspaceRootSource}`);
  lines.push('', 'Do not use the parent workspace for implementation work unless explicitly instructed.');

  return lines.join('\n');
}

function appendOpenClawRepoContext(message: string, repoContextSection: string | null): string {
  if (!repoContextSection) return message;
  if (message.includes('## Active Repo Context')) return message;
  return `${message.trimEnd()}\n\n${repoContextSection}`;
}

const MCP_STALE_NOTICE_IDS = new Set(['mcp-stale-catalog', 'mcp-not-yet-listed', 'mcp-not-yet-connected']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function missingRequiredTools(actual: string[], required: string[]): string[] {
  return required.filter((name) => !actual.some((actualName) => openClawToolNameMatches(actualName, name)));
}

function openClawToolNameMatches(actualName: string, requiredName: string): boolean {
  if (actualName === requiredName) return true;
  return actualName.endsWith(`___${requiredName}`) || actualName.endsWith(`__${requiredName}`);
}

function extractJsonObject(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('command output did not contain a JSON object');
  return JSON.parse(raw.slice(start, end + 1));
}

function collectStringValues(value: unknown, keys: Set<string>, out = new Set<string>()): string[] {
  if (!value || typeof value !== 'object') return Array.from(out).sort();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') out.add(item);
      else collectStringValues(item, keys, out);
    }
    return Array.from(out).sort();
  }
  const record = value as Record<string, unknown>;
  for (const [key, child] of Object.entries(record)) {
    if (keys.has(key)) {
      if (typeof child === 'string') out.add(child);
      else if (Array.isArray(child)) {
        for (const item of child) {
          if (typeof item === 'string') out.add(item);
          else collectStringValues(item, keys, out);
        }
      }
    } else {
      collectStringValues(child, keys, out);
    }
  }
  return Array.from(out).sort();
}

function formatCommandFailure(command: string, args: string[], status: number | null, signal: NodeJS.Signals | null, output: string): string {
  const detail = output.trim().split('\n').slice(-6).join('\n').trim();
  return `${[command, ...args].join(' ')} failed` +
    (status !== null ? ` with status ${status}` : '') +
    (signal ? ` signal ${signal}` : '') +
    (detail ? `: ${detail}` : '');
}

function reloadOpenClawMcpRuntimeCache(workingDirectory: string): void {
  const command = process.env.OPENCLAW_BIN?.trim() || 'openclaw';
  const args = ['mcp', 'reload'];
  const result = spawnSync(command, args, {
    cwd: workingDirectory,
    encoding: 'utf8',
    timeout: 30_000,
  });
  const output = [result.stderr, result.stdout].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n');
  if (result.error) {
    throw new Error(`OpenClaw MCP runtime cache reload failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`OpenClaw MCP runtime cache reload failed: ${formatCommandFailure(command, args, result.status, result.signal, output)}`);
  }
  console.log(`[OpenClawRuntime] MCP runtime cache reload complete: cwd=${workingDirectory}`);
}

function probeOpenClawMcpServer(params: {
  serverName: string;
  workingDirectory: string;
  requiredToolNames: string[];
}): void {
  const command = process.env.OPENCLAW_BIN?.trim() || 'openclaw';
  const args = ['mcp', 'probe', params.serverName, '--json'];
  const result = spawnSync(command, args, {
    cwd: params.workingDirectory,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = [result.stderr, result.stdout].filter((part): part is string => typeof part === 'string' && part.trim().length > 0).join('\n');
  if (result.error) {
    throw new Error(`OpenClaw MCP server "${params.serverName}" startup probe failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`OpenClaw MCP server "${params.serverName}" startup probe failed: ${formatCommandFailure(command, args, result.status, result.signal, output)}`);
  }

  let parsed: unknown;
  try {
    parsed = extractJsonObject(output);
  } catch (err) {
    throw new Error(
      `OpenClaw MCP server "${params.serverName}" startup probe returned unreadable JSON: ` +
      (err instanceof Error ? err.message : String(err)),
    );
  }

  const toolNames = collectStringValues(parsed, new Set(['tools']));
  const missing = missingRequiredTools(toolNames, params.requiredToolNames);
  console.log(
    `[OpenClawRuntime] MCP server initialization probe complete: server=${params.serverName} ` +
    `toolCount=${toolNames.length} requiredTools=${params.requiredToolNames.join(', ') || '(none)'} ` +
    `missing=${missing.join(', ') || '(none)'}`,
  );
  if (missing.length > 0) {
    throw new Error(
      `OpenClaw MCP server "${params.serverName}" initialized without required tool(s): ` +
      `${missing.join(', ')}; discoveredToolCount=${toolNames.length}`,
    );
  }
}

async function waitForOpenClawMcpReadiness(params: {
  sessionKey: string;
  agentSlug: string;
  readiness: NonNullable<DispatchParams['openClawMcpReadiness']>;
}): Promise<void> {
  const requiredToolNames = Array.from(new Set(params.readiness.requiredToolNames)).sort();
  if (params.readiness.materializedCount <= 0 || requiredToolNames.length === 0) return;

  const configuredTimeoutMs = Number(process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_TIMEOUT_MS ?? 15_000);
  const configuredPollMs = Number(process.env.AGENT_HQ_OPENCLAW_MCP_READINESS_POLL_MS ?? 500);
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : 15_000;
  const pollMs = Number.isFinite(configuredPollMs) && configuredPollMs > 0
    ? configuredPollMs
    : 500;

  const workingDirectory = params.readiness.workingDirectory?.trim();
  if (workingDirectory) {
    reloadOpenClawMcpRuntimeCache(workingDirectory);
    const requiredByServer = params.readiness.requiredToolsByServerName ?? {};
    for (const serverName of params.readiness.serverNames) {
      probeOpenClawMcpServer({
        serverName,
        workingDirectory,
        requiredToolNames: requiredByServer[serverName] ?? [],
      });
    }
  }

  const startedAt = Date.now();
  let lastError: string | null = null;
  let lastToolNames: string[] = [];
  let lastNoticeIds: string[] = [];

  while (Date.now() - startedAt <= timeoutMs) {
    const effective = await gatewayWsGetEffectiveTools({
      sessionKey: params.sessionKey,
      agentId: params.agentSlug,
      timeoutMs: Math.min(10_000, timeoutMs),
    });
    if (!effective.ok) {
      lastError = effective.error ?? 'tools.effective failed';
    } else {
      lastError = null;
      lastToolNames = effective.toolNames;
      lastNoticeIds = effective.noticeIds;
      const missing = missingRequiredTools(effective.toolNames, requiredToolNames);
      const staleNotices = effective.noticeIds.filter((id) => MCP_STALE_NOTICE_IDS.has(id));
      console.log(
        `[OpenClawRuntime] MCP readiness poll: sessionKey=${params.sessionKey} servers=${params.readiness.serverNames.join(', ') || '(none)'} effectiveToolCount=${effective.toolNames.length} requiredTools=${requiredToolNames.join(', ')} missing=${missing.join(', ') || '(none)'} notices=${effective.noticeIds.join(', ') || '(none)'}`,
      );
      if (missing.length === 0 && staleNotices.length === 0) return;
      if (workingDirectory && staleNotices.length > 0 && staleNotices.every((id) => id === 'mcp-not-yet-connected')) {
        console.log(
          `[OpenClawRuntime] MCP readiness continuing after cold-session catalog notice: ` +
          `sessionKey=${params.sessionKey} notices=${staleNotices.join(', ')} ` +
          `effectiveMissing=${missing.join(', ') || '(none)'} ` +
          `probeVerifiedServers=${params.readiness.serverNames.join(', ') || '(none)'}`,
        );
        return;
      }
    }
    await sleep(pollMs);
  }

  const missing = missingRequiredTools(lastToolNames, requiredToolNames);
  throw new Error(
    `OpenClaw MCP readiness timed out before dispatch for session "${params.sessionKey}": ` +
    `servers=${params.readiness.serverNames.join(', ') || '(none)'} ` +
    `requiredTools=${requiredToolNames.join(', ') || '(none)'} ` +
    `missing=${missing.join(', ') || '(none)'} ` +
    `effectiveToolCount=${lastToolNames.length} ` +
    `notices=${lastNoticeIds.join(', ') || '(none)'} ` +
    `bundle=${params.readiness.bundlePath ?? '(none)'}` +
    (lastError ? ` lastError=${lastError}` : ''),
  );
}

// ── OpenClawRuntime ───────────────────────────────────────────────────────────

export class OpenClawRuntime implements AgentRuntime {
  async prepareAuthProfiles(params: PrepareAuthProfilesParams): Promise<RuntimeAuthProfileSyncResult> {
    const provider = params.preferredProvider ?? null;
    if (provider !== 'openai-codex') {
      return skippedRuntimeAuthProfileSync('OpenClaw OAuth auth-profile sync is only required for openai-codex provider selection.');
    }

    const result = await syncOAuthProviderForOpenClawAgent({
      provider: 'openai-codex',
      agentSlug: params.agentSlug,
    });

    if (!result.ok) {
      return {
        ok: false,
        status: 'failed',
        providersSynced: [],
        runtimeAuthProvidersSynced: [],
        openclawAuthProvidersSynced: [],
        openclawAuthPath: result.targetPath ?? null,
        source: result.source,
        refreshed: result.refreshed,
        error: result.error ?? 'No usable openai-codex OAuth credential was found for OpenClaw runtime auth.',
      };
    }

    if (result.refreshed || result.updatedPaths.length > 0) {
      console.log(
        `[OpenClawRuntime] Synced ${result.provider} OAuth profile for agent "${params.agentSlug}"` +
        ` (${result.updatedPaths.length} auth file(s) updated${result.refreshed ? ', refreshed token' : ''})`,
      );
      const reload = await reloadOpenClawSecretsRuntimeForAuthSync();
      if (!reload.ok) {
        return {
          ok: false,
          status: 'failed',
          providersSynced: [],
          runtimeAuthProvidersSynced: [],
          openclawAuthProvidersSynced: [],
          openclawAuthPath: result.targetPath ?? null,
          source: result.source,
          refreshed: result.refreshed,
          error: `OpenClaw secrets runtime reload failed after OAuth profile sync for agent "${params.agentSlug}": ${reload.message}`,
        };
      }
      console.log(`[OpenClawRuntime] ${reload.message} Agent: "${params.agentSlug}"`);
    }

    return {
      ok: true,
      status: 'synced',
      providersSynced: [result.provider],
      runtimeAuthProvidersSynced: [result.provider],
      openclawAuthProvidersSynced: [result.provider],
      runtimeAuthPath: result.targetPath ?? null,
      openclawAuthPath: result.targetPath ?? null,
      source: result.source,
      refreshed: result.refreshed,
      details: {
        profile_key: result.profileKey,
        updated_paths: result.updatedPaths,
        expires_at: result.expiresAt ?? null,
      },
    };
  }

  /**
   * dispatch — fire an isolated agent turn via the OpenClaw gateway WebSocket path.
   */
  async dispatch(params: DispatchParams): Promise<{ runId: string }> {
    const routedSessionKey = params.sessionKey.startsWith('agent:')
      ? params.sessionKey
      : `agent:${params.agentSlug}:${params.sessionKey}`;

    const patchResult = await gatewayWsPatchSession({
      sessionKey: routedSessionKey,
      model: params.model ?? null,
      thinking: params.thinking ?? null,
      fastMode: params.fastMode ?? null,
      force: Boolean(params.openClawMcpReadiness?.materializedCount),
    });
    if (!patchResult.ok) {
      const message = `Failed to apply runtime routing overrides for session "${routedSessionKey}": ${patchResult.error ?? 'unknown error'}`;
      if (params.model) {
        throw new Error(message);
      }
      console.warn(
        `[OpenClawRuntime] ${message}; dispatching with existing OpenClaw session settings`,
      );
    }

    if (params.openClawMcpReadiness) {
      await waitForOpenClawMcpReadiness({
        sessionKey: routedSessionKey,
        agentSlug: params.agentSlug,
        readiness: params.openClawMcpReadiness,
      });
    }

    const activeRepoRoot = params.activeRepoRoot ?? null;
    const workspaceRoot = params.workspaceRoot ?? null;
    const pathMetadata = params.pathMetadata ?? null;
    if (activeRepoRoot || workspaceRoot) {
      const pathMode = pathMetadata?.pathMode ?? (activeRepoRoot ? 'active-repo-root' : 'workspace-root');
      console.log(
        `[OpenClawRuntime] dispatch path resolution: sessionKey=${routedSessionKey} mode=${pathMode} cwd=${activeRepoRoot ?? workspaceRoot ?? 'null'} activeRepoRoot=${activeRepoRoot ?? 'null'} workspaceRoot=${workspaceRoot ?? 'null'} worktreeRoot=${pathMetadata?.worktreeRoot ?? 'null'} runtimeConfigWorkingDirectory=${pathMetadata?.runtimeConfigWorkingDirectory ?? 'null'} repoRootSource=${pathMetadata?.repoRootSource ?? 'unknown'} workspaceRootSource=${pathMetadata?.workspaceRootSource ?? 'unknown'}`,
      );
    }

    const dispatchMessage = appendOpenClawRepoContext(
      params.message,
      buildOpenClawRepoContextSection({
        activeRepoRoot,
        workspaceRoot,
        repoAccessMode: params.repoAccessMode ?? null,
        repoSource: params.repoSource ?? null,
        repoWorkspacePath: params.repoWorkspacePath ?? null,
        repoBranch: params.repoBranch ?? null,
        pathMetadata,
      }),
    );
    // Start local/raw terminal observation before chat.send returns. Some OpenClaw
    // failures end the trajectory immediately and never emit a gateway chat
    // terminal event after the RPC resolves.
    // Both awaited, which is what actually delivers on the comment above: startCapture only
    // registers the listeners and returns, so unawaited it was racing gatewayWsSend rather than
    // preceding it, and an OpenClaw run that fails instantly could emit and finish its whole
    // trajectory before the capture was subscribed — exactly the case this is here to observe.
    await this.persistUserPrompt(params, dispatchMessage);
    await this.startCapture(params, undefined, routedSessionKey);

    const wsResult = await gatewayWsSend({
      sessionKey: routedSessionKey,
      message: dispatchMessage,
      timeoutMs: (params.timeoutSeconds ?? 900) * 1000,
    });

    if (!wsResult.ok) {
      throw new Error(wsResult.error ?? 'WebSocket dispatch failed');
    }

    // Re-registers the capture now that the real runId is known. Awaited so the capture is in
    // place before this method returns and the caller treats the dispatch as observed.
    await this.startCapture(params, wsResult.runId, routedSessionKey);
    return { runId: wsResult.runId ?? '' };
  }

  /**
   * startCapture — start background real-time transcript capture for this dispatch.
   * Use the stored short hook:* session key first; current OpenClaw gateway
   * history/subscription resolution is keyed on that form for Agent HQ runs.
   */
  private async startCapture(params: DispatchParams, runId?: string, routedSessionKey?: string): Promise<void> {
    if (params.instanceId == null) return;
    try {
      const db = getDb();
      const instRow = await db.get('SELECT agent_id, session_key FROM job_instances WHERE id = ?', params.instanceId) as { agent_id: number; session_key: string | null } | undefined;
      if (!instRow) return;

      const agentId = instRow.agent_id;
      const baseSessionKey = instRow.session_key ?? params.sessionKey;
      if (!baseSessionKey) return;

      // chat.send routes OpenClaw runs into agent-scoped sessions of the form:
      //   agent:<agentSlug>:<hook-session-key>
      // Transcript capture must follow that routed key, not the short persisted
      // hook:* key stored on the instance record, or live chat/agent events will
      // never match the tracked capture.
      const captureSessionKey = baseSessionKey.startsWith('agent:')
        ? baseSessionKey
        : `agent:${params.agentSlug}:${baseSessionKey}`;

      const timeoutSeconds = (params.timeoutSeconds ?? 900) + 120;
      const timeoutMs = timeoutSeconds * 1000;
      await startTranscriptCapture(params.instanceId, agentId, captureSessionKey, {
                timeoutMs,
                forceHistoryRefresh: Boolean(runId),
                runId,
                onTurnEnd: (event) => {
                  void this.handleTurnEnd(params.instanceId!, event, params.onRuntimeEnd);
                },
              });
      startRawSessionTerminalPoll({
        instanceId: params.instanceId,
        sessionKey: routedSessionKey ?? captureSessionKey,
        timeoutMs,
        onTurnEnd: (event) => {
          void this.handleTurnEnd(params.instanceId!, event, params.onRuntimeEnd);
        },
      });
    } catch (err) {
      console.warn(
        '[OpenClawRuntime] Failed to start transcript capture:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * persistUserPrompt — write the dispatched prompt as a user-role chat_messages
   * row so the Chats tab shows what was sent to the agent.
   */
  private async persistUserPrompt(params: DispatchParams, promptContent = params.message): Promise<number | null> {
    try {
      if (params.instanceId == null) return null;
      const db = getDb();
      const hasJobInstanceDurableRunId = await tableHasColumn(db, 'job_instances', 'durable_run_id');
      const instRow = await db.get(`
        SELECT agent_id, session_key${hasJobInstanceDurableRunId ? ', durable_run_id' : ''}
        FROM job_instances
        WHERE id = ?
      `, params.instanceId) as {
        agent_id: number;
        session_key?: string | null;
        durable_run_id?: string | null;
      } | undefined;
      const agentId = instRow?.agent_id ?? null;
      if (agentId == null) return null;

      const identityColumns: string[] = [];
      const identityValues: unknown[] = [];
      if (await tableHasColumn(db, 'chat_messages', 'tenant_id')) {
        identityColumns.push('tenant_id');
        identityValues.push(await requireRuntimeTenantId(db, {
          instanceId: params.instanceId,
          agentId,
        }));
      }
      if (await tableHasColumn(db, 'chat_messages', 'durable_run_id')) {
        identityColumns.push('durable_run_id');
        identityValues.push(instRow?.durable_run_id ?? null);
      }
      if (await tableHasColumn(db, 'chat_messages', 'session_key')) {
        identityColumns.push('session_key');
        identityValues.push(instRow?.session_key ?? params.sessionKey ?? null);
      }
      const identityColumnSql = identityColumns.length ? `${identityColumns.join(', ')}, ` : '';
      const identityValueSql = identityColumns.length ? `${identityColumns.map(() => '?').join(', ')}, ` : '';

      const now = nowTimestamp();
      await db.run(`
        INSERT INTO chat_messages (id, agent_id, instance_id, ${identityColumnSql}role, content, timestamp, event_type, event_meta)
        VALUES (?, ?, ?, ${identityValueSql}'user', ?, ?, 'text', '{}') ON CONFLICT DO NOTHING`, `oc-user-${params.instanceId}`, agentId, params.instanceId, ...identityValues, promptContent, now);
      return agentId;
    } catch (err) {
      console.warn(
        `[OpenClawRuntime] Failed to persist user prompt:`,
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  /**
   * abort — cancel a running agent turn via the OpenClaw gateway CLI.
   *
   * Mirrors the previous abortChatRunBySessionKey logic in integrations/openclaw.ts.
   * "Already gone" (session not found) is treated as a success.
   */
  async abort(runId: string, sessionKey: string): Promise<void> {
    // Stop any active background transcript capture for this session. Awaited so the final
    // transcript flush completes before the run is aborted below — otherwise the abort tears
    // down the session while the capture is still writing, and the tail of the transcript for
    // the very run being cancelled is the part most likely to be lost.
    await stopTranscriptCapture(sessionKey);

    const result = abortChatRunBySessionKey(sessionKey);
    if (!result.ok) {
      throw new Error(
        `OpenClawRuntime.abort failed (${result.status}): ${result.error ?? result.stderr}`,
      );
    }
  }

  private async handleTurnEnd(instanceId: number, event: RuntimeEndEvent, onRuntimeEnd?: DispatchParams['onRuntimeEnd']): Promise<void> {
    await handleOpenClawRuntimeEnd(instanceId, event, onRuntimeEnd);
  }
}
