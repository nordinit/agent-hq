import type { RequestHandler } from 'express';
import { authenticateApiRequest, type ApiAuthConfig } from './apiAuth';

/**
 * Test support for apps that mount the real /api/v1 authentication.
 *
 * jest-setup-env.ts gives every worker a fixed operator token. Suites mount the production
 * authenticator with it and talk to their app as the operator — the way the UI proxy and the CLI
 * do — unless a request carries a credential of its own, so a request runs as an agent only when
 * it presents that agent's key. Enforcement is never relaxed for tests: a request that presents
 * nothing is refused exactly as it is in production.
 */

export function testOperatorToken(): string {
  const token = process.env.AGENT_HQ_OPERATOR_TOKEN;
  if (!token) throw new Error('AGENT_HQ_OPERATOR_TOKEN is set by jest-setup-env.ts; this helper only runs under Jest.');
  return token;
}

export function testApiAuthConfig(): ApiAuthConfig {
  return { mode: 'enforce', operatorToken: testOperatorToken() };
}

/** The production /api/v1 authenticator, configured with the test operator token. */
export function authenticateTestApiRequest(): RequestHandler {
  return authenticateApiRequest(testApiAuthConfig(), { log: () => undefined });
}

export function operatorAuthHeaders(): Record<string, string> {
  return { authorization: `Bearer ${testOperatorToken()}` };
}

const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'x-agent-hq-mcp-client'];

/** `fetch` as the operator, unless the request already presents a credential of its own. */
export const operatorFetch: typeof fetch = (input, init = {}) => {
  const headers = new Headers(init.headers);
  if (!CREDENTIAL_HEADERS.some((name) => headers.has(name))) {
    headers.set('authorization', `Bearer ${testOperatorToken()}`);
  }
  return fetch(input, { ...init, headers });
};
