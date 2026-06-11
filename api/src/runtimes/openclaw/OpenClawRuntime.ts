/**
 * runtimes/OpenClawRuntime.ts — AgentRuntime backed by the OpenClaw gateway.
 *
 * Contains the dispatch and abort logic previously inlined in dispatcher.ts
 * (fireAgentRun) and integrations/openclaw.ts (abortChatRunBySessionKey).
 * The dispatcher now calls this via the AgentRuntime interface.
 */

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
  gatewayWsPatchSession,
  gatewayWsSend,
  reloadOpenClawSecretsRuntimeForAuthSync,
} from './gatewayClient';
import { handleOpenClawRuntimeEnd } from './runtimeEnd';
import {
  startRawSessionTerminalPoll,
} from './transcript';

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
    this.persistUserPrompt(params, dispatchMessage);
    this.startCapture(params, undefined, routedSessionKey);

    const wsResult = await gatewayWsSend({
      sessionKey: routedSessionKey,
      message: dispatchMessage,
      timeoutMs: (params.timeoutSeconds ?? 900) * 1000,
    });

    if (!wsResult.ok) {
      throw new Error(wsResult.error ?? 'WebSocket dispatch failed');
    }

    this.startCapture(params, wsResult.runId, routedSessionKey);
    return { runId: wsResult.runId ?? '' };
  }

  /**
   * startCapture — start background real-time transcript capture for this dispatch.
   * Use the stored short hook:* session key first; current OpenClaw gateway
   * history/subscription resolution is keyed on that form for Agent HQ runs.
   */
  private startCapture(params: DispatchParams, runId?: string, routedSessionKey?: string): void {
    if (params.instanceId == null) return;
    try {
      const db = getDb();
      const instRow = db
        .prepare('SELECT agent_id, session_key FROM job_instances WHERE id = ?')
        .get(params.instanceId) as { agent_id: number; session_key: string | null } | undefined;
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
      startTranscriptCapture(params.instanceId, agentId, captureSessionKey, {
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
  private persistUserPrompt(params: DispatchParams, promptContent = params.message): number | null {
    try {
      if (params.instanceId == null) return null;
      const db = getDb();
      const hasJobInstanceDurableRunId = tableHasColumn(db, 'job_instances', 'durable_run_id');
      const instRow = db.prepare(`
        SELECT agent_id, session_key${hasJobInstanceDurableRunId ? ', durable_run_id' : ''}
        FROM job_instances
        WHERE id = ?
      `).get(params.instanceId) as {
        agent_id: number;
        session_key?: string | null;
        durable_run_id?: string | null;
      } | undefined;
      const agentId = instRow?.agent_id ?? null;
      if (agentId == null) return null;

      const identityColumns: string[] = [];
      const identityValues: unknown[] = [];
      if (tableHasColumn(db, 'chat_messages', 'durable_run_id')) {
        identityColumns.push('durable_run_id');
        identityValues.push(instRow?.durable_run_id ?? null);
      }
      if (tableHasColumn(db, 'chat_messages', 'session_key')) {
        identityColumns.push('session_key');
        identityValues.push(instRow?.session_key ?? params.sessionKey ?? null);
      }
      const identityColumnSql = identityColumns.length ? `${identityColumns.join(', ')}, ` : '';
      const identityValueSql = identityColumns.length ? `${identityColumns.map(() => '?').join(', ')}, ` : '';

      const now = new Date().toISOString();
      db.prepare(`
        INSERT OR IGNORE INTO chat_messages (id, agent_id, instance_id, ${identityColumnSql}role, content, timestamp, event_type, event_meta)
        VALUES (?, ?, ?, ${identityValueSql}'user', ?, ?, 'text', '{}')
      `).run(`oc-user-${params.instanceId}`, agentId, params.instanceId, ...identityValues, promptContent, now);
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
    // Stop any active background transcript capture for this session
    stopTranscriptCapture(sessionKey);

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
