import fs from 'fs';
import { createHash } from 'crypto';

export function openClawBundleRevision(bundlePath: string): string {
  return createHash('sha256').update(fs.readFileSync(bundlePath)).digest('hex');
}

export function assertOpenClawBundleRevision(bundlePath: string, revision: string): void {
  if (openClawBundleRevision(bundlePath) !== revision) {
    throw new Error('OpenClaw MCP configuration changed before dispatch; retry with the current configuration');
  }
}
