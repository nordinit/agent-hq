import fs from 'fs';
import os from 'os';
import path from 'path';
import { openClawInstallationRevision } from './installationRevision';

it('invalidates an installed build changed behind the same executable path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-installation-'));
  const before = { bin: process.env.OPENCLAW_BIN, allowed: process.env.AGENT_HQ_ALLOWED_OPENCLAW_BINARIES };
  try {
    const entry = path.join(root, 'openclaw.mjs');
    fs.writeFileSync(entry, '#!/usr/bin/env node\n'); fs.chmodSync(entry, 0o700);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"openclaw","version":"1.0.0"}');
    fs.mkdirSync(path.join(root, 'dist')); fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'one');
    process.env.OPENCLAW_BIN = entry; process.env.AGENT_HQ_ALLOWED_OPENCLAW_BINARIES = entry;
    const first = openClawInstallationRevision();
    expect(openClawInstallationRevision()).toBe(first);
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"openclaw","version":"1.0.1"}');
    const upgraded = openClawInstallationRevision(); expect(upgraded).not.toBe(first);
    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'changed compiled build');
    expect(openClawInstallationRevision()).not.toBe(upgraded);
  } finally {
    if (before.bin === undefined) delete process.env.OPENCLAW_BIN; else process.env.OPENCLAW_BIN = before.bin;
    if (before.allowed === undefined) delete process.env.AGENT_HQ_ALLOWED_OPENCLAW_BINARIES; else process.env.AGENT_HQ_ALLOWED_OPENCLAW_BINARIES = before.allowed;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
