import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  ensureOpenClawOAuthConfigMapping,
  type OpenClawOAuthCredential,
  upsertOAuthProfileStore,
} from './openclawOAuthProfiles';

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('OpenClaw OAuth profile synchronization', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-hq-openclaw-oauth-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes Agent HQ Codex OAuth credentials into the current OpenClaw SQLite profile', async () => {
    const storePath = path.join(tempDir, 'openclaw-agent.sqlite');
    const db = new Database(storePath);
    db.exec(`
      CREATE TABLE auth_profile_store (
        store_key TEXT NOT NULL PRIMARY KEY,
        store_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    db.prepare(`
      INSERT INTO auth_profile_store (store_key, store_json, updated_at)
      VALUES ('primary', ?, 1)
    `).run(JSON.stringify({
            version: 1,
            profiles: {
              'anthropic:default': { type: 'token', provider: 'anthropic', token: 'keep-me' },
              'openai:default': { type: 'api_key', provider: 'openai', key: 'stale', displayName: 'Existing profile' },
            },
          }));
    db.close();

    const credential: OpenClawOAuthCredential = {
      type: 'oauth',
      provider: 'openai-codex',
      access: jwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'account-123',
          chatgpt_plan_type: 'pro',
        },
        'https://api.openai.com/profile': {
          email: 'atlas@example.com',
        },
      }),
      refresh: 'refresh-token',
      expires: 2_000_000_000_000,
    };

    expect(await upsertOAuthProfileStore(storePath, 'openai-codex', credential)).toBe(true);
    expect(await upsertOAuthProfileStore(storePath, 'openai-codex', credential)).toBe(false);

    const verifyDb = new Database(storePath, { readonly: true });
    const row = verifyDb.prepare(`
      SELECT store_json
      FROM auth_profile_store
      WHERE store_key = 'primary'
    `).get() as { store_json: string };
    verifyDb.close();
    const document = JSON.parse(row.store_json);

    expect(document.profiles['anthropic:default']).toEqual(expect.objectContaining({ token: 'keep-me' }));
    expect(document.profiles['openai:default']).toEqual(expect.objectContaining({
      type: 'oauth',
      provider: 'openai',
      access: credential.access,
      refresh: credential.refresh,
      expires: credential.expires,
      accountId: 'account-123',
      email: 'atlas@example.com',
      chatgptPlanType: 'pro',
      displayName: 'Existing profile',
    }));
  });

  it('repairs the OpenClaw config profile mode while preserving the legacy mapping', () => {
    const configPath = path.join(tempDir, 'openclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({
      auth: {
        profiles: {
          'openai-codex:default': { provider: 'openai-codex', mode: 'oauth' },
          'openai:default': { provider: 'openai', mode: 'token', displayName: 'Primary account' },
        },
        order: {
          openai: ['openai:backup', 'openai:default'],
        },
      },
    }));

    expect(ensureOpenClawOAuthConfigMapping(configPath)).toBe(true);
    expect(ensureOpenClawOAuthConfigMapping(configPath)).toBe(false);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.auth.profiles['openai:default']).toEqual({
      provider: 'openai',
      mode: 'oauth',
      displayName: 'Primary account',
    });
    expect(config.auth.profiles['openai-codex:default']).toEqual({
      provider: 'openai-codex',
      mode: 'oauth',
    });
    expect(config.auth.order.openai).toEqual(['openai:default', 'openai:backup']);
  });
});
