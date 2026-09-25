import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkWorkspacePath, isAllowedWorkspacePath, isDeletableOpenClawWorkspace } from './hostPathPolicy';

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
