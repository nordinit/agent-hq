/**
 * config.ts — Centralised environment configuration.
 *
 * All env-driven defaults derive from HOME / os.homedir() or explicit env vars.
 * Import from here instead of duplicating
 * env reads and fallback logic in each module.
 */

import path from 'path';
import os from 'os';
import { existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';

const HOME = process.env.HOME ?? os.homedir();

// ── Node binary directory ─────────────────────────────────────────────────
// Used to augment PATH when spawning the openclaw CLI.
// OPENCLAW_NODE_BIN env var overrides; otherwise we locate `node` at startup,
// falling back to a standard nvm-derived path.

function resolveNodeBinDir(): string {
  if (process.env.OPENCLAW_NODE_BIN) return process.env.OPENCLAW_NODE_BIN;
  if (process.execPath) return path.dirname(process.execPath);
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const raw = execFileSync(locator, ['node'], { encoding: 'utf-8' }).trim();
    const nodePath = raw.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    if (nodePath) return path.dirname(nodePath);
  } catch {
    // fallback: standard nvm structure using HOME
    return path.join(HOME, '.nvm', 'versions', 'node', process.version, 'bin');
  }
  return path.join(HOME, '.nvm', 'versions', 'node', process.version, 'bin');
}

export const NODE_BIN_DIR: string = resolveNodeBinDir();

// ── OpenClaw CLI / config ─────────────────────────────────────────────────

export const OPENCLAW_CONFIG_PATH: string =
  process.env.OPENCLAW_CONFIG_PATH ??
  path.join(HOME, '.openclaw', 'openclaw.json');

export const OPENCLAW_HOME: string = path.dirname(OPENCLAW_CONFIG_PATH);
export const OPENCLAW_BIN_DIR: string = path.join(OPENCLAW_HOME, 'node_modules', '.bin');

function resolveOpenClawBin(): string {
  if (process.env.OPENCLAW_BIN) return process.env.OPENCLAW_BIN;

  const localCandidates = process.platform === 'win32'
    ? [
      path.join(OPENCLAW_BIN_DIR, 'openclaw.cmd'),
      path.join(OPENCLAW_BIN_DIR, 'openclaw.exe'),
      path.join(OPENCLAW_BIN_DIR, 'openclaw'),
    ]
    : [path.join(OPENCLAW_BIN_DIR, 'openclaw')];

  return localCandidates.find(candidate => existsSync(candidate)) ?? 'openclaw';
}

export const OPENCLAW_BIN: string = resolveOpenClawBin();

export function prependPathEntries(entries: string[], currentPath = process.env.PATH ?? ''): string {
  const parts = [
    ...entries.filter(Boolean),
    ...currentPath.split(path.delimiter).filter(Boolean),
  ];
  return Array.from(new Set(parts)).join(path.delimiter);
}

export const OPENCLAW_PATH: string = prependPathEntries([NODE_BIN_DIR, OPENCLAW_BIN_DIR]);

function readLocalGatewayDefaults(): { port: number; tlsEnabled: boolean } {
  const fallback = { port: 18789, tlsEnabled: false };
  try {
    const raw = JSON.parse(readFileSync(OPENCLAW_CONFIG_PATH, 'utf-8')) as {
      gateway?: {
        port?: unknown;
        tls?: {
          enabled?: unknown;
        };
      };
    };
    const port = raw.gateway?.port;
    const tlsEnabled = raw.gateway?.tls?.enabled;
    return {
      port: typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535
        ? port
        : fallback.port,
      tlsEnabled: tlsEnabled === true,
    };
  } catch {
    return fallback;
  }
}

export function resolveDefaultGatewayUrl(target: 'http' | 'ws'): string {
  const defaults = readLocalGatewayDefaults();
  const scheme = target === 'http'
    ? (defaults.tlsEnabled ? 'https' : 'http')
    : (defaults.tlsEnabled ? 'wss' : 'ws');
  return `${scheme}://127.0.0.1:${defaults.port}`;
}

function normalizeGatewayUrl(raw: string | undefined, target: 'http' | 'ws'): string {
  const fallback = resolveDefaultGatewayUrl(target);
  try {
    const parsed = new URL(raw ?? fallback);
    if (target === 'http') {
      if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
      else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
      else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    } else {
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return fallback;
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return fallback;
  }
}

export const OPENCLAW_GATEWAY_URL: string = normalizeGatewayUrl(
  process.env.OPENCLAW_GATEWAY_URL ?? process.env.GATEWAY_WS_URL,
  'http',
);

export const OPENCLAW_GATEWAY_WS_URL: string = normalizeGatewayUrl(
  process.env.GATEWAY_WS_URL ?? process.env.OPENCLAW_GATEWAY_URL,
  'ws',
);

// ── Workspace ─────────────────────────────────────────────────────────────

export const WORKSPACE_ROOT: string =
  process.env.WORKSPACE_ROOT ??
  path.join(HOME, '.openclaw', 'workspace');

/**
 * Parent directory for workspaces belonging to runtimes Agent HQ owns itself
 * (claude-code, codex, hermes) rather than to OpenClaw.
 *
 * These must NOT live under `~/.openclaw`: that tree is OpenClaw's, is scanned by
 * its agent registry, and its per-agent auth profiles are synced there. A
 * claude-code agent has no OpenClaw identity, so a workspace under that root is
 * both misleading and liable to be picked up by OpenClaw tooling.
 *
 * `AGENT_HQ_DATA_DIR` is the same override the Codex runtime-state root honours
 * (api/src/runtimes/codex/profile.ts), so one env var relocates all Agent HQ data.
 *
 * Kept as a function, like resolveUploadsRoot() below, so tests and one-shot
 * commands can set an isolated root after module loading.
 */
export function resolveAgentHqWorkspaceParent(): string {
  const explicit = process.env.AGENT_HQ_WORKSPACE_PARENT?.trim();
  if (explicit) return path.resolve(explicit);
  const dataRoot = process.env.AGENT_HQ_DATA_DIR?.trim();
  return dataRoot
    ? path.join(path.resolve(dataRoot), 'workspaces')
    : path.join(HOME, '.agent-hq', 'workspaces');
}

/**
 * Default workspace for an Agent HQ-owned runtime agent: one directory per agent
 * slug under the Agent HQ workspace parent.
 *
 * This is only ever a FALLBACK cwd. A workflow's repo checkout or task worktree
 * always outranks it at dispatch (see resolveDispatchPathContext in
 * services/dispatcher.ts); it exists so an agent with no repo assigned still has a
 * stable, writable place to run instead of failing to launch.
 */
export function buildAgentHqWorkspacePath(agentSlug: string): string {
  const slug = agentSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!slug) throw new Error('buildAgentHqWorkspacePath requires a non-empty agent slug');
  return path.join(resolveAgentHqWorkspaceParent(), slug);
}

// ── Persistent uploads ────────────────────────────────────────────────────

/**
 * One root for every filesystem upload class. Keep this as a function so tests and
 * one-shot commands can set an isolated root after module loading.
 */
export function resolveUploadsRoot(): string {
  return path.resolve(
    process.env.AGENT_HQ_UPLOADS_DIR ?? path.join(__dirname, '../..', 'uploads'),
  );
}

