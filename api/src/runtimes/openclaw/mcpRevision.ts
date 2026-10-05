import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { openClawInstallationRevision } from './installationRevision';
import { stableJson } from './stableJson';

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');

export function openClawMcpRevision(input: { configPath: string; bundlePath: string; bundlePluginId: string }) {
  const config = JSON.parse(fs.readFileSync(input.configPath, 'utf8'));
  const manifestPath = path.join(path.dirname(input.bundlePath), '.claude-plugin', 'plugin.json');
  // Missing expected files are a startup failure, never an unchanged revision.
  const payload = JSON.parse(fs.readFileSync(input.bundlePath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const runtime = openClawInstallationRevision();
  const metadata = digest({ manifest, bundlePath: path.resolve(input.bundlePath),
    pluginId: input.bundlePluginId, serverNames: Object.keys(payload.mcpServers ?? {}).sort(), plugins: config.plugins, agents: config.agents, mcp: config.mcp, runtime });
  return { revision: digest({ payload, metadata }), metadata, runtime };
}
