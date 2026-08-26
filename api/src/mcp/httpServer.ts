/**
 * Agent HQ MCP Server — Streamable HTTP Transport
 *
 * Serves the same tool surface as the stdio server over MCP's Streamable HTTP transport, so
 * remote clients (Claude connectors, ChatGPT custom connectors, anything speaking Streamable
 * HTTP) can reach an Agent HQ install that is published at an HTTPS URL.
 *
 * Architecture:
 *   remote MCP client -> HTTPS -> this router (/mcp) -> Agent HQ REST API (same process)
 *
 * Two properties are worth stating plainly, because they are what keep this endpoint from
 * becoming a way around the permission model:
 *
 * 1. Every tool call still travels through the Agent HQ REST API carrying the caller's own MCP
 *    key. The transport authenticates the key so it can reject junk early and label its logs,
 *    but it never elevates: authorizeMcpApiRequestIfPresent runs on every resulting /api/v1
 *    request exactly as it does for a local stdio client. A key that cannot move a task over
 *    stdio cannot move it from a phone either.
 *
 * 2. Servers are built per request and thrown away (stateless transport, no session id). MCP
 *    sessions would otherwise pin server state to a client that may never come back — remote
 *    connectors reconnect freely — and per-request construction keeps one client's identity from
 *    outliving its request.
 */

import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AgentHqApiClient } from './apiClient';
import { RateLimiter } from './rateLimiter';
import { createAgentHqMcpServer } from './serverFactory';
import { DEFAULT_MCP_TOOL_PROFILE, resolveMcpToolProfile, type McpToolProfile } from './toolProfiles';
import { getDb } from '../db/client';
import {
  McpApiAuthError,
  resolveMcpApiIdentityForKey,
  type McpApiIdentity,
} from '../lib/mcpApiAuth';

/** JSON-RPC application error range; -32001 is the conventional "unauthorized" choice. */
const JSONRPC_UNAUTHORIZED = -32001;
const JSONRPC_INTERNAL_ERROR = -32603;

export interface McpHttpRouterOptions {
  /** Base URL the tool handlers call back into. Normally this process's own API. */
  apiBaseUrl: string;
  /** Tool profile name exposed to remote clients. Defaults to `mobile`. */
  profileName?: string | null;
  /** Per-key request ceiling. Defaults to 120/min. */
  rateLimitRpm?: number;
  /** Server instructions returned during initialize. */
  instructions?: string;
  /** Host allow-list for DNS rebinding protection. Off unless configured. */
  allowedHosts?: string[];
  /**
   * URL of this endpoint's protected-resource metadata, advertised on 401s.
   *
   * This is the whole discovery mechanism: a connector arriving without a token reads the
   * resource_metadata pointer out of WWW-Authenticate, fetches it, finds the authorization
   * server, and starts the OAuth flow. Without it a client can only conclude it is unauthorized.
   */
  resourceMetadataUrl?: string;
  /** Seam for tests; defaults to resolving the key against the live database. */
  resolveIdentity?: (apiKey: string) => Promise<McpApiIdentity>;
}

/**
 * Per-key limiters. Keyed by MCP key id so one connector cannot spend another's budget, and
 * bounded so a stream of invalid-but-distinct keys can't grow it without limit — identities are
 * few (one per connector) and rebuilding a limiter only costs that key a refilled bucket.
 */
const MAX_TRACKED_KEYS = 64;

function limiterFor(limiters: Map<number, RateLimiter>, keyId: number, rpm: number): RateLimiter {
  const existing = limiters.get(keyId);
  if (existing) return existing;
  if (limiters.size >= MAX_TRACKED_KEYS) limiters.clear();
  const limiter = new RateLimiter(rpm);
  limiters.set(keyId, limiter);
  return limiter;
}

function readHeaderValue(req: Request, name: string): string {
  const value = req.headers[name];
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads the MCP key off the request.
 *
 * Deliberately not extractMcpApiKeyFromRequest: that one only honours `Authorization: Bearer`
 * when the caller also sends `x-agent-hq-mcp-client`, because /api/v1 serves browsers too and a
 * session's Authorization header must not be mistaken for an MCP key. This route has no such
 * ambiguity — every request to it is an MCP request — and remote connectors send a plain bearer
 * token and nothing else. Requiring a custom marker header here would make the endpoint
 * unreachable from the clients it exists for.
 */
function readMcpApiKey(req: Request): { key: string | null; presented: boolean } {
  const xApiKey = readHeaderValue(req, 'x-api-key');
  if (xApiKey) return { key: xApiKey, presented: true };

  const auth = readHeaderValue(req, 'authorization');
  if (!auth) return { key: null, presented: false };

  const match = auth.match(/^Bearer\s+(.+)$/i);
  return { key: match?.[1]?.trim() || null, presented: true };
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  if (res.headersSent) return;
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

export function createMcpHttpRouter(options: McpHttpRouterOptions): Router {
  const router = Router();
  const profile = resolveMcpToolProfile(options.profileName ?? 'mobile');
  const rateLimitRpm = options.rateLimitRpm && options.rateLimitRpm > 0 ? options.rateLimitRpm : 120;
  const resolveIdentity = options.resolveIdentity
    ?? ((apiKey: string) => resolveMcpApiIdentityForKey(getDb(), apiKey));
  const limiters = new Map<number, RateLimiter>();
  const wwwAuthenticate = options.resourceMetadataUrl
    ? `Bearer realm="Agent HQ MCP", resource_metadata="${options.resourceMetadataUrl}"`
    : 'Bearer realm="Agent HQ MCP"';

  router.all('/', async (req: Request, res: Response) => {
    const { key, presented } = readMcpApiKey(req);
    if (!presented || !key) {
      res.setHeader('WWW-Authenticate', wwwAuthenticate);
      return sendJsonRpcError(
        res,
        401,
        JSONRPC_UNAUTHORIZED,
        'Authorization required. Connect through OAuth, or send an Agent HQ MCP API key as "Authorization: Bearer <key>".',
      );
    }

    let identity: McpApiIdentity;
    try {
      identity = await resolveIdentity(key);
    } catch (err) {
      if (err instanceof McpApiAuthError) {
        console.warn(`[agent-hq-mcp-http] rejected ${req.method} (${err.code})`);
        res.setHeader('WWW-Authenticate', wwwAuthenticate);
        return sendJsonRpcError(res, err.statusCode, JSONRPC_UNAUTHORIZED, err.message);
      }
      console.error('[agent-hq-mcp-http] identity resolution failed:', err);
      return sendJsonRpcError(res, 500, JSONRPC_INTERNAL_ERROR, 'Agent HQ could not verify the MCP API key.');
    }

    if (!limiterFor(limiters, identity.keyId, rateLimitRpm).allow()) {
      return sendJsonRpcError(
        res,
        429,
        JSONRPC_UNAUTHORIZED,
        `Rate limit exceeded. Maximum ${rateLimitRpm} requests per minute for this MCP key.`,
      );
    }

    const server = createAgentHqMcpServer({
      api: new AgentHqApiClient(options.apiBaseUrl, key),
      hasApiKey: true,
      // Limiting already happened per key above; a second bucket would double-count.
      rateLimiter: null,
      profile: profile.toolNames ? profile : null,
      instructions: options.instructions,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      ...(options.allowedHosts?.length
        ? { allowedHosts: options.allowedHosts, enableDnsRebindingProtection: true }
        : {}),
    });

    // The transport writes the response; both objects are per-request and must not outlive it.
    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[agent-hq-mcp-http] request failed for ${identity.agentSlug}:`, err);
      sendJsonRpcError(res, 500, JSONRPC_INTERNAL_ERROR, 'Agent HQ MCP request failed.');
    }
  });

  return router;
}

/** Reads the HTTP transport's configuration out of the environment. */
export function resolveMcpHttpConfigFromEnv(env: NodeJS.ProcessEnv, apiPort: string | number): {
  enabled: boolean;
  apiBaseUrl: string;
  profileName: string;
  rateLimitRpm: number;
  allowedHosts: string[];
} {
  const rawRpm = Number.parseInt(env.AGENT_HQ_MCP_HTTP_RATE_LIMIT_RPM ?? '', 10);
  return {
    enabled: (env.AGENT_HQ_MCP_HTTP_ENABLED ?? '1').trim() !== '0',
    apiBaseUrl: env.AGENT_HQ_INTERNAL_BASE_URL?.trim() || `http://127.0.0.1:${apiPort}`,
    profileName: env.AGENT_HQ_MCP_HTTP_TOOL_PROFILE?.trim() || 'mobile',
    rateLimitRpm: Number.isInteger(rawRpm) && rawRpm > 0 ? rawRpm : 120,
    allowedHosts: (env.AGENT_HQ_MCP_HTTP_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  };
}

export { DEFAULT_MCP_TOOL_PROFILE, type McpToolProfile };
