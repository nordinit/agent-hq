import { z } from 'zod';
import { McpDomainContext } from '../registrar';

export function registerSkillsTools(ctx: McpDomainContext) {
  const { api, registerTool, wrap } = ctx;

  registerTool(
    ['agent_hq_list_skills', 'atlas_list_skills'],
    'List Agent HQ-managed skills.',
    {},
    () => wrap(() => api.listSkills())(),
    { domain: 'skills', rest_paths: ['/api/v1/skills'] },
  );
  
  registerTool(
    ['agent_hq_get_skill', 'atlas_get_skill'],
    'Get a skill by name.',
    { name: z.string().min(1).describe('Skill name') },
    ({ name }) => wrap(() => api.getSkill(name))(),
    { domain: 'skills', rest_paths: ['/api/v1/skills/:name'] },
  );
  
  registerTool(
    ['agent_hq_create_skill', 'atlas_create_skill'],
    'Create a new Agent HQ-managed skill.',
    {
      name: z.string().min(1).describe('Skill name'),
      description: z.string().optional().describe('Optional description'),
      content: z.string().optional().describe('SKILL.md content'),
    },
    ({ name, description, content }) => wrap(() => api.createSkill({ name, description, content }))(),
    { domain: 'skills', rest_paths: ['/api/v1/skills'] },
  );
  
  registerTool(
    ['agent_hq_update_skill', 'atlas_update_skill'],
    'Replace a skill\'s SKILL.md content.',
    {
      name: z.string().min(1).describe('Skill name'),
      content: z.string().min(1).describe('New SKILL.md content'),
    },
    ({ name, content }) => wrap(() => api.updateSkill(name, content))(),
    { domain: 'skills', rest_paths: ['/api/v1/skills/:name'] },
  );
  
  registerTool(
    ['agent_hq_delete_skill', 'atlas_delete_skill'],
    'Delete an Agent HQ-managed skill.',
    { name: z.string().min(1).describe('Skill name') },
    ({ name }) => wrap(() => api.deleteSkill(name))(),
    { domain: 'skills', rest_paths: ['/api/v1/skills/:name'] },
  );
  
  registerTool(
    ['agent_hq_list_agent_skills', 'atlas_list_agent_skills'],
    'List skill assignments for an agent as a first-class relation.',
    { agent_id: z.number().int().positive().describe('Agent ID') },
    ({ agent_id }) => wrap(() => api.listAgentSkills(agent_id))(),
    { domain: 'skills', rest_paths: ['/api/v1/agents/:id/skills'] },
  );
  
  registerTool(
    ['agent_hq_assign_skill_to_agent', 'atlas_assign_skill_to_agent'],
    'Assign a skill to an agent as a first-class relation by skill id or skill name.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      skill_id: z.number().int().positive().optional().describe('Skill ID'),
      skill_name: z.string().min(1).optional().describe('Skill name'),
    },
    ({ agent_id, skill_id, skill_name }) => wrap(() => api.assignSkillToAgent(agent_id, { skill_id, skill_name }))(),
    { domain: 'skills', rest_paths: ['/api/v1/agents/:id/skills'] },
  );
  
  registerTool(
    ['agent_hq_remove_skill_from_agent', 'atlas_remove_skill_from_agent'],
    'Remove a skill assignment from an agent as a first-class relation by skill id or skill name.',
    {
      agent_id: z.number().int().positive().describe('Agent ID'),
      skill_id: z.number().int().positive().optional().describe('Skill ID'),
      skill_name: z.string().min(1).optional().describe('Skill name'),
    },
    ({ agent_id, skill_id, skill_name }) => wrap(() => api.removeSkillFromAgent(agent_id, skill_name ? skill_name : { skill_id }))(),
    { domain: 'skills', rest_paths: ['/api/v1/agents/:id/skills/:skillIdentifier'] },
  );
}
