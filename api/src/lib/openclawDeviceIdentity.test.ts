import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { loadDeviceIdentity } from './openclawDeviceIdentity';

describe('OpenClaw device identity storage migration', () => {
  let directory: string;
  const keys = crypto.generateKeyPairSync('ed25519');
  const identity = {
    version: 1, deviceId: 'test-device', createdAtMs: 1700000000000,
    publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-identity-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  it('keeps supporting the legacy identity file', () => {
    fs.mkdirSync(path.join(directory, 'identity'));
    fs.writeFileSync(path.join(directory, 'identity', 'device.json'), JSON.stringify(identity));
    expect(loadDeviceIdentity(directory)).toEqual(identity);
  });

  it('loads the primary migrated identity and can sign a gateway challenge', () => {
    fs.mkdirSync(path.join(directory, 'state'));
    const filename = path.join(directory, 'state', 'openclaw.sqlite');
    const database = new Database(filename);
    database.exec('CREATE TABLE device_identities (identity_key TEXT PRIMARY KEY, device_id TEXT, public_key_pem TEXT, private_key_pem TEXT, created_at_ms INTEGER)');
    const insert = database.prepare('INSERT INTO device_identities VALUES (?, ?, ?, ?, ?)');
    insert.run('unrelated', 'other-device', 'invalid', 'invalid', 1);
    insert.run('primary', identity.deviceId, identity.publicKeyPem, identity.privateKeyPem, identity.createdAtMs);
    database.close();
    const before = fs.readFileSync(filename);
    const loaded = loadDeviceIdentity(directory);
    expect(loaded).toEqual(identity);
    const challenge = Buffer.from('gateway-connect-challenge');
    const signature = crypto.sign(null, challenge, loaded!.privateKeyPem);
    expect(crypto.verify(null, challenge, identity.publicKeyPem, signature)).toBe(true);
    expect(fs.readFileSync(filename)).toEqual(before);
    expect(fs.existsSync(path.join(directory, 'identity', 'device.json'))).toBe(false);
  });

  it('does not create state when neither identity store exists', () => {
    expect(loadDeviceIdentity(directory)).toBeNull();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it('returns no identity for an incompatible or corrupt database', () => {
    fs.mkdirSync(path.join(directory, 'state'));
    const filename = path.join(directory, 'state', 'openclaw.sqlite');
    const database = new Database(filename);
    database.exec('CREATE TABLE unrelated (id INTEGER)');
    database.close();
    expect(loadDeviceIdentity(directory)).toBeNull();
    fs.writeFileSync(filename, 'invalid sqlite');
    expect(loadDeviceIdentity(directory)).toBeNull();
  });
});
