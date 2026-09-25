import { NextRequest } from 'next/server';
import { getAgentHqBaseUrl } from '@/lib/agentHqBaseUrl';
import { buildDownstreamResponseHeaders, buildUpstreamRequestHeaders } from '@/lib/apiProxyHeaders';
import { getOperatorToken } from '@/lib/operatorSession';
import { isSameOriginProxyRequest } from '@/lib/proxyOrigin';

const API_BASE = getAgentHqBaseUrl();

// middleware.ts has already required a signed-in session for every request that reaches here.
async function proxy(req: NextRequest, path: string[]) {
  if (!isSameOriginProxyRequest(req.headers)) {
    return Response.json(
      { code: 'cross_origin_forbidden', error: 'Cross-origin browser requests to the Agent HQ API are not allowed.' },
      { status: 403 },
    );
  }
  const operatorToken = getOperatorToken();
  if (!operatorToken) {
    return Response.json(
      { code: 'operator_token_not_configured', error: 'AGENT_HQ_OPERATOR_TOKEN is not configured for the UI.' },
      { status: 503 },
    );
  }

  const url = new URL(req.url);
  const target = new URL(`/api/v1/${path.join('/')}${url.search}`, API_BASE);

  const init: RequestInit = {
    method: req.method,
    headers: buildUpstreamRequestHeaders(req.headers, operatorToken),
    cache: 'no-store',
    redirect: 'manual',
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = await req.arrayBuffer();
  }

  const upstream = await fetch(target, init);

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: buildDownstreamResponseHeaders(upstream.headers),
  });
}

export async function GET(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(req, path);
}

export async function POST(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(req, path);
}

export async function PUT(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(req, path);
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(req, path);
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(req, path);
}

export async function OPTIONS(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  return proxy(req, path);
}
