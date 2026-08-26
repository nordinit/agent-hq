/**
 * OAuthServerProvider for the Agent HQ MCP transport.
 *
 * The SDK's mcpAuthRouter owns the protocol: metadata documents, PKCE verification, redirect-URI
 * matching, error shapes, and the token endpoint's grant dispatch. This file supplies the six
 * decisions the SDK cannot make for us — who is allowed to approve a connector, which Agent HQ
 * identity a token acts as, and how tokens are minted, refreshed, verified, and revoked.
 *
 * The identity question is the important one. A token issued here binds to one Agent HQ agent
 * (by default the scoped remote-MCP identity from provision-remote-mcp-identity.ts), and that
 * agent's capability policy is what decides what the connector can touch. OAuth authenticates
 * the connection; the policy authorizes the calls. Widening what a phone can do is a policy edit,
 * not a token change.
 */

import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidRequestError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Db } from '../../db/adapter/types';
import { isMcpApiKeyExpired, McpApiAuthError, resolveMcpApiIdentityForKey } from '../../lib/mcpApiAuth';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AgentHqOAuthClientsStore,
  CONSENT_REQUEST_TTL_MS,
  consumeAuthorizationCode,
  createGrant,
  createRefreshToken,
  findGrantByRefreshToken,
  findGrantForAccessToken,
  getConsentSigningKey,
  markGrantUsed,
  mintAccessToken,
  peekAuthorizationCode,
  revokeGrant,
  signConsentPayload,
  supersedeGrant,
} from './store';

export const CONSENT_PATH = '/oauth/consent';

/** What the consent form carries between /authorize and the operator's approval. */
export interface ConsentRequestPayload {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
}

export interface AgentHqOAuthProviderOptions {
  db: Db;
  allowDynamicRegistration: boolean;
  accessTokenTtlSeconds?: number;
}

export class AgentHqOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: AgentHqOAuthClientsStore;

  constructor(private readonly options: AgentHqOAuthProviderOptions) {
    this.clientsStore = new AgentHqOAuthClientsStore(options.db, {
      allowDynamicRegistration: options.allowDynamicRegistration,
    });
  }

  /**
   * Hands the request to the consent screen rather than issuing a code.
   *
   * The SDK has already checked the client and the redirect URI by this point. What it cannot
   * check is whether the person driving the browser is the operator — Agent HQ has no user login
   * — so nothing is issued until the consent form comes back with the operator password.
   *
   * The request travels in a signed payload inside the form. That keeps this hop stateless: no
   * pending-authorization row to strand if the operator wanders off, and an API restart mid-login
   * costs a retry rather than a cleanup.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const key = await getConsentSigningKey(this.options.db);
    const payload: ConsentRequestPayload = {
      clientId: client.client_id,
      clientName: client.client_name || client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      state: params.state,
      scopes: params.scopes ?? [],
      resource: params.resource?.toString(),
      expiresAt: Date.now() + CONSENT_REQUEST_TTL_MS,
    };
    const request = signConsentPayload(key, payload as unknown as Record<string, unknown>);
    res.redirect(`${CONSENT_PATH}?request=${encodeURIComponent(request)}`);
  }

  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = await peekAuthorizationCode(this.options.db, authorizationCode);
    if (!record) throw new InvalidGrantError('Authorization code is not valid');
    return record.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    // PKCE itself was verified by the SDK against challengeForAuthorizationCode above.
    const claimed = await consumeAuthorizationCode(this.options.db, authorizationCode);
    if (!claimed.ok) {
      throw new InvalidGrantError(
        claimed.reason === 'replayed'
          ? 'Authorization code has already been used'
          : 'Authorization code is expired or invalid',
      );
    }

    const record = claimed.record;
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client');
    }
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    // RFC 8707: a code authorized for one resource must not yield a token for another.
    if (record.resource && resource && resource.toString() !== record.resource) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }

    const refreshToken = createRefreshToken();
    const grantId = await createGrant(this.options.db, {
      clientId: record.clientId,
      agentId: record.agentId,
      tenantId: record.tenantId,
      scopes: record.scopes,
      resource: record.resource,
      refreshToken,
    });

    const access = await mintAccessToken(this.options.db, {
      grantId,
      agentId: record.agentId,
      clientId: record.clientId,
      ttlSeconds: this.options.accessTokenTtlSeconds,
    });

    console.log(`[mcp-oauth] issued grant ${grantId} to ${record.clientId} for agent #${record.agentId}`);

    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: access.expiresInSeconds,
      refresh_token: refreshToken,
      scope: record.scopes.join(' ') || undefined,
    };
  }

  /**
   * Rotates the refresh token, and treats reuse of a rotated one as a compromise.
   *
   * Rotation without reuse detection is bookkeeping: it changes the token but does nothing when
   * an old one shows up. Here an unknown-but-previously-issued token means either a buggy client
   * or a stolen one, and since the two are indistinguishable from the server's side, the whole
   * rotation family is revoked and the operator has to reconnect.
   */
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const grant = await findGrantByRefreshToken(this.options.db, refreshToken);
    if (!grant) throw new InvalidGrantError('Refresh token is not valid');
    if (grant.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was issued to a different client');
    }

    // A token that was already rotated away, or belongs to a revoked grant, is being presented a
    // second time. The client should have discarded it, so either it is buggy or the token
    // leaked — indistinguishable from here, and the safe reading is the second one. Every grant
    // in the rotation chain dies and the operator reconnects.
    if (grant.supersededAt || grant.revokedAt) {
      const revoked = await revokeGrant(this.options.db, grant.id, 'refresh_token_reuse', { family: true });
      console.warn(`[mcp-oauth] refresh token reuse on grant ${grant.id}; revoked ${revoked.length} grant(s) in the family`);
      throw new InvalidGrantError('Refresh token has already been used');
    }
    if (grant.resource && resource && resource.toString() !== grant.resource) {
      throw new InvalidGrantError('resource does not match the original grant');
    }
    // Narrowing is allowed; asking for more than was granted is not.
    if (scopes?.some((scope) => !grant.scopes.includes(scope))) {
      throw new InvalidRequestError('Requested scopes exceed the original grant');
    }

    const nextRefresh = createRefreshToken();
    const nextGrantId = await createGrant(this.options.db, {
      clientId: grant.clientId,
      agentId: grant.agentId,
      tenantId: grant.tenantId,
      scopes: scopes?.length ? scopes : grant.scopes,
      resource: grant.resource,
      refreshToken: nextRefresh,
      rotatedFromId: grant.id,
    });

    await supersedeGrant(this.options.db, grant.id);

    const access = await mintAccessToken(this.options.db, {
      grantId: nextGrantId,
      agentId: grant.agentId,
      clientId: grant.clientId,
      ttlSeconds: this.options.accessTokenTtlSeconds,
    });
    await markGrantUsed(this.options.db, nextGrantId);

    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: access.expiresInSeconds,
      refresh_token: nextRefresh,
      scope: (scopes?.length ? scopes : grant.scopes).join(' ') || undefined,
    };
  }

  /**
   * Verifies an access token.
   *
   * The token is an MCP API key, so this is the same resolution every other Agent HQ caller goes
   * through — expiry, revocation, disabled agent, and tenant binding all included. The only extra
   * step is refusing a token whose grant was revoked after the key row was written.
   */
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let identity;
    try {
      identity = await resolveMcpApiIdentityForKey(this.options.db, token, { updateLastUsed: false });
    } catch (err) {
      if (err instanceof McpApiAuthError) throw new InvalidGrantError(err.message);
      throw new ServerError('Could not verify access token');
    }

    const grant = await findGrantForAccessToken(this.options.db, identity.keyId);
    if (!grant) {
      // A direct MCP key rather than an OAuth token. Valid for the transport, but it is not
      // something this authorization server issued, so it carries no grant, scopes, or expiry.
      return { token, clientId: 'agent-hq-direct-key', scopes: [], extra: { agentId: identity.agentId } };
    }
    if (grant.revokedAt) throw new InvalidGrantError('Grant has been revoked');

    const row = await this.options.db.get(
      `SELECT expires_at FROM mcp_api_keys WHERE id = ? LIMIT 1`,
      identity.keyId,
    ) as { expires_at: string | null } | undefined;
    if (isMcpApiKeyExpired(row?.expires_at)) throw new InvalidGrantError('Access token has expired');

    await markGrantUsed(this.options.db, grant.id);

    return {
      token,
      clientId: grant.clientId,
      scopes: grant.scopes,
      expiresAt: row?.expires_at ? Math.floor(Date.parse(`${row.expires_at.replace(' ', 'T')}Z`) / 1000) : undefined,
      extra: { agentId: identity.agentId, grantId: grant.id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const token = request.token;

    const byRefresh = await findGrantByRefreshToken(this.options.db, token);
    if (byRefresh) {
      if (byRefresh.clientId !== client.client_id) return;
      await revokeGrant(this.options.db, byRefresh.id, 'client_revocation', { family: true });
      return;
    }

    try {
      const identity = await resolveMcpApiIdentityForKey(this.options.db, token, { updateLastUsed: false });
      const grant = await findGrantForAccessToken(this.options.db, identity.keyId);
      if (grant && grant.clientId === client.client_id) {
        await revokeGrant(this.options.db, grant.id, 'client_revocation');
      }
    } catch {
      // RFC 7009: revoking an unknown or already-dead token is a success, not an error.
    }
  }
}
