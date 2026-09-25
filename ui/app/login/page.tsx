import type { Metadata } from 'next';
import { KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getOperatorToken, safeRedirectPath } from '@/lib/operatorSession';

export const metadata: Metadata = {
  title: 'Sign in · Agent HQ',
};
export const dynamic = 'force-dynamic';

const ERRORS: Record<string, string> = {
  invalid_token: 'That is not this install’s operator token.',
  forbidden: 'Sign in from the Agent HQ page itself.',
};

type LoginPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  const configured = getOperatorToken() !== null;
  const next = safeRedirectPath(typeof params.next === 'string' ? params.next : null);
  const error = typeof params.error === 'string' ? ERRORS[params.error] : undefined;

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <form
        method="post"
        action="/api/auth/login"
        className="w-full max-w-sm space-y-5 rounded-2xl border border-slate-700 bg-slate-800/60 p-6 shadow-xl"
      >
        <div className="flex items-center gap-3">
          <div className="rounded-xl bg-amber-500/15 p-2 text-amber-400">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white">Sign in to Agent HQ</h1>
            <p className="text-xs text-slate-400">Agents run commands on this machine, so the operator signs in.</p>
          </div>
        </div>

        {!configured ? (
          <div role="alert" className="space-y-2 rounded-lg border border-red-800 bg-red-950/40 p-3 text-sm text-red-200">
            <p>
              <code className="text-red-100">AGENT_HQ_OPERATOR_TOKEN</code> is not set for the UI, or is shorter than 32
              characters.
            </p>
            <p className="text-red-300">
              Generate one with <code>openssl rand -hex 32</code>, give the same value to the API and the UI, and
              restart both. <code>agent-hq start</code> does this for you.
            </p>
          </div>
        ) : (
          <>
            {error && (
              <p role="alert" className="rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-200">
                {error}
              </p>
            )}
            <input type="hidden" name="next" value={next} />
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-slate-200">Operator token</span>
              <input
                name="token"
                type="password"
                required
                autoFocus
                autoComplete="current-password"
                spellCheck={false}
                className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 font-mono text-sm text-slate-100 outline-none focus:border-amber-500"
              />
            </label>
            <Button type="submit" variant="primary" className="w-full">
              Sign in
            </Button>
            <div className="space-y-1.5 text-xs leading-relaxed text-slate-400">
              <p className="font-medium text-slate-300">Where to find it</p>
              <p>
                Run <code className="text-slate-300">agent-hq token</code> on the machine running Agent HQ, or{' '}
                <code className="text-slate-300">agent-hq open</code> to open Agent HQ already signed in. The CLI keeps
                it in <code className="text-slate-300">~/.agent-hq/.env</code>.
              </p>
              <p>
                Docker Compose and manual installs set it as{' '}
                <code className="text-slate-300">AGENT_HQ_OPERATOR_TOKEN</code> in their <code className="text-slate-300">.env</code>.
              </p>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
