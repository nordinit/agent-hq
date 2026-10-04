import { apiFetch } from './http';
export interface TeamResolution {
  team_id: number;
  context_version: number;
  skill_names: string[];
  members: Array<{
    id: number; name: string; enabled: boolean;
    capabilities: Array<{ id: string; label: string; kind: 'tool' | 'mcp' | 'skill'; source: string }>;
  }>;
}

export const getTeamResolution = (id: number) => apiFetch<TeamResolution>(`/api/v1/teams/${id}/resolution`);
export const previewTeamSkills = (id: number, skills: string[]) => apiFetch<{ before: TeamResolution; after: TeamResolution }>(`/api/v1/teams/${id}/resolution/preview`, { method: 'POST', body: JSON.stringify({ skill_names: skills }) });
