import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acquireWorkspaceLease, INVALID_LOCK_RECLAIM_MS, workspaceIsLeased } from './workspaceLease';

let root: string;
let workspace: string;
let lock: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-lease-'));
  workspace = path.join(root, 'task-2461');
  lock = path.join(root, '.task-2461.agent-hq-lock');
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function backdate(file: string, ms: number): void {
  const when = new Date(Date.now() - ms);
  fs.utimesSync(file, when, when);
}

it('publishes the lock with its owner PID, excludes a second holder, and releases cleanly', () => {
  const release = acquireWorkspaceLease(workspace)!;
  expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
  expect(acquireWorkspaceLease(workspace)).toBeNull();
  release();
  expect(fs.readdirSync(root)).toEqual([]);
});

it('leaves no lock behind when the PID write fails on a full disk', () => {
  const realWriteFileSync = fs.writeFileSync;
  jest.spyOn(fs, 'writeFileSync').mockImplementationOnce((file, _data, options) => {
    // A full disk creates the file, then fails the write: the 2026-10-05 failure.
    realWriteFileSync(file, '', options);
    throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  });

  expect(() => acquireWorkspaceLease(workspace)).toThrow('ENOSPC');
  expect(fs.readdirSync(root)).toEqual([]);

  const release = acquireWorkspaceLease(workspace);
  expect(release).not.toBeNull();
  release!();
});

it('treats a lock without a valid PID as held while it is younger than the reclaim window', () => {
  fs.writeFileSync(lock, '');
  backdate(lock, INVALID_LOCK_RECLAIM_MS - 60_000);
  expect(workspaceIsLeased(workspace)).toBe(true);
  expect(acquireWorkspaceLease(workspace)).toBeNull();
  expect(fs.existsSync(lock)).toBe(true);
  expect(console.warn).toHaveBeenCalledTimes(1);
});

it.each(['', 'not-a-pid', '-4', '0'])('reclaims a lock holding %p once it is older than the reclaim window', content => {
  fs.writeFileSync(lock, content);
  backdate(lock, INVALID_LOCK_RECLAIM_MS + 60_000);
  const release = acquireWorkspaceLease(workspace)!;
  expect(release).not.toBeNull();
  expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
  release();
});

it('reclaims a lock whose owner process has exited', () => {
  const exited = spawnSync(process.execPath, ['-e', '']).pid;
  fs.writeFileSync(lock, String(exited));
  const release = acquireWorkspaceLease(workspace)!;
  expect(release).not.toBeNull();
  expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
  release();
});

it('never expires a lock whose owner process is alive, however old', () => {
  fs.writeFileSync(lock, String(process.pid));
  backdate(lock, 10 * INVALID_LOCK_RECLAIM_MS);
  expect(acquireWorkspaceLease(workspace)).toBeNull();
  expect(fs.readFileSync(lock, 'utf8')).toBe(String(process.pid));
});
