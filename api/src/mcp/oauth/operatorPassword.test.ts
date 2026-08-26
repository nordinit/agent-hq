import { getDb } from '../../db/client';
import { setupTestDb, teardownTestDb } from '../../db/testDb';
import {
  clearOperatorPassword,
  isOperatorPasswordSet,
  MIN_OPERATOR_PASSWORD_LENGTH,
  resetOperatorPasswordLockout,
  setOperatorPassword,
  verifyOperatorPassword,
} from './operatorPassword';

const PASSWORD = 'a-sufficiently-long-operator-password';

describe('operator password', () => {
  beforeEach(async () => {
    await setupTestDb();
    resetOperatorPasswordLockout();
  });

  afterEach(async () => {
    resetOperatorPasswordLockout();
    await teardownTestDb();
  });

  it('reports not-set before one is configured', async () => {
    const db = getDb();
    expect(await isOperatorPasswordSet(db)).toBe(false);
    expect(await verifyOperatorPassword(db, PASSWORD)).toEqual({ ok: false, reason: 'not_set' });
  });

  it('accepts the configured password and rejects anything else', async () => {
    const db = getDb();
    await setOperatorPassword(db, PASSWORD);

    expect(await isOperatorPasswordSet(db)).toBe(true);
    expect(await verifyOperatorPassword(db, PASSWORD)).toEqual({ ok: true });
    expect(await verifyOperatorPassword(db, `${PASSWORD}x`)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('stores a salted hash rather than the password', async () => {
    const db = getDb();
    await setOperatorPassword(db, PASSWORD);

    const row = await db.get(
      `SELECT value FROM app_settings WHERE key = 'mcp_oauth_operator_password'`,
    ) as { value: string };

    expect(row.value).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(row.value).not.toContain(PASSWORD);
  });

  it('salts, so the same password stored twice does not produce the same hash', async () => {
    const db = getDb();
    await setOperatorPassword(db, PASSWORD);
    const first = await db.get(`SELECT value FROM app_settings WHERE key = 'mcp_oauth_operator_password'`) as { value: string };
    await setOperatorPassword(db, PASSWORD);
    const second = await db.get(`SELECT value FROM app_settings WHERE key = 'mcp_oauth_operator_password'`) as { value: string };

    expect(first.value).not.toBe(second.value);
    expect(await verifyOperatorPassword(db, PASSWORD)).toEqual({ ok: true });
  });

  it('refuses a password below the minimum length', async () => {
    await expect(setOperatorPassword(getDb(), 'short')).rejects.toThrow(
      new RegExp(`at least ${MIN_OPERATOR_PASSWORD_LENGTH}`),
    );
  });

  it('locks out after repeated failures and stays locked for the correct password', async () => {
    // Online guessing is the threat this endpoint faces once it is published.
    const db = getDb();
    await setOperatorPassword(db, PASSWORD);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(await verifyOperatorPassword(db, 'wrong')).toMatchObject({ reason: 'invalid' });
    }
    expect(await verifyOperatorPassword(db, 'wrong')).toMatchObject({ ok: false, reason: 'locked' });
    expect(await verifyOperatorPassword(db, PASSWORD)).toMatchObject({ ok: false, reason: 'locked' });
  });

  it('clears the lockout once the window passes', async () => {
    const db = getDb();
    await setOperatorPassword(db, PASSWORD);
    for (let attempt = 0; attempt < 5; attempt += 1) await verifyOperatorPassword(db, 'wrong');

    const later = Date.now() + 16 * 60 * 1000;
    expect(await verifyOperatorPassword(db, PASSWORD, later)).toEqual({ ok: true });
  });

  it('drops a lockout when the password is changed', async () => {
    // Otherwise an operator who forgot the password and locked themselves out would still be
    // locked out after setting a new one from the CLI.
    const db = getDb();
    await setOperatorPassword(db, PASSWORD);
    for (let attempt = 0; attempt < 5; attempt += 1) await verifyOperatorPassword(db, 'wrong');

    await setOperatorPassword(db, 'another-long-operator-password');
    expect(await verifyOperatorPassword(db, 'another-long-operator-password')).toEqual({ ok: true });
  });

  it('clears back to not-set', async () => {
    const db = getDb();
    await setOperatorPassword(db, PASSWORD);
    await clearOperatorPassword(db);

    expect(await isOperatorPasswordSet(db)).toBe(false);
    expect(await verifyOperatorPassword(db, PASSWORD)).toEqual({ ok: false, reason: 'not_set' });
  });
});
