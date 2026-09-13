import fs from 'fs';
import path from 'path';

// Shared by dispatch and cleanup, including separate API processes on this host.
function lockPath(workspace: string): string { return path.join(path.dirname(workspace), `.${path.basename(workspace)}.agent-hq-lock`); }
export function workspaceIsLeased(workspace: string): boolean {
  try {
    const lock = lockPath(workspace);
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true;
      fs.unlinkSync(lock);
      return false;
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
export function acquireWorkspaceLease(workspace: string): (() => void) | null {
  fs.mkdirSync(path.dirname(workspace), { recursive: true });
  if (workspaceIsLeased(workspace)) return null;
  const lock = lockPath(workspace);
  try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error; }
  return () => { fs.unlinkSync(lock); };
}
