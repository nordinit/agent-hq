export { apiFetch, getApiBase } from './http';
export * from './types';

import { agentsClient } from './agents';
import { chatClient } from './chat';
import { filesClient } from './files';
import { observabilityClient } from './observability';
import { projectsClient } from './projects';
import { providersClient } from './providers';
import { routingClient } from './routing';
import { runtimesClient } from './runtimes';
import { runsClient } from './runs';
import { tasksClient } from './tasks';
import { teamsClient } from './teams';
import { workflowsClient } from './workflows';

export const api = {
  ...agentsClient,
  ...providersClient,
  ...runsClient,
  ...observabilityClient,
  ...projectsClient,
  ...filesClient,
  ...chatClient,
  ...workflowsClient,
  ...tasksClient,
  ...routingClient,
  ...runtimesClient,
  ...teamsClient,
};
