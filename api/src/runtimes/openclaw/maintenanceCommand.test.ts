import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { runMaintenanceCommand, serializeOpenClawMaintenance } from './maintenanceCommand';

describe('OpenClaw maintenance processes', () => {
  it('serves an API callback while the child is waiting for it', async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => { paths.push(req.url ?? ''); res.end('callback-served'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/permissions`;
      const result = await runMaintenanceCommand({
        command: process.execPath,
        args: ['-e', `fetch(${JSON.stringify(url)}, {signal: AbortSignal.timeout(1500)}).then(r=>r.text()).then(console.log).catch(()=>process.exit(2))`],
        timeoutMs: 3000,
      });
      expect(result.ok).toBe(true);
      expect(result.stdout).toBe('callback-served');
      expect(paths).toEqual(['/permissions']);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it('terminates and reaps a child that ignores SIGTERM', async () => {
    const result = await runMaintenanceCommand({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM',()=>{}); console.log(process.pid); setInterval(()=>{},1000)"],
      timeoutMs: 300,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');
    const pid = Number(result.stdout);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('reports launch failures and redacts command diagnostics', async () => {
    expect((await runMaintenanceCommand({ command: '/nonexistent/ahq-openclaw', args: [] })).ok).toBe(false);
    const result = await runMaintenanceCommand({ command: process.execPath, args: ['-e', "console.error('API_KEY=private-value'); process.exit(3)"] });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('[REDACTED]');
    expect(result.stderr).not.toContain('private-value');
  });

  it('serializes later revisions and recovers after a failed operation', async () => {
    const events: string[] = [];
    let release!: () => void;
    const first = serializeOpenClawMaintenance('fixture', async () => {
      events.push('first');
      await new Promise<void>((resolve) => { release = resolve; });
      throw new Error('fixture failure');
    });
    const rejected = expect(first).rejects.toThrow('fixture failure');
    const second = serializeOpenClawMaintenance('fixture', async () => { events.push('second'); return 2; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(events).toEqual(['first']);
    release();
    await rejected;
    expect(await second).toBe(2);
    expect(events).toEqual(['first', 'second']);
  });
});
