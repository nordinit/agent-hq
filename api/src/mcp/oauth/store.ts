/**
 * Storage for the MCP OAuth authorization server.
 *
 * Clients, authorization codes, and grants live in the tables added by migration 23. Access
 * tokens deliberately do not: an issued access token is a row in mcp_api_keys carrying an expiry
 * and a grant back-reference, so every downstream check — identity resolution, capability policy,
 * audit actor — is the same code path a local stdio key already takes.
 *
 * Codes and refresh tokens are stored as sha256 hashes, so nothing here can hand back a usable
 * credential after the one moment it is issued. Client secrets are not stored at all: this server
 * registers public clients and relies on PKCE, which is what OAuth 2.1 requires anyway.
 */

import crypto from 'crypto';
import type { Db } from '../../db/adapter/types';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { issueMcpApiKeyForAgent } from '../../lib/mcpApiAuth';

const SIGNING_KEY_SETTING = 'mcp_oauth_signing_key';

export const AUTHORIZATION_CODE_TTL_MS = 60_000;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const CONSENT_REQUEST_TTL_MS = 10 * 60_000;

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function utcTimestamp(at: number): string {
  return new Date(at).toISOString().slice(0, 19).replace('T', ' ');
}

function parseJsonArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * HMAC key for the consent hop.
 *
 * The authorization request has to survive the round trip through the operator's browser between
 * /authorize and the consent POST. Signing it and putting it in the form keeps that hop stateless
 * — no pending-request table, and an API restart mid-login costs the operator a retry rather than
 * stranding a row. Generated once and kept in app_settings.
 */
export async function getConsentSigningKey(db: Db): Promise<Buffer> {
  const row = await db.get(`SELECT value FROM app_settings WHERE key = ?`, SIGNING_KEY_SETTING) as { value: string } | undefined;
  const existing = row?.value?.trim();
  if (existing) return Buffer.from(existing, 'base64');

  const generated = crypto.randomBytes(32);
  await db.run(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT(key) DO NOTHING
  `, SIGNING_KEY_SETTING, generated.toString('base64'));

  const after = await db.get(`SELECT value FROM app_settings WHERE key = ?`, SIGNING_KEY_SETTING) as { value: string } | undefined;
  return Buffer.from((after?.value ?? generated.toString('base64')).trim(), 'base64');
}

export function signConsentPayload(key: Buffer, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyConsentPayload<T = Record<string, unknown>>(key: Buffer, token: string): T | null {
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', key).update(body).digest('base64url');
  const provided = Buffer.from(mac);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length || !crypto.timingSafeEqual(provided, computed)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function rowToClient(row: Record<string, unknown>): OAuthClientInformationFull {
  return {
    client_id: String(row.client_id),
    client_secret: undefined,
    client_name: String(row.client_name ?? ''),
    redirect_uris: parseJsonArray(row.redirect_uris) as [string, ...string[]],
    grant_types: parseJsonArray(row.grant_types),
    response_types: parseJsonArray(row.response_types),
    token_endpoint_auth_method: String(row.token_endpoint_auth_method ?? 'none'),
    scope: typeof row.scope === 'string' ? row.scope : undefined,
    client_uri: typeof row.client_uri === 'string' ? row.client_uri : undefined,
    client_id_issued_at: Number(row.client_id_issued_at ?? 0),
    client_secret_expires_at: row.client_secret_expires_at == null ? undefined : Number(row.client_secret_expires_at),
  } as OAuthClientInformationFull;
}

export interface ClientsStoreOptions {
  /** Whether new clients may register themselves (RFC 7591). */
  allowDynamicRegistration: boolean;
}

export class AgentHqOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: Db, private readonly options: ClientsStoreOptions) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const row = await this.db.get(
      `SELECT * FROM mcp_oauth_clients WHERE client_id = ? AND disabled_at IS NULL LIMIT 1`,
      clientId,
    ) as Record<string, unknown> | undefined;
    if (!row) return undefined;

    // No client_secret is ever returned, because none is ever issued — see registerClient.
    return rowToClient(row);
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    if (!this.options.allowDynamicRegistration) {
      throw new Error('Dynamic client registration is disabled on this Agent HQ install.');
    }

    const redirectUris = Array.isArray(client.redirect_uris) ? client.redirect_uris : [];
    if (redirectUris.length === 0) {
      throw new Error('At least one redirect_uri is required.');
    }
    for (const uri of redirectUris) {
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        throw new Error(`redirect_uri is not a valid URL: ${uri}`);
      }
      // Loopback stays allowed for desktop clients that listen locally; everything else must be
      // https, so an authorization code is never handed to a plaintext endpoint.
      const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
      if (parsed.protocol !== 'https:' && !isLoopback) {
        throw new Error(`redirect_uri must use https (or loopback): ${uri}`);
      }
    }

    const clientId = `ahq_client_${crypto.randomBytes(16).toString('base64url')}`;
    const issuedAt = Math.floor(Date.now() / 1000);

    // Public clients only, always. Confidential clients would mean holding a secret this server
    // can compare in the clear — the SDK's client authentication does a plain string equality
    // against whatever getClient returns, so a hash cannot be used — and a recoverable secret in
    // the same database as everything else buys nothing over the PKCE exchange that OAuth 2.1
    // already requires. A client that asks for a secret is registered without one; the
    // authorization code is bound to its code_challenge instead, which is what actually proves
    // the token request came from the same software that started the flow.
    await this.db.run(`
      INSERT INTO mcp_oauth_clients (
        client_id, client_secret_hash, client_name, redirect_uris, grant_types, response_types,
        token_endpoint_auth_method, scope, client_uri, registered_via, client_id_issued_at
      ) VALUES (?, NULL, ?, ?, ?, ?, 'none', ?, ?, 'dcr', ?)
    `,
      clientId,
      client.client_name ?? '',
      JSON.stringify(redirectUris),
      JSON.stringify(client.grant_types ?? ['authorization_code', 'refresh_token']),
      JSON.stringify(client.response_types ?? ['code']),
      client.scope ?? null,
      client.client_uri ?? null,
      issuedAt,
    );

    console.log(`[mcp-oauth] registered client ${clientId} (${client.client_name ?? 'unnamed'})`);

    return {
      ...client,
      client_id: clientId,
      client_secret: undefined,
      token_endpoint_auth_method: 'none',
      client_id_issued_at: issuedAt,
      redirect_uris: redirectUris as [string, ...string[]],
    } as OAuthClientInformationFull;
  }
}

export interface CreateAuthorizationCodeInput {
  clientId: string;
  agentId: number;
  tenantId: number;
  redirectUri: string;
  codeChallenge: string;
  resource?: string | null;
  scopes: string[];
}

export async function createAuthorizationCode(db: Db, input: CreateAuthorizationCodeInput, now = Date.now()): Promise<string> {
  const code = `ahq_code_${crypto.randomBytes(32).toString('base64url')}`;
  await db.run(`
    INSERT INTO mcp_oauth_authorization_codes (
      code_hash, client_id, agent_id, tenant_id, redirect_uri, code_challenge, resource, scopes, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    sha256(code),
    input.clientId,
    input.agentId,
    input.tenantId,
    input.redirectUri,
    input.codeChallenge,
    input.resource ?? null,
    JSON.stringify(input.scopes),
    utcTimestamp(now + AUTHORIZATION_CODE_TTL_MS),
  );
  return code;
}

export interface AuthorizationCodeRecord {
  id: number;
  clientId: string;
  agentId: number;
  tenantId: number;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  scopes: string[];
}

export async function peekAuthorizationCode(db: Db, code: string): Promise<AuthorizationCodeRecord | null> {
  const row = await db.get(
    `SELECT * FROM mcp_oauth_authorization_codes WHERE code_hash = ? LIMIT 1`,
    sha256(code),
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    clientId: String(row.client_id),
    agentId: Number(row.agent_id),
    tenantId: Number(row.tenant_id),
    redirectUri: String(row.redirect_uri),
    codeChallenge: String(row.code_challenge),
    resource: typeof row.resource === 'string' ? row.resource : null,
    scopes: parseJsonArray(row.scopes),
  };
}

/**
 * Claims a code for exactly one caller.
 *
 * The UPDATE ... WHERE consumed_at IS NULL is the whole mechanism: two token requests racing on
 * the same code both reach the database, and only the one whose UPDATE reports a changed row is
 * allowed to continue. Checking-then-writing would let both through.
 */
export async function consumeAuthorizationCode(
  db: Db,
  code: string,
  now = Date.now(),
): Promise<{ ok: true; record: AuthorizationCodeRecord } | { ok: false; reason: 'unknown' | 'expired' | 'replayed' }> {
  const record = await peekAuthorizationCode(db, code);
  if (!record) return { ok: false, reason: 'unknown' };

  const result = await db.run(`
    UPDATE mcp_oauth_authorization_codes
    SET consumed_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?
  `, sha256(code), utcTimestamp(now));

  if (!result.changes) {
    const row = await db.get(
      `SELECT consumed_at, expires_at FROM mcp_oauth_authorization_codes WHERE code_hash = ? LIMIT 1`,
      sha256(code),
    ) as { consumed_at: string | null; expires_at: string } | undefined;
    if (row?.consumed_at) {
      // A replayed code means the first one may have been stolen. Nothing to revoke yet — no
      // grant exists for a code that never completed — but it is worth seeing in the log.
      console.warn(`[mcp-oauth] authorization code replay for client ${record.clientId}`);
      return { ok: false, reason: 'replayed' };
    }
    return { ok: false, reason: 'expired' };
  }

  return { ok: true, record };
}

export interface GrantRecord {
  id: number;
  clientId: string;
  agentId: number;
  tenantId: number;
  scopes: string[];
  resource: string | null;
  supersededAt: string | null;
  revokedAt: string | null;
}

export async function createGrant(db: Db, input: {
  clientId: string;
  agentId: number;
  tenantId: number;
  scopes: string[];
  resource: string | null;
  refreshToken: string;
  rotatedFromId?: number | null;
}): Promise<number> {
  const result = await db.run(`
    INSERT INTO mcp_oauth_grants (client_id, agent_id, tenant_id, scopes, resource, refresh_token_hash, rotated_from_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `,
    input.clientId,
    input.agentId,
    input.tenantId,
    JSON.stringify(input.scopes),
    input.resource,
    sha256(input.refreshToken),
    input.rotatedFromId ?? null,
  );
  return Number(result.lastInsertId);
}

export async function findGrantByRefreshToken(db: Db, refreshToken: string): Promise<(GrantRecord & { rotatedFromId: number | null }) | null> {
  const row = await db.get(
    `SELECT * FROM mcp_oauth_grants WHERE refresh_token_hash = ? LIMIT 1`,
    sha256(refreshToken),
  ) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    clientId: String(row.client_id),
    agentId: Number(row.agent_id),
    tenantId: Number(row.tenant_id),
    scopes: parseJsonArray(row.scopes),
    resource: typeof row.resource === 'string' ? row.resource : null,
    supersededAt: typeof row.superseded_at === 'string' ? row.superseded_at : null,
    revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    rotatedFromId: row.rotated_from_id == null ? null : Number(row.rotated_from_id),
  };
}

/** Every grant reachable from this one by rotation, in both directions. */
async function collectGrantFamily(db: Db, grantId: number): Promise<number[]> {
  const seen = new Set<number>([grantId]);
  const queue = [grantId];
  while (queue.length) {
    const current = queue.pop() as number;
    const rows = await db.all(`
      SELECT id FROM mcp_oauth_grants WHERE rotated_from_id = ?
      UNION
      SELECT rotated_from_id AS id FROM mcp_oauth_grants WHERE id = ? AND rotated_from_id IS NOT NULL
    `, current, current) as Array<{ id: number }>;
    for (const row of rows) {
      const id = Number(row.id);
      if (!seen.has(id)) {
        seen.add(id);
        queue.push(id);
      }
    }
  }
  return [...seen];
}

/**
 * Revokes a grant and every access token issued under it.
 *
 * `family: true` extends that to every grant reachable by rotation, which is what a replayed
 * refresh token warrants: either the client is buggy or a token leaked, and in the second case
 * the attacker holds a token from somewhere in the same chain.
 */
export async function revokeGrant(db: Db, grantId: number, reason: string, options: { family?: boolean } = {}): Promise<number[]> {
  const ids = options.family ? await collectGrantFamily(db, grantId) : [grantId];
  for (const id of ids) {
    await db.run(`
      UPDATE mcp_oauth_grants
      SET revoked_at = COALESCE(revoked_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),
          revoked_reason = COALESCE(revoked_reason, ?),
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = ?
    `, reason, id);
    await db.run(`
      UPDATE mcp_api_keys
      SET enabled = 0,
          revoked_at = COALESCE(revoked_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),
          updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
      WHERE oauth_grant_id = ?
    `, id);
  }
  return ids;
}

export async function markGrantUsed(db: Db, grantId: number): Promise<void> {
  await db.run(`
    UPDATE mcp_oauth_grants
    SET last_used_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `, grantId);
}

/**
 * Mints an access token for a grant.
 *
 * The token is an ordinary MCP API key with an expiry and a grant reference, which is what lets
 * the rest of Agent HQ treat an OAuth-authenticated connector exactly like any other MCP client.
 */
export async function mintAccessToken(db: Db, params: {
  grantId: number;
  agentId: number;
  clientId: string;
  ttlSeconds?: number;
}, now = Date.now()): Promise<{ token: string; expiresInSeconds: number }> {
  const ttl = params.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const issued = await issueMcpApiKeyForAgent(db, params.agentId, `OAuth access token (${params.clientId})`);
  await db.run(`
    UPDATE mcp_api_keys SET expires_at = ?, oauth_grant_id = ? WHERE id = ?
  `, utcTimestamp(now + ttl * 1000), params.grantId, issued.keyId);
  return { token: issued.apiKey, expiresInSeconds: ttl };
}

export function createRefreshToken(): string {
  return `ahq_refresh_${crypto.randomBytes(32).toString('base64url')}`;
}

export async function findGrantForAccessToken(db: Db, accessTokenKeyId: number): Promise<GrantRecord | null> {
  const row = await db.get(`
    SELECT g.* FROM mcp_oauth_grants g
    JOIN mcp_api_keys k ON k.oauth_grant_id = g.id
    WHERE k.id = ? LIMIT 1
  `, accessTokenKeyId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    clientId: String(row.client_id),
    agentId: Number(row.agent_id),
    tenantId: Number(row.tenant_id),
    scopes: parseJsonArray(row.scopes),
    resource: typeof row.resource === 'string' ? row.resource : null,
    supersededAt: typeof row.superseded_at === 'string' ? row.superseded_at : null,
    revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
  };
}

/**
 * Marks a grant as rotated away without forgetting its token hash.
 *
 * The hash is what makes a replay recognisable later; dropping it would turn a stolen token into
 * an anonymous "unknown token" error and leave the rest of the family alive.
 */
export async function supersedeGrant(db: Db, grantId: number): Promise<void> {
  await db.run(`
    UPDATE mcp_oauth_grants
    SET superseded_at = COALESCE(superseded_at, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')),
        updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = ?
  `, grantId);
}

/** Connected-apps view: one row per live grant. */
export async function listGrants(db: Db): Promise<Array<{
  id: number;
  clientId: string;
  clientName: string;
  agentId: number;
  agentName: string | null;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  activeTokens: number;
}>> {
  const rows = await db.all(`
    SELECT g.id, g.client_id, g.agent_id, g.scopes, g.created_at, g.last_used_at, g.revoked_at,
           c.client_name AS client_name,
           a.name AS agent_name,
           (SELECT COUNT(*) FROM mcp_api_keys k
             WHERE k.oauth_grant_id = g.id AND k.enabled = 1 AND k.revoked_at IS NULL) AS active_tokens
    FROM mcp_oauth_grants g
    LEFT JOIN mcp_oauth_clients c ON c.client_id = g.client_id
    LEFT JOIN agents a ON a.id = g.agent_id
    ORDER BY g.id DESC
  `) as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    id: Number(row.id),
    clientId: String(row.client_id),
    clientName: String(row.client_name ?? ''),
    agentId: Number(row.agent_id),
    agentName: typeof row.agent_name === 'string' ? row.agent_name : null,
    scopes: parseJsonArray(row.scopes),
    createdAt: String(row.created_at),
    lastUsedAt: typeof row.last_used_at === 'string' ? row.last_used_at : null,
    revokedAt: typeof row.revoked_at === 'string' ? row.revoked_at : null,
    activeTokens: Number(row.active_tokens ?? 0),
  }));
}

/** Housekeeping for consumed and expired codes. Safe to call on a timer. */
export async function pruneExpiredAuthorizationCodes(db: Db, now = Date.now()): Promise<void> {
  await db.run(`DELETE FROM mcp_oauth_authorization_codes WHERE expires_at <= ?`, utcTimestamp(now - 60_000));
}
