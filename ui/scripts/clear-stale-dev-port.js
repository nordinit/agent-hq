const { execFileSync } = require('child_process');
const process = require('process');

const port = String(process.env.PORT || '').trim();

if (!port || !/^\d+$/.test(port)) {
  process.exit(0);
}

function execText(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function commandForPid(pid) {
  return execText('ps', ['-ww', '-p', pid, '-o', 'command=']);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const currentPid = String(process.pid);
const parentPid = String(process.ppid);
const pids = execText('lsof', ['-ti', `tcp:${port}`])
  .split(/\s+/)
  .filter(Boolean)
  .filter(pid => pid !== currentPid && pid !== parentPid);

for (const pid of pids) {
  const command = commandForPid(pid);
  const isNextServer = /\b(next-server|next start|node .*next)\b/.test(command);

  if (!isNextServer) {
    console.warn(`[start-dev] Port ${port} is occupied by pid ${pid}; command did not look like Next.js, leaving it alone.`);
    continue;
  }

  try {
    process.kill(Number(pid), 'SIGTERM');
    console.log(`[start-dev] Stopped stale Next.js listener on port ${port}: pid ${pid}`);
  } catch (error) {
    console.warn(`[start-dev] Failed to stop stale Next.js listener pid ${pid}: ${error.message}`);
  }
}

if (pids.length > 0) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const remaining = execText('lsof', ['-ti', `tcp:${port}`]).split(/\s+/).filter(Boolean);
    if (remaining.length === 0) break;
    sleep(100);
  }
}
