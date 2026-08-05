import fs from 'fs';
import os from 'os';
import path from 'path';
import { resolveOAuthCredentialForProvider } from '../../lib/openclawOAuthProfiles';
import {
  codexProviderHomeReference,
  codexAuthReady,
  prepareCodexAuthProfiles,
  resolveCodexHome,
  upsertCodexOAuthAuth,
} from './auth';
import { normalizeCodexRuntimeConfig } from './config';

jest.mock('../../lib/openclawOAuthProfiles', () => ({
  resolveOAuthCredentialForProvider: jest.fn(),
}));

const resolveOAuth = resolveOAuthCredentialForProvider as jest.MockedFunction<
  typeof resolveOAuthCredentialForProvider
>;
const originalRunStateDir = process.env.AGENT_HQ_RUN_STATE_DIR;
const originalDataDir = process.env.AGENT_HQ_DATA_DIR;
const originalCodexAllowlist = process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-test-'));
  resolveOAuth.mockReset();
});
afterEach(() => {
  if (originalCodexAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
  else process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = originalCodexAllowlist;
  fs.rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  if (originalRunStateDir === undefined) delete process.env.AGENT_HQ_RUN_STATE_DIR;
  else process.env.AGENT_HQ_RUN_STATE_DIR = originalRunStateDir;
  if (originalDataDir === undefined) delete process.env.AGENT_HQ_DATA_DIR;
  else process.env.AGENT_HQ_DATA_DIR = originalDataDir;
});

const credential = {
  type: 'oauth' as const,
  provider: 'openai-codex' as const,
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 3_600_000,
  accountId: 'acct-1',
  idToken: 'id-token',
};

function fakeCodex(version = 'codex-cli 0.146.0', authReady = true): string {
  const executable = path.join(root, `codex-${version.replace(/[^a-z0-9]+/gi, '-')}`);
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then printf '%s\\n' ${JSON.stringify(version)}; exit 0; fi`,
    `touch ${JSON.stringify(path.join(root, 'auth-probed'))}`,
    `exit ${authReady ? 0 : 1}`,
    '',
  ].join('\n'), { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = executable;
  return executable;
}

describe('Codex managed auth', () => {
  it('defaults to durable agent-scoped state rather than an OS temp directory', () => {
    delete process.env.AGENT_HQ_RUN_STATE_DIR;
    delete process.env.AGENT_HQ_DATA_DIR;
    const config = normalizeCodexRuntimeConfig({});
    const home = resolveCodexHome('Cinder Backend', config, { tenantId: 1, agentId: 7 });
    expect(home).toContain(path.join(os.homedir(), '.agent-hq', 'runtime-state', 'codex'));
    expect(home).not.toContain(os.tmpdir());
    expect(home).toBe(resolveCodexHome('Renamed Agent', config, { tenantId: 1, agentId: 7 }));
    expect(home).not.toBe(resolveCodexHome('Cinder Backend', config, { tenantId: 2, agentId: 7 }));
    expect(home).not.toBe(resolveCodexHome('Cinder Backend', config, { tenantId: 1, agentId: 8 }));
  });

  it('writes native auth.json atomically and avoids churn for unchanged credentials', () => {
    const authPath = path.join(root, 'auth.json');
    expect(upsertCodexOAuthAuth(authPath, credential)).toBe(true);
    expect(upsertCodexOAuthAuth(authPath, credential)).toBe(false);
    expect(codexAuthReady(authPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toMatchObject({
      OPENAI_API_KEY: null,
      tokens: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
        id_token: 'id-token',
        account_id: 'acct-1',
      },
    });
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600);
  });

  it('materializes legacy central OAuth only without a runtime-owned connection', async () => {
    resolveOAuth.mockResolvedValue({
      ok: true,
      provider: 'openai-codex',
      profileKey: 'openai-codex:default',
      source: 'provider-config',
      refreshed: false,
      credential,
      expiresAt: credential.expires,
    });
    const result = await prepareCodexAuthProfiles({ codexBin: fakeCodex() }, {
      agentSlug: 'cinder',
      agentId: 7,
      tenantId: 1,
      preferredProvider: 'openai-codex',
      runtimeConfig: { codexHomeRoot: root },
    });
    expect(result).toMatchObject({ ok: true, status: 'synced', providersSynced: ['openai-codex'] });
    expect(resolveOAuth).toHaveBeenCalledTimes(1);
    expect(result.runtimeAuthPath).toContain(path.join(root, 'codex'));
  });

  it('keeps same-slug managed auth in separate tenant homes', async () => {
    resolveOAuth.mockResolvedValue({
      ok: true,
      provider: 'openai-codex',
      profileKey: 'openai-codex:default',
      source: 'provider-config',
      refreshed: false,
      credential,
      expiresAt: credential.expires,
    });
    const codexBin = fakeCodex();
    const first = await prepareCodexAuthProfiles({ codexBin }, {
      agentSlug: 'shared', agentId: 7, tenantId: 1,
      preferredProvider: 'openai-codex',
      runtimeConfig: { codexHomeRoot: root },
    });
    const second = await prepareCodexAuthProfiles({ codexBin }, {
      agentSlug: 'shared', agentId: 7, tenantId: 2,
      preferredProvider: 'openai-codex',
      runtimeConfig: { codexHomeRoot: root },
    });
    expect(first.runtimeAuthPath).toContain(path.join('tenant-1', 'agent-7'));
    expect(second.runtimeAuthPath).toContain(path.join('tenant-2', 'agent-7'));
    expect(first.runtimeAuthPath).not.toBe(second.runtimeAuthPath);
  });

  it('fails closed without trusted ownership for a managed home', async () => {
    const result = await prepareCodexAuthProfiles({ codexBin: fakeCodex() }, {
      agentSlug: 'shared',
      preferredProvider: 'openai-codex',
      runtimeConfig: { codexHomeRoot: root },
    });
    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.error).toContain('trusted positive tenantId');
  });

  it('validates but never overwrites a runtime-owned provider profile', async () => {
    const ownedHome = path.join(root, 'cli-owned');
    fs.mkdirSync(ownedHome, { recursive: true });
    const authPath = path.join(ownedHome, 'auth.json');
    const original = '{"tokens":{"access_token":"cli-owned-token"},"custom":true}\n';
    fs.writeFileSync(authPath, original, { mode: 0o600 });

    const result = await prepareCodexAuthProfiles({ codexBin: fakeCodex() }, {
      agentSlug: 'cinder',
      preferredProvider: 'openai-codex',
      providerConnectionId: 91,
      runtimeConfig: {
        codexHome: ownedHome,
        providerConnectionExternalRef: codexProviderHomeReference(ownedHome),
      },
    });
    expect(result).toMatchObject({
      ok: true,
      status: 'synced',
      source: 'runtime-provider-connection',
      details: { credential_owner: 'codex', auth_changed: false },
    });
    expect(resolveOAuth).not.toHaveBeenCalled();
    expect(fs.readFileSync(authPath, 'utf8')).toBe(original);
  });

  it('fails before auth materialization when the installed CLI family is unverified', async () => {
    const result = await prepareCodexAuthProfiles({ codexBin: fakeCodex('codex-cli 0.147.0') }, {
      agentSlug: 'cinder',
      agentId: 7,
      tenantId: 1,
      preferredProvider: 'openai-codex',
      runtimeConfig: { codexHomeRoot: root },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      source: 'runtime-cli-version',
      details: { runtime_cli_version: 'codex-cli 0.147.0' },
    });
    expect(resolveOAuth).not.toHaveBeenCalled();
  });

  it('verifies an operator-managed CODEX_HOME when no provider is selected', async () => {
    const result = await prepareCodexAuthProfiles({
      codexBin: fakeCodex(),
      codexHomeRoot: root,
    }, {
      agentSlug: 'cinder',
      agentId: 7,
      tenantId: 1,
    });

    expect(result).toMatchObject({ ok: true, status: 'skipped' });
    expect(fs.existsSync(path.join(root, 'auth-probed'))).toBe(true);
  });

  it('fails without a provider when the effective CODEX_HOME is unauthenticated', async () => {
    const result = await prepareCodexAuthProfiles({
      codexBin: fakeCodex('codex-cli 0.146.0', false),
      codexHomeRoot: root,
    }, {
      agentSlug: 'cinder',
      agentId: 7,
      tenantId: 1,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      source: 'operator-managed-cli-profile',
      details: { auth_ready: false },
    });
    expect(result.error).toContain('effective CODEX_HOME is not authenticated');
  });

  it('rejects non-Codex providers instead of claiming scrubbed API-key environment auth', async () => {
    const result = await prepareCodexAuthProfiles({
      codexBin: fakeCodex(),
      codexHomeRoot: root,
    }, {
      agentSlug: 'cinder',
      agentId: 7,
      tenantId: 1,
      preferredProvider: 'openai',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      source: 'runtime-provider-configuration',
    });
    expect(result.error).toContain('API-key child environment credentials are intentionally unavailable');
    expect(fs.existsSync(path.join(root, 'auth-probed'))).toBe(false);
  });
});
