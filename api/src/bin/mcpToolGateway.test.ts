import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

const API_ROOT = path.resolve(__dirname, '../..');
const GATEWAY = path.resolve(__dirname, 'mcp-tool-gateway.ts');

/**
 * A minimal stdio MCP server. Like real upstream servers, it stays alive for as
 * long as its stdin is open, so it outlives a gateway that never closes it.
 */
const FAKE_UPSTREAM = `
const fs = require('fs');
fs.writeFileSync(process.env.UPSTREAM_PID_FILE, String(process.pid));
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-upstream', version: '1' } }
      : message.method === 'tools/list' ? { tools: [] } : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
`;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe('mcp-tool-gateway process lifetime', () => {
  let dir: string;
  let broker: http.Server;
  let gateway: ChildProcessWithoutNullStreams | null = null;
  let upstreamPid: number | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'mcp-tool-gateway-'));
    writeFileSync(path.join(dir, 'upstream.js'), FAKE_UPSTREAM);
    broker = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => broker.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    if (gateway?.pid && isAlive(gateway.pid)) gateway.kill('SIGKILL');
    if (upstreamPid && isAlive(upstreamPid)) process.kill(upstreamPid, 'SIGKILL');
    gateway = null;
    upstreamPid = null;
    await new Promise<void>((resolve) => broker.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits and stops its upstream server when the client closes stdin', async () => {
    const pidFile = path.join(dir, 'upstream.pid');
    const { port } = broker.address() as AddressInfo;
    gateway = spawn(process.execPath, ['--import', 'tsx', GATEWAY], {
      cwd: API_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        AGENT_HQ_MCP_UPSTREAM: JSON.stringify({
          command: process.execPath,
          args: [path.join(dir, 'upstream.js')],
          allowedTools: null,
          env: { UPSTREAM_PID_FILE: pidFile },
        }),
        AGENT_HQ_INTERNAL_BASE_URL: `http://127.0.0.1:${port}`,
        AGENT_HQ_EXECUTION_API_KEY: 'test-key',
        AGENT_HQ_EXECUTION_SERVER_ID: '1',
        AGENT_HQ_EXECUTION_REVISION_ID: 'test-revision',
      },
    });
    const exited = new Promise<number | null>((resolve) => gateway!.once('exit', (code) => resolve(code)));

    // Complete a real handshake so the gateway and its upstream are both fully up.
    let stdout = '';
    gateway.stdout.setEncoding('utf8');
    const initialized = new Promise<void>((resolve) => {
      gateway!.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.includes('"id":1')) resolve();
      });
    });
    gateway.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    })}\n`);
    await initialized;
    upstreamPid = Number(readFileSync(pidFile, 'utf8'));
    expect(isAlive(upstreamPid)).toBe(true);

    // The client (Claude CLI, or the dispatch preflight) goes away without signalling.
    gateway.stdin.end();

    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      exited,
      new Promise<'still running'>((resolve) => { timer = setTimeout(() => resolve('still running'), 8000); }),
    ]);
    clearTimeout(timer);
    expect(code).toBe(0);
    expect(await waitFor(() => !isAlive(upstreamPid!), 2000)).toBe(true);
  }, 30_000);
});
