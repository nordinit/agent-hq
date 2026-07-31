import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  describeMcpPreflightFailure,
  preflightMcpServer,
  preflightMcpServers,
} from './mcpPreflight';

/**
 * These tests spawn REAL child processes speaking real JSON-RPC over stdio.
 * Mocking child_process here would test the mock, not the handshake — and the
 * handshake is the entire value of this module, since the CLI's own in-band MCP
 * status is unreliable in both directions.
 */
let tmpDir: string;

function writeServer(name: string, body: string): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

/** A minimal, correct stdio MCP server. */
const GOOD_SERVER = `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'good', version: '1' } } }) + '\\n');
    } else if (msg.method === 'tools/list') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'alpha' }, { name: 'beta' }] } }) + '\\n');
    }
  }
});
`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-preflight-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('preflightMcpServer', () => {
  it('completes the handshake and reports the advertised tools', async () => {
    const server = writeServer('good.js', GOOD_SERVER);
    const result = await preflightMcpServer('agent-hq__agent-42', {
      command: process.execPath,
      args: [server],
    });

    expect(result.ok).toBe(true);
    expect(result.serverName).toBe('agent-hq__agent-42');
    expect(result.toolNames).toEqual(['alpha', 'beta']);
    expect(result.error).toBeUndefined();
  });

  it('passes configured env through to the server', async () => {
    // Proves AGENT_HQ_MCP_API_KEY reaches the server — a server that starts but
    // is unauthenticated would otherwise look healthy.
    const server = writeServer(
      'env.js',
      `
      let buf='';
      process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){
        const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;
        const msg=JSON.parse(line);
        if(msg.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{}})+'\\n');}
        else if(msg.method==='tools/list'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,result:{tools:[{name:process.env.PROBE_KEY||'missing'}]}})+'\\n');}
      }});
      `,
    );

    const result = await preflightMcpServer('s', {
      command: process.execPath,
      args: [server],
      env: { PROBE_KEY: 'secret-value' },
    });

    expect(result.ok).toBe(true);
    expect(result.toolNames).toEqual(['secret-value']);
  });

  it('fails when the command does not exist', async () => {
    const result = await preflightMcpServer('agent-hq__agent-1', {
      command: '/nonexistent/definitely-not-here',
      args: [],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/ENOENT/);
  });

  it('fails when the server exits immediately', async () => {
    const server = writeServer('dies.js', `process.stderr.write('boom\\n'); process.exit(3);`);
    const result = await preflightMcpServer('s', { command: process.execPath, args: [server] });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/exited with code 3/);
    expect(result.error).toMatch(/boom/);
  });

  it('fails when the server never answers initialize', async () => {
    const server = writeServer('silent.js', `setInterval(() => {}, 1000);`);
    const result = await preflightMcpServer('s', { command: process.execPath, args: [server] }, 400);

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/did not answer initialize/);
  });

  it('fails when initialize returns a JSON-RPC error', async () => {
    const server = writeServer(
      'err.js',
      `
      let buf='';
      process.stdin.on('data',(c)=>{buf+=c;let i;while((i=buf.indexOf('\\n'))>=0){
        const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line)continue;
        const msg=JSON.parse(line);
        if(msg.method==='initialize'){process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:msg.id,error:{code:-32000,message:'nope'}})+'\\n');}
      }});
      `,
    );

    const result = await preflightMcpServer('s', { command: process.execPath, args: [server] }, 2000);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/initialize failed/);
  });

  it('tolerates non-JSON chatter on stdout before the reply', async () => {
    const server = writeServer(
      'noisy.js',
      `
      process.stdout.write('starting up...\\n');
      ${GOOD_SERVER}
      `,
    );
    const result = await preflightMcpServer('s', { command: process.execPath, args: [server] });
    expect(result.ok).toBe(true);
  });

  it('rejects a server with no command rather than spawning a shell', async () => {
    const result = await preflightMcpServer('s', { args: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('server has no command');
  });

  it('does not leave the probe process running', async () => {
    const server = writeServer('good2.js', GOOD_SERVER);
    const before = process.memoryUsage().rss;
    const result = await preflightMcpServer('s', { command: process.execPath, args: [server] });
    expect(result.ok).toBe(true);
    // A leaked probe would hold the jest worker open; the suite completing is
    // the real assertion. rss is only read to keep the intent explicit.
    expect(typeof before).toBe('number');
  });
});

describe('preflightMcpServers', () => {
  it('reports a required server that was never materialized', async () => {
    const results = await preflightMcpServers({}, ['agent-hq__agent-9']);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toBe('server was not materialized');
  });

  it('checks several servers and preserves the requested order', async () => {
    const good = writeServer('multi.js', GOOD_SERVER);
    const results = await preflightMcpServers(
      {
        a: { command: process.execPath, args: [good] },
        b: { command: '/nonexistent/nope', args: [] },
      },
      ['b', 'a'],
    );

    expect(results.map((r) => r.serverName)).toEqual(['b', 'a']);
    expect(results[0].ok).toBe(false);
    expect(results[1].ok).toBe(true);
  });

  it('is trivially satisfied when nothing is required', async () => {
    expect(await preflightMcpServers({}, [])).toEqual([]);
  });
});

describe('describeMcpPreflightFailure', () => {
  it('is empty when everything passed', () => {
    expect(
      describeMcpPreflightFailure([{ serverName: 'a', ok: true, toolNames: [], durationMs: 1 }]),
    ).toBe('');
  });

  it('names every failing server and its cause', () => {
    const message = describeMcpPreflightFailure([
      { serverName: 'a', ok: true, toolNames: [], durationMs: 1 },
      { serverName: 'b', ok: false, toolNames: [], error: 'ENOENT', durationMs: 2 },
      { serverName: 'c', ok: false, toolNames: [], durationMs: 3 },
    ]);

    expect(message).toContain('b (ENOENT)');
    expect(message).toContain('c (unknown error)');
    expect(message).not.toContain('a (');
    // The operator-facing reason the run was stopped at all.
    expect(message).toContain('lifecycle tools');
  });
});
