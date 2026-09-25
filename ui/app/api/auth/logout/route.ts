import { NextRequest, NextResponse } from 'next/server';
import {
  getOperatorToken,
  isSecureRequest,
  operatorSessionCookieName,
  operatorSessionCookieOptions,
} from '@/lib/operatorSession';
import { isSameOriginProxyRequest } from '@/lib/proxyOrigin';

/**
 * Ends this browser's session. Sessions are stateless, so this cannot end a session copied
 * elsewhere; rotating AGENT_HQ_OPERATOR_TOKEN ends all of them.
 */
export async function POST(req: NextRequest) {
  if (!isSameOriginProxyRequest(req.headers)) {
    return NextResponse.json({ code: 'cross_origin_forbidden', error: 'Cross-origin sign-out is not allowed.' }, { status: 403 });
  }
  const res = new NextResponse(null, { status: 303, headers: { Location: '/login' } });
  const operatorToken = getOperatorToken();
  if (operatorToken) {
    res.cookies.set(
      await operatorSessionCookieName(operatorToken),
      '',
      operatorSessionCookieOptions(isSecureRequest(req.url, req.headers), 0),
    );
  }
  return res;
}
