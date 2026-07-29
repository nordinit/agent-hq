import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { getDb } from '../db/client';
import { OPENCLAW_CONFIG_PATH } from '../config';
import { ATLAS_AGENT_SLUG } from './atlasAgent';
import { getActiveTenantId } from './tenantContext';

export type OAuthProviderSlug = 'openai-codex';

export interface OAuthTokenPayload {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  id_token?: string;
}

export interface OpenClawOAuthCredential {
  type: 'oauth';
  provider: OAuthProviderSlug;
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
  email?: string;
  displayName?: string;
  chatgptPlanType?: string;
  idToken?: string;
}

export interface OAuthProfileSyncResult {
  ok: boolean;
  provider: OAuthProviderSlug;
  profileKey: string;
  source: 'auth-profile' | 'provider-config' | 'refreshed' | 'none';
  refreshed: boolean;
  updatedPaths: string[];
  targetPath?: string;
  expiresAt?: number;
  error?: string;
}

export interface OAuthCredentialResolveResult {
  ok: boolean;
  provider: OAuthProviderSlug;
  profileKey: string;
  source: OAuthProfileSyncResult['source'];
  refreshed: boolean;
  credential?: OpenClawOAuthCredential;
  expiresAt?: number;
  error?: string;
}

interface ProviderConfigRow {
  id: number;
  slug: string;
  display_name: string | null;
  status: string;
  config: string;
}

interface OAuthCandidate {
  credential: OpenClawOAuthCredential;
  source: 'auth-profile' | 'provider-config';
  path?: string;
}

const OPENAI_CODEX_OAUTH = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  tokenUrl: 'https://auth.openai.com/oauth/token',
};

const OPENCLAW_RUNTIME_PROVIDER = 'openai';
const OPENCLAW_RUNTIME_PROFILE_KEY = 'openai:default';
const OPENCLAW_AUTH_STORE_FILENAME = 'openclaw-agent.sqlite';

const DEFAULT_MIN_TTL_MS = 5 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function openClawHome(): string {
  return path.dirname(process.env.OPENCLAW_CONFIG_PATH ?? OPENCLAW_CONFIG_PATH);
}

export function getOAuthProfileKey(slug: OAuthProviderSlug): string {
  return `${slug}:default`;
}

export function buildAgentAuthProfilesPath(agentId: string): string {
  return path.join(openClawHome(), 'agents', agentId, 'agent', 'auth-profiles.json');
}

export function buildAgentAuthStorePath(agentId: string): string {
  return path.join(openClawHome(), 'agents', agentId, 'agent', OPENCLAW_AUTH_STORE_FILENAME);
}

function createEmptyAuthProfilesDocument(): Record<string, unknown> {
  return {
    version: 1,
    profiles: {},
    lastGood: {},
    usageStats: {},
  };
}

function readJsonFile(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonFileAtomic(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function normalizeOAuthCredential(
  value: unknown,
  provider: OAuthProviderSlug,
): OpenClawOAuthCredential | null {
  if (!isRecord(value)) return null;
  if (value.type !== 'oauth' || value.provider !== provider) return null;

  const access = typeof value.access === 'string' ? value.access.trim() : '';
  const refresh = typeof value.refresh === 'string' ? value.refresh.trim() : '';
  const expires = typeof value.expires === 'number' && Number.isFinite(value.expires)
    ? value.expires
    : 0;
  if (!access && !refresh) return null;

  const credential: OpenClawOAuthCredential = {
    type: 'oauth',
    provider,
    access,
    refresh,
    expires,
  };

  if (typeof value.accountId === 'string' && value.accountId.trim()) {
    credential.accountId = value.accountId.trim();
  }
  if (typeof value.email === 'string' && value.email.trim()) {
    credential.email = value.email.trim();
  }
  if (typeof value.displayName === 'string' && value.displayName.trim()) {
    credential.displayName = value.displayName.trim();
  }
  if (typeof value.chatgptPlanType === 'string' && value.chatgptPlanType.trim()) {
    credential.chatgptPlanType = value.chatgptPlanType.trim();
  }
  if (typeof value.idToken === 'string' && value.idToken.trim()) {
    credential.idToken = value.idToken.trim();
  }

  return credential;
}

function profileFromAuthFile(filePath: string, provider: OAuthProviderSlug): OpenClawOAuthCredential | null {
  const data = readJsonFile(filePath);
  const profiles = data?.profiles;
  if (!isRecord(profiles)) return null;
  return normalizeOAuthCredential(profiles[getOAuthProfileKey(provider)], provider);
}

export function upsertOAuthProfile(
  filePath: string,
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
): boolean {
  const data = fs.existsSync(filePath)
    ? (readJsonFile(filePath) ?? createEmptyAuthProfilesDocument())
    : createEmptyAuthProfilesDocument();

  const profiles = isRecord(data.profiles) ? data.profiles : {};
  const profileKey = getOAuthProfileKey(provider);
  const existing = normalizeOAuthCredential(profiles[profileKey], provider);
  const nextProfile: OpenClawOAuthCredential = {
    type: 'oauth',
    provider,
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    ...(credential.accountId ? { accountId: credential.accountId } : {}),
    ...(credential.email ? { email: credential.email } : {}),
    ...(credential.displayName ? { displayName: credential.displayName } : {}),
    ...(credential.chatgptPlanType ? { chatgptPlanType: credential.chatgptPlanType } : {}),
    ...(credential.idToken ? { idToken: credential.idToken } : {}),
  };

  const unchanged =
    existing?.access === nextProfile.access &&
    existing.refresh === nextProfile.refresh &&
    existing.expires === nextProfile.expires &&
    existing.accountId === nextProfile.accountId &&
    existing.email === nextProfile.email &&
    existing.displayName === nextProfile.displayName &&
    existing.chatgptPlanType === nextProfile.chatgptPlanType &&
    existing.idToken === nextProfile.idToken;

  if (unchanged) return false;

  profiles[profileKey] = nextProfile;
  data.profiles = profiles;

  const lastGood = isRecord(data.lastGood) ? data.lastGood as Record<string, string> : {};
  lastGood[provider] = profileKey;
  data.lastGood = lastGood;

  if (!isRecord(data.usageStats)) {
    data.usageStats = {};
  }

  writeJsonFileAtomic(filePath, data);
  return true;
}

async function addKnownAgentIds(agentIds: Set<string>): Promise<void> {
  agentIds.add(ATLAS_AGENT_SLUG);

  try {
    const rows = await getDb().all(`
      SELECT DISTINCT openclaw_agent_id
      FROM agents
      WHERE openclaw_agent_id IS NOT NULL
        AND trim(openclaw_agent_id) <> ''
    `) as Array<{ openclaw_agent_id: string }>;
    for (const row of rows) {
      if (typeof row.openclaw_agent_id === 'string' && row.openclaw_agent_id.trim()) {
        agentIds.add(row.openclaw_agent_id.trim());
      }
    }
  } catch {
    // During bootstrap/tests the DB may not be initialized yet.
  }

  const agentsDir = path.join(openClawHome(), 'agents');
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.trim()) {
        agentIds.add(entry.name.trim());
      }
    }
  } catch {
    // No OpenClaw agents directory yet.
  }
}

export async function collectOAuthAuthProfilePaths(): Promise<string[]> {
  const agentIds = new Set<string>();
  await addKnownAgentIds(agentIds);
  return Array.from(agentIds).sort().map(buildAgentAuthProfilesPath);
}

export async function collectOAuthAuthStorePaths(): Promise<string[]> {
  const agentIds = new Set<string>();
  await addKnownAgentIds(agentIds);
  return Array.from(agentIds).sort().map(buildAgentAuthStorePath);
}

function parseProviderConfigCredential(
  row: ProviderConfigRow,
  provider: OAuthProviderSlug,
): OpenClawOAuthCredential | null {
  let config: Record<string, unknown>;
  try {
    const parsed = JSON.parse(row.config || '{}');
    config = isRecord(parsed) ? parsed : {};
  } catch {
    return null;
  }

  if (config.auth_type !== 'oauth' || config.provider !== provider) return null;

  const tokens = isRecord(config.tokens) ? config.tokens : {};
  const access = typeof tokens.access_token === 'string' ? tokens.access_token.trim() : '';
  const refresh = typeof tokens.refresh_token === 'string' ? tokens.refresh_token.trim() : '';
  if (!access && !refresh) return null;

  const expires = typeof config.expires_at === 'number' && Number.isFinite(config.expires_at)
    ? config.expires_at
    : 0;
  const accountId = typeof config.account_id === 'string' && config.account_id.trim()
    ? config.account_id.trim()
    : typeof tokens.account_id === 'string' && tokens.account_id.trim()
      ? tokens.account_id.trim()
      : undefined;
  const idToken = typeof tokens.id_token === 'string' && tokens.id_token.trim()
    ? tokens.id_token.trim()
    : undefined;

  return {
    type: 'oauth',
    provider,
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

async function providerConfigCandidate(provider: OAuthProviderSlug): Promise<OAuthCandidate | null> {
  try {
    const db = getDb();
    const tenantId = await getActiveTenantId(db);
    const row = await db.get(`
      SELECT id, slug, display_name, status, config
      FROM provider_config
      WHERE slug = ? AND tenant_id = ?
      LIMIT 1
    `, provider, tenantId) as ProviderConfigRow | undefined;
    if (!row) return null;
    const credential = parseProviderConfigCredential(row, provider);
    return credential ? { credential, source: 'provider-config' } : null;
  } catch {
    return null;
  }
}

async function profileFromAuthStore(filePath: string, provider: OAuthProviderSlug): Promise<OpenClawOAuthCredential | null> {
  if (provider !== 'openai-codex' || !fs.existsSync(filePath)) return null;

  // NOT the Agent HQ database: this is OpenClaw's own on-disk SQLite auth store,
  // read through the raw better-sqlite3 driver. It never moves to PostgreSQL.
  let db: Database.Database | null = null;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    const row = db.prepare(`
      SELECT store_json
      FROM auth_profile_store
      WHERE store_key = 'primary'
      LIMIT 1
    `).get() as { store_json: string } | undefined;
    if (!row) return null;

    const document = JSON.parse(row.store_json);
    if (!isRecord(document) || !isRecord(document.profiles)) return null;
    const value = document.profiles[OPENCLAW_RUNTIME_PROFILE_KEY];
    if (!isRecord(value) || value.type !== 'oauth' || value.provider !== OPENCLAW_RUNTIME_PROVIDER) {
      return null;
    }

    const access = typeof value.access === 'string' ? value.access.trim() : '';
    const refresh = typeof value.refresh === 'string' ? value.refresh.trim() : '';
    const expires = typeof value.expires === 'number' && Number.isFinite(value.expires)
      ? value.expires
      : 0;
    if (!access && !refresh) return null;

    return {
      type: 'oauth',
      provider,
      access,
      refresh,
      expires,
      ...(typeof value.accountId === 'string' && value.accountId.trim() ? { accountId: value.accountId.trim() } : {}),
      ...(typeof value.email === 'string' && value.email.trim() ? { email: value.email.trim() } : {}),
      ...(typeof value.displayName === 'string' && value.displayName.trim() ? { displayName: value.displayName.trim() } : {}),
      ...(typeof value.chatgptPlanType === 'string' && value.chatgptPlanType.trim() ? { chatgptPlanType: value.chatgptPlanType.trim() } : {}),
      ...(typeof value.idToken === 'string' && value.idToken.trim() ? { idToken: value.idToken.trim() } : {}),
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function collectOAuthCandidates(provider: OAuthProviderSlug): Promise<OAuthCandidate[]> {
  const candidates: OAuthCandidate[] = [];

  for (const filePath of await collectOAuthAuthProfilePaths()) {
    if (!fs.existsSync(filePath)) continue;
    const credential = profileFromAuthFile(filePath, provider);
    if (credential) {
      candidates.push({ credential, source: 'auth-profile', path: filePath });
    }
  }

  for (const filePath of await collectOAuthAuthStorePaths()) {
    const credential = await profileFromAuthStore(filePath, provider);
    if (credential) {
      candidates.push({ credential, source: 'auth-profile', path: filePath });
    }
  }

  const dbCandidate = await providerConfigCandidate(provider);
  if (dbCandidate) candidates.push(dbCandidate);

  return candidates;
}

function isFreshCredential(credential: OpenClawOAuthCredential, minTtlMs: number): boolean {
  return Boolean(credential.access) && credential.expires > Date.now() + minTtlMs;
}

function chooseBestCandidate(candidates: OAuthCandidate[]): OAuthCandidate | null {
  return candidates
    .filter(candidate => candidate.credential.access || candidate.credential.refresh)
    .sort((a, b) => {
      const expiresDelta = b.credential.expires - a.credential.expires;
      if (expiresDelta !== 0) return expiresDelta;
      if (a.source !== b.source) return a.source === 'auth-profile' ? -1 : 1;
      return 0;
    })[0] ?? null;
}

function chooseFreshCandidate(candidates: OAuthCandidate[], minTtlMs: number): OAuthCandidate | null {
  return chooseBestCandidate(candidates.filter(candidate => isFreshCredential(candidate.credential, minTtlMs)));
}

interface OpenAICodexIdentity {
  accountId?: string;
  email?: string;
  chatgptPlanType?: string;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const encoded = token.split('.')[1];
    if (!encoded) return null;
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractOpenAICodexIdentity(accessToken: string): OpenAICodexIdentity {
  const payload = decodeJwtPayload(accessToken) ?? {};
  const auth = isRecord(payload['https://api.openai.com/auth'])
    ? payload['https://api.openai.com/auth'] as Record<string, unknown>
    : {};
  const profile = isRecord(payload['https://api.openai.com/profile'])
    ? payload['https://api.openai.com/profile'] as Record<string, unknown>
    : {};
  const accountId = typeof auth.chatgpt_account_id === 'string' && auth.chatgpt_account_id.trim()
    ? auth.chatgpt_account_id.trim()
    : undefined;
  const email = typeof profile.email === 'string' && profile.email.trim()
    ? profile.email.trim()
    : undefined;
  const chatgptPlanType = typeof auth.chatgpt_plan_type === 'string' && auth.chatgpt_plan_type.trim()
    ? auth.chatgpt_plan_type.trim()
    : undefined;
  return {
    ...(accountId ? { accountId } : {}),
    ...(email ? { email } : {}),
    ...(chatgptPlanType ? { chatgptPlanType } : {}),
  };
}

export function oauthTokensToCredential(
  provider: OAuthProviderSlug,
  tokens: OAuthTokenPayload,
): OpenClawOAuthCredential {
  const identity = extractOpenAICodexIdentity(tokens.access_token);
  return {
    type: 'oauth',
    provider,
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + tokens.expires_in * 1000,
    ...identity,
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
  };
}

function credentialToStoredOAuthConfig(
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
): Record<string, unknown> {
  return {
    auth_type: 'oauth',
    managed_by: 'agent-hq',
    provider,
    profile_key: getOAuthProfileKey(provider),
    account_id: credential.accountId ?? null,
    expires_at: credential.expires,
    last_sync: new Date().toISOString(),
    tokens: {
      access_token: credential.access,
      refresh_token: credential.refresh,
      ...(credential.accountId ? { account_id: credential.accountId } : {}),
      ...(credential.idToken ? { id_token: credential.idToken } : {}),
    },
  };
}

export async function persistOAuthCredentialToProviderConfig(
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
): Promise<void> {
  const db = getDb();
  const tenantId = await getActiveTenantId(db);
  const config = JSON.stringify(credentialToStoredOAuthConfig(provider, credential));
  const existing = await db.get('SELECT id FROM provider_config WHERE slug = ? AND tenant_id = ?', provider, tenantId) as { id: number } | undefined;
  if (existing) {
    await db.run(`
      UPDATE provider_config
      SET status = 'connected',
          config = ?,
          validation_error = NULL,
          last_validated_at = datetime('now'),
          updated_at = datetime('now')
      WHERE slug = ? AND tenant_id = ?
    `, config, provider, tenantId);
    return;
  }

  await db.run(`
    INSERT INTO provider_config (tenant_id, slug, display_name, status, config, last_validated_at, validation_error)
    VALUES (?, ?, ?, 'connected', ?, datetime('now'), NULL)
  `, tenantId, provider, 'OpenAI Codex (OAuth)', config);
}

async function refreshOpenAICodexCredential(refreshToken: string): Promise<OpenClawOAuthCredential> {
  const response = await fetch(OPENAI_CODEX_OAUTH.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENAI_CODEX_OAUTH.clientId,
    }).toString(),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI Codex token refresh failed (${response.status}): ${text.slice(0, 300)}`);
  }

  const data = await response.json() as Partial<OAuthTokenPayload>;
  if (
    typeof data.access_token !== 'string' ||
    typeof data.refresh_token !== 'string' ||
    typeof data.expires_in !== 'number'
  ) {
    throw new Error('OpenAI Codex token refresh returned an incomplete token payload.');
  }

  return oauthTokensToCredential('openai-codex', data as OAuthTokenPayload);
}

export function syncOAuthCredentialToAuthProfiles(
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
  paths: string[],
): string[] {
  const updated: string[] = [];
  for (const filePath of Array.from(new Set(paths))) {
    if (upsertOAuthProfile(filePath, provider, credential)) {
      updated.push(filePath);
    }
  }
  return updated;
}

export async function syncOAuthCredentialToAllAuthProfiles(
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
): Promise<string[]> {
  return syncOAuthCredentialToAuthProfiles(provider, credential, await collectOAuthAuthProfilePaths());
}

function buildRuntimeOAuthProfile(
  credential: OpenClawOAuthCredential,
  existing: Record<string, unknown> | null,
): Record<string, unknown> {
  const identity = extractOpenAICodexIdentity(credential.access);
  return {
    ...(existing ?? {}),
    type: 'oauth',
    provider: OPENCLAW_RUNTIME_PROVIDER,
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    ...(credential.accountId || identity.accountId
      ? { accountId: credential.accountId ?? identity.accountId }
      : {}),
    ...(credential.email || identity.email
      ? { email: credential.email ?? identity.email }
      : {}),
    ...(credential.displayName ? { displayName: credential.displayName } : {}),
    ...(credential.chatgptPlanType || identity.chatgptPlanType
      ? { chatgptPlanType: credential.chatgptPlanType ?? identity.chatgptPlanType }
      : {}),
    ...(credential.idToken ? { idToken: credential.idToken } : {}),
  };
}

export async function upsertOAuthProfileStore(
  filePath: string,
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
): Promise<boolean> {
  if (provider !== 'openai-codex' || !fs.existsSync(filePath)) return false;

  // NOT the Agent HQ database: this is OpenClaw's own on-disk SQLite auth store.
  // It keeps the raw better-sqlite3 driver — including PRAGMA and the synchronous
  // db.transaction() form — because it is not part of the PostgreSQL migration.
  let db: Database.Database | null = null;
  try {
    db = new Database(filePath, { fileMustExist: true });
    db.pragma('busy_timeout = 5000');
    // Raw better-sqlite3 on purpose: this opens OPENCLAW'S OWN auth-profile file, an
    // external SQLite database Agent HQ only reads. It is not Agent HQ's database and does
    // not migrate to PostgreSQL with it, so sqlite_master here is correct and permanent.
    const table = db.prepare(`
      SELECT 1 AS present
      FROM sqlite_master
      WHERE type = 'table' AND name = 'auth_profile_store'
      LIMIT 1
    `).get() as { present: number } | undefined;
    if (!table) return false;

    return db.transaction(() => {
      const row = db!.prepare(`
        SELECT store_json
        FROM auth_profile_store
        WHERE store_key = 'primary'
        LIMIT 1
      `).get() as { store_json: string } | undefined;
      const document = row
        ? JSON.parse(row.store_json)
        : { version: 1, profiles: {} };
      if (!isRecord(document)) return false;

      const profiles = isRecord(document.profiles) ? document.profiles : {};
      const existing = isRecord(profiles[OPENCLAW_RUNTIME_PROFILE_KEY])
        ? profiles[OPENCLAW_RUNTIME_PROFILE_KEY] as Record<string, unknown>
        : null;
      const nextProfile = buildRuntimeOAuthProfile(credential, existing);
      if (existing && JSON.stringify(existing) === JSON.stringify(nextProfile)) return false;

      profiles[OPENCLAW_RUNTIME_PROFILE_KEY] = nextProfile;
      document.version = typeof document.version === 'number' ? document.version : 1;
      document.profiles = profiles;
      const now = Date.now();
      if (row) {
        db!.prepare(`
          UPDATE auth_profile_store
          SET store_json = ?, updated_at = ?
          WHERE store_key = 'primary'
        `).run(JSON.stringify(document), now);
      } else {
        db!.prepare(`
          INSERT INTO auth_profile_store (store_key, store_json, updated_at)
          VALUES ('primary', ?, ?)
        `).run(JSON.stringify(document), now);
      }
      return true;
    })();
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

export async function syncOAuthCredentialToAuthStores(
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
  paths: string[],
): Promise<string[]> {
  const updated: string[] = [];
  for (const filePath of Array.from(new Set(paths))) {
    if (await upsertOAuthProfileStore(filePath, provider, credential)) {
      updated.push(filePath);
    }
  }
  return updated;
}

export function ensureOpenClawOAuthConfigMapping(
  configPath = process.env.OPENCLAW_CONFIG_PATH ?? OPENCLAW_CONFIG_PATH,
): boolean {
  if (!fs.existsSync(configPath)) return false;
  const config = readJsonFile(configPath);
  if (!config) return false;

  const before = JSON.stringify(config);
  const auth = isRecord(config.auth) ? config.auth : {};
  const profiles = isRecord(auth.profiles) ? auth.profiles : {};
  const existing = isRecord(profiles[OPENCLAW_RUNTIME_PROFILE_KEY])
    ? profiles[OPENCLAW_RUNTIME_PROFILE_KEY] as Record<string, unknown>
    : {};
  profiles[OPENCLAW_RUNTIME_PROFILE_KEY] = {
    ...existing,
    provider: OPENCLAW_RUNTIME_PROVIDER,
    mode: 'oauth',
  };
  auth.profiles = profiles;

  const order = isRecord(auth.order) ? auth.order : {};
  const existingOrder = Array.isArray(order[OPENCLAW_RUNTIME_PROVIDER])
    ? order[OPENCLAW_RUNTIME_PROVIDER].filter((value): value is string => typeof value === 'string')
    : [];
  order[OPENCLAW_RUNTIME_PROVIDER] = [
    OPENCLAW_RUNTIME_PROFILE_KEY,
    ...existingOrder.filter(profileId => profileId !== OPENCLAW_RUNTIME_PROFILE_KEY),
  ];
  auth.order = order;
  config.auth = auth;

  if (before === JSON.stringify(config)) return false;
  writeJsonFileAtomic(configPath, config);
  return true;
}

export async function syncOAuthCredentialToAllOpenClawStores(
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
): Promise<string[]> {
  const updated = [
    ...await syncOAuthCredentialToAllAuthProfiles(provider, credential),
    ...await syncOAuthCredentialToAuthStores(provider, credential, await collectOAuthAuthStorePaths()),
  ];
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? OPENCLAW_CONFIG_PATH;
  if (ensureOpenClawOAuthConfigMapping(configPath)) updated.push(configPath);
  return Array.from(new Set(updated));
}

export async function syncAvailableOAuthProfilesToAuthFile(agentDirPath: string): Promise<string[]> {
  const synced: string[] = [];
  const authFilePath = path.join(agentDirPath, 'auth-profiles.json');
  const authStorePath = path.join(agentDirPath, OPENCLAW_AUTH_STORE_FILENAME);
  const provider: OAuthProviderSlug = 'openai-codex';
  const candidate = chooseFreshCandidate(await collectOAuthCandidates(provider), 0)
    ?? chooseBestCandidate(await collectOAuthCandidates(provider));
  if (!candidate) return synced;

  upsertOAuthProfile(authFilePath, provider, candidate.credential);
  await upsertOAuthProfileStore(authStorePath, provider, candidate.credential);
  ensureOpenClawOAuthConfigMapping();
  synced.push(provider);
  return synced;
}

export async function resolveOAuthCredentialForProvider(params: {
  provider?: OAuthProviderSlug;
  minTtlMs?: number;
}): Promise<OAuthCredentialResolveResult> {
  const provider = params.provider ?? 'openai-codex';
  const profileKey = getOAuthProfileKey(provider);
  const minTtlMs = params.minTtlMs ?? DEFAULT_MIN_TTL_MS;
  let candidates = await collectOAuthCandidates(provider);

  let selected = chooseFreshCandidate(candidates, minTtlMs);
  let credential = selected?.credential ?? null;
  let source: OAuthProfileSyncResult['source'] = selected?.source ?? 'none';
  let refreshed = false;

  if (!credential) {
    const refreshCandidate = chooseBestCandidate(candidates.filter(candidate => Boolean(candidate.credential.refresh)));
    if (!refreshCandidate) {
      return {
        ok: false,
        provider,
        profileKey,
        source: 'none',
        refreshed: false,
        error: `No OAuth profile "${profileKey}" with a refresh token was found.`,
      };
    }

    try {
      credential = await refreshOpenAICodexCredential(refreshCandidate.credential.refresh);
      source = 'refreshed';
      refreshed = true;
    } catch (err) {
      // Another OpenClaw session may have refreshed the shared account while we
      // were reading. Reload once and adopt any fresh profile before failing.
      candidates = await collectOAuthCandidates(provider);
      selected = chooseFreshCandidate(candidates, minTtlMs);
      if (selected) {
        credential = selected.credential;
        source = selected.source;
      } else {
        return {
          ok: false,
          provider,
          profileKey,
          source: refreshCandidate.source,
          refreshed: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  await persistOAuthCredentialToProviderConfig(provider, credential);

  return {
    ok: true,
    provider,
    profileKey,
    source,
    refreshed,
    credential,
    expiresAt: credential.expires,
  };
}

export async function syncOAuthProviderForOpenClawAgent(params: {
  provider?: OAuthProviderSlug;
  agentSlug: string;
  minTtlMs?: number;
  syncAll?: boolean;
}): Promise<OAuthProfileSyncResult> {
  const provider = params.provider ?? 'openai-codex';
  const profileKey = getOAuthProfileKey(provider);
  const targetPath = buildAgentAuthProfilesPath(params.agentSlug);
  const resolved = await resolveOAuthCredentialForProvider({
    provider,
    minTtlMs: params.minTtlMs,
  });

  if (!resolved.ok || !resolved.credential) {
    return {
      ok: false,
      provider,
      profileKey,
      source: resolved.source,
      refreshed: false,
      updatedPaths: [],
      targetPath,
      error: resolved.error ?? `No usable OAuth profile "${profileKey}" was found.`,
    };
  }

  const credential = resolved.credential;
  const paths = params.syncAll ? await collectOAuthAuthProfilePaths() : [targetPath];
  const storePaths = params.syncAll
    ? await collectOAuthAuthStorePaths()
    : [buildAgentAuthStorePath(params.agentSlug)];
  const updatedPaths = [
    ...syncOAuthCredentialToAuthProfiles(provider, credential, paths),
    ...await syncOAuthCredentialToAuthStores(provider, credential, storePaths),
  ];
  const configPath = process.env.OPENCLAW_CONFIG_PATH ?? OPENCLAW_CONFIG_PATH;
  if (ensureOpenClawOAuthConfigMapping(configPath)) updatedPaths.push(configPath);

  return {
    ok: true,
    provider,
    profileKey,
    source: resolved.source,
    refreshed: resolved.refreshed,
    updatedPaths: Array.from(new Set(updatedPaths)),
    targetPath,
    expiresAt: credential.expires,
  };
}
