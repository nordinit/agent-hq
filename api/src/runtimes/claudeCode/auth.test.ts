import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeProviderHomeReference, prepareClaudeCodeAuthProfiles } from './auth';

const directories: string[] = [];
const originalClaudeAllowlist = process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;

function fakeClaude(
  loggedIn: boolean,
  version = '2.1.222 (Claude Code)',
): { executable: string; home: string; authMarker: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-test-'));
  directories.push(root);
  const executable = path.join(root, 'claude');
  const authMarker = path.join(root, 'auth-probed');
  fs.writeFileSync(executable, [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then printf '%s\\n' ${JSON.stringify(version)}; exit 0; fi`,
    `touch ${JSON.stringify(authMarker)}`,
    `printf '%s\\n' '{"loggedIn":${loggedIn ? 'true' : 'false'},"email":"never-return@example.test"}'`,
    `exit ${loggedIn ? 0 : 1}`,
    '',
  ].join('\n'), { mode: 0o755 });
  fs.chmodSync(executable, 0o755);
  process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = executable;
  return { executable, home: root, authMarker };
}

afterEach(() => {
  if (originalClaudeAllowlist == null) delete process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES;
  else process.env.AGENT_HQ_ALLOWED_CLAUDE_BINARIES = originalClaudeAllowlist;
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('prepareClaudeCodeAuthProfiles', () => {
  it('checks a selected runtime-owned profile without returning account or path details', async () => {
    const profile = fakeClaude(true);
    const result = await prepareClaudeCodeAuthProfiles({}, {
      agentSlug: 'builder',
      preferredProvider: 'anthropic',
      providerConnectionId: 71,
      runtimeConfig: {
        claudeBin: profile.executable,
        claudeConfigDir: profile.home,
        providerConnectionExternalRef: claudeProviderHomeReference(profile.home),
      },
    });

    expect(result).toMatchObject({
      ok: true,
      status: 'synced',
      providersSynced: ['anthropic'],
      details: { credential_owner: 'claude-code', provider_connection_id: 71, auth_ready: true },
    });
    expect(JSON.stringify(result)).not.toContain('never-return@example.test');
    expect(JSON.stringify(result)).not.toContain(profile.home);
  });

  it('fails closed when a selected profile is logged out', async () => {
    const profile = fakeClaude(false);
    const result = await prepareClaudeCodeAuthProfiles({}, {
      agentSlug: 'builder',
      preferredProvider: 'anthropic',
      providerConnectionId: 72,
      runtimeConfig: {
        claudeBin: profile.executable,
        claudeConfigDir: profile.home,
        providerConnectionExternalRef: claudeProviderHomeReference(profile.home),
      },
    });

    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.error).toContain('claude auth login');
    expect(JSON.stringify(result)).not.toContain(profile.home);
  });

  it('keeps operator-profile mode non-mutating when no provider connection is selected', async () => {
    const profile = fakeClaude(true);
    await expect(prepareClaudeCodeAuthProfiles({ claudeBin: profile.executable }, {
      agentSlug: 'builder',
      preferredProvider: 'anthropic',
    })).resolves.toMatchObject({ ok: true, status: 'skipped' });
    expect(fs.existsSync(profile.authMarker)).toBe(true);
  });

  it('fails a no-provider dispatch when the effective operator profile is logged out', async () => {
    const profile = fakeClaude(false);
    const result = await prepareClaudeCodeAuthProfiles({
      claudeBin: profile.executable,
      claudeConfigDir: profile.home,
    }, {
      agentSlug: 'builder',
      preferredProvider: 'anthropic',
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      source: 'operator-managed-cli-profile',
      details: { auth_ready: false },
    });
    expect(result.error).toContain('operator-managed Claude Code profile is not authenticated');
    expect(fs.existsSync(profile.authMarker)).toBe(true);
  });

  it('rejects profile substitution before probing authentication', async () => {
    const profile = fakeClaude(true);
    const result = await prepareClaudeCodeAuthProfiles({}, {
      agentSlug: 'builder',
      preferredProvider: 'anthropic',
      providerConnectionId: 73,
      runtimeConfig: {
        claudeBin: profile.executable,
        claudeConfigDir: profile.home,
        providerConnectionExternalRef: 'claude-code:000000000000',
      },
    });

    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.error).toContain('does not match');
    expect(JSON.stringify(result)).not.toContain(profile.home);
    expect(fs.existsSync(profile.authMarker)).toBe(false);
  });

  it('fails before authentication when the installed CLI family is outside the verified range', async () => {
    const profile = fakeClaude(true, '2.2.0 (Claude Code)');
    const result = await prepareClaudeCodeAuthProfiles({}, {
      agentSlug: 'builder',
      preferredProvider: 'anthropic',
      providerConnectionId: 74,
      runtimeConfig: {
        claudeBin: profile.executable,
        claudeConfigDir: profile.home,
        providerConnectionExternalRef: claudeProviderHomeReference(profile.home),
      },
    });

    expect(result).toMatchObject({
      ok: false,
      status: 'failed',
      source: 'runtime-cli-version',
      details: { runtime_cli_version: '2.2.0 (Claude Code)' },
    });
    expect(result.error).toContain('outside the verified claude-code CLI range');
    expect(fs.existsSync(profile.authMarker)).toBe(false);
  });
});
