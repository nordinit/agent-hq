import { NextRequest, NextResponse } from 'next/server';
import {
  getOperatorToken,
  isSecureRequest,
  newOperatorSession,
  operatorSessionCookieOptions,
  signInWithToken,
} from '@/lib/operatorSession';
import { isSameOriginProxyRequest } from '@/lib/proxyOrigin';

// A relative Location keeps the browser on the host it used, which is the host the cookie is set
// for — including behind a reverse proxy that rewrites Host.
async function signIn(req: NextRequest, presented: string | null, next: string | null): Promise<NextResponse> {
  const operatorToken = getOperatorToken();
  const outcome = await signInWithToken(operatorToken, presented, next);
  const res = new NextResponse(null, { status: 303, headers: { Location: outcome.location, 'Cache-Control': 'no-store' } });
  if (outcome.startSession && operatorToken) {
    const session = await newOperatorSession(operatorToken);
    res.cookies.set(session.name, session.value, operatorSessionCookieOptions(isSecureRequest(req.url, req.headers)));
  }
  return res;
}

/** The sign-in form. */
export async function POST(req: NextRequest) {
  if (!isSameOriginProxyRequest(req.headers)) {
    return new NextResponse(null, { status: 303, headers: { Location: '/login?error=forbidden' } });
  }
  const form = await req.formData().catch(() => null);
  return signIn(req, String(form?.get('token') ?? ''), form?.get('next')?.toString() ?? null);
}

/**
 * Pages reached without a session, and `/login?token=…`, both rewritten here by middleware.ts.
 * The redirect either shows the sign-in page or signs in and drops the token from the URL.
 */
export async function GET(req: NextRequest) {
  return signIn(req, req.nextUrl.searchParams.get('token'), req.nextUrl.searchParams.get('next'));
}
