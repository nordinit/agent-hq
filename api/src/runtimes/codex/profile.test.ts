import fs from 'fs';
import os from 'os';
import path from 'path';
import { normalizeCodexRuntimeConfig } from './config';
import {
  allocateCodexAdHocRuntimeProfile,
  allocateCodexRuntimeProfile,
  DEFAULT_CODEX_STALE_PROFILE_TTL_MS,
  removeCodexAdHocRuntimeProfile,
  removeCodexRuntimeProfile,
  resolveCodexRuntimeStateHome,
  scavengeStaleCodexRuntimeProfiles,
} from './profile';

const originalRunStateDir = process.env.AGENT_HQ_RUN_STATE_DIR;
let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-profile-test-'));
  process.env.AGENT_HQ_RUN_STATE_DIR = path.join(root, 'runtime-state');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
afterAll(() => {
  if (originalRunStateDir === undefined) delete process.env.AGENT_HQ_RUN_STATE_DIR;
  else process.env.AGENT_HQ_RUN_STATE_DIR = originalRunStateDir;
});

describe('Codex runtime profile isolation', () => {
  it('allocates ad-hoc config and state under one random restricted run-state home', () => {
    const providerHome = path.join(root, 'provider');
    fs.mkdirSync(providerHome, { recursive: true, mode: 0o700 });
    const authPath = path.join(providerHome, 'auth.json');
    fs.writeFileSync(authPath, '{}\n', { mode: 0o600 });

    const first = allocateCodexAdHocRuntimeProfile({ providerAuthPath: authPath });
    const second = allocateCodexAdHocRuntimeProfile({ providerAuthPath: authPath });

    expect(first.codexHome).not.toBe(second.codexHome);
    expect(first.codexHome).toBe(path.join(first.allocationRoot, first.nonce));
    expect(first.profile.configPath.startsWith(`${first.codexHome}${path.sep}`)).toBe(true);
    expect(first.profile.snapshotPath.startsWith(`${first.codexHome}${path.sep}`)).toBe(true);
    expect(fs.statSync(first.codexHome).mode & 0o777).toBe(0o700);
    expect(fs.statSync(first.profile.stateHome).mode & 0o777).toBe(0o700);
    expect(fs.realpathSync(path.join(first.codexHome, 'auth.json'))).toBe(fs.realpathSync(authPath));

    removeCodexAdHocRuntimeProfile(first);
    removeCodexAdHocRuntimeProfile(second);
    expect(fs.existsSync(first.codexHome)).toBe(false);
    expect(fs.existsSync(second.codexHome)).toBe(false);
  });

  it('refuses to recursively remove a path outside the exact ad-hoc allocation', () => {
    const providerHome = path.join(root, 'provider');
    fs.mkdirSync(providerHome, { recursive: true });
    const authPath = path.join(providerHome, 'auth.json');
    fs.writeFileSync(authPath, '{}\n');
    const allocation = allocateCodexAdHocRuntimeProfile({ providerAuthPath: authPath });
    const outside = path.join(root, 'keep-me');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'important'), 'keep\n');

    expect(() => removeCodexAdHocRuntimeProfile({
      ...allocation,
      codexHome: outside,
    })).toThrow(/Refusing to remove/);
    expect(fs.existsSync(path.join(outside, 'important'))).toBe(true);

    removeCodexAdHocRuntimeProfile(allocation);
  });

  it('keeps provider credentials canonical while state is tenant/agent scoped', () => {
    const credentialHome = path.join(root, 'cli-owned');
    fs.mkdirSync(credentialHome, { recursive: true });
    const config = normalizeCodexRuntimeConfig({ codexHomeRoot: credentialHome });

    const first = allocateCodexRuntimeProfile({
      agentSlug: 'shared-slug',
      config,
      credentialHome,
      providerConnectionId: 9,
      tenantId: 1,
      agentId: 101,
      instanceId: 11,
    });
    const second = allocateCodexRuntimeProfile({
      agentSlug: 'shared-slug',
      config,
      credentialHome,
      providerConnectionId: 9,
      tenantId: 2,
      agentId: 202,
      instanceId: 22,
    });

    expect(path.dirname(first.configPath)).toBe(credentialHome);
    expect(path.dirname(second.configPath)).toBe(credentialHome);
    expect(first.configPath).not.toBe(second.configPath);
    expect(first.snapshotPath).toContain(path.join('tenant-1', 'agent-101'));
    expect(second.snapshotPath).toContain(path.join('tenant-2', 'agent-202'));
    expect(first.snapshotPath.startsWith(`${credentialHome}${path.sep}`)).toBe(false);
    expect(second.snapshotPath.startsWith(`${credentialHome}${path.sep}`)).toBe(false);
    expect(fs.statSync(first.stateHome).mode & 0o777).toBe(0o700);
  });

  it('removes only the allocated ephemeral profile', () => {
    const credentialHome = path.join(root, 'cli-owned');
    fs.mkdirSync(credentialHome, { recursive: true });
    const profile = allocateCodexRuntimeProfile({
      agentSlug: 'cinder',
      config: normalizeCodexRuntimeConfig({}),
      credentialHome,
      providerConnectionId: 9,
      tenantId: 1,
      agentId: 2,
      instanceId: 3,
    });
    fs.writeFileSync(profile.configPath, '# ephemeral\n', { mode: 0o600 });
    removeCodexRuntimeProfile(credentialHome, profile);
    expect(fs.existsSync(profile.configPath)).toBe(false);

    const outside = path.join(root, 'outside.config.toml');
    fs.writeFileSync(outside, '# keep\n');
    expect(() => removeCodexRuntimeProfile(credentialHome, {
      name: profile.name,
      configPath: outside,
    })).toThrow(/Refusing to remove/);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('resolves distinct state for distinct tenant/agent identities', () => {
    const config = normalizeCodexRuntimeConfig({});
    const credentialHome = path.join(root, 'cli-owned');
    const one = resolveCodexRuntimeStateHome({
      agentSlug: 'same', config, credentialHome, providerConnectionId: 1,
      tenantId: 1, agentId: 7,
    });
    const two = resolveCodexRuntimeStateHome({
      agentSlug: 'same', config, credentialHome, providerConnectionId: 1,
      tenantId: 2, agentId: 7,
    });
    expect(one).not.toBe(two);
  });

  it('scavenges only expired inactive runtime profiles', () => {
    const credentialHome = path.join(root, 'cli-owned');
    fs.mkdirSync(credentialHome, { recursive: true });
    const stale = 'agent-hq-runtime-11-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.config.toml';
    const active = 'agent-hq-runtime-12-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.config.toml';
    const fresh = 'agent-hq-runtime-13-cccccccccccccccccccccccccccccccc.config.toml';
    const unrelated = 'personal.config.toml';
    for (const name of [stale, active, fresh, unrelated]) {
      fs.writeFileSync(path.join(credentialHome, name), `# ${name}\n`, { mode: 0o600 });
    }
    const nowMs = Date.now();
    const old = new Date(nowMs - DEFAULT_CODEX_STALE_PROFILE_TTL_MS - 1_000);
    fs.utimesSync(path.join(credentialHome, stale), old, old);
    fs.utimesSync(path.join(credentialHome, active), old, old);

    const result = scavengeStaleCodexRuntimeProfiles(credentialHome, {
      nowMs,
      protectedInstanceIds: new Set([12]),
    });

    expect(result.removed).toEqual([stale]);
    expect(result.retainedActive).toEqual([active]);
    expect(result.retainedFresh).toEqual([fresh]);
    expect(result.failures).toEqual([]);
    expect(fs.existsSync(path.join(credentialHome, stale))).toBe(false);
    for (const name of [active, fresh, unrelated]) {
      expect(fs.existsSync(path.join(credentialHome, name))).toBe(true);
    }
  });

  it('reports a failed stale unlink and removes it on a later retry', () => {
    const credentialHome = path.join(root, 'cli-owned');
    fs.mkdirSync(credentialHome, { recursive: true });
    const name = 'agent-hq-runtime-14-dddddddddddddddddddddddddddddddd.config.toml';
    const filePath = path.join(credentialHome, name);
    fs.writeFileSync(filePath, '# stale secret\n', { mode: 0o600 });
    const nowMs = Date.now();
    const old = new Date(nowMs - DEFAULT_CODEX_STALE_PROFILE_TTL_MS - 1_000);
    fs.utimesSync(filePath, old, old);
    const realUnlink = fs.unlinkSync.bind(fs);
    const unlink = jest.spyOn(fs, 'unlinkSync').mockImplementationOnce(() => {
      const error = new Error('permission denied') as NodeJS.ErrnoException;
      error.code = 'EACCES';
      throw error;
    });

    const failed = scavengeStaleCodexRuntimeProfiles(credentialHome, { nowMs });
    expect(failed.failures).toEqual([{ name, error: 'permission denied' }]);
    expect(fs.existsSync(filePath)).toBe(true);

    unlink.mockImplementation(realUnlink);
    const retried = scavengeStaleCodexRuntimeProfiles(credentialHome, { nowMs });
    expect(retried.removed).toEqual([name]);
    expect(fs.existsSync(filePath)).toBe(false);
    unlink.mockRestore();
  });
});
