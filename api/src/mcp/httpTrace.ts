import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpApiIdentity } from '../lib/mcpApiAuth';

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Trace protocol metadata only. Arguments, credentials, resource URIs and result text stay out. */
export function traceMcpHttpRequest(
  req: Request,
  res: Response,
  transport: StreamableHTTPServerTransport,
  identity: McpApiIdentity,
  policyFingerprint: string,
): void {
  const started = Date.now();
  const body = record(req.body);
  const methods = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'resources/templates/list', 'ping']);
  const method = typeof body.method === 'string' && methods.has(body.method) ? body.method : 'other';
  const name = record(body.params).name;
  const tool = method === 'tools/call'
    ? typeof name === 'string' && /^agent_hq_[a-z0-9_]{1,100}$/.test(name) ? name : '[invalid]'
    : undefined;
  let result = 'no_rpc_response';
  let errorCode: number | undefined;
  let toolCount: number | undefined;
  let catalogHash: string | undefined;

  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    // Only inspect this request's response, never server notifications or payload contents.
    if ('id' in message && message.id === body.id) {
      if ('error' in message) {
        result = 'rpc_error';
        errorCode = message.error.code;
      } else if ('result' in message) {
        const response = record(message.result);
        result = response.isError === true ? 'tool_error' : 'success';
        if (method === 'tools/list' && Array.isArray(response.tools)) {
          toolCount = response.tools.length;
          catalogHash = createHash('sha256').update(JSON.stringify(response.tools)).digest('hex').slice(0, 16);
        }
        // Agent HQ handlers return an {ok:false} JSON envelope for REST failures.
        if (method === 'tools/call' && Array.isArray(response.content)) {
          for (const item of response.content) {
            const content = record(item);
            if (content.type !== 'text' || typeof content.text !== 'string') continue;
            try {
              if (record(JSON.parse(content.text)).ok === false) result = 'api_error';
            } catch { /* SDK validation errors are plain text; isError above covers them. */ }
          }
        }
      }
    }
    return send(message, options);
  };

  res.once('close', () => {
    console.log('[agent-hq-mcp-http] trace', JSON.stringify({
      timestamp: new Date().toISOString(),
      agent: identity.agentSlug,
      key_id: identity.keyId,
      policy_fingerprint: policyFingerprint,
      method,
      tool,
      result: res.writableFinished ? result : 'disconnected',
      http_status: res.statusCode,
      error_code: errorCode,
      tool_count: toolCount,
      catalog_hash: catalogHash,
      duration_ms: Date.now() - started,
    }));
  });
}
