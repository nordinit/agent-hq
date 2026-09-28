import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

export interface DeviceIdentity {
  version: number;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
}

function parseIdentity(value: unknown): DeviceIdentity | null {
  const identity = value as Partial<DeviceIdentity> | null;
  return identity?.version === 1 && typeof identity.deviceId === 'string' &&
    typeof identity.publicKeyPem === 'string' && typeof identity.privateKeyPem === 'string' &&
    typeof identity.createdAtMs === 'number'
    ? identity as DeviceIdentity : null;
}

/** OpenClaw 2026.9 moves device.json into its shared SQLite state. */
export function loadDeviceIdentity(stateDir = path.join(os.homedir(), '.openclaw')): DeviceIdentity | null {
  try {
    const identity = parseIdentity(JSON.parse(fs.readFileSync(path.join(stateDir, 'identity', 'device.json'), 'utf8')));
    if (identity) return identity;
  } catch {
    // The migrated installation no longer keeps the legacy file.
  }

  let database: Database.Database | undefined;
  try {
    database = new Database(path.join(stateDir, 'state', 'openclaw.sqlite'), {
      readonly: true,
      fileMustExist: true,
      timeout: 1000,
    });
    const row = database.prepare(`
      SELECT device_id AS deviceId, public_key_pem AS publicKeyPem,
             private_key_pem AS privateKeyPem, created_at_ms AS createdAtMs
      FROM device_identities WHERE identity_key = ?
    `).get('primary');
    return row ? parseIdentity({ version: 1, ...row as object }) : null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}
