import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  assessRuntimeCliVersion,
  probeAllowedRuntimeCliVersion,
} from './runtimeCliVersion';

const roots: string[] = [];
const originalCodexAllowlist = process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;

afterEach(() => {
  if (originalCodexAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
  else process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = originalCodexAllowlist;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(version: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cli-version-'));
  roots.push(root);
  const executable = path.join(root, 'codex');
  fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(version)}\n`, { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  return executable;
}

describe('runtime CLI version policy', () => {
  it('enforces only the minimum and flags releases newer than the verified family', () => {
    expect(assessRuntimeCliVersion('claude-code', '2.1.219 (Claude Code)').ok).toBe(false);
    expect(assessRuntimeCliVersion('claude-code', '2.1.220 (Claude Code)')).toMatchObject({ ok: true, newerThanVerified: false });
    expect(assessRuntimeCliVersion('claude-code', '2.1.999 (Claude Code)')).toMatchObject({ ok: true, newerThanVerified: false });
    expect(assessRuntimeCliVersion('claude-code', '2.2.0 (Claude Code)')).toMatchObject({ ok: true, newerThanVerified: true });
    expect(assessRuntimeCliVersion('claude-code', '3.0.0 (Claude Code)')).toMatchObject({ ok: true, newerThanVerified: true });
    expect(assessRuntimeCliVersion('codex', 'codex-cli 0.164.0')).toMatchObject({ ok: true, newerThanVerified: false });
    const newer = assessRuntimeCliVersion('codex', 'codex-cli 0.165.0');
    expect(newer).toMatchObject({ ok: true, newerThanVerified: true, details: { newer_than_verified: true } });
    expect(newer.message).toMatch(/re-verify/);
    expect(assessRuntimeCliVersion('codex', 'codex-cli 1.0.0').ok).toBe(true);
    // Below the minimum the hardened policy does not apply (0.146 predates code-mode models and MCP approval mode).
    expect(assessRuntimeCliVersion('codex', 'codex-cli 0.146.0').ok).toBe(false);
    expect(assessRuntimeCliVersion('codex', 'not a version').ok).toBe(false);
  });

  it('probes an explicitly allowlisted fixture without starting a model turn', async () => {
    const executable = fixture('codex-cli 0.164.3');
    process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES = executable;
    await expect(probeAllowedRuntimeCliVersion({
      runtime: 'codex',
      command: executable,
    })).resolves.toMatchObject({
      ok: true,
      version: 'codex-cli 0.164.3',
      executablePath: fs.realpathSync(executable),
      executableFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      details: {
        executable_path: fs.realpathSync(executable),
        executable_fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      },
    });
  });

  it('rejects a request-selected fixture before executing it when not allowlisted', async () => {
    const executable = fixture('codex-cli 0.164.0');
    delete process.env.AGENT_HQ_ALLOWED_CODEX_BINARIES;
    await expect(probeAllowedRuntimeCliVersion({
      runtime: 'codex',
      command: executable,
    })).resolves.toMatchObject({ ok: false, version: null, message: expect.stringMatching(/not authorized/) });
  });
});
