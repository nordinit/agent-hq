import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

// Shared by dispatch and cleanup, including separate API processes on this host.
function lockPath(workspace: string): string { return path.join(path.dirname(workspace), `.${path.basename(workspace)}.agent-hq-lock`); }

/**
 * How long a lock that holds no valid PID keeps blocking before it is reclaimed.
 *
 * acquireWorkspaceLease publishes a lock only with its owner's PID already inside,
 * so an empty or unparsable lock is debris from a writer that failed or died while
 * creating it. On 2026-10-05 a full disk (ENOSPC) left 0-byte locks that blocked
 * their tasks' dispatch for a month. Releases before this change created the lock
 * first and wrote the PID second, so a lock from one of them can be briefly empty
 * while live. The window is therefore far longer than any dispatch preparation
 * holds a lease, including a workflow's 15-minute environment setup.
 */
export const INVALID_LOCK_RECLAIM_MS = 60 * 60 * 1000;

const reportedInvalidLocks = new Set<string>();

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Removes the lock only while it is still the file that was judged stale, so a lock
 * another process created in the meantime survives. Any failure counts as held.
 */
function removeLockIfUnchanged(lock: string, judged: fs.Stats): boolean {
  try {
    if (fs.statSync(lock).ino !== judged.ino) return false;
    fs.unlinkSync(lock);
    return true;
  } catch (error) {
    return isErrno(error, 'ENOENT');
  }
}

export function workspaceIsLeased(workspace: string): boolean {
  const lock = lockPath(workspace);
  let content: string;
  let stat: fs.Stats;
  try {
    const fd = fs.openSync(lock, 'r');
    try {
      stat = fs.fstatSync(fd);
      content = fs.readFileSync(fd, 'utf8');
    } finally { fs.closeSync(fd); }
  } catch (error) {
    return !isErrno(error, 'ENOENT');
  }

  const pid = Number(content);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    const ageMs = Date.now() - stat.mtimeMs;
    const key = `${lock}:${stat.ino}`;
    if (ageMs < INVALID_LOCK_RECLAIM_MS) {
      if (!reportedInvalidLocks.has(key)) {
        reportedInvalidLocks.add(key);
        console.warn(
          `[workspaceLease] ${lock} holds no valid PID (${stat.size} bytes, ${Math.floor(ageMs / 60_000)} min old); `
          + `treating it as held until it is ${INVALID_LOCK_RECLAIM_MS / 60_000} min old.`,
        );
      }
      return true;
    }
    if (!removeLockIfUnchanged(lock, stat)) return true;
    reportedInvalidLocks.delete(key);
    console.warn(`[workspaceLease] Reclaimed ${lock}: it held no valid PID for ${Math.floor(ageMs / 60_000)} min.`);
    return false;
  }

  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (!isErrno(error, 'ESRCH')) return true;
    return !removeLockIfUnchanged(lock, stat);
  }
}

export function acquireWorkspaceLease(workspace: string): (() => void) | null {
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  if (workspaceIsLeased(workspace)) return null;
  const lock = lockPath(workspace);
  // Write the PID to a private file first, then hard-link it into place. link()
  // fails with EEXIST exactly as the 'wx' create did, but the lock only ever appears
  // with its PID inside, so a failed write leaves no lock rather than an empty one.
  const staged = `${lock}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staged, String(process.pid), { flag: 'wx' });
    fs.linkSync(staged, lock);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return null;
    throw error;
  } finally {
    try { fs.unlinkSync(staged); } catch { /* never created; a leftover is harmless */ }
  }
  return () => { fs.unlinkSync(lock); };
}
