import 'dotenv/config';

// Must be set after dotenv loads but before any fetch/TLS calls.
// dotenv/config is synchronous, so process.env is populated by now.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  // Re-affirm for Node's TLS stack (some runtimes cache this early)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
import express, { type Request } from 'express';
import cors from 'cors';
import { getDb } from './db/client';
import { verifyStartupSchemaCurrent } from './db/startupVerifier';
import tasksRouter from './domains/tasks';
import routingRouter, { dispatchRouter, modelRoutingRouter } from './domains/routing';
import agentsRouter from './routes/agents';
import sprintsRouter, { checkSprintCompletion } from './routes/sprints';
import skillsRouter from './routes/skills';
import logsRouter from './routes/logs';
import projectsRouter from './routes/projects';
import artifactsRouter from './routes/artifacts';
import chatRouter, { setupChatProxy } from './routes/chat';
import instancesRouter from './routes/instances';
import externalTaskEventsRouter from './routes/external-task-events';
import { WebSocketServer } from 'ws';
import * as http from 'http';
import { startScheduler } from './scheduler';
import { startSprintScheduler } from './scheduler/sprintScheduler';
import { startWatchdog } from './scheduler/watchdog';
import { startReconciler } from './scheduler/reconciler';
import projectFilesRouter from './routes/project-files';
import workflowFilesRouter from './routes/workflow-files';
import telemetryRouter from './routes/telemetry';
import browserRouter from './routes/browser';
import setupRouter from './routes/setup';
import settingsRouter from './routes/settings';
import tenantsRouter from './routes/tenants';
import toolsRouter, { agentToolsRouter } from './routes/tools';
import mcpServersRouter, { agentMcpServersRouter } from './routes/mcp-servers';
import providersRouter from './routes/providers';
import providerConnectionsRouter from './routes/provider-connections';
import githubIdentitiesRouter from './routes/github-identities';
import sessionsRouter from './routes/sessions';
import recurringTaskSeriesRouter from './routes/recurring-task-series';
import { shutdownPool as shutdownBrowserPool } from './services/browserPool';
import { getMcpCatalog } from './mcp/catalog';
import { registerAgentHqMcpCatalog } from './mcp/registerCatalog';
import { authenticateMcpApiKeyIfPresent, authorizeMcpApiRequestIfPresent } from './lib/mcpApiAuth';
import { handleJsonRequestErrors } from './lib/jsonRequestErrors';
import openApiRouter from './openapi/router';
import { normalizeWorkflowRequestAliases, workflowAliasResponseMiddleware } from './lib/workflowCompatibility';
import { getDashboardTokenUsageLast24h } from './domains/dashboard/stats';
import { resolveTenantIdFromRequest } from './lib/tenantContext';

registerAgentHqMcpCatalog();

const app = express();
const PORT = process.env.PORT ?? 3501;
const HOST = process.env.HOST ?? '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(handleJsonRequestErrors);
app.use('/api/v1', normalizeWorkflowRequestAliases);
app.use('/api/v1', authenticateMcpApiKeyIfPresent);
app.use('/api/v1', authorizeMcpApiRequestIfPresent);

function dispatchToSprintsAlias(req: express.Request, res: express.Response, targetUrl: string): void {
  const originalUrl = req.url;
  req.url = targetUrl;
  sprintsRouter(req, res, () => {
    req.url = originalUrl;
  });
}

function resolveSprintTypeKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Agent HQ API', ts: new Date().toISOString() });
});

app.use(openApiRouter);
app.use('/api/v1', openApiRouter);

// API routes
app.get('/api/v1/mcp/catalog', (_req, res) => {
  res.json(getMcpCatalog());
});

app.get('/api/v1/mcp/catalog/health', (_req, res) => {
  const catalog = getMcpCatalog();
  res.json({
    ok: true,
    server: catalog.server,
    tool_count: catalog.tools.length,
    resource_count: catalog.resources.length,
    domains: catalog.domains,
  });
});

app.use('/api/v1/agents', agentsRouter);
app.use('/api/v1/skills', skillsRouter);
app.use('/api/v1/logs', logsRouter);
app.use('/api/v1/projects', projectsRouter);
app.use('/api/v1/tenants', tenantsRouter);
// Legacy compatibility alias. Prefer /api/v1/tenants for new clients.
app.use('/api/v1/companies', tenantsRouter);
app.use('/api/v1/artifacts', artifactsRouter);
app.use('/api/v1/chat', chatRouter);
app.use('/api/v1/tasks', tasksRouter);
app.use('/api/v1/recurring-task-series', recurringTaskSeriesRouter);
app.use('/api/v1/instances', instancesRouter);
app.use('/api/v1/external', externalTaskEventsRouter);
function buildWorkflowEventMappingSuffix(req: Request): string {
  const query = new URLSearchParams();
  if (typeof req.query.project_id === 'string') query.set('project_id', req.query.project_id);
  if (typeof req.query.source === 'string') query.set('source', req.query.source);
  if (typeof req.query.event_name === 'string') query.set('event_name', req.query.event_name);
  if (typeof req.query.task_type === 'string') query.set('task_type', req.query.task_type);
  return query.toString() ? `?${query.toString()}` : '';
}

function redirectPreservingQuery(req: Request, path: string): string {
  const queryStart = req.originalUrl.indexOf('?');
  return queryStart === -1 ? path : `${path}${req.originalUrl.slice(queryStart)}`;
}

app.get('/api/v1/workflow-events/definitions', (req, res) => {
  res.redirect(307, `/api/v1/routing/workflow-event-mappings${buildWorkflowEventMappingSuffix(req)}`);
});
app.get('/api/v1/workflow-events/mappings', (req, res) => {
  res.redirect(307, `/api/v1/routing/workflow-event-mappings${buildWorkflowEventMappingSuffix(req)}`);
});

app.get('/api/v1/external-task-events/definitions', (req, res) => {
  res.redirect(307, `/api/v1/routing/workflow-event-mappings${buildWorkflowEventMappingSuffix(req)}`);
});
app.get('/api/v1/external-task-events/mappings', (req, res) => {
  res.redirect(307, `/api/v1/routing/workflow-event-mappings${buildWorkflowEventMappingSuffix(req)}`);
});
app.use('/api/v1/sprints', sprintsRouter);
app.use('/api/v1/workflows', workflowAliasResponseMiddleware, sprintsRouter);
app.get('/api/v1/workflow-types', (_req, res) => {
  res.redirect(307, '/api/v1/workflows/types/list');
});
app.post('/api/v1/workflow-types', (_req, res) => {
  res.redirect(307, '/api/v1/workflows/types');
});
app.get('/api/v1/workflow-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}`);
});
app.put('/api/v1/workflow-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}`);
});
app.delete('/api/v1/workflow-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}`);
});
app.get('/api/v1/workflow-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.put('/api/v1/workflow-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.get('/api/v1/workflow-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.post('/api/v1/workflow-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.get('/api/v1/workflow-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/workflow-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.delete('/api/v1/workflow-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.get('/api/v1/sprint-types', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/types/list');
});
app.post('/api/v1/sprint-types', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/types');
});
app.get('/api/v1/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.put('/api/v1/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.delete('/api/v1/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.get('/api/v1/sprint-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.put('/api/v1/sprint-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.get('/api/v1/sprint-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.post('/api/v1/sprint-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.get('/api/v1/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.delete('/api/v1/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.get('/api/v1/task-definitions', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/config');
});
app.get('/api/v1/workflow-definitions', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, '/api/v1/workflows/config'));
});
app.get('/api/v1/task-definitions/config', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/config');
});
app.get('/api/v1/workflow-definitions/config', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, '/api/v1/workflows/config'));
});
app.get('/api/v1/workflow-definitions/types', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, '/api/v1/workflows/types/list'));
});
app.post('/api/v1/workflow-definitions/types', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, '/api/v1/workflows/types'));
});
app.get('/api/v1/workflow-definitions/types/:key', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}`));
});
app.put('/api/v1/workflow-definitions/types/:key', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}`));
});
app.delete('/api/v1/workflow-definitions/types/:key', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}`));
});
app.get('/api/v1/workflow-definitions/types/:key/task-types', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/task-types`));
});
app.put('/api/v1/workflow-definitions/types/:key/task-types', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/task-types`));
});
app.get('/api/v1/workflow-definitions/types/:key/field-schemas', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas`));
});
app.post('/api/v1/workflow-definitions/types/:key/field-schemas', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas`));
});
app.get('/api/v1/workflow-definitions/types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`));
});
app.put('/api/v1/workflow-definitions/types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`));
});
app.delete('/api/v1/workflow-definitions/types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`));
});
app.get('/api/v1/task-definitions/sprint-types', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/types/list');
});
app.post('/api/v1/task-definitions/sprint-types', (_req, res) => {
  res.redirect(307, '/api/v1/sprints/types');
});
app.get('/api/v1/task-definitions/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.put('/api/v1/task-definitions/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.delete('/api/v1/task-definitions/sprint-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}`);
});
app.get('/api/v1/task-definitions/sprint-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.put('/api/v1/task-definitions/sprint-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.get('/api/v1/task-definitions/sprint-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.post('/api/v1/task-definitions/sprint-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.get('/api/v1/task-definitions/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/task-definitions/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.delete('/api/v1/task-definitions/sprint-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/sprints/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.get('/api/v1/task-field-schemas', (req, res) => {
  const sprintTypeKey = typeof req.query.sprint_type_key === 'string'
    ? req.query.sprint_type_key
    : typeof req.query.sprint_type === 'string'
      ? req.query.sprint_type
      : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_query_params: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas',
    });
  }
  dispatchToSprintsAlias(req, res, `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`);
});
app.post('/api/v1/task-field-schemas', (req, res) => {
  const sprintTypeKey = typeof req.body?.sprint_type_key === 'string'
    ? req.body.sprint_type_key
    : typeof req.body?.sprint_type === 'string'
      ? req.body.sprint_type
      : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_body_fields: ['sprint_type_key', 'sprint_type', 'task_type', 'schema'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas',
    });
  }
  req.url = `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`;
  sprintsRouter(req, res, () => undefined);
});
app.get('/api/v1/task-field-schemas/:schemaId', (req, res) => {
  const sprintTypeKey = typeof req.query.sprint_type_key === 'string'
    ? req.query.sprint_type_key
    : typeof req.query.sprint_type === 'string'
      ? req.query.sprint_type
      : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_query_params: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas/:schemaId',
    });
  }
  dispatchToSprintsAlias(req, res, `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/task-field-schemas/:schemaId', (req, res) => {
  const sprintTypeKey = typeof req.body?.sprint_type_key === 'string'
    ? req.body.sprint_type_key
    : typeof req.body?.sprint_type === 'string'
      ? req.body.sprint_type
      : typeof req.query.sprint_type_key === 'string'
        ? req.query.sprint_type_key
        : typeof req.query.sprint_type === 'string'
          ? req.query.sprint_type
          : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_fields: ['sprint_type_key', 'sprint_type', 'task_type', 'schema'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas/:schemaId',
    });
  }
  req.url = `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  sprintsRouter(req, res, () => undefined);
});
app.delete('/api/v1/task-field-schemas/:schemaId', (req, res) => {
  const sprintTypeKey = typeof req.body?.sprint_type_key === 'string'
    ? req.body.sprint_type_key
    : typeof req.body?.sprint_type === 'string'
      ? req.body.sprint_type
      : typeof req.query.sprint_type_key === 'string'
        ? req.query.sprint_type_key
        : typeof req.query.sprint_type === 'string'
          ? req.query.sprint_type
          : '';
  if (!sprintTypeKey.trim()) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_fields: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas/:schemaId',
    });
  }
  req.url = `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  sprintsRouter(req, res, () => undefined);
});
app.get('/api/v1/task-field-definitions', (req, res) => {
  const sprintTypeKey = resolveSprintTypeKey(req.query.sprint_type_key)
    || resolveSprintTypeKey(req.query.sprint_type);
  if (!sprintTypeKey) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_query_params: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas',
      alias_of: '/api/v1/task-field-schemas',
    });
  }
  dispatchToSprintsAlias(req, res, `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas`);
});
app.post('/api/v1/task-field-definitions', (req, res) => {
  req.url = `/task-field-schemas`;
  app._router.handle(req, res, () => undefined);
});
app.get('/api/v1/task-field-definitions/:schemaId', (req, res) => {
  const sprintTypeKey = resolveSprintTypeKey(req.query.sprint_type_key)
    || resolveSprintTypeKey(req.query.sprint_type);
  if (!sprintTypeKey) {
    return res.status(400).json({
      error: 'sprint_type_key is required',
      supported_query_params: ['sprint_type_key', 'sprint_type'],
      canonical_path_template: '/api/v1/sprints/types/:key/field-schemas/:schemaId',
      alias_of: '/api/v1/task-field-schemas/:schemaId',
    });
  }
  dispatchToSprintsAlias(req, res, `/types/${encodeURIComponent(sprintTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/task-field-definitions/:schemaId', (req, res) => {
  req.url = `/task-field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  app._router.handle(req, res, () => undefined);
});
app.delete('/api/v1/task-field-definitions/:schemaId', (req, res) => {
  req.url = `/task-field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  app._router.handle(req, res, () => undefined);
});
function dispatchToRoutingRulesAlias(req: express.Request, res: express.Response, next: express.NextFunction, id?: string) {
  req.url = `/rules${id ? `/${encodeURIComponent(id)}` : ''}${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
  routingRouter(req, res, next);
}

app.get('/api/v1/routing-rules', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next);
});
app.post('/api/v1/routing-rules', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next);
});
app.get('/api/v1/routing-rules/:id', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next, req.params.id);
});
app.put('/api/v1/routing-rules/:id', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next, req.params.id);
});
app.delete('/api/v1/routing-rules/:id', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next, req.params.id);
});
app.get('/api/v1/assignment-rules', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next);
});
app.post('/api/v1/assignment-rules', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next);
});
app.get('/api/v1/assignment-rules/:id', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next, req.params.id);
});
app.put('/api/v1/assignment-rules/:id', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next, req.params.id);
});
app.delete('/api/v1/assignment-rules/:id', (req, res, next) => {
  dispatchToRoutingRulesAlias(req, res, next, req.params.id);
});
app.use('/api/v1/projects/:id/files', projectFilesRouter);
app.use('/api/v1/projects/:projectId/workflows/:workflowId/files', workflowFilesRouter);
app.use('/api/v1/telemetry', telemetryRouter);
app.use('/api/v1/routing', routingRouter);
app.use('/api/v1/dispatch', dispatchRouter);
app.use('/api/v1/model-routing', modelRoutingRouter);
app.use('/api/v1/story-point-routing', modelRoutingRouter);
app.use('/api/v1/model-routing-rules', modelRoutingRouter);
app.use('/api/v1/routing/model-routing', modelRoutingRouter);
app.use('/api/v1/routing/story-point-routing', modelRoutingRouter);
app.use('/api/v1/routing/model-routing-rules', modelRoutingRouter);
app.use('/api/v1/routing/model-routes', modelRoutingRouter);
app.use('/api/v1/browser', browserRouter);
app.use('/api/v1/setup', setupRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/tools', toolsRouter);
app.use('/api/v1/agents/:id/tools', agentToolsRouter);
app.use('/api/v1/mcp-servers', mcpServersRouter);
app.use('/api/v1/agents/:id/mcp-servers', agentMcpServersRouter);
app.use('/api/v1/providers', providersRouter);
app.use('/api/v1/provider-connections', providerConnectionsRouter);
app.use('/api/v1/github-identities', githubIdentitiesRouter);
app.use('/api/v1/sessions', sessionsRouter);

// Instances route (shortcut for Kanban)
app.get('/api/v1/instances', async (_req, res) => {
  try {
    const { getDb } = require('./db/client');
    const db = getDb();
    const instances = await db.all(`
      SELECT ji.*, a.job_title as job_title, a.name as agent_name, a.session_key as agent_session_key,
             t.title as task_title, t.status as task_status, t.project_id as project_id
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      LEFT JOIN tasks t ON t.id = ji.task_id
      ORDER BY ji.created_at DESC
      LIMIT 200
    `);
    res.json(instances);
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Dashboard stats
app.get('/api/v1/stats', async (req, res) => {
  try {
    const { getDb } = require('./db/client');
    const db = getDb();
    const tenantId = await resolveTenantIdFromRequest(db, req);
    const projectId = Number(req.query.project_id) || null;
    const agentProjectWhere = projectId ? 'WHERE tenant_id = ? AND project_id = ?' : 'WHERE tenant_id = ?';
    const enabledAgentProjectWhere = projectId ? 'AND tenant_id = ? AND project_id = ?' : 'AND tenant_id = ?';
    const agentProjectParams = projectId ? [tenantId, projectId] : [tenantId];
    const scopedJobJoin = 'LEFT JOIN tasks t ON t.id = ji.task_id LEFT JOIN agents a ON a.id = ji.agent_id';
    const scopedJobWhere = projectId
      ? ' AND ((t.tenant_id = ? AND t.project_id = ?) OR (ji.task_id IS NULL AND a.tenant_id = ? AND a.project_id = ?))'
      : ' AND (t.tenant_id = ? OR (ji.task_id IS NULL AND a.tenant_id = ?))';
    const scopedJobParams = projectId ? [tenantId, projectId, tenantId, projectId] : [tenantId, tenantId];

    const totalAgents = (await db.get(`SELECT COUNT(*) as n FROM agents ${agentProjectWhere}`, ...agentProjectParams) as { n: number }).n;
    const activeJobs = (await db.get(`SELECT COUNT(*) as n FROM job_instances ji ${scopedJobJoin} WHERE ji.status IN ('queued','dispatched','running')${scopedJobWhere}`, ...scopedJobParams) as { n: number }).n;
    const runningJobs = (await db.get(`SELECT COUNT(*) as n FROM job_instances ji ${scopedJobJoin} WHERE ji.status = 'running'${scopedJobWhere}`, ...scopedJobParams) as { n: number }).n;
    const pendingJobs = (await db.get(`SELECT COUNT(*) as n FROM job_instances ji ${scopedJobJoin} WHERE ji.status IN ('queued','dispatched')${scopedJobWhere}`, ...scopedJobParams) as { n: number }).n;
    const recentRuns = (await db.get(`SELECT COUNT(*) as n FROM job_instances ji ${scopedJobJoin} WHERE ji.created_at >= datetime('now', '-24 hours')${scopedJobWhere}`, ...scopedJobParams) as { n: number }).n;
    const failedRecent = (await db.get(`SELECT COUNT(*) as n FROM job_instances ji ${scopedJobJoin} WHERE ji.status = 'failed' AND ji.created_at >= datetime('now', '-24 hours')${scopedJobWhere}`, ...scopedJobParams) as { n: number }).n;
    const doneRecent = (await db.get(`SELECT COUNT(*) as n FROM job_instances ji ${scopedJobJoin} WHERE ji.status = 'done' AND ji.created_at >= datetime('now', '-24 hours')${scopedJobWhere}`, ...scopedJobParams) as { n: number }).n;
    const enabledTemplates = (await db.get(`SELECT COUNT(*) as n FROM agents WHERE enabled = 1 ${enabledAgentProjectWhere}`, ...agentProjectParams) as { n: number }).n;
    const tokensLast24h = await getDashboardTokenUsageLast24h(db, projectId, tenantId);

    const recentFailed = await db.all(`
      SELECT ji.*, a.job_title as job_title, a.name as agent_name
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      LEFT JOIN tasks t ON t.id = ji.task_id
      WHERE ji.status = 'failed' AND ji.created_at >= datetime('now', '-24 hours')
      ${scopedJobWhere}
      ORDER BY ji.created_at DESC
      LIMIT 5
    `, ...scopedJobParams);

    res.json({
      totalAgents,
      activeJobs,
      runningJobs,
      pendingJobs,
      recentRuns,
      failedRecent,
      doneRecent,
      enabledTemplates,
      tokensLast24h,
      todayTokenUsage: tokensLast24h,
      recentFailed,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// Verify DB schema and start. Startup must not run schema/data migrations.
verifyStartupSchemaCurrent();

const automationDisabled = process.env.AGENT_HQ_DISABLE_AUTOMATION === '1';
if (automationDisabled) {
  console.warn('[boot] Background automation disabled by AGENT_HQ_DISABLE_AUTOMATION=1');
} else {
  startScheduler();
  startSprintScheduler();
  startWatchdog();
  startReconciler();
}

// Sprint heartbeat: check every 5 min for time/run-limit exceeded sprints
setInterval(async () => {
  try { await checkSprintCompletion(); } catch (err) { console.error('[sprints] Heartbeat error:', err); }
}, 5 * 60 * 1000);

const server = http.createServer(app);

console.log('[boot] http server created', { port: Number(PORT), host: HOST });

// WebSocket proxy for chat (bridges browser → Gateway wss://)
console.log('[boot] creating chat websocket server', { path: '/api/v1/chat/ws' });
const wss = new WebSocketServer({ server, path: '/api/v1/chat/ws' });
console.log('[boot] calling setupChatProxy');
setupChatProxy(wss);
console.log('[boot] setupChatProxy returned');

console.log('[boot] about to server.listen', { port: Number(PORT), host: HOST });
server.listen(Number(PORT), HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log(`Agent HQ API running on http://${displayHost}:${PORT}`);
});

// Graceful shutdown: close browser pool
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    console.log(`[shutdown] Received ${sig}, shutting down browser pool...`);
    await shutdownBrowserPool();
    process.exit(0);
  });
}

export default app;
