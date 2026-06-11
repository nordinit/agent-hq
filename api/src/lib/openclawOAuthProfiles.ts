import fs from 'fs';
import path from 'path';
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
  };

  const unchanged =
    existing?.access === nextProfile.access &&
    existing.refresh === nextProfile.refresh &&
    existing.expires === nextProfile.expires &&
    existing.accountId === nextProfile.accountId &&
    existing.email === nextProfile.email &&
    existing.displayName === nextProfile.displayName;

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

function addKnownAgentIds(agentIds: Set<string>): void {
  agentIds.add(ATLAS_AGENT_SLUG);

  try {
    const rows = getDb().prepare(`
      SELECT DISTINCT openclaw_agent_id
      FROM agents
      WHERE openclaw_agent_id IS NOT NULL
        AND trim(openclaw_agent_id) <> ''
    `).all() as Array<{ openclaw_agent_id: string }>;
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

export function collectOAuthAuthProfilePaths(): string[] {
  const agentIds = new Set<string>();
  addKnownAgentIds(agentIds);
  return Array.from(agentIds).sort().map(buildAgentAuthProfilesPath);
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

  return {
    type: 'oauth',
    provider,
    access,
    refresh,
    expires,
    ...(accountId ? { accountId } : {}),
  };
}

function providerConfigCandidate(provider: OAuthProviderSlug): OAuthCandidate | null {
  try {
    const db = getDb();
    const tenantId = getActiveTenantId(db);
    const row = db.prepare(`
      SELECT id, slug, display_name, status, config
      FROM provider_config
      WHERE slug = ? AND tenant_id = ?
      LIMIT 1
    `).get(provider, tenantId) as ProviderConfigRow | undefined;
    if (!row) return null;
    const credential = parseProviderConfigCredential(row, provider);
    return credential ? { credential, source: 'provider-config' } : null;
  } catch {
    return null;
  }
}

function collectOAuthCandidates(provider: OAuthProviderSlug): OAuthCandidate[] {
  const candidates: OAuthCandidate[] = [];

  for (const filePath of collectOAuthAuthProfilePaths()) {
    if (!fs.existsSync(filePath)) continue;
    const credential = profileFromAuthFile(filePath, provider);
    if (credential) {
      candidates.push({ credential, source: 'auth-profile', path: filePath });
    }
  }

  const dbCandidate = providerConfigCandidate(provider);
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

function extractAccountIdFromJwt(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64').toString()) as Record<string, unknown>;
    const auth = isRecord(payload['https://api.openai.com/auth'])
      ? payload['https://api.openai.com/auth'] as Record<string, unknown>
      : {};
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null;
  } catch {
    return null;
  }
}

export function oauthTokensToCredential(
  provider: OAuthProviderSlug,
  tokens: OAuthTokenPayload,
): OpenClawOAuthCredential {
  const accountId = extractAccountIdFromJwt(tokens.access_token);
  return {
    type: 'oauth',
    provider,
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + tokens.expires_in * 1000,
    ...(accountId ? { accountId } : {}),
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
    },
  };
}

export function persistOAuthCredentialToProviderConfig(
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
): void {
  const db = getDb();
  const tenantId = getActiveTenantId(db);
  const config = JSON.stringify(credentialToStoredOAuthConfig(provider, credential));
  const existing = db.prepare('SELECT id FROM provider_config WHERE slug = ? AND tenant_id = ?').get(provider, tenantId) as { id: number } | undefined;
  if (existing) {
    db.prepare(`
      UPDATE provider_config
      SET status = 'connected',
          config = ?,
          validation_error = NULL,
          last_validated_at = datetime('now'),
          updated_at = datetime('now')
      WHERE slug = ? AND tenant_id = ?
    `).run(config, provider, tenantId);
    return;
  }

  db.prepare(`
    INSERT INTO provider_config (tenant_id, slug, display_name, status, config, last_validated_at, validation_error)
    VALUES (?, ?, ?, 'connected', ?, datetime('now'), NULL)
  `).run(tenantId, provider, 'OpenAI Codex (OAuth)', config);
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

export function syncOAuthCredentialToAllAuthProfiles(
  provider: OAuthProviderSlug,
  credential: OpenClawOAuthCredential,
): string[] {
  return syncOAuthCredentialToAuthProfiles(provider, credential, collectOAuthAuthProfilePaths());
}

export function syncAvailableOAuthProfilesToAuthFile(agentDirPath: string): string[] {
  const synced: string[] = [];
  const authFilePath = path.join(agentDirPath, 'auth-profiles.json');
  const provider: OAuthProviderSlug = 'openai-codex';
  const candidate = chooseFreshCandidate(collectOAuthCandidates(provider), 0)
    ?? chooseBestCandidate(collectOAuthCandidates(provider));
  if (!candidate) return synced;

  if (upsertOAuthProfile(authFilePath, provider, candidate.credential)) {
    synced.push(provider);
  } else {
    synced.push(provider);
  }
  return synced;
}

export async function resolveOAuthCredentialForProvider(params: {
  provider?: OAuthProviderSlug;
  minTtlMs?: number;
}): Promise<OAuthCredentialResolveResult> {
  const provider = params.provider ?? 'openai-codex';
  const profileKey = getOAuthProfileKey(provider);
  const minTtlMs = params.minTtlMs ?? DEFAULT_MIN_TTL_MS;
  let candidates = collectOAuthCandidates(provider);

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
      candidates = collectOAuthCandidates(provider);
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

  persistOAuthCredentialToProviderConfig(provider, credential);

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
  const paths = params.syncAll ? collectOAuthAuthProfilePaths() : [targetPath];
  const updatedPaths = syncOAuthCredentialToAuthProfiles(provider, credential, paths);

  return {
    ok: true,
    provider,
    profileKey,
    source: resolved.source,
    refreshed: resolved.refreshed,
    updatedPaths,
    targetPath,
    expiresAt: credential.expires,
  };
}
