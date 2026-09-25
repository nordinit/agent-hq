import { spawnSync } from 'child_process';
import { OPENCLAW_BIN, OPENCLAW_PATH } from '../config';
import { buildOpenClawEnv, isLoopbackGatewayUrl, runOpenClawSync } from './openclawCli';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

const mockSpawnSync = spawnSync as jest.MockedFunction<typeof spawnSync>;

const ENV_KEYS = ['OPENCLAW_GATEWAY_URL', 'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_BIN', 'NODE_TLS_REJECT_UNAUTHORIZED'] as const;

describe('openclaw CLI child environment', () => {
  const original = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    mockSpawnSync.mockReset();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  it('drops a loopback gateway URL so the CLI uses the gateway and certificate its own config trusts', () => {
    for (const url of [
      'https://127.0.0.1:18789',
      'wss://localhost:18789',
      'ws://[::1]:18789',
      'http://127.0.0.2:18789',
    ]) {
      process.env.OPENCLAW_GATEWAY_URL = url;
      expect({ url, env: buildOpenClawEnv().OPENCLAW_GATEWAY_URL }).toEqual({ url, env: undefined });
      expect({ url, env: buildOpenClawEnv({ OPENCLAW_GATEWAY_URL: url }).OPENCLAW_GATEWAY_URL }).toEqual({ url, env: undefined });
    }
  });

  it('keeps a remote gateway URL, which the CLI then verifies like any other peer', () => {
    for (const url of [
      'wss://gateway.example.com',
      'https://host.docker.internal:18789',
      'wss://10.0.0.5:18789',
      'wss://127.0.0.1.attacker.example',
    ]) {
      process.env.OPENCLAW_GATEWAY_URL = url;
      expect(buildOpenClawEnv().OPENCLAW_GATEWAY_URL).toBe(url);
    }
  });

  it('sets the CLI PATH and quiet flags and never turns TLS verification off', () => {
    process.env.OPENCLAW_BIN = '/opt/openclaw/bin/openclaw';
    const env = buildOpenClawEnv();

    expect(env.PATH).toBe(OPENCLAW_PATH);
    expect(env.OPENCLAW_HIDE_BANNER).toBe('1');
    expect(env.OPENCLAW_SUPPRESS_NOTES).toBe('1');
    expect(env.OPENCLAW_BIN).toBeUndefined();
    expect(env).not.toHaveProperty('NODE_TLS_REJECT_UNAUTHORIZED');
  });

  it('passes a gateway token through the environment', () => {
    expect(buildOpenClawEnv({ OPENCLAW_GATEWAY_TOKEN: 'gateway-secret' }).OPENCLAW_GATEWAY_TOKEN).toBe('gateway-secret');
  });

  it('recognises loopback gateway URLs only', () => {
    expect(isLoopbackGatewayUrl('https://127.0.0.1:18789')).toBe(true);
    expect(isLoopbackGatewayUrl(' wss://localhost:18789 ')).toBe(true);
    expect(isLoopbackGatewayUrl('wss://gateway.example.com')).toBe(false);
    expect(isLoopbackGatewayUrl('127.0.0.1:18789')).toBe(false);
    expect(isLoopbackGatewayUrl('')).toBe(false);
    expect(isLoopbackGatewayUrl(undefined)).toBe(false);
  });

  it('spawns the CLI with that environment', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'https://127.0.0.1:18789';
    mockSpawnSync.mockReturnValue({ status: 0, stdout: '[]', stderr: '', pid: 1, output: [], signal: null });

    runOpenClawSync(['cron', 'list', '--json'], { timeout: 10000, env: { OPENCLAW_GATEWAY_TOKEN: 'gateway-secret' } });

    const [command, args, options] = mockSpawnSync.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; timeout: number }];
    expect(command).toBe(OPENCLAW_BIN);
    expect(args).toEqual(['cron', 'list', '--json']);
    expect(options.timeout).toBe(10000);
    expect(options.env.OPENCLAW_GATEWAY_URL).toBeUndefined();
    expect(options.env.OPENCLAW_GATEWAY_TOKEN).toBe('gateway-secret');
    expect(options.env.PATH).toBe(OPENCLAW_PATH);
  });
});
