import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { OPENCLAW_BIN, OPENCLAW_PATH } from '../config';

const DEFAULT_GATEWAY_PROTOCOL_VERSION = 4;
const ENV_KEYS = [
  'AGENT_HQ_OPENCLAW_GATEWAY_PROTOCOL_VERSION',
  'OPENCLAW_GATEWAY_PROTOCOL_VERSION',
] as const;

let cachedProtocolVersion: number | null = null;

function parseProtocolVersion(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 && parsed < 100 ? parsed : null;
}

function parseProtocolVersionFromText(text: string): number | null {
  const direct = text.match(/\bPROTOCOL_VERSION\b\s*(?::|=)\s*(\d+)/);
  if (direct) return parseProtocolVersion(direct[1]);

  const clientDefault = text.match(/\bminProtocol\b\s*:\s*this\.opts\.minProtocol\s*\?\?\s*(\d+)/);
  return clientDefault ? parseProtocolVersion(clientDefault[1]) : null;
}

function readProtocolVersionFile(filePath: string): number | null {
  try {
    return parseProtocolVersionFromText(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isOpenClawPackageRoot(candidate: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(candidate, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { name?: unknown };
    return parsed.name === 'openclaw';
  } catch {
    return false;
  }
}

function findOpenClawPackageRoot(startPath: string): string | null {
  let current = fs.existsSync(startPath) && fs.statSync(startPath).isDirectory()
    ? startPath
    : path.dirname(startPath);

  for (let i = 0; i < 10; i += 1) {
    if (isOpenClawPackageRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function resolveOpenClawBinaryPath(): string | null {
  const configured = OPENCLAW_BIN;
  if (path.isAbsolute(configured) || configured.includes(path.sep)) {
    return fs.existsSync(configured) ? fs.realpathSync(configured) : null;
  }

  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const raw = execFileSync(locator, [configured], {
      encoding: 'utf8',
      env: { ...process.env, PATH: OPENCLAW_PATH },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = raw.split(/\r?\n/).map(line => line.trim()).find(Boolean);
    return first ? fs.realpathSync(first) : null;
  } catch {
    return null;
  }
}

function resolveOpenClawPackageRoot(): string | null {
  const explicitPackageRoot = process.env.OPENCLAW_PACKAGE_ROOT;
  if (explicitPackageRoot && isOpenClawPackageRoot(explicitPackageRoot)) {
    return explicitPackageRoot;
  }

  const binPath = resolveOpenClawBinaryPath();
  return binPath ? findOpenClawPackageRoot(binPath) : null;
}

export function readOpenClawGatewayProtocolVersionFromPackage(packageRoot: string): number | null {
  const candidates = [
    path.join(packageRoot, 'dist', 'plugin-sdk', 'src', 'gateway', 'protocol', 'version.d.ts'),
    path.join(packageRoot, 'docs', 'gateway', 'protocol.md'),
  ];

  for (const candidate of candidates) {
    const protocolVersion = readProtocolVersionFile(candidate);
    if (protocolVersion) return protocolVersion;
  }

  try {
    const distEntries = fs.readdirSync(path.join(packageRoot, 'dist'));
    for (const entry of distEntries) {
      if (!entry.startsWith('client-') || !entry.endsWith('.js')) continue;
      const protocolVersion = readProtocolVersionFile(path.join(packageRoot, 'dist', entry));
      if (protocolVersion) return protocolVersion;
    }
  } catch {
    // The package layout changed or dist is unavailable. Fall through to default.
  }

  return null;
}

export function resolveOpenClawGatewayProtocolVersion(): number {
  if (cachedProtocolVersion) return cachedProtocolVersion;

  for (const key of ENV_KEYS) {
    const protocolVersion = parseProtocolVersion(process.env[key]);
    if (protocolVersion) {
      cachedProtocolVersion = protocolVersion;
      return protocolVersion;
    }
  }

  const packageRoot = resolveOpenClawPackageRoot();
  if (packageRoot) {
    const protocolVersion = readOpenClawGatewayProtocolVersionFromPackage(packageRoot);
    if (protocolVersion) {
      cachedProtocolVersion = protocolVersion;
      return protocolVersion;
    }
  }

  cachedProtocolVersion = DEFAULT_GATEWAY_PROTOCOL_VERSION;
  return cachedProtocolVersion;
}

export function resetOpenClawGatewayProtocolVersionCacheForTests(): void {
  cachedProtocolVersion = null;
}
