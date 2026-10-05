import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { resolveAllowedRuntimeExecutable } from '../executablePolicy';
import { stableJson } from './stableJson';

const digest = (value: unknown) => createHash('sha256').update(stableJson(value)).digest('hex');

/** Read installation identity without starting a CLI that can open shared state. */
export function openClawInstallationRevision(): string {
  const executable = resolveAllowedRuntimeExecutable('openclaw', process.env.OPENCLAW_BIN || 'openclaw');
  let directory = path.dirname(executable.path);
  for (let depth = 0; depth < 5; depth++) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest.name === 'openclaw') {
        const entry = path.join(directory, 'dist', 'index.js');
        const stat = fs.existsSync(entry) ? fs.statSync(entry) : null;
        return digest({ executable, manifest, entry: stat && [stat.ino, stat.size, stat.mtimeMs] });
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return digest(executable);
}

