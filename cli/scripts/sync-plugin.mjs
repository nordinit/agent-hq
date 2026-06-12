/**
 * Copies the OpenClaw capability-tools plugin from the repo into cli/plugin/
 * so it ships inside the npm package. Runs automatically via "prepack".
 *
 * Docker-mode installs have no source checkout, so the CLI configures
 * OpenClaw from this bundled copy (see ensureBundledOpenClawPluginConfig).
 */
import { cpSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(cliRoot, '..', 'plugins', 'openclaw-capability-tools');
const target = join(cliRoot, 'plugin');

if (!existsSync(join(source, 'openclaw.plugin.json'))) {
  console.error(`sync-plugin: plugin source not found at ${source}`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (src) => !src.endsWith('.test.mjs') && !src.endsWith('.test.js'),
});
console.log(`sync-plugin: copied ${source} -> ${target}`);
