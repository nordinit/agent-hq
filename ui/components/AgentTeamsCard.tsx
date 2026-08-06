'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AgentEffectiveCapabilities, AgentTeamMembership, api } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Users } from 'lucide-react';

/**
 * An agent's team memberships and what it actually gets at dispatch because of them.
 *
 * The effective list is the point: an operator looking at an agent that has a tool they never
 * assigned it needs somewhere to see that a team granted it, and which team.
 */
export function AgentTeamsCard({ agentId }: { agentId: number }) {
  const [memberships, setMemberships] = useState<AgentTeamMembership[]>([]);
  const [effective, setEffective] = useState<AgentEffectiveCapabilities | null>(null);

  useEffect(() => {
    api.getAgentTeams(agentId).then(setMemberships).catch(() => undefined);
    api.getAgentEffectiveCapabilities(agentId).then(setEffective).catch(() => undefined);
  }, [agentId]);

  if (memberships.length === 0) return null;

  const inheritedTools = effective?.tools.filter(t => t.source === 'team') ?? [];
  const inheritedServers = effective?.mcp_servers.filter(s => s.source === 'team') ?? [];
  const ambiguous = memberships.length > 1 && effective?.dispatch_team_id == null;

  return (
    <Card className="border-amber-500/20 space-y-3">
      <h2 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
        <Users className="w-4 h-4" /> Teams
      </h2>

      <div className="space-y-2">
        {memberships.map(membership => (
          <div key={membership.team_id} className="flex items-center gap-2 flex-wrap">
            <Link href={`/teams/${membership.team_id}`} className="text-slate-200 hover:text-white underline text-sm">
              {membership.name}
            </Link>
            {membership.member_role && <Badge variant="info">{membership.member_role}</Badge>}
            {membership.is_lead === 1 && <Badge variant="workspace">lead</Badge>}
            {membership.is_primary === 1 && <Badge variant="review">primary</Badge>}
            {effective?.dispatch_team_id === membership.team_id && (
              <span className="text-xs text-slate-500">speaks for dispatches without a workflow owner</span>
            )}
          </div>
        ))}
      </div>

      {ambiguous && (
        <p className="text-xs text-amber-400/90">
          On several teams with no primary set. Work under a team-owned workflow uses that
          workflow&apos;s team; anything else injects no team context until one is marked primary.
        </p>
      )}

      {(inheritedTools.length > 0 || inheritedServers.length > 0) && (
        <div className="border-t border-slate-800 pt-3 space-y-2">
          <p className="text-xs text-slate-500">Inherited from teams</p>
          <div className="flex flex-wrap gap-1.5">
            {inheritedTools.map(tool => (
              <span key={`tool-${tool.id}`} className="text-xs bg-slate-800 rounded px-2 py-0.5 text-slate-300">
                {tool.name} <span className="text-slate-500">· {tool.source_team_name}</span>
              </span>
            ))}
            {inheritedServers.map(server => (
              <span key={`mcp-${server.id}`} className="text-xs bg-slate-800 rounded px-2 py-0.5 text-slate-300">
                {server.slug} <span className="text-slate-500">· {server.source_team_name}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}
