import type { IncomingMessage } from 'http';
import type { NextFunction, Request, Response } from 'express';
import type { CorsOptions, CorsOptionsDelegate } from 'cors';

// The operator API has no login of its own yet, so a web page the operator happens to visit
// must not be able to drive it through the browser: `/api/v1` can create and test tools that
// run on the host. Browsers always attach `Origin` to cross-origin fetches and WebSocket
// handshakes; servers, agents, the CLI and the UI's own server-side proxy send none. So a
// request without `Origin` passes, and a request with one must come from an allowed origin.
// This closes cross-site request forgery. It does not replace authentication for clients that
// can reach the port directly.

const OPERATOR_API_PREFIX = '/api/v1';

/** Parses `AGENT_HQ_ALLOWED_ORIGINS` (comma-separated) into normalized origins. */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const origins = new Set<string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      origins.add(new URL(trimmed).origin);
    } catch {
      console.warn(`[origin-guard] Ignoring invalid AGENT_HQ_ALLOWED_ORIGINS entry: ${trimmed}`);
    }
  }
  return origins;
}

function parseOrigin(origin: string): URL | null {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function hostHeader(headers: IncomingMessage['headers']): string | null {
  const host = headers.host;
  return typeof host === 'string' && host.trim() ? host.trim().toLowerCase() : null;
}

/** True when a browser request carries no origin, a same-origin one, or an allowlisted one. */
export function isOriginAllowed(
  origin: string | undefined,
  headers: IncomingMessage['headers'],
  allowed: Set<string>,
): boolean {
  if (origin === undefined) return true;
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  if (allowed.has(parsed.origin)) return true;
  return parsed.host.toLowerCase() === hostHeader(headers);
}

/**
 * WebSocket handshakes come straight from the UI page, which is served from a different port
 * than the API, so the same hostname on any port counts as the operator's own UI.
 */
export function isWebSocketOriginAllowed(
  origin: string | undefined,
  headers: IncomingMessage['headers'],
  allowed: Set<string>,
): boolean {
  if (origin === undefined || isOriginAllowed(origin, headers, allowed)) return true;
  const parsed = parseOrigin(origin);
  const host = hostHeader(headers);
  if (!parsed || !host) return false;
  return parsed.hostname.toLowerCase() === new URL(`http://${host}`).hostname;
}

/** CORS for the operator API is allowlist-only; OAuth discovery and `/mcp` keep open CORS. */
export function corsOptionsDelegate(allowed: Set<string>): CorsOptionsDelegate<Request> {
  return (req, callback) => {
    const options: CorsOptions = req.path.startsWith(OPERATOR_API_PREFIX)
      ? { origin: (origin, done) => done(null, origin !== undefined && allowed.has(origin)) }
      : { origin: '*' };
    callback(null, options);
  };
}

export function rejectCrossOriginRequests(allowed: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
    if (isOriginAllowed(origin, req.headers, allowed)) {
      next();
      return;
    }
    res.status(403).json({
      code: 'cross_origin_forbidden',
      error: 'Cross-origin browser requests to the Agent HQ API are not allowed. Add the origin to AGENT_HQ_ALLOWED_ORIGINS to permit it.',
    });
  };
}
