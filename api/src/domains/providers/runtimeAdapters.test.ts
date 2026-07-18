import fs from 'fs';
import os from 'os';
import path from 'path';
import { getRuntimeProviderAdapter, listRuntimeProviderCapabilities } from './runtimeAdapters';

describe('runtime provider adapters', () => {
  const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  const tempDirs: string[] = [];

  afterEach(() => {
    if (originalOpenClawStateDir == null) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-provider-adapter-'));
    tempDirs.push(dir);
    return dir;
  }

  test('registry exposes Anthropic subscription capabilities for OpenClaw and Hermes', () => {
    const capabilities = listRuntimeProviderCapabilities();
    expect(capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime: 'openclaw', provider: 'anthropic', authModes: ['subscription'] }),
      expect.objectContaining({ runtime: 'hermes', provider: 'anthropic', authModes: ['subscription'] }),
    ]));
  });

  test('OpenClaw discovers profile references without returning credential values', async () => {
    const root = tempDir();
    process.env.OPENCLAW_STATE_DIR = root;
    const authPath = path.join(root, 'agents', 'builder', 'agent', 'auth-profiles.json');
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({
      profiles: {
        'anthropic:work': { type: 'oauth', provider: 'anthropic', access: 'sensitive-access', refresh: 'sensitive-refresh' },
      },
    }));

    const adapter = getRuntimeProviderAdapter('openclaw', 'anthropic', 'subscription');
    expect(adapter).not.toBeNull();
    const connections = await adapter!.discover({ agentSlug: 'builder' });
    expect(connections).toEqual([
      expect.objectContaining({ externalRef: 'builder/anthropic:work', metadata: { agent_slug: 'builder', profile_id: 'anthropic:work', credential_owner: 'openclaw' } }),
    ]);
    expect(JSON.stringify(connections)).not.toContain('sensitive-access');
    expect(JSON.stringify(connections)).not.toContain('sensitive-refresh');

    const dispatch = adapter!.buildDispatchConfig({
      model: 'anthropic/claude-sonnet-4-6',
      externalRef: 'builder/anthropic:work',
      runtimeConfig: {},
    });
    expect(dispatch.model).toBe('anthropic/claude-sonnet-4-6@anthropic:work');
  });

  test('Hermes discovers its profile and translates canonical Anthropic models', async () => {
    const root = tempDir();
    const authPath = path.join(root, 'profiles', 'qa', 'auth.json');
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ providers: { anthropic: { auth_mode: 'oauth', token: 'sensitive-token' } } }));

    const adapter = getRuntimeProviderAdapter('hermes', 'anthropic', 'subscription');
    expect(adapter).not.toBeNull();
    const connections = await adapter!.discover({ runtimeConfig: { profile: 'qa', hermesHome: root } });
    expect(connections).toEqual([
      expect.objectContaining({ externalRef: 'hermes:qa:anthropic', metadata: { profile: 'qa', credential_owner: 'hermes' } }),
    ]);
    expect(JSON.stringify(connections)).not.toContain('sensitive-token');

    const dispatch = adapter!.buildDispatchConfig({
      model: 'anthropic/claude-sonnet-4-6',
      externalRef: 'hermes:qa:anthropic',
      runtimeConfig: { profile: 'qa' },
    });
    expect(dispatch.provider).toBe('anthropic');
    expect(dispatch.model).toBe('claude-sonnet-4-6');
    expect(dispatch.runtimeConfig).toEqual(expect.objectContaining({ provider: 'anthropic', profile: 'qa' }));
  });
});
