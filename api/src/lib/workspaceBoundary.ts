/**
 * workspaceBoundary.ts — Path boundary enforcement for agent workspaces.
 *
 * This is the software-layer guardrail that ensures all agent file operations
 * resolve within the agent's assigned workspace directory.
 *
 * Key behaviour:
 * - resolveAndValidate(): resolves a path and rejects any that escape the root
 * - detectSymlinkEscape(): follows symlinks and rejects traversal outside root
 * - logSecurityViolation(): writes a security event to the `security_events` table
 *
 * All errors thrown here include the WorkspaceBoundaryError class so callers
 * can distinguish boundary violations from generic FS errors.
 */

import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { insertRuntimeLog } from './runtimeTenantScope';

// ── Error type ────────────────────────────────────────────────────────────────

export class WorkspaceBoundaryError extends Error {
  public readonly workspaceRoot: string;
  public readonly attemptedPath: string;
  public readonly resolvedPath: string;

  constructor(message: string, opts: {
    workspaceRoot: string;
    attemptedPath: string;
    resolvedPath: string;
  }) {
    super(message);
    this.name = 'WorkspaceBoundaryError';
    this.workspaceRoot = opts.workspaceRoot;
    this.attemptedPath = opts.attemptedPath;
    this.resolvedPath = opts.resolvedPath;
  }
}

// ── Core validation ───────────────────────────────────────────────────────────

/**
 * normaliseRoot — resolve + canonicalise the workspace root path.
 * Uses realpathSync when the root exists; falls back to path.resolve for
 * roots that haven't been created yet (e.g. fresh workspaces).
 */
export function normaliseRoot(workspaceRoot: string): string {
  try {
    return fs.realpathSync(workspaceRoot);
  } catch {
    return path.resolve(workspaceRoot);
  }
}

/**
 * realpathBestEffort — resolve a path to its canonical form, handling paths
 * that may not fully exist yet by walking up to the first existing ancestor
 * and reconstructing the rest.
 *
 * This is necessary on macOS where /var is a symlink to /private/var — absolute
 * paths constructed with path.join/path.resolve will use /var/... while
 * realpathSync on an existing directory returns /private/var/....
 * Walking up finds the real ancestor and rebuilds the full canonical path.
 */
export function realpathBestEffort(p: string): string {
  // Fast path: the path already exists, resolve it directly
  try {
    return fs.realpathSync(p);
  } catch {
    // Path does not exist — walk up to the first existing ancestor
    const parts: string[] = [];
    let current = p;
    for (;;) {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached filesystem root without finding a real ancestor
        return path.resolve(p);
      }
      parts.push(path.basename(current));
      current = parent;
      try {
        const real = fs.realpathSync(current);
        // Reconstruct: real ancestor + all non-existent tail segments in order
        return parts.reduceRight((acc, part) => path.join(acc, part), real);
      } catch {
        // Keep walking up
      }
    }
  }
}

/**
 * normalisePrefixSymlinks — resolve OS-level prefix symlinks in a path
 * (e.g. /var → /private/var on macOS) without following application-level
 * symlinks at the leaf node.
 *
 * This is used for the basic boundary check when followSymlinks=false:
 * we need both the root and the target to use the same canonical prefix, but
 * we should NOT follow application-level symlinks (that's detectSymlinkEscape's job).
 *
 * Strategy: resolve the nearest existing parent via realpathSync, then reattach
 * any non-existent tail segments. If the leaf itself is a symlink (lstat indicates
 * it), we stop before following it — the parent directory is real-pathed instead.
 */
export function normalisePrefixSymlinks(p: string): string {
  // Check if the leaf node is a symlink — if so, normalise only the parent
  try {
    const lstat = fs.lstatSync(p);
    if (lstat.isSymbolicLink()) {
      // Don't follow the leaf symlink; normalise the parent and reattach basename
      const parent = path.dirname(p);
      const base = path.basename(p);
      const realParent = normalisePrefixSymlinks(parent);
      return path.join(realParent, base);
    }
    // Not a symlink — full realpath is safe
    return fs.realpathSync(p);
  } catch {
    // Path does not exist or lstat failed — walk up
    return realpathBestEffort(p);
  }
}

/**
 * resolveAndValidate — resolve `targetPath` relative to `workspaceRoot` (if
 * relative) and verify the resolved path is within the workspace boundary.
 *
 * Steps:
 *   1. Normalise the workspace root via realpathSync (follows real symlinks on the root itself).
 *   2. Resolve the target (relative → absolute against root; absolute → as-is).
 *   3. Normalise the resolved path via realpathBestEffort so macOS /var→/private/var
 *      symlinks and similar prefix symlinks are transparently handled.
 *   4. Verify the normalised resolved path starts with "<root>/".
 *   5. Optionally follow any symlinks in the target path and re-check.
 *
 * @param workspaceRoot  The canonical workspace directory for this agent.
 * @param targetPath     The path to validate (may be relative or absolute).
 * @param followSymlinks When true (default), also check for symlink escape after resolve.
 * @throws WorkspaceBoundaryError if the path resolves outside the workspace.
 * @returns The resolved absolute path (real-path normalised).
 */
export function resolveAndValidate(
  workspaceRoot: string,
  targetPath: string,
  followSymlinks = true,
): string {
  const root = normaliseRoot(workspaceRoot);
  // Normalise root to always end with separator so prefix check is unambiguous
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;

  // Resolve the target: relative paths are anchored to the workspace root.
  // Then normalise so prefix symlinks (e.g. /var → /private/var on macOS) are
  // resolved consistently with the root — but without following application-level
  // symlinks at the leaf (that's detectSymlinkEscape's job when followSymlinks=true).
  const rawResolved = path.isAbsolute(targetPath)
    ? path.normalize(targetPath)
    : path.resolve(root, targetPath);
  const resolved = followSymlinks
    ? realpathBestEffort(rawResolved)
    : normalisePrefixSymlinks(rawResolved);

  // The resolved path must be the root itself or start with root + sep
  const inside = resolved === root || resolved.startsWith(rootWithSep);

  if (!inside) {
    throw new WorkspaceBoundaryError(
      `Path escape attempt: "${targetPath}" resolves to "${resolved}" which is outside workspace "${root}"`,
      { workspaceRoot: root, attemptedPath: targetPath, resolvedPath: resolved },
    );
  }

  // Optionally follow existing symlinks and re-check the real destination
  if (followSymlinks) {
    detectSymlinkEscape(root, rootWithSep, resolved);
  }

  return resolved;
}

/**
 * detectSymlinkEscape — walk the resolved path, follow any symlinks, and
 * verify the final real path is still inside the workspace root.
 *
 * This prevents symlink-based path traversal where a file or directory inside
 * the workspace points outside it (e.g. a symlink to /etc/passwd).
 *
 * Only checks paths that actually exist on disk — no error for missing paths
 * (they can't escape via symlink if they don't exist yet).
 */
export function detectSymlinkEscape(
  root: string,
  rootWithSep: string,
  resolvedPath: string,
): void {
  // Walk path components to detect intermediate symlinks
  // (realpathSync resolves the full chain in one shot)
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(resolvedPath);
  } catch {
    // Path does not exist yet — cannot escape via symlink
    return;
  }

  const inside = realTarget === root || realTarget.startsWith(rootWithSep);
  if (!inside) {
    throw new WorkspaceBoundaryError(
      `Symlink escape attempt: "${resolvedPath}" resolves via symlink to "${realTarget}" which is outside workspace "${root}"`,
      { workspaceRoot: root, attemptedPath: resolvedPath, resolvedPath: realTarget },
    );
  }
}

// ── Security event logging ────────────────────────────────────────────────────

export interface SecurityViolationContext {
  agentId?: number | null;
  instanceId?: number | null;
  taskId?: number | null;
  attemptedPath: string;
  resolvedPath: string;
  workspaceRoot: string;
  detail?: string;
}

/**
 * logSecurityViolation — write a security event to Agent HQ.
 *
 * Uses the `security_events` table.
 * Falls back to console.error if the DB write fails so a logging failure
 * never silences the violation itself.
 *
 * Also writes a row to the `logs` table (level=error) so the event appears
 * in the existing Agent HQ log viewer.
 */
export function logSecurityViolation(
  db: Database.Database,
  ctx: SecurityViolationContext,
): void {
  const summary =
    `WORKSPACE_BOUNDARY_VIOLATION: agent_id=${ctx.agentId ?? 'unknown'} ` +
    `instance_id=${ctx.instanceId ?? 'unknown'} ` +
    `task_id=${ctx.taskId ?? 'unknown'} ` +
    `attempted="${ctx.attemptedPath}" resolved="${ctx.resolvedPath}" ` +
    `workspace_root="${ctx.workspaceRoot}"` +
    (ctx.detail ? ` detail="${ctx.detail}"` : '');

  // Write to security_events table
  try {
    db.prepare(`
      INSERT INTO security_events (event_type, agent_id, instance_id, task_id, details)
      VALUES ('workspace_boundary_violation', ?, ?, ?, ?)
    `).run(
      ctx.agentId ?? null,
      ctx.instanceId ?? null,
      ctx.taskId ?? null,
      JSON.stringify({
        attempted_path: ctx.attemptedPath,
        resolved_path: ctx.resolvedPath,
        workspace_root: ctx.workspaceRoot,
        detail: ctx.detail ?? null,
      }),
    );
  } catch (err) {
    // Table may not exist in stale DBs — log to stderr as fallback
    console.error('[workspaceBoundary] security_events insert failed:', err);
  }

  // Also write to the existing logs table so the event appears in the UI log viewer
  try {
    insertRuntimeLog(db, {
      taskId: ctx.taskId ?? null,
      instanceId: ctx.instanceId ?? null,
      agentId: ctx.agentId ?? null,
      jobTitle: 'security',
      level: 'error',
      message: summary,
    });
  } catch (err) {
    console.error('[workspaceBoundary] logs insert failed:', err);
  }

  // Always emit to stderr regardless of DB state
  console.error(`[security] ${summary}`);
}

// ── Convenience wrapper ───────────────────────────────────────────────────────

/**
 * validateAndLogViolation — validate a path; if it escapes the workspace,
 * log the violation to the DB and rethrow the WorkspaceBoundaryError.
 *
 * This is the primary entry point for callers that have a DB handle.
 */
export function validateAndLogViolation(
  db: Database.Database,
  workspaceRoot: string,
  targetPath: string,
  ctx: Omit<SecurityViolationContext, 'attemptedPath' | 'resolvedPath' | 'workspaceRoot'>,
): string {
  try {
    return resolveAndValidate(workspaceRoot, targetPath);
  } catch (err) {
    if (err instanceof WorkspaceBoundaryError) {
      logSecurityViolation(db, {
        ...ctx,
        attemptedPath: err.attemptedPath,
        resolvedPath: err.resolvedPath,
        workspaceRoot: err.workspaceRoot,
      });
    }
    throw err;
  }
}
