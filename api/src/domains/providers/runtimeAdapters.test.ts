import fs from 'fs';
import os from 'os';
import path from 'path';
import { getRuntimeProviderAdapter, listRuntimeProviderCapabilities } from './runtimeAdapters';
import { normalizeCodexRuntimeConfig } from '../../runtimes/codex/config';
import { resolveEffectiveCodexHome } from '../../runtimes/codex/auth';
import { normalizeClaudeCodeRuntimeConfig } from '../../runtimes/claudeCode/config';
import { resolveEffectiveClaudeConfigHome } from '../../runtimes/claudeCode/auth';

describe('runtime provider adapters', () => {
  const originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const originalCodexHome = process.env.CODEX_HOME;
  const originalClaudeAllowlist = process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
  const originalCodexAllowlist = process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
  const tempDirs: string[] = [];

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalOpenClawStateDir == null) delete process.env.OPENCLAW_STATE_DIR;
    else process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
    if (originalClaudeConfigDir == null) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
    if (originalCodexHome == null) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalClaudeAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
    else process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = originalClaudeAllowlist;
    if (originalCodexAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
    else process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = originalCodexAllowlist;
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-provider-adapter-'));
    tempDirs.push(dir);
    return dir;
  }

  function fakeCli(name: string, body: string): string {
    const root = tempDir();
    const executable = path.join(root, name);
    fs.writeFileSync(executable, `#!/bin/sh\n${body}\n`, 'utf8');
    fs.chmodSync(executable, 0o755);
    return executable;
  }

  test('registry exposes runtime-owned subscription capabilities without conflating runtime and provider slugs', () => {
    const capabilities = listRuntimeProviderCapabilities();
    expect(capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime: 'openclaw', provider: 'anthropic', authModes: ['subscription'] }),
      expect.objectContaining({ runtime: 'hermes', provider: 'anthropic', authModes: ['subscription'] }),
      expect.objectContaining({ runtime: 'claude-code', provider: 'anthropic', authModes: ['subscription'] }),
      expect.objectContaining({ runtime: 'codex', provider: 'openai-codex', authModes: ['subscription'] }),
    ]));
  });

  test('Claude Code discovers an isolated CLI login without exposing credential contents or its host path', async () => {
    const root = tempDir();
    const claudeBin = fakeCli('claude', 'exit 0');
    process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = claudeBin;
    process.env.CLAUDE_CONFIG_DIR = root;
    fs.writeFileSync(path.join(root, '.credentials.json'), JSON.stringify({
      claudeAiOauth: { accessToken: 'sensitive-access', refreshToken: 'sensitive-refresh' },
    }));

    const adapter = getRuntimeProviderAdapter('claude-code', 'anthropic', 'subscription');
    const connections = await adapter!.discover({ runtimeConfig: { claudeConfigDir: root, claudeBin } });
    expect(connections).toHaveLength(1);
    expect(connections[0]).toEqual(expect.objectContaining({
      externalRef: expect.stringMatching(/^claude-code:[a-f0-9]{12}$/),
      metadata: expect.objectContaining({ credential_owner: 'claude-code' }),
    }));
    expect(JSON.stringify(connections)).not.toContain(root);
    expect(JSON.stringify(connections)).not.toContain('sensitive-access');
    expect(JSON.stringify(connections)).not.toContain('sensitive-refresh');

    const dispatch = adapter!.buildDispatchConfig({
      model: 'anthropic/claude-opus-4-1',
      externalRef: connections[0].externalRef,
      runtimeConfig: { claudeConfigDir: root, claudeBin },
    });
    expect(dispatch).toEqual(expect.objectContaining({ provider: 'anthropic', model: 'claude-opus-4-1' }));
    expect(resolveEffectiveClaudeConfigHome({
      config: normalizeClaudeCodeRuntimeConfig(dispatch.runtimeConfig),
      providerConnectionId: 71,
    })).toBe(root);
  });

  test('Claude Code discovers keyring-backed auth through the CLI without retaining status output', async () => {
    const root = tempDir();
    const claudeBin = fakeCli('claude', `printf '%s\\n' '{"loggedIn":true,"email":"private@example.test","subscriptionType":"max"}'`);
    process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = claudeBin;
    const adapter = getRuntimeProviderAdapter('claude-code', 'anthropic', 'subscription');

    const connections = await adapter!.discover({ runtimeConfig: { claudeConfigDir: root, claudeBin } });

    expect(connections).toHaveLength(1);
    expect(JSON.stringify(connections)).not.toContain('private@example.test');
    expect(JSON.stringify(connections)).not.toContain(root);
  });

  test('Codex discovers auth.json as openai-codex while keeping auth material opaque', async () => {
    const root = tempDir();
    const codexBin = fakeCli('codex', 'exit 0');
    process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = codexBin;
    process.env.CODEX_HOME = root;
    fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'sensitive-access', refresh_token: 'sensitive-refresh' },
    }));

    const adapter = getRuntimeProviderAdapter('codex', 'openai-codex', 'subscription');
    const connections = await adapter!.discover({ runtimeConfig: { codexHome: root, codexBin } });
    expect(connections).toHaveLength(1);
    expect(connections[0]).toEqual(expect.objectContaining({
      externalRef: expect.stringMatching(/^codex:[a-f0-9]{12}$/),
      metadata: expect.objectContaining({ credential_owner: 'codex' }),
    }));
    expect(JSON.stringify(connections)).not.toContain(root);
    expect(JSON.stringify(connections)).not.toContain('sensitive-access');

    const dispatch = adapter!.buildDispatchConfig({
      model: 'openai/gpt-5.4',
      externalRef: connections[0].externalRef,
      runtimeConfig: { codexHome: root, codexBin },
    });
    expect(dispatch).toEqual(expect.objectContaining({ provider: 'openai-codex', model: 'gpt-5.4' }));
    expect(resolveEffectiveCodexHome({
      agentSlug: 'builder',
      config: normalizeCodexRuntimeConfig(dispatch.runtimeConfig),
      providerConnectionId: 91,
    })).toBe(root);
  });

  test('Codex discovers keyring-backed auth through login status', async () => {
    const root = tempDir();
    const codexBin = fakeCli('codex', 'exit 0');
    process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = codexBin;
    const adapter = getRuntimeProviderAdapter('codex', 'openai-codex', 'subscription');

    const connections = await adapter!.discover({ runtimeConfig: { codexHomeRoot: root, codexBin } });

    expect(connections).toHaveLength(1);
    expect(connections[0].metadata).toEqual(expect.objectContaining({
      credential_owner: 'codex',
      home_source: 'configured-legacy',
    }));
    expect(JSON.stringify(connections)).not.toContain(root);
    const dispatch = adapter!.buildDispatchConfig({
      model: 'openai/gpt-5.4',
      externalRef: connections[0].externalRef,
      runtimeConfig: { codexHomeRoot: root, codexBin },
    });
    expect(resolveEffectiveCodexHome({
      agentSlug: 'builder',
      config: normalizeCodexRuntimeConfig(dispatch.runtimeConfig),
      providerConnectionId: 92,
    })).toBe(root);
  });

  test.each([
    ['claude-code', 'anthropic', 'claudeBin', 'AGENT_HQ_ALLOWED_CLAUDE_BINARIES'],
    ['codex', 'openai-codex', 'codexBin', 'AGENT_HQ_ALLOWED_CODEX_BINARIES'],
  ] as const)('does not execute an unallowlisted %s discovery binary', async (
    runtime,
    provider,
    binaryField,
    allowlistVariable,
  ) => {
    delete process.env[allowlistVariable];
    const root = tempDir();
    const marker = path.join(root, 'executed');
    const attacker = fakeCli(runtime === 'codex' ? 'codex' : 'claude', `touch ${JSON.stringify(marker)}; exit 0`);
    const adapter = getRuntimeProviderAdapter(runtime, provider, 'subscription')!;

    await expect(adapter.discover({
      runtimeConfig: {
        [binaryField]: attacker,
        ...(runtime === 'codex' ? { codexHome: root } : { claudeConfigDir: root }),
      },
    })).rejects.toThrow(/not authorized/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('Codex default and environment profiles resolve to the same home at dispatch', async () => {
    const fakeHome = tempDir();
    const codexBin = fakeCli('codex', 'exit 0');
    process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = codexBin;
    jest.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    delete process.env.CODEX_HOME;
    const defaultHome = path.join(fakeHome, '.codex');
    fs.mkdirSync(defaultHome, { recursive: true });
    fs.writeFileSync(path.join(defaultHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'default-sensitive' },
    }));
    const adapter = getRuntimeProviderAdapter('codex', 'openai-codex', 'subscription')!;
    const defaults = await adapter.discover({ runtimeConfig: { codexBin } });
    expect(defaults[0]).toMatchObject({
      externalRef: 'codex:default',
      metadata: { credential_owner: 'codex', profile: 'default', home_source: 'default' },
    });
    const defaultDispatch = adapter.buildDispatchConfig({
      model: null,
      externalRef: defaults[0].externalRef,
      runtimeConfig: { codexBin },
    });
    process.env.CODEX_HOME = tempDir();
    expect(resolveEffectiveCodexHome({
      agentSlug: 'builder',
      config: normalizeCodexRuntimeConfig(defaultDispatch.runtimeConfig),
      providerConnectionId: 93,
    })).toBe(defaultHome);

    jest.restoreAllMocks();
    const environmentHome = tempDir();
    process.env.CODEX_HOME = environmentHome;
    fs.writeFileSync(path.join(environmentHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'environment-sensitive' },
    }));
    const environment = await adapter.discover({ runtimeConfig: { codexBin } });
    expect(environment[0].metadata).toEqual(expect.objectContaining({ home_source: 'environment' }));
    const environmentDispatch = adapter.buildDispatchConfig({
      model: null,
      externalRef: environment[0].externalRef,
      runtimeConfig: { codexBin },
    });
    expect(resolveEffectiveCodexHome({
      agentSlug: 'builder',
      config: normalizeCodexRuntimeConfig(environmentDispatch.runtimeConfig),
      providerConnectionId: 94,
    })).toBe(environmentHome);
    expect(JSON.stringify([...defaults, ...environment])).not.toContain(environmentHome);
  });

  test('Codex rejects a stale opaque profile when CODEX_HOME changes', async () => {
    const firstHome = tempDir();
    const secondHome = tempDir();
    const codexBin = fakeCli('codex', 'exit 0');
    process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = codexBin;
    process.env.CODEX_HOME = firstHome;
    fs.writeFileSync(path.join(firstHome, 'auth.json'), '{"tokens":{"access_token":"one"}}');
    const adapter = getRuntimeProviderAdapter('codex', 'openai-codex', 'subscription')!;
    const [connection] = await adapter.discover({ runtimeConfig: { codexBin } });
    process.env.CODEX_HOME = secondHome;
    const dispatch = adapter.buildDispatchConfig({
      model: null,
      externalRef: connection.externalRef,
      runtimeConfig: { codexBin },
    });
    expect(() => resolveEffectiveCodexHome({
      agentSlug: 'builder',
      config: normalizeCodexRuntimeConfig(dispatch.runtimeConfig),
      providerConnectionId: 95,
    })).toThrow(/does not match/);
  });

  test('Codex auth instructions retain CLI ownership without embedding a home path', () => {
    const adapter = getRuntimeProviderAdapter('codex', 'openai-codex', 'subscription')!;
    expect(adapter.authInstructions()).toEqual(expect.objectContaining({
      command: 'codex',
      args: ['login'],
      message: expect.stringContaining('CODEX_HOME'),
    }));
    expect(adapter.authInstructions().message).not.toContain(os.homedir());
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
