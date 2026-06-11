import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readOpenClawGatewayProtocolVersionFromPackage,
  resetOpenClawGatewayProtocolVersionCacheForTests,
  resolveOpenClawGatewayProtocolVersion,
} from './openclawGatewayProtocol';

const ENV_KEYS = [
  'AGENT_HQ_OPENCLAW_GATEWAY_PROTOCOL_VERSION',
  'OPENCLAW_GATEWAY_PROTOCOL_VERSION',
  'OPENCLAW_PACKAGE_ROOT',
] as const;

let tempRoots: string[] = [];
let savedEnv: Partial<Record<typeof ENV_KEYS[number], string | undefined>>;

function createOpenClawPackageRoot(protocolVersion: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-openclaw-protocol-'));
  tempRoots.push(root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'openclaw' }));
  const protocolDir = path.join(root, 'dist', 'plugin-sdk', 'src', 'gateway', 'protocol');
  fs.mkdirSync(protocolDir, { recursive: true });
  fs.writeFileSync(
    path.join(protocolDir, 'version.d.ts'),
    [
      `export declare const PROTOCOL_VERSION: ${protocolVersion};`,
      `export declare const MIN_CLIENT_PROTOCOL_VERSION: ${protocolVersion};`,
      `export declare const MIN_PROBE_PROTOCOL_VERSION: ${protocolVersion};`,
    ].join('\n'),
  );
  return root;
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  resetOpenClawGatewayProtocolVersionCacheForTests();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  resetOpenClawGatewayProtocolVersionCacheForTests();
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

it('resolves the gateway protocol from the installed OpenClaw package root', () => {
  process.env.OPENCLAW_PACKAGE_ROOT = createOpenClawPackageRoot(7);

  expect(resolveOpenClawGatewayProtocolVersion()).toBe(7);
});

it('lets an Agent HQ override win over the installed package', () => {
  process.env.OPENCLAW_PACKAGE_ROOT = createOpenClawPackageRoot(7);
  process.env.AGENT_HQ_OPENCLAW_GATEWAY_PROTOCOL_VERSION = '6';

  expect(resolveOpenClawGatewayProtocolVersion()).toBe(6);
});

it('reads generated OpenClaw protocol typings directly', () => {
  const root = createOpenClawPackageRoot(5);

  expect(readOpenClawGatewayProtocolVersionFromPackage(root)).toBe(5);
});
