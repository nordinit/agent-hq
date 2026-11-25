export { apiFetch, getApiBase } from './http';
export * from './types';
export * from './dispatchContext';
export * from './context';
export * from './approvals';

import { agentsClient } from './agents';
import { dispatchContextClient } from './dispatchContext';
import { contextClient } from './context';
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
import { telemetryClient } from './telemetry';
import { approvalsClient } from './approvals';

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
  ...dispatchContextClient,
  ...contextClient,
  ...telemetryClient,
  ...approvalsClient,
};
