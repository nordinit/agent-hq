const HOP_BY_HOP_HEADERS = [
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

/**
 * Credentials never pass through from the browser. The session cookie stays with the UI, and the
 * proxy speaks to the API as the operator, so a page cannot choose which identity its requests
 * run as.
 */
const BROWSER_CREDENTIAL_HEADERS = ['authorization', 'cookie', 'x-api-key', 'x-agent-hq-mcp-client'];

/** Headers for forwarding a signed-in browser request to the API. */
export function buildUpstreamRequestHeaders(incoming: Headers, operatorToken: string): Headers {
  const headers = new Headers(incoming);
  for (const header of [...HOP_BY_HOP_HEADERS, ...BROWSER_CREDENTIAL_HEADERS]) headers.delete(header);
  // Checked before forwarding. The API sees the UI server as a same-machine caller, not the page.
  headers.delete('origin');
  headers.set('authorization', `Bearer ${operatorToken}`);
  return headers;
}

export function buildDownstreamResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
  return headers;
}

/** For the UI's own server-side calls to the API. */
export function operatorAuthorizationHeaders(operatorToken: string | null): Record<string, string> {
  return operatorToken ? { authorization: `Bearer ${operatorToken}` } : {};
}
