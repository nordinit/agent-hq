import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getDb } from '../db/client';
import { McpApiAuthError, resolveMcpApiIdentityForKey, type McpApiIdentity } from './mcpApiAuth';
import { operatorSessionCookieName, readCookie, verifyOperatorSession } from './operatorSession';
import { isWebSocketOriginAllowed } from './originGuard';

/**
 * Authentication for the operator API (`/api/v1`).
 *
 * Every request presents exactly one of two credentials:
 *
 * - the operator token, `AGENT_HQ_OPERATOR_TOKEN`, as `Authorization: Bearer <token>`. It carries
 *   full operator authority — what the UI (through its server-side proxy) and the CLI use;
 * - an agent's MCP API key, as `x-api-key: <key>` or `Authorization: Bearer <key>`. The request
 *   runs as that key's identity and authorizeMcpApiRequestIfPresent limits it to the key's grants.
 *
 * A request with neither used to run with full access. Agents run real CLIs on this host, so any
 * of them could drop its scoped key and act as the operator; that fallthrough is what this closes.
 * `x-agent-hq-mcp-client` no longer decides whether a bearer token counts — any bearer token is a
 * credential now — and remains only a label.
 *
 * AGENT_HQ_AUTH_MODE=report keeps the old behaviour for requests this would refuse, logging each
 * distinct caller once, so an existing install can find its unauthenticated callers first.
 */

export type ApiAuthMode = 'enforce' | 'report';

export interface ApiAuthConfig {
  mode: ApiAuthMode;
  /** Null only in report mode; enforce refuses to start without one. */
  operatorToken: string | null;
}

/** `openssl rand -hex 32` yields 64 characters; anything under 32 is not a generated secret. */
export const MIN_OPERATOR_TOKEN_LENGTH = 32;

export class ApiAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiAuthConfigError';
  }
}

export function resolveApiAuthConfigFromEnv(env: NodeJS.ProcessEnv): ApiAuthConfig {
  const rawMode = (env.AGENT_HQ_AUTH_MODE ?? '').trim().toLowerCase();
  if (rawMode && rawMode !== 'enforce' && rawMode !== 'report') {
    throw new ApiAuthConfigError(`AGENT_HQ_AUTH_MODE must be "enforce" or "report", not "${env.AGENT_HQ_AUTH_MODE}".`);
  }
  const mode: ApiAuthMode = rawMode === 'report' ? 'report' : 'enforce';
  const operatorToken = env.AGENT_HQ_OPERATOR_TOKEN?.trim() || null;

  if (operatorToken && operatorToken.length < MIN_OPERATOR_TOKEN_LENGTH) {
    throw new ApiAuthConfigError(
      `AGENT_HQ_OPERATOR_TOKEN is too short (${operatorToken.length} characters; at least ${MIN_OPERATOR_TOKEN_LENGTH} required). `
      + 'Generate one with `openssl rand -hex 32`.',
    );
  }
  if (!operatorToken && mode === 'enforce') {
    throw new ApiAuthConfigError([
      'AGENT_HQ_OPERATOR_TOKEN is not set, and every /api/v1 request must authenticate.',
      'Generate one with `openssl rand -hex 32`, give the same value to the API and the UI (for example in the repository .env), and restart.',
      '`agent-hq start` generates and stores one for you.',
      'To find unauthenticated callers before enforcing, start with AGENT_HQ_AUTH_MODE=report.',
    ].join(' '));
  }
  return { mode, operatorToken };
}

function tokenDigest(value: string): Buffer {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time: digests first, so neither content nor length leaks through timing. */
export function isOperatorToken(candidate: string, operatorToken: string | null): boolean {
  if (!operatorToken || !candidate) return false;
  return crypto.timingSafeEqual(tokenDigest(candidate), tokenDigest(operatorToken));
}

function readHeader(headers: IncomingMessage['headers'], name: string): string {
  const value = headers[name];
  if (Array.isArray(value)) return String(value[0] ?? '').trim();
  return typeof value === 'string' ? value.trim() : '';
}

export type ApiCredential =
  | { kind: 'none' }
  | { kind: 'operator' }
  | { kind: 'mcp_key'; key: string }
  | { kind: 'invalid'; code: string; message: string };

/**
 * Classifies what a request presents. The operator token is accepted only as a bearer token;
 * `x-api-key` is always an MCP key. Two different credentials on one request are refused rather
 * than ranked, so no header can quietly override another.
 */
export function readApiCredential(headers: IncomingMessage['headers'], operatorToken: string | null): ApiCredential {
  const xApiKey = readHeader(headers, 'x-api-key');
  const authorization = readHeader(headers, 'authorization');
  const mcpClientMarker = readHeader(headers, 'x-agent-hq-mcp-client');

  let bearer = '';
  if (authorization) {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]?.trim()) {
      return {
        kind: 'invalid',
        code: 'api_auth_scheme_unsupported',
        message: 'The Authorization header must be "Bearer <operator token or MCP API key>".',
      };
    }
    bearer = match[1].trim();
  }

  if (xApiKey && bearer && xApiKey !== bearer) {
    return {
      kind: 'invalid',
      code: 'api_credentials_conflict',
      message: 'The request carries different credentials in x-api-key and Authorization. Send one.',
    };
  }
  if (bearer && isOperatorToken(bearer, operatorToken)) return { kind: 'operator' };
  if (xApiKey || bearer) return { kind: 'mcp_key', key: xApiKey || bearer };
  if (mcpClientMarker) return { kind: 'invalid', code: 'mcp_api_key_missing', message: 'MCP API key is required' };
  return { kind: 'none' };
}

/**
 * Whether the request would have been authenticated before enforcement existed: `x-api-key`, or a
 * bearer token next to the MCP client marker. Report mode keeps those strict exactly as they were,
 * and relaxes only requests the old code let through with full access.
 */
function presentedLegacyMcpKey(headers: IncomingMessage['headers']): string | null {
  const xApiKey = readHeader(headers, 'x-api-key');
  if (xApiKey) return xApiKey;
  if (!readHeader(headers, 'x-agent-hq-mcp-client')) return null;
  const bearer = readHeader(headers, 'authorization').match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  return bearer || '';
}

declare global {
  namespace Express {
    interface Request {
      /** How /api/v1 authenticated this request. `unauthenticated` exists only in report mode. */
      apiCredential?: 'operator' | 'mcp_key' | 'unauthenticated';
    }
  }
}

/** Paths under /api/v1 that answer without a credential. */
const PUBLIC_API_PATHS = new Set([
  // Static API description, also served at /openapi.json outside /api/v1. No data, no secrets.
  'GET /openapi.json',
  'HEAD /openapi.json',
]);

const MAX_LOGGED_CALLERS = 2000;

/** Numeric ids, UUIDs and long opaque segments collapse so one caller logs once, not per record. */
export function apiPathPattern(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ':id';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':uuid';
      if (segment.length >= 24) return ':value';
      return segment;
    })
    .join('/');
}

export interface ApiAuthLogger {
  (message: string): void;
}

/**
 * Logs each distinct caller once per process. Keyed on method, path pattern, user agent and remote
 * address so the report names who to fix without repeating on every poll.
 */
function createCallerLog(prefix: string, log: ApiAuthLogger) {
  const seen = new Set<string>();
  return (params: { method: string; path: string; userAgent: string; remoteAddress: string; reason: string }): void => {
    const pattern = apiPathPattern(params.path);
    const userAgent = params.userAgent.slice(0, 160) || '-';
    const key = `${params.method} ${pattern} ${userAgent} ${params.remoteAddress}`;
    if (seen.has(key)) return;
    if (seen.size >= MAX_LOGGED_CALLERS) seen.clear();
    seen.add(key);
    log(`${prefix} ${params.method} ${pattern} (${params.reason}) user-agent=${JSON.stringify(userAgent)} remote=${params.remoteAddress}`);
  };
}

function sendAuthError(res: Response, status: number, code: string, message: string): void {
  if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="Agent HQ"');
  res.status(status).json({ error: message, code });
}

const MISSING_CREDENTIAL_MESSAGE = 'Authentication required. Send the operator token as "Authorization: Bearer <AGENT_HQ_OPERATOR_TOKEN>", or an agent MCP API key as "x-api-key: <key>".';

export interface ApiAuthMiddlewareOptions {
  /** Seam for tests; defaults to resolving against the live database. */
  resolveIdentity?: (apiKey: string) => Promise<McpApiIdentity>;
  log?: ApiAuthLogger;
}

export function authenticateApiRequest(config: ApiAuthConfig, options: ApiAuthMiddlewareOptions = {}): RequestHandler {
  const resolveIdentity = options.resolveIdentity ?? ((apiKey: string) => resolveMcpApiIdentityForKey(getDb(), apiKey));
  const log = options.log ?? ((message: string) => console.warn(message));
  const logReported = createCallerLog('[api-auth:report] would reject', log);
  const logRejected = createCallerLog('[api-auth] rejected', log);

  const caller = (req: Request, reason: string) => ({
    method: req.method.toUpperCase(),
    path: `${req.baseUrl}${req.path}`,
    userAgent: readHeader(req.headers, 'user-agent'),
    remoteAddress: req.socket.remoteAddress ?? 'unknown',
    reason,
  });

  const authenticateKey = async (req: Request, res: Response, next: NextFunction, key: string): Promise<void> => {
    try {
      if (!key) throw new McpApiAuthError('MCP API key is required', 401, 'mcp_api_key_missing');
      req.mcpIdentity = await resolveIdentity(key);
      req.apiCredential = 'mcp_key';
      next();
    } catch (err) {
      const authErr = err instanceof McpApiAuthError
        ? err
        : new McpApiAuthError(err instanceof Error ? err.message : String(err));
      logRejected(caller(req, authErr.code));
      sendAuthError(res, authErr.statusCode, authErr.code, authErr.message);
    }
  };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (PUBLIC_API_PATHS.has(`${req.method.toUpperCase()} ${req.path}`)) return next();

    const credential = readApiCredential(req.headers, config.operatorToken);
    if (credential.kind === 'operator') {
      req.apiCredential = 'operator';
      return next();
    }

    if (config.mode === 'report') {
      const legacyKey = presentedLegacyMcpKey(req.headers);
      if (legacyKey !== null) {
        if (credential.kind === 'invalid' && credential.code === 'api_credentials_conflict') {
          logReported(caller(req, credential.code));
        }
        return authenticateKey(req, res, next, legacyKey);
      }
      if (credential.kind === 'mcp_key') {
        // A bare bearer token used to be ignored. Enforce authenticates it as an MCP key instead.
        logReported(caller(req, 'bearer token is not the operator token; enforce treats it as an MCP API key'));
      } else {
        logReported(caller(req, credential.kind === 'invalid' ? credential.code : 'no credential'));
      }
      req.apiCredential = 'unauthenticated';
      return next();
    }

    if (credential.kind === 'mcp_key') return authenticateKey(req, res, next, credential.key);
    if (credential.kind === 'invalid') {
      logRejected(caller(req, credential.code));
      return sendAuthError(res, 401, credential.code, credential.message);
    }
    logRejected(caller(req, 'no credential'));
    return sendAuthError(res, 401, 'api_auth_required', MISSING_CREDENTIAL_MESSAGE);
  };
}

/**
 * The chat WebSocket is opened by the browser straight against the API port, so it cannot go
 * through the UI proxy that adds the operator token. It authenticates with the UI's login cookie
 * instead: cookies are per host, not per port, so the browser sends the cookie the UI set, and
 * the API — holding the same operator token — verifies its HMAC. Server-side clients may send the
 * operator token as a bearer token. MCP keys are not accepted: chat drives the gateway as the
 * operator.
 */
export function createWebSocketAuthenticator(config: ApiAuthConfig, options: { log?: ApiAuthLogger } = {}) {
  const log = options.log ?? ((message: string) => console.warn(message));
  const logReported = createCallerLog('[api-auth:report] would reject', log);
  const logRejected = createCallerLog('[api-auth] rejected', log);
  const cookieName = config.operatorToken ? operatorSessionCookieName(config.operatorToken) : null;

  return (req: IncomingMessage, now = Date.now()): boolean => {
    const credential = readApiCredential(req.headers, config.operatorToken);
    if (credential.kind === 'operator') return true;
    if (cookieName && config.operatorToken
      && verifyOperatorSession(config.operatorToken, readCookie(req.headers.cookie, cookieName), now)) {
      return true;
    }

    const details = {
      method: 'GET',
      path: (req.url ?? '').split('?')[0],
      userAgent: readHeader(req.headers, 'user-agent'),
      remoteAddress: req.socket?.remoteAddress ?? 'unknown',
      reason: 'WebSocket handshake without a UI session or operator token',
    };
    if (config.mode === 'report') {
      logReported(details);
      return true;
    }
    logRejected(details);
    return false;
  };
}

type VerifyClientDone = (result: boolean, code?: number, message?: string) => void;

/** `verifyClient` for the chat WebSocket: an allowed Origin first, then a session or the token. */
export function createChatWebSocketVerifier(
  config: ApiAuthConfig,
  allowedOrigins: Set<string>,
  options: { log?: ApiAuthLogger } = {},
) {
  const authenticate = createWebSocketAuthenticator(config, options);
  return ({ origin, req }: { origin: string; req: IncomingMessage }, done: VerifyClientDone): void => {
    if (!isWebSocketOriginAllowed(origin || undefined, req.headers, allowedOrigins)) return done(false, 403, 'Forbidden');
    if (!authenticate(req)) return done(false, 401, 'Unauthorized');
    done(true);
  };
}
