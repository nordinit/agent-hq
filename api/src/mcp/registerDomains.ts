import { McpDomainContext } from './registrar';
import { registerAdvancedTools } from './domains/advanced';
import { registerAgentsTools } from './domains/agents';
import { registerLifecycleTools } from './domains/lifecycle';
import { registerMcpServersTools } from './domains/mcp-servers';
import { registerProjectsTools } from './domains/projects';
import { registerResourcesTools } from './domains/resources';
import { registerRoutingTools } from './domains/routing';
import { registerSkillsTools } from './domains/skills';
import { registerTaskDefinitionsTools } from './domains/task-definitions';
import { registerTasksTools } from './domains/tasks';
import { registerToolRegistryTools } from './domains/tool-registry';
import { registerWorkflowsTools } from './domains/workflows';

export function registerAgentHqMcpDomains(context: McpDomainContext) {
  registerProjectsTools(context);
  registerWorkflowsTools(context);
  registerTasksTools(context);
  registerLifecycleTools(context);
  registerAgentsTools(context);
  registerAdvancedTools(context);
  registerToolRegistryTools(context);
  registerSkillsTools(context);
  registerMcpServersTools(context);
  registerRoutingTools(context);
  registerTaskDefinitionsTools(context);
  registerResourcesTools(context);
}
