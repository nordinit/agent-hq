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

// Only the socket URL. The API's chat proxy authenticates to the gateway on the browser's
// behalf, so no gateway credential is handed to the page, and there is nothing left to fetch
// from the API: the route is computed here, behind the UI's operator sign-in (middleware.ts).
export async function GET(req: NextRequest) {
  try {
    const gatewayUrl = buildGatewayUrl(req, getAgentHqBaseUrl());
    return NextResponse.json({ gatewayUrl }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ gatewayUrl: '' });
  }
}
