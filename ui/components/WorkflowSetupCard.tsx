'use client';

import Link from 'next/link';
import { GitBranch, Wrench } from 'lucide-react';
import type { Workflow } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { describeValue } from '@/lib/approvalFields';
import { summarizeEnvironmentSetup } from '@/lib/environmentSetup';

const MODE_CLASSES = {
  off: 'border-slate-600 bg-slate-800 text-slate-300',
  auto: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200',
  custom: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
} as const;

function repository(workflow: Workflow): { label: string; location: string | null } {
  if (workflow.repo_access_mode === 'worktree') return { label: 'Worktree', location: workflow.repo_path ?? null };
  if (workflow.repo_access_mode === 'clone') return { label: 'Clone', location: workflow.repo_url ?? null };
  return { label: 'None', location: null };
}

/** What each task in this workflow gets before its agent starts: the code, and what runs on it. */
export function WorkflowSetupCard({ workflow }: { workflow: Workflow }) {
  const repo = repository(workflow);
  const setup = summarizeEnvironmentSetup(workflow.environment_setup ?? null);

  return <Card>
    <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">Repository and environment preparation</h3>
    <div className="grid gap-5 md:grid-cols-2">
      <section className="space-y-2">
        <p className="flex items-center gap-2 text-sm font-medium text-white"><GitBranch className="h-4 w-4 text-slate-400" /> Repository: {repo.label}</p>
        {repo.location && <p className="break-all font-mono text-xs text-cyan-300">{repo.location}</p>}
        <p className="text-sm text-slate-400">{describeValue('repo_access_mode', workflow.repo_access_mode ?? null)}</p>
      </section>

      <section className="space-y-2">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-white">
          <Wrench className="h-4 w-4 text-slate-400" /> Environment preparation
          {setup && <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${MODE_CLASSES[setup.mode]}`}>{setup.label}</span>}
        </p>
        {setup ? <>
          <p className="text-sm text-slate-400">{setup.description}</p>
          {setup.mode === 'auto' && <p className="text-xs text-slate-400">Project folders: <span className="font-mono text-slate-200">{setup.roots.join(', ')}</span></p>}
          {setup.mode === 'custom' && <ol className="space-y-1">
            {/* No ligatures: "--frozen-lockfile" must not render as a dash. */}
            {setup.steps.map((step, index) => <li key={index} className="rounded bg-slate-950 px-2 py-1.5 text-xs [font-variant-ligatures:none]">
              <span className="text-slate-500">{index + 1}.</span>{' '}
              <code className="break-all text-slate-100">{step.command}</code>
              {step.cwd !== '.' && <span className="text-slate-500"> in <code className="text-slate-300">{step.cwd}</code></span>}
            </li>)}
          </ol>}
          {setup.timeoutSeconds !== null && <p className="text-xs text-slate-500">Stops after {setup.timeoutSeconds} seconds.</p>}
        </> : <p className="text-sm text-red-300">This workflow’s environment preparation can’t be read.</p>}
      </section>
    </div>
    <p className="mt-4 border-t border-slate-700 pt-3 text-xs text-slate-500">
      This runs on this machine, as your user account, before each task’s agent starts. Every agent this workflow routes work to
      needs this setup approved; see <Link href="/approvals" className="text-amber-300 hover:underline">Approvals</Link>.
      Change it with the edit (pencil) button above.
    </p>
  </Card>;
}
