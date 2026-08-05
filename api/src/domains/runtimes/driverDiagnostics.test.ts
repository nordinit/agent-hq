import fs from 'fs';
import os from 'os';
import path from 'path';
import { diagnoseRuntimeDriver, resolveExecutable } from './driverDiagnostics';

const temporaryDirectories: string[] = [];
const originalClaudeAllowlist = process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
const originalCodexAllowlist = process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diagnostic-'));
  temporaryDirectories.push(directory);
  return directory;
}

function fakeRuntimeCli(version: string, authenticated: boolean, claude = false): string {
  const executable = path.join(temporaryDirectory(), claude ? 'claude' : 'codex');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then printf '%s\\n' '${version}'; exit 0; fi`,
    claude
      ? `if [ "$1" = "auth" ]; then printf '%s\\n' '{"loggedIn":${authenticated ? 'true' : 'false'}}'; exit ${authenticated ? 0 : 1}; fi`
      : `if [ "$1" = "login" ]; then exit ${authenticated ? 0 : 1}; fi`,
    'exit 2',
    '',
  ].join('\n'), { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  return executable;
}

function allowRuntimeCli(runtime: 'claude-code' | 'codex', executable: string): void {
  if (runtime === 'claude-code') process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = executable;
  else process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = executable;
}

afterEach(() => {
  if (originalClaudeAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
  else process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = originalClaudeAllowlist;
  if (originalCodexAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
  else process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = originalCodexAllowlist;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime driver diagnostics', () => {
  it('resolves an absolute executable without using a shell', async () => {
    await expect(resolveExecutable(process.execPath, '')).resolves.toBe(path.resolve(process.execPath));
  });

  it('checks Codex command, version, workspace, and config home without starting a turn', async () => {
    const codexHome = temporaryDirectory();
    const codexBin = fakeRuntimeCli('codex-cli 0.146.0', true);
    allowRuntimeCli('codex', codexBin);
    const result = await diagnoseRuntimeDriver({
      runtimeType: 'codex',
      runtimeConfig: {
        codexBin,
        codexHome,
        sandboxMode: 'workspace-write',
      },
      workspacePath: process.cwd(),
      pathValue: '',
      agentSlug: 'builder',
      providerConnectionId: 91,
    });

    expect(result.ok).toBe(true);
    expect(result.executable_path).toBe(fs.realpathSync(codexBin));
    expect(result.version).toBe('codex-cli 0.146.0');
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'command', status: 'pass' }),
      expect.objectContaining({ key: 'version', status: 'pass' }),
      expect.objectContaining({ key: 'workspace', status: 'pass' }),
      expect.objectContaining({ key: 'config_home', status: 'pass' }),
      expect.objectContaining({ key: 'auth', status: 'pass' }),
    ]));
  });

  it('fails readiness when Claude Code is installed but its isolated profile is logged out', async () => {
    const claudeHome = temporaryDirectory();
    const claudeBin = fakeRuntimeCli('2.1.222 (Claude Code)', false, true);
    allowRuntimeCli('claude-code', claudeBin);
    const result = await diagnoseRuntimeDriver({
      runtimeType: 'claude-code',
      runtimeConfig: {
        claudeBin,
        claudeConfigDir: claudeHome,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'version', status: 'pass' }),
      expect.objectContaining({ key: 'auth', status: 'fail' }),
    ]));
  });

  it('fails readiness for a CLI older than the verified adapter contract', async () => {
    const codexBin = fakeRuntimeCli('codex-cli 0.145.0', true);
    allowRuntimeCli('codex', codexBin);
    const result = await diagnoseRuntimeDriver({
      runtimeType: 'codex',
      runtimeConfig: {
        codexBin,
        codexHome: temporaryDirectory(),
      },
      agentSlug: 'builder',
      providerConnectionId: 91,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'version', status: 'fail' }),
      expect.objectContaining({ key: 'auth', status: 'pass' }),
    ]));
  });

  it('fails closed for a newer unverified CLI contract family', async () => {
    const codexBin = fakeRuntimeCli('codex-cli 0.147.0', true);
    allowRuntimeCli('codex', codexBin);
    const result = await diagnoseRuntimeDriver({
      runtimeType: 'codex',
      runtimeConfig: {
        codexBin,
        codexHome: temporaryDirectory(),
      },
      agentSlug: 'builder',
      providerConnectionId: 91,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'version', status: 'fail' }),
    ]));
  });

  it('does not resolve or invoke an executable from invalid runtime configuration', async () => {
    const result = await diagnoseRuntimeDriver({
      runtimeType: 'claude-code',
      runtimeConfig: { claudeBin: '/definitely/not/a/claude-binary' },
      pathValue: '',
    });

    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'config', status: 'fail' }),
      expect.objectContaining({ key: 'command', status: 'skipped' }),
      expect.objectContaining({ key: 'version', status: 'skipped' }),
    ]));
  });

  it('never executes a request-selected attacker binary that the host did not allowlist', async () => {
    delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
    const root = temporaryDirectory();
    const marker = path.join(root, 'executed');
    const attacker = path.join(root, 'codex');
    fs.writeFileSync(attacker, [
      '#!/bin/sh',
      `touch ${JSON.stringify(marker)}`,
      `printf '%s\\n' 'codex-cli 0.146.0'`,
      'exit 0',
      '',
    ].join('\n'), { mode: 0o755 });

    const result = await diagnoseRuntimeDriver({
      runtimeType: 'codex',
      runtimeConfig: { codexBin: attacker, codexHome: root },
      agentSlug: 'builder',
      providerConnectionId: 91,
    });

    expect(result.ok).toBe(false);
    expect(result.executable_path).toBeNull();
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'config', status: 'fail' }),
      expect.objectContaining({ key: 'command', status: 'skipped' }),
      expect.objectContaining({ key: 'auth', status: 'skipped' }),
    ]));
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('skips local command checks for remote runtimes', async () => {
    const result = await diagnoseRuntimeDriver({ runtimeType: 'webhook' });
    expect(result.ok).toBe(true);
    expect(result.command).toBeNull();
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'command', status: 'skipped' }),
      expect.objectContaining({ key: 'version', status: 'skipped' }),
    ]));
  });
});
