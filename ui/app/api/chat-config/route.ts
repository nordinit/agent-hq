import { NextRequest, NextResponse } from 'next/server';
import { getAgentHqBaseUrl } from '@/lib/agentHqBaseUrl';

function buildGatewayUrl(req: NextRequest, apiBase: string): string {
  const internalApiUrl = new URL(apiBase);
  const forwardedHost = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const forwardedProto = req.headers.get('x-forwarded-proto');
  const browserUrl = new URL(req.url);
  const requestOrigin = forwardedHost
    ? `${forwardedProto === 'https' ? 'https' : browserUrl.protocol.replace(':', '')}://${forwardedHost}`
    : browserUrl.toString();
  const gatewayUrl = new URL(requestOrigin);

  gatewayUrl.protocol = (forwardedProto ?? browserUrl.protocol.replace(':', '')) === 'https' ? 'wss:' : 'ws:';

  if (internalApiUrl.port) {
    gatewayUrl.port = internalApiUrl.port;
  } else {
    gatewayUrl.port = internalApiUrl.protocol === 'https:' ? '443' : '80';
  }

  gatewayUrl.pathname = '/api/v1/chat/ws';
  gatewayUrl.search = '';

  return gatewayUrl.toString();
}

export async function GET(req: NextRequest) {
  const apiBase = getAgentHqBaseUrl();
  try {
    const res = await fetch(`${apiBase}/api/v1/chat/config`, {
      cache: 'no-store',
    });
    const data = await res.json();
    const gatewayUrl = buildGatewayUrl(req, apiBase);
    return NextResponse.json({ token: data.token, gatewayUrl }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ token: '', gatewayUrl: '' });
  }
}
