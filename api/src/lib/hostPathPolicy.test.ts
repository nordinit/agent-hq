import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  checkRuntimeConfigHostPaths,
  checkWorkspacePath,
  isAllowedRuntimeHome,
  isAllowedWorkspacePath,
  isDeletableOpenClawWorkspace,
} from './hostPathPolicy';

const ENV_KEYS = ['AGENT_HQ_WORKSPACE_PARENT', 'WORKSPACE_PARENT', 'AGENT_HQ_ALLOWED_WORKSPACE_ROOTS'] as const;

describe('workspace path policy', () => {
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let tempDir = '';
  let agentHqParent = '';
  let openClawParent = '';

  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-path-policy-')));
    agentHqParent = path.join(tempDir, 'agent-hq-workspaces');
    openClawParent = path.join(tempDir, 'openclaw');
    fs.mkdirSync(agentHqParent);
    fs.mkdirSync(openClawParent);
    process.env.AGENT_HQ_WORKSPACE_PARENT = agentHqParent;
    process.env.WORKSPACE_PARENT = openClawParent;
    delete process.env.AGENT_HQ_ALLOWED_WORKSPACE_ROOTS;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('accepts Agent HQ and OpenClaw workspaces', () => {
    for (const allowed of [
      path.join(agentHqParent, 'cinder'),
      path.join(agentHqParent, 'cinder', 'nested'),
      path.join(openClawParent, 'workspace'),
      path.join(openClawParent, 'workspace-atlas'),
      path.join(openClawParent, 'workspace-atlas', 'memory'),
    ]) {
      expect({ allowed, ok: isAllowedWorkspacePath(allowed) }).toEqual({ allowed, ok: true });
    }
  });

  it('refuses the host outside those roots, the roots themselves, and OpenClaw state', () => {
    for (const refused of [
      '/',
      '/etc',
      os.homedir(),
      agentHqParent,
      `${agentHqParent}-sibling/x`,
      path.join(agentHqParent, '..', 'escape'),
      openClawParent,
      path.join(openClawParent, 'identity'),
      path.join(openClawParent, 'agents', 'atlas', 'agent'),
      path.join(openClawParent, 'workspace-atlas', '..', 'identity'),
      'relative/workspace',
    ]) {
      expect({ refused, ok: isAllowedWorkspacePath(refused) }).toEqual({ refused, ok: false });
    }
  });

  it('follows symlinks before deciding', () => {
    const outside = path.join(tempDir, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(agentHqParent, 'linked'));
    expect(isAllowedWorkspacePath(path.join(agentHqParent, 'linked'))).toBe(false);
    expect(isAllowedWorkspacePath(path.join(agentHqParent, 'linked', 'deeper'))).toBe(false);
  });

  it('lets the operator allow further roots', () => {
    const elsewhere = path.join(tempDir, 'repos');
    expect(isAllowedWorkspacePath(path.join(elsewhere, 'app'))).toBe(false);
    process.env.AGENT_HQ_ALLOWED_WORKSPACE_ROOTS = ['relative/ignored', elsewhere].join(path.delimiter);
    expect(isAllowedWorkspacePath(elsewhere)).toBe(true);
    expect(isAllowedWorkspacePath(path.join(elsewhere, 'app'))).toBe(true);
  });

  it('normalizes accepted paths and explains refusals', () => {
    expect(checkWorkspacePath(`${agentHqParent}/cinder/../prism/`)).toEqual({ ok: true, path: path.join(agentHqParent, 'prism') });
    const refused = checkWorkspacePath('/');
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain('AGENT_HQ_ALLOWED_WORKSPACE_ROOTS');
    expect(checkWorkspacePath('')).toMatchObject({ ok: false });
  });

  it('only deletes a real ~/.openclaw/workspace-* directory', () => {
    const openclaw = path.join(os.homedir(), '.openclaw');
    expect(isDeletableOpenClawWorkspace(path.join(openclaw, 'workspace-cinder'))).toBe(true);
    // The old prefix check accepted these; deleting the agent then removed the home directory.
    expect(isDeletableOpenClawWorkspace(`${path.join(openclaw, 'workspace-cinder')}/../..`)).toBe(false);
    expect(isDeletableOpenClawWorkspace(`${path.join(openclaw, 'workspace-')}../../Documents`)).toBe(false);
    expect(isDeletableOpenClawWorkspace(path.join(openclaw, 'workspace-cinder', 'nested'))).toBe(false);
    expect(isDeletableOpenClawWorkspace(path.join(openclaw, 'workspace'))).toBe(false);
    expect(isDeletableOpenClawWorkspace('relative/workspace-cinder')).toBe(false);
  });
});

describe('runtime config home policy', () => {
  const keys = ['AGENT_HQ_DATA_DIR', 'AGENT_HQ_ALLOWED_RUNTIME_HOME_ROOTS', 'CODEX_HOME'] as const;
  const originalEnv = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const home = os.homedir();

  beforeEach(() => {
    for (const key of keys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of keys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it("accepts the runtime's own config directories and Agent HQ's data directory", () => {
    expect(isAllowedRuntimeHome('claude', path.join(home, '.claude'))).toBe(true);
    expect(isAllowedRuntimeHome('claude', path.join(home, '.claude-work'))).toBe(true);
    expect(isAllowedRuntimeHome('codex', path.join(home, '.codex'))).toBe(true);
    expect(isAllowedRuntimeHome('hermes', path.join(home, '.hermes', 'profiles', 'cinder'))).toBe(true);
    expect(isAllowedRuntimeHome('codex', path.join(home, '.agent-hq', 'runtime-state'))).toBe(true);
  });

  it('refuses arbitrary directories and another runtime\'s home', () => {
    for (const [kind, value] of [
      ['claude', '/'],
      ['claude', home],
      ['claude', path.join(home, '.ssh')],
      ['claude', path.join(home, '.codex')],
      ['codex', path.join(home, '.claude', '..', '.ssh')],
      ['hermes', 'relative/.hermes'],
    ] as const) {
      expect({ kind, value, ok: isAllowedRuntimeHome(kind, value) }).toEqual({ kind, value, ok: false });
    }
  });

  it('honours the runtime environment value and the operator allowlist', () => {
    expect(isAllowedRuntimeHome('codex', '/srv/codex-home')).toBe(false);
    process.env.CODEX_HOME = '/srv/codex-home';
    expect(isAllowedRuntimeHome('codex', '/srv/codex-home')).toBe(true);
    process.env.AGENT_HQ_ALLOWED_RUNTIME_HOME_ROOTS = '/srv/runtime-homes';
    expect(isAllowedRuntimeHome('claude', '/srv/runtime-homes/claude-a')).toBe(true);
  });

  it('checks only changed fields of a runtime config', () => {
    expect(checkRuntimeConfigHostPaths('claude-code', { claudeConfigDir: '/etc' })).toMatch(/claudeConfigDir/);
    expect(checkRuntimeConfigHostPaths('codex', { codexHomeRoot: '/etc' })).toMatch(/codexHomeRoot/);
    expect(checkRuntimeConfigHostPaths('hermes', { profile: 'x', hermesHome: '/etc' })).toMatch(/hermesHome/);
    // Fields of another runtime are not this runtime's homes.
    expect(checkRuntimeConfigHostPaths('webhook', { claudeConfigDir: '/etc' })).toBeNull();
    // A stored legacy value round-tripped unchanged stays editable.
    expect(checkRuntimeConfigHostPaths('claude-code', { claudeConfigDir: '/etc', model: 'x' }, '{"claudeConfigDir":"/etc"}')).toBeNull();
    expect(checkRuntimeConfigHostPaths('claude-code', { claudeConfigDir: path.join(home, '.claude') })).toBeNull();
  });
});
