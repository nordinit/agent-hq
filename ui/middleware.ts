import { NextResponse, type NextRequest } from 'next/server';
import {
  decideOperatorAccess,
  getOperatorToken,
  isSecureRequest,
  newOperatorSession,
  operatorSessionCookieOptions,
} from '@/lib/operatorSession';

/** Requires a signed-in operator for every page and UI API route; see decideOperatorAccess. */
export async function middleware(req: NextRequest): Promise<NextResponse> {
  const operatorToken = getOperatorToken();
  const decision = await decideOperatorAccess({
    operatorToken,
    pathname: req.nextUrl.pathname,
    searchParams: req.nextUrl.searchParams,
    cookie: (name) => req.cookies.get(name)?.value,
  });

  switch (decision.kind) {
    case 'reject':
      return NextResponse.json({ code: decision.code, error: decision.error }, { status: decision.status });
    case 'sign_in':
      return NextResponse.rewrite(new URL(decision.location, req.url));
    case 'allow': {
      const res = NextResponse.next();
      if (decision.renewSession && operatorToken) {
        const session = await newOperatorSession(operatorToken);
        res.cookies.set(session.name, session.value, operatorSessionCookieOptions(isSecureRequest(req.url, req.headers)));
      }
      return res;
    }
  }
}

export const config = {
  runtime: 'nodejs',
  // Static build output carries no data; everything else, pages and /api alike, is checked.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
