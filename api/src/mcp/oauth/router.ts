/**
 * Mounts the MCP OAuth authorization server.
 *
 * The SDK's mcpAuthRouter provides /authorize, /token, /register, /revoke and both metadata
 * documents. This module supplies the configuration, the provider, and the consent screen, and
 * resolves the Agent HQ identity that issued tokens will act as.
 *
 * OAuth stays off until AGENT_HQ_PUBLIC_URL is set. An issuer identifier has to be the URL
 * clients actually reach, and it goes into signed metadata and into every redirect — guessing it
 * from a Host header would let whoever controls that header move the issuer.
 */

import express, { type Router } from 'express';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { Db } from '../../db/adapter/types';
import { AgentHqOAuthProvider } from './provider';
import { createConsentHandlers } from './consent';
import {
  findLastIdentityForClient,
  listRemoteMcpIdentities,
  selectDefaultIdentity,
} from './identities';
import { ACCESS_TOKEN_TTL_SECONDS, pruneExpiredAuthorizationCodes } from './store';

export const MCP_OAUTH_SCOPE = 'agenthq:mcp';

export interface McpOAuthConfig {
  enabled: boolean;
  publicUrl: string | null;
  agentSlug: string;
  allowDynamicRegistration: boolean;
  accessTokenTtlSeconds: number;
}

export function resolveMcpOAuthConfigFromEnv(env: NodeJS.ProcessEnv): McpOAuthConfig {
  const publicUrl = env.AGENT_HQ_PUBLIC_URL?.trim() || null;
  const ttl = Number.parseInt(env.AGENT_HQ_OAUTH_ACCESS_TOKEN_TTL_SECONDS ?? '', 10);
  return {
    enabled: Boolean(publicUrl) && (env.AGENT_HQ_OAUTH_ENABLED ?? '1').trim() !== '0',
    publicUrl,
      // Pre-selected on the consent screen when a client has no history. Not a restriction: every
    // identity provisioned as a remote MCP client is selectable there.
    agentSlug: env.AGENT_HQ_OAUTH_AGENT_SLUG?.trim() || 'claude-mobile',
    allowDynamicRegistration: (env.AGENT_HQ_OAUTH_ALLOW_DCR ?? '1').trim() !== '0',
    accessTokenTtlSeconds: Number.isInteger(ttl) && ttl > 0 ? ttl : ACCESS_TOKEN_TTL_SECONDS,
  };
}

export interface McpOAuthMount {
  router: Router;
  /** Advertised to unauthenticated /mcp callers so they can discover this server. */
  resourceMetadataUrl: string;
}

export function createMcpOAuthRouter(options: { db: Db; config: McpOAuthConfig }): McpOAuthMount {
  const { db, config } = options;
  if (!config.publicUrl) throw new Error('AGENT_HQ_PUBLIC_URL is required to mount the MCP OAuth router.');

  const issuerUrl = new URL(config.publicUrl);
  const resourceServerUrl = new URL('/mcp', issuerUrl);

  const provider = new AgentHqOAuthProvider({
    db,
    allowDynamicRegistration: config.allowDynamicRegistration,
    accessTokenTtlSeconds: config.accessTokenTtlSeconds,
  });

  const consent = createConsentHandlers({
    db,
    listIdentities: () => listRemoteMcpIdentities(db),
    // Pre-selection order: what this client connected as last, then the configured default, then
    // whatever exists. The operator can always override it on the form.
    resolveSelection: async (identities, clientId) => selectDefaultIdentity(identities, {
      lastAgentId: await findLastIdentityForClient(db, clientId),
      defaultSlug: config.agentSlug,
    }),
  });

  const router = express.Router();

  // The consent form is the only urlencoded body this server takes; the API is JSON elsewhere.
  router.get('/oauth/consent', (req, res, next) => {
    consent.renderConsent(req, res).catch(next);
  });
  router.post('/oauth/consent', express.urlencoded({ extended: false }), (req, res, next) => {
    consent.submitConsent(req, res).catch(next);
  });

  router.use(mcpAuthRouter({
    provider,
    issuerUrl,
    baseUrl: issuerUrl,
    resourceServerUrl,
    resourceName: 'Agent HQ',
    scopesSupported: [MCP_OAUTH_SCOPE],
  }));

  // Consumed and expired codes are dead weight; clear them on the same cadence as the token TTL.
  const prune = setInterval(() => {
    void pruneExpiredAuthorizationCodes(db).catch((err) => {
      console.warn('[mcp-oauth] pruning authorization codes failed:', err);
    });
  }, 15 * 60_000);
  prune.unref();

  return {
    router,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  };
}
