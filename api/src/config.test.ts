import fs from 'fs';
import os from 'os';
import path from 'path';

describe('resolveDefaultGatewayUrl', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('uses wss/https when local OpenClaw TLS is enabled', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-config-test-'));
    const configPath = path.join(tempDir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: {
        port: 19999,
        tls: {
          enabled: true,
        },
      },
    }));

    process.env.OPENCLAW_CONFIG_PATH = configPath;
    jest.resetModules();

    jest.isolateModules(() => {
      const { resolveDefaultGatewayUrl } = require('./config') as typeof import('./config');
      expect(resolveDefaultGatewayUrl('http')).toBe('https://127.0.0.1:19999');
      expect(resolveDefaultGatewayUrl('ws')).toBe('wss://127.0.0.1:19999');
    });
  });

  it('falls back to ws/http when TLS is not enabled', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-config-test-'));
    const configPath = path.join(tempDir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: {
        port: 18888,
        tls: {
          enabled: false,
        },
      },
    }));

    process.env.OPENCLAW_CONFIG_PATH = configPath;
    jest.resetModules();

    jest.isolateModules(() => {
      const { resolveDefaultGatewayUrl } = require('./config') as typeof import('./config');
      expect(resolveDefaultGatewayUrl('http')).toBe('http://127.0.0.1:18888');
      expect(resolveDefaultGatewayUrl('ws')).toBe('ws://127.0.0.1:18888');
    });
  });
});
