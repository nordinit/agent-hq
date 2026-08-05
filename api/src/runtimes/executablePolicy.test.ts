import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assertRuntimeExecutableAllowed,
  resolveAllowedRuntimeExecutable,
  validateRuntimeExecutable,
} from './executablePolicy';

const originalClaudeAllowlist = process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
const originalCodexAllowlist = process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
const roots: string[] = [];

afterEach(() => {
  if (originalClaudeAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
  else process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = originalClaudeAllowlist;
  if (originalCodexAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
  else process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = originalCodexAllowlist;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function executableAt(directory: string, name: string): string {
  fs.mkdirSync(directory, { recursive: true });
  const executable = path.join(directory, name);
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  return executable;
}

describe('runtime executable policy', () => {
  it('always permits only the adapter-owned default command without host configuration', () => {
    delete process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
    delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;

    expect(validateRuntimeExecutable('claude-code', undefined)).toBeNull();
    expect(validateRuntimeExecutable('claude-code', ' claude ')).toBeNull();
    expect(validateRuntimeExecutable('codex', 'codex')).toBeNull();
    expect(validateRuntimeExecutable('claude-code', 'claude-preview')).toContain(
      'must be "claude" or an absolute path',
    );
    expect(validateRuntimeExecutable('codex', './codex')).toContain(
      'must be "codex" or an absolute path',
    );
  });

  it('rejects an absolute request-selected executable unless the host allowlists it', () => {
    delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
    expect(validateRuntimeExecutable('codex', '/tmp/attacker-codex')).toBe(
      'runtime_config.codexBin path is not authorized by AGENT_HQ_ALLOWED_CODEX_BINARIES',
    );
    expect(() => assertRuntimeExecutableAllowed('codex', '/tmp/attacker-codex')).toThrow(
      /not authorized/,
    );
  });

  it('permits exact absolute paths explicitly selected by the host', () => {
    const first = path.resolve('/tmp/approved-claude');
    const second = path.resolve('/tmp/other-approved-claude');
    process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = [first, second].join(path.delimiter);

    expect(validateRuntimeExecutable('claude-code', first)).toBeNull();
    expect(validateRuntimeExecutable('claude-code', second)).toBeNull();
    expect(validateRuntimeExecutable('claude-code', '/tmp/not-approved-claude')).toContain(
      'not authorized',
    );
  });

  it('ignores relative host allowlist entries instead of resolving them against cwd', () => {
    process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = `relative/codex${path.delimiter}/tmp/approved-codex`;
    expect(validateRuntimeExecutable('codex', path.resolve('relative/codex'))).toContain(
      'not authorized',
    );
    expect(validateRuntimeExecutable('codex', '/tmp/approved-codex')).toBeNull();
  });

  it('resolves a default command once to its canonical absolute host identity', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-executable-policy-'));
    roots.push(root);
    const expected = executableAt(path.join(root, 'approved'), 'codex');

    expect(resolveAllowedRuntimeExecutable('codex', 'codex', {
      PATH: path.dirname(expected),
    })).toEqual({
      path: fs.realpathSync(expected),
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
  });

  it('skips cwd-dependent PATH entries and selects only an absolute host directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-executable-cwd-'));
    roots.push(root);
    executableAt(root, 'codex');
    const approved = executableAt(path.join(root, 'approved'), 'codex');
    const previousCwd = process.cwd();
    try {
      process.chdir(root);
      const resolved = resolveAllowedRuntimeExecutable('codex', 'codex', {
        PATH: ['.', path.dirname(approved)].join(path.delimiter),
      });
      expect(resolved.path).toBe(fs.realpathSync(approved));
    } finally {
      process.chdir(previousCwd);
    }
  });
});
