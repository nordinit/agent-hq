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

// ── Custom runtime LLM fleet integration ──────────────────────────────────
// Credentials are supplied via environment or other Agent HQ-managed secret/config surfaces.
// Used by CustomAgentRuntime (Mode 2) and available for model routing (Mode 1).

export const VERI_BASE_URL: string =
  process.env.VERI_BASE_URL ?? '';

export const VERI_API_KEY: string =
  process.env.VERI_API_KEY ?? '';
