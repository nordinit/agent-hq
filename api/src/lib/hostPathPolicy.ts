/**
 * hostPathPolicy.ts — which host directories an agent record may point at.
 *
 * An agent's workspace_path is the cwd its runtime launches in, the root the artifacts API reads
 * and writes, and where skill and MCP bundles are materialized. Accepting any string made the
 * artifacts endpoints a read/write primitive for the whole host (`workspace_path: "/"`), and let
 * one agent point at another tenant's workspace. A workspace must now live where Agent HQ puts
 * workspaces:
 *
 *   - under the Agent HQ workspace parent (AGENT_HQ_WORKSPACE_PARENT, or AGENT_HQ_DATA_DIR/
 *     workspaces, or ~/.agent-hq/workspaces), strictly below it;
 *   - in an OpenClaw workspace: `<WORKSPACE_PARENT or ~/.openclaw>/workspace` or `workspace-*`,
 *     or WORKSPACE_ROOT when that is set;
 *   - under a directory the operator listed in AGENT_HQ_ALLOWED_WORKSPACE_ROOTS
 *     (path-delimiter separated absolute paths), for installs that keep workspaces elsewhere.
 *
 * Paths are compared after resolving symlinks, so a link inside an allowed root cannot carry a
 * workspace out of it.
 */

import os from 'os';
import path from 'path';
import { resolveAgentHqWorkspaceParent, WORKSPACE_ROOT } from '../config';
import { realpathBestEffort } from './workspaceBoundary';

const OPENCLAW_WORKSPACE_DIR = /^workspace(?:-[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export const ALLOWED_WORKSPACE_ROOTS_ENV = 'AGENT_HQ_ALLOWED_WORKSPACE_ROOTS';

function canonical(p: string): string {
  return realpathBestEffort(path.resolve(p));
}

/** True when `child` is `root` itself (if allowed) or lies below it. Both must be canonical. */
export function isPathWithin(child: string, root: string, allowEqual = true): boolean {
  if (child === root) return allowEqual;
  const relative = path.relative(root, child);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Absolute directories listed in an operator allowlist variable. Relative entries are ignored. */
export function operatorAllowedRoots(variable: string): string[] {
  return (process.env[variable] ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry && path.isAbsolute(entry))
    .map(canonical);
}

function openClawWorkspaceParent(): string {
  return canonical(process.env.WORKSPACE_PARENT?.trim() || path.join(process.env.HOME ?? os.homedir(), '.openclaw'));
}

/** The directory an OpenClaw workspace path belongs to, if it is one: `<parent>/workspace[-*]`. */
function openClawWorkspaceOf(target: string): string | null {
  const parent = openClawWorkspaceParent();
  if (!isPathWithin(target, parent, false)) return null;
  const [first] = path.relative(parent, target).split(path.sep);
  return first && OPENCLAW_WORKSPACE_DIR.test(first) ? path.join(parent, first) : null;
}

export function isAllowedWorkspacePath(value: string): boolean {
  if (!path.isAbsolute(value) || value.includes('\0')) return false;
  const target = canonical(value);
  if (isPathWithin(target, canonical(resolveAgentHqWorkspaceParent()), false)) return true;
  if (openClawWorkspaceOf(target)) return true;
  if (isPathWithin(target, canonical(WORKSPACE_ROOT))) return true;
  return operatorAllowedRoots(ALLOWED_WORKSPACE_ROOTS_ENV).some((root) => isPathWithin(target, root));
}

export type WorkspacePathCheck = { ok: true; path: string } | { ok: false; error: string };

/** Validates a workspace path supplied by a caller and returns it normalized for storage. */
export function checkWorkspacePath(value: unknown, field = 'workspace_path'): WorkspacePathCheck {
  if (typeof value !== 'string' || !value.trim()) return { ok: false, error: `${field} must be a non-empty absolute path` };
  const trimmed = value.trim();
  if (!path.isAbsolute(trimmed)) return { ok: false, error: `${field} must be an absolute path` };
  if (!isAllowedWorkspacePath(trimmed)) {
    return {
      ok: false,
      error: `${field} must be inside the Agent HQ workspace directory (${resolveAgentHqWorkspaceParent()}) or an OpenClaw workspace (${path.join(openClawWorkspaceParent(), 'workspace-*')}). To allow another location, add it to ${ALLOWED_WORKSPACE_ROOTS_ENV}.`,
    };
  }
  return { ok: true, path: path.resolve(trimmed) };
}

// ── Runtime config homes ──────────────────────────────────────────────────────
//
// claudeConfigDir, codexHome/codexHomeRoot and hermesHome become CLAUDE_CONFIG_DIR, CODEX_HOME
// and HERMES_HOME for the agent process, are read for provider credentials, and are where
// Agent HQ writes profile, skill and MCP configuration. They may name the runtime's own config
// directories in the home directory (~/.claude, ~/.claude-work, ...), the runtime's current
// environment value, Agent HQ's data directory, or a root the operator lists in
// AGENT_HQ_ALLOWED_RUNTIME_HOME_ROOTS — not arbitrary directories such as ~/.ssh.

export const ALLOWED_RUNTIME_HOME_ROOTS_ENV = 'AGENT_HQ_ALLOWED_RUNTIME_HOME_ROOTS';

type RuntimeHomeKind = 'claude' | 'codex' | 'hermes';

const RUNTIME_HOME_FIELDS: ReadonlyArray<{ runtime: string; field: string; kind: RuntimeHomeKind }> = [
  { runtime: 'claude-code', field: 'claudeConfigDir', kind: 'claude' },
  { runtime: 'codex', field: 'codexHome', kind: 'codex' },
  { runtime: 'codex', field: 'codexHomeRoot', kind: 'codex' },
  { runtime: 'hermes', field: 'hermesHome', kind: 'hermes' },
];

const RUNTIME_HOME_ENV: Record<RuntimeHomeKind, string> = {
  claude: 'CLAUDE_CONFIG_DIR',
  codex: 'CODEX_HOME',
  hermes: 'HERMES_HOME',
};

function agentHqDataRoots(): string[] {
  const dataRoot = process.env.AGENT_HQ_DATA_DIR?.trim();
  const runState = process.env.AGENT_HQ_RUN_STATE_DIR?.trim();
  return [
    dataRoot && path.isAbsolute(dataRoot) ? dataRoot : path.join(os.homedir(), '.agent-hq'),
    ...(runState && path.isAbsolute(runState) ? [runState] : []),
  ].map(canonical);
}

export function isAllowedRuntimeHome(kind: RuntimeHomeKind, value: string): boolean {
  if (!path.isAbsolute(value) || value.includes('\0')) return false;
  const target = canonical(value);
  const home = canonical(os.homedir());
  if (isPathWithin(target, home, false)) {
    const [first] = path.relative(home, target).split(path.sep);
    if (first === `.${kind}` || first.startsWith(`.${kind}-`)) return true;
  }
  const envHome = process.env[RUNTIME_HOME_ENV[kind]]?.trim();
  const roots = [
    ...agentHqDataRoots(),
    ...(envHome && path.isAbsolute(envHome) ? [canonical(envHome)] : []),
    ...operatorAllowedRoots(ALLOWED_RUNTIME_HOME_ROOTS_ENV),
  ];
  return roots.some((root) => isPathWithin(target, root));
}

function parseConfigRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return parseConfigRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Checks the config-home fields of a runtime_config. A field equal to the value already stored
 * for the agent (`previous`) is accepted as-is, so existing agents stay editable; any new or
 * changed value must satisfy the policy.
 */
export function checkRuntimeConfigHostPaths(runtimeType: string, config: unknown, previous?: unknown): string | null {
  const next = parseConfigRecord(config);
  const prior = parseConfigRecord(previous);
  for (const { runtime, field, kind } of RUNTIME_HOME_FIELDS) {
    if (runtime !== runtimeType) continue;
    const value = next[field];
    if (value == null || (typeof value === 'string' && !value.trim())) continue;
    if (value === prior[field]) continue;
    if (typeof value !== 'string' || !isAllowedRuntimeHome(kind, value.trim())) {
      return `runtime_config.${field} must be an absolute path inside ~/.${kind} (or ~/.${kind}-*), $${RUNTIME_HOME_ENV[kind]}, or the Agent HQ data directory. To allow another location, add it to ${ALLOWED_RUNTIME_HOME_ROOTS_ENV}.`;
    }
  }
  return null;
}

/**
 * True only for a real directory directly under ~/.openclaw named `workspace-*`: the one shape
 * of workspace that agent deletion removes from disk. This used to be a string prefix test, so
 * `~/.openclaw/workspace-x/../..` passed it and deleting the agent removed the home directory.
 */
export function isDeletableOpenClawWorkspace(value: string): boolean {
  if (!path.isAbsolute(value) || value.includes('\0')) return false;
  const resolved = path.resolve(value);
  const name = path.basename(resolved);
  return name.startsWith('workspace-')
    && OPENCLAW_WORKSPACE_DIR.test(name)
    && path.dirname(canonical(resolved)) === canonical(path.join(os.homedir(), '.openclaw'));
}
