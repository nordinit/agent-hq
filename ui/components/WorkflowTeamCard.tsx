'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, Team, TeamRoutingPlan, TeamRoutingPlanAction } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { GitBranch, Users } from 'lucide-react';

/**
 * Which team runs this workflow, and stamping that team's routing template onto it.
 *
 * Assignment and routing are two buttons on purpose. Picking a team changes what its members
 * read in their prompts and nothing else; routing rules are only written after the operator has
 * looked at a diff, because rewriting routing configuration is not something they can undo from
 * this screen.
 */

const ACTION_BADGE: Record<TeamRoutingPlanAction, { variant: 'done' | 'info' | 'default' | 'warn' | 'queued'; label: string }> = {
  create: { variant: 'done', label: 'create' },
  update: { variant: 'info', label: 'update' },
  unchanged: { variant: 'default', label: 'unchanged' },
  conflict: { variant: 'warn', label: 'conflict' },
  skip: { variant: 'queued', label: 'skip' },
};

export function WorkflowTeamCard({ workflowId, teamId }: { workflowId: number; teamId: number | null }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [selected, setSelected] = useState<number | null>(teamId);
  const [plan, setPlan] = useState<TeamRoutingPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api.getTeams().then(setTeams).catch(() => undefined); }, []);
  useEffect(() => { setSelected(teamId); }, [teamId]);

  const assign = useCallback(async (nextTeamId: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.setWorkflowTeam(workflowId, nextTeamId);
      setSelected(nextTeamId);
      setPlan(null);
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }, [workflowId]);

  const preview = async () => {
    setBusy(true);
    setError(null);
    try { setPlan(await api.applyWorkflowTeamRouting(workflowId, true)); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    try { setPlan(await api.applyWorkflowTeamRouting(workflowId, false)); }
    catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  const team = teams.find(t => t.id === selected) ?? null;
  const writes = plan ? plan.summary.create + plan.summary.update : 0;

  return (
    <Card className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-medium text-slate-200 flex items-center gap-2">
          <Users className="w-4 h-4" /> Team
        </h2>
        {team && (
          <Link href={`/teams/${team.id}`} className="text-xs text-slate-400 hover:text-slate-200 underline">
            Open team
          </Link>
        )}
      </div>

      <select
        className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-slate-100"
        value={selected ?? ''}
        disabled={busy}
        onChange={e => assign(e.target.value ? Number(e.target.value) : null)}
      >
        <option value="">No team</option>
        {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>

      {team ? (
        <p className="text-xs text-slate-500">
          Members of {team.name} working this workflow now see their team role and teammates in
          their prompts. Routing is unchanged until applied below.
        </p>
      ) : (
        <p className="text-xs text-slate-500">
          Assigning a team injects its goal, roles and roster into every member&apos;s prompt on
          this workflow.
        </p>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}

      {selected && (
        <div className="border-t border-slate-800 pt-3 space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" onClick={preview} loading={busy}>
              <GitBranch className="w-3.5 h-3.5" /> Preview routing defaults
            </Button>
            {plan && !plan.applied && writes > 0 && (
              <Button variant="primary" size="sm" onClick={apply} loading={busy}>
                Apply {writes} change{writes === 1 ? '' : 's'}
              </Button>
            )}
          </div>

          {plan && (
            <div className="space-y-2">
              <p className="text-xs text-slate-400">
                {plan.applied ? 'Applied.' : 'Dry run — nothing written yet.'}{' '}
                {writes === 0 && plan.entries.length > 0 && 'Nothing to change.'}
                {plan.entries.length === 0 && 'This team has no routing defaults for this workflow type.'}
              </p>

              {plan.entries.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-slate-500 border-b border-slate-800">
                      <tr>
                        <th className="text-left py-1 pr-3">Action</th>
                        <th className="text-left py-1 pr-3">Status</th>
                        <th className="text-left py-1 pr-3">Task type</th>
                        <th className="text-left py-1 pr-3">Routes to</th>
                        <th className="text-left py-1">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plan.entries.map(entry => (
                        <tr key={`${entry.team_rule_id}-${entry.status}-${entry.task_type ?? '*'}`} className="border-b border-slate-800/50">
                          <td className="py-1 pr-3">
                            <Badge variant={ACTION_BADGE[entry.action].variant}>{ACTION_BADGE[entry.action].label}</Badge>
                          </td>
                          <td className="py-1 pr-3 text-slate-300">{entry.status}</td>
                          <td className="py-1 pr-3 text-slate-500">{entry.task_type ?? 'any'}</td>
                          <td className="py-1 pr-3 text-slate-300">
                            {entry.agent_name ?? (entry.member_role ? `role: ${entry.member_role}` : '—')}
                          </td>
                          <td className="py-1 text-slate-500">{entry.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {plan.orphaned.length > 0 && (
                <div className="text-xs text-slate-400 bg-slate-800/50 rounded p-2 space-y-1">
                  <p className="text-slate-300">
                    {plan.orphaned.length} rule{plan.orphaned.length === 1 ? '' : 's'} this team
                    applied here no longer match a template rule. Left in place — this workflow may
                    be mid-flight on them.
                  </p>
                  {plan.orphaned.map(o => (
                    <p key={o.rule_id} className="text-slate-500">
                      {o.status} / {o.task_type ?? 'any'}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
