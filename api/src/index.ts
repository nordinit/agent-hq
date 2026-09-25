import './config/loadRootEnv';

// Must be set after dotenv loads but before any fetch/TLS calls.
// dotenv/config is synchronous, so process.env is populated by now.
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  // Re-affirm for Node's TLS stack (some runtimes cache this early)
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}
import express, { type Request } from 'express';
import cors from 'cors';
import { corsOptionsDelegate, parseAllowedOrigins, rejectCrossOriginRequests } from './lib/originGuard';
import { getDb } from './db/client';
import { verifyStartupSchema } from './db/startupVerifier';
import tasksRouter from './domains/tasks';
import routingRouter, { dispatchRouter, modelRoutingRouter } from './domains/routing';
import agentsRouter from './routes/agents';
import workflowsRouter, { checkWorkflowCompletion } from './routes/workflows';
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
import { startWatchdog } from './scheduler/watchdog';
import { startReconciler } from './scheduler/reconciler';
import projectFilesRouter from './routes/project-files';
import workflowFilesRouter from './routes/workflow-files';
import telemetryV2Router from './routes/telemetry-v2';
import { startTelemetryCaptureWorker } from './domains/telemetry/capture';
import { startTelemetryQueryWorker } from './domains/telemetry/queries';
import setupRouter from './routes/setup';
import settingsRouter from './routes/settings';
import tenantsRouter from './routes/tenants';
import toolsRouter, { agentToolsRouter } from './routes/tools';
import mcpServersRouter, { agentMcpServersRouter } from './routes/mcp-servers';
import teamsRouter, {
  agentEffectiveCapabilitiesRouter,
  agentTeamsRouter,
  workflowTeamRouter,
} from './routes/teams';
import providersRouter from './routes/providers';
import providerConnectionsRouter from './routes/provider-connections';
import githubIdentitiesRouter from './routes/github-identities';
import sessionsRouter from './routes/sessions';
import recurringTaskSeriesRouter from './routes/recurring-task-series';
import runtimeDriversRouter from './routes/runtime-drivers';
import { getMcpCatalog } from './mcp/catalog';
import { mcpAccessRouter } from './mcp/accessRouter';
import { registerAgentHqMcpCatalog } from './mcp/registerCatalog';
import { createMcpHttpRouter, resolveMcpHttpConfigFromEnv } from './mcp/httpServer';
import { createMcpOAuthRouter, resolveMcpOAuthConfigFromEnv } from './mcp/oauth/router';
import { authorizeMcpApiRequestIfPresent } from './lib/mcpApiAuth';
import { ApiAuthConfigError, authenticateApiRequest, createChatWebSocketVerifier, resolveApiAuthConfigFromEnv } from './lib/apiAuth';
import { handleJsonRequestErrors } from './lib/jsonRequestErrors';
import { apiSecurityHeaders } from './lib/userContentHeaders';
import openApiRouter from './openapi/router';
import { getDashboardTokenUsageLast24h } from './domains/dashboard/stats';
import { resolveTenantIdFromRequest } from './lib/tenantContext';

registerAgentHqMcpCatalog();

function loadApiAuthConfig() {
  try {
    return resolveApiAuthConfigFromEnv(process.env);
  } catch (err) {
    if (!(err instanceof ApiAuthConfigError)) throw err;
    console.error(`[api-auth] ${err.message}`);
    process.exit(1);
  }
}

const apiAuthConfig = loadApiAuthConfig();
if (apiAuthConfig.mode === 'report') {
  console.warn('[api-auth] AGENT_HQ_AUTH_MODE=report: /api/v1 requests without a credential are still allowed with full access, and each distinct caller is logged once as "[api-auth:report] would reject". Switch to enforce once no new lines appear.');
  if (!apiAuthConfig.operatorToken) console.warn('[api-auth] AGENT_HQ_OPERATOR_TOKEN is not set; the UI cannot sign in until it is.');
}

const app = express();
app.disable('x-powered-by');
app.use(apiSecurityHeaders);
const PORT = process.env.PORT ?? 3501;
// Loopback by default: agents run commands on this host, so the API stays off the network unless
// the operator publishes it deliberately. Containers set HOST=0.0.0.0 and publish the port on the
// host's loopback instead.
const HOST = process.env.HOST ?? '127.0.0.1';
const allowedBrowserOrigins = parseAllowedOrigins(process.env.AGENT_HQ_ALLOWED_ORIGINS);

app.use(cors(corsOptionsDelegate(allowedBrowserOrigins)));
app.use('/api/v1', rejectCrossOriginRequests(allowedBrowserOrigins));
// Every /api/v1 request authenticates as the operator or as an agent's MCP key; see lib/apiAuth.
// Before body parsing, so an anonymous caller cannot make the API parse a 10 MB body.
app.use('/api/v1', authenticateApiRequest(apiAuthConfig));
app.use(express.json({ limit: '10mb' }));
app.use(handleJsonRequestErrors);

// Scope checks read the body.
app.use('/api/v1', authorizeMcpApiRequestIfPresent);

function dispatchToWorkflowsAlias(req: express.Request, res: express.Response, targetUrl: string): void {
  const originalUrl = req.url;
  req.url = targetUrl;
  workflowsRouter(req, res, () => {
    req.url = originalUrl;
  });
}

function resolveWorkflowTypeKey(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Health check
app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'Agent HQ API', ts: new Date().toISOString() });
});

app.use(openApiRouter);
app.use('/api/v1', openApiRouter);

// API routes
app.use('/api/v1/mcp', mcpAccessRouter);
app.get('/api/v1/mcp/catalog', (_req, res) => {
  res.json(getMcpCatalog());
});

// Streamable HTTP MCP transport. Mounted outside /api/v1 on purpose: the MCP-key middlewares
// on that prefix authorize REST resource paths, and /mcp is a JSON-RPC envelope rather than a
// resource. The router authenticates the key itself, and the tool calls it makes land back on
// /api/v1 where the capability policy applies as usual.
const mcpHttpConfig = resolveMcpHttpConfigFromEnv(process.env, PORT);
const mcpOAuthConfig = resolveMcpOAuthConfigFromEnv(process.env);
let mcpResourceMetadataUrl: string | undefined;

// The authorization server mounts before the resource it protects so /mcp can advertise it.
if (mcpHttpConfig.enabled && mcpOAuthConfig.enabled) {
  try {
    const oauth = createMcpOAuthRouter({ db: getDb(), config: mcpOAuthConfig });
    app.use(oauth.router);
    mcpResourceMetadataUrl = oauth.resourceMetadataUrl;
    console.log(`[mcp-oauth] authorization server mounted at ${mcpOAuthConfig.publicUrl} (identity: ${mcpOAuthConfig.agentSlug}, DCR: ${mcpOAuthConfig.allowDynamicRegistration ? 'on' : 'off'})`);
  } catch (err) {
    // A misconfigured issuer should not take the API down; the endpoint stays reachable with a
    // direct MCP key, which is how local clients and the smoke test use it anyway.
    console.error('[mcp-oauth] not mounted:', err instanceof Error ? err.message : err);
  }
} else if (mcpHttpConfig.enabled && !mcpOAuthConfig.publicUrl) {
  console.log('[mcp-oauth] disabled — set AGENT_HQ_PUBLIC_URL to the public HTTPS URL of this install to enable connector OAuth');
}

if (mcpHttpConfig.enabled) {
  app.use('/mcp', createMcpHttpRouter({
    apiBaseUrl: mcpHttpConfig.apiBaseUrl,
    rateLimitRpm: mcpHttpConfig.rateLimitRpm,
    allowedHosts: mcpHttpConfig.allowedHosts,
    resourceMetadataUrl: mcpResourceMetadataUrl,
  }));
  console.log(`[mcp-http] Streamable HTTP MCP transport mounted at /mcp (access: identity permissions)`);
}

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
app.use('/api/v1/runtime-drivers', runtimeDriversRouter);
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
app.use('/api/v1/workflows', workflowsRouter);
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
app.get('/api/v1/task-definitions', (_req, res) => {
  res.redirect(307, '/api/v1/workflows/config');
});
app.get('/api/v1/workflow-definitions', (req, res) => {
  res.redirect(307, redirectPreservingQuery(req, '/api/v1/workflows/config'));
});
app.get('/api/v1/task-definitions/config', (_req, res) => {
  res.redirect(307, '/api/v1/workflows/config');
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
app.get('/api/v1/task-definitions/workflow-types', (_req, res) => {
  res.redirect(307, '/api/v1/workflows/types/list');
});
app.post('/api/v1/task-definitions/workflow-types', (_req, res) => {
  res.redirect(307, '/api/v1/workflows/types');
});
app.get('/api/v1/task-definitions/workflow-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}`);
});
app.put('/api/v1/task-definitions/workflow-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}`);
});
app.delete('/api/v1/task-definitions/workflow-types/:key', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}`);
});
app.get('/api/v1/task-definitions/workflow-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.put('/api/v1/task-definitions/workflow-types/:key/task-types', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/task-types`);
});
app.get('/api/v1/task-definitions/workflow-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.post('/api/v1/task-definitions/workflow-types/:key/field-schemas', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas`);
});
app.get('/api/v1/task-definitions/workflow-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/task-definitions/workflow-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.delete('/api/v1/task-definitions/workflow-types/:key/field-schemas/:schemaId', (req, res) => {
  res.redirect(307, `/api/v1/workflows/types/${encodeURIComponent(req.params.key)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.get('/api/v1/task-field-schemas', (req, res) => {
  const workflowTypeKey = typeof req.query.workflow_type_key === 'string'
    ? req.query.workflow_type_key
    : typeof req.query.workflow_type === 'string'
      ? req.query.workflow_type
      : '';
  if (!workflowTypeKey.trim()) {
    return res.status(400).json({
      error: 'workflow_type_key is required',
      supported_query_params: ['workflow_type_key', 'workflow_type'],
      canonical_path_template: '/api/v1/workflows/types/:key/field-schemas',
    });
  }
  dispatchToWorkflowsAlias(req, res, `/types/${encodeURIComponent(workflowTypeKey)}/field-schemas`);
});
app.post('/api/v1/task-field-schemas', (req, res) => {
  const workflowTypeKey = typeof req.body?.workflow_type_key === 'string'
    ? req.body.workflow_type_key
    : typeof req.body?.workflow_type === 'string'
      ? req.body.workflow_type
      : '';
  if (!workflowTypeKey.trim()) {
    return res.status(400).json({
      error: 'workflow_type_key is required',
      supported_body_fields: ['workflow_type_key', 'workflow_type', 'task_type', 'schema'],
      canonical_path_template: '/api/v1/workflows/types/:key/field-schemas',
    });
  }
  req.url = `/types/${encodeURIComponent(workflowTypeKey)}/field-schemas`;
  workflowsRouter(req, res, () => undefined);
});
app.get('/api/v1/task-field-schemas/:schemaId', (req, res) => {
  const workflowTypeKey = typeof req.query.workflow_type_key === 'string'
    ? req.query.workflow_type_key
    : typeof req.query.workflow_type === 'string'
      ? req.query.workflow_type
      : '';
  if (!workflowTypeKey.trim()) {
    return res.status(400).json({
      error: 'workflow_type_key is required',
      supported_query_params: ['workflow_type_key', 'workflow_type'],
      canonical_path_template: '/api/v1/workflows/types/:key/field-schemas/:schemaId',
    });
  }
  dispatchToWorkflowsAlias(req, res, `/types/${encodeURIComponent(workflowTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
});
app.put('/api/v1/task-field-schemas/:schemaId', (req, res) => {
  const workflowTypeKey = typeof req.body?.workflow_type_key === 'string'
    ? req.body.workflow_type_key
    : typeof req.body?.workflow_type === 'string'
      ? req.body.workflow_type
      : typeof req.query.workflow_type_key === 'string'
        ? req.query.workflow_type_key
        : typeof req.query.workflow_type === 'string'
          ? req.query.workflow_type
          : '';
  if (!workflowTypeKey.trim()) {
    return res.status(400).json({
      error: 'workflow_type_key is required',
      supported_fields: ['workflow_type_key', 'workflow_type', 'task_type', 'schema'],
      canonical_path_template: '/api/v1/workflows/types/:key/field-schemas/:schemaId',
    });
  }
  req.url = `/types/${encodeURIComponent(workflowTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  workflowsRouter(req, res, () => undefined);
});
app.delete('/api/v1/task-field-schemas/:schemaId', (req, res) => {
  const workflowTypeKey = typeof req.body?.workflow_type_key === 'string'
    ? req.body.workflow_type_key
    : typeof req.body?.workflow_type === 'string'
      ? req.body.workflow_type
      : typeof req.query.workflow_type_key === 'string'
        ? req.query.workflow_type_key
        : typeof req.query.workflow_type === 'string'
          ? req.query.workflow_type
          : '';
  if (!workflowTypeKey.trim()) {
    return res.status(400).json({
      error: 'workflow_type_key is required',
      supported_fields: ['workflow_type_key', 'workflow_type'],
      canonical_path_template: '/api/v1/workflows/types/:key/field-schemas/:schemaId',
    });
  }
  req.url = `/types/${encodeURIComponent(workflowTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`;
  workflowsRouter(req, res, () => undefined);
});
app.get('/api/v1/task-field-definitions', (req, res) => {
  const workflowTypeKey = resolveWorkflowTypeKey(req.query.workflow_type_key)
    || resolveWorkflowTypeKey(req.query.workflow_type);
  if (!workflowTypeKey) {
    return res.status(400).json({
      error: 'workflow_type_key is required',
      supported_query_params: ['workflow_type_key', 'workflow_type'],
      canonical_path_template: '/api/v1/workflows/types/:key/field-schemas',
      alias_of: '/api/v1/task-field-schemas',
    });
  }
  dispatchToWorkflowsAlias(req, res, `/types/${encodeURIComponent(workflowTypeKey)}/field-schemas`);
});
app.post('/api/v1/task-field-definitions', (req, res) => {
  req.url = `/task-field-schemas`;
  app._router.handle(req, res, () => undefined);
});
app.get('/api/v1/task-field-definitions/:schemaId', (req, res) => {
  const workflowTypeKey = resolveWorkflowTypeKey(req.query.workflow_type_key)
    || resolveWorkflowTypeKey(req.query.workflow_type);
  if (!workflowTypeKey) {
    return res.status(400).json({
      error: 'workflow_type_key is required',
      supported_query_params: ['workflow_type_key', 'workflow_type'],
      canonical_path_template: '/api/v1/workflows/types/:key/field-schemas/:schemaId',
      alias_of: '/api/v1/task-field-schemas/:schemaId',
    });
  }
  dispatchToWorkflowsAlias(req, res, `/types/${encodeURIComponent(workflowTypeKey)}/field-schemas/${encodeURIComponent(req.params.schemaId)}`);
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
app.use('/api/v1/telemetry/v2', telemetryV2Router);
app.use('/api/v1/routing', routingRouter);
app.use('/api/v1/dispatch', dispatchRouter);
app.use('/api/v1/model-routing', modelRoutingRouter);
app.use('/api/v1/story-point-routing', modelRoutingRouter);
app.use('/api/v1/model-routing-rules', modelRoutingRouter);
app.use('/api/v1/routing/model-routing', modelRoutingRouter);
app.use('/api/v1/routing/story-point-routing', modelRoutingRouter);
app.use('/api/v1/routing/model-routing-rules', modelRoutingRouter);
app.use('/api/v1/routing/model-routes', modelRoutingRouter);
app.use('/api/v1/setup', setupRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/tools', toolsRouter);
app.use('/api/v1/agents/:id/tools', agentToolsRouter);
app.use('/api/v1/mcp-servers', mcpServersRouter);
app.use('/api/v1/agents/:id/mcp-servers', agentMcpServersRouter);
app.use('/api/v1/teams', teamsRouter);
app.use('/api/v1/agents/:id/teams', agentTeamsRouter);
app.use('/api/v1/agents/:id/effective-capabilities', agentEffectiveCapabilitiesRouter);
// Team ownership hangs off the workflow, not the team: "which team runs this workflow" is a
// property of the workflow. Mounted under both vocabularies like the workflow router itself.
app.use('/api/v1/workflows/:workflowId/team', workflowTeamRouter);
app.use('/api/v1/providers', providersRouter);
app.use('/api/v1/provider-connections', providerConnectionsRouter);
app.use('/api/v1/github-identities', githubIdentitiesRouter);
app.use('/api/v1/sessions', sessionsRouter);

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
    const recentRuns = (await db.get(`SELECT COUNT(*) as n FROM job_instances ji ${scopedJobJoin} WHERE ji.created_at >= to_char((now() AT TIME ZONE 'utc' - interval '24 hour'), 'YYYY-MM-DD HH24:MI:SS')${scopedJobWhere}`, ...scopedJobParams) as { n: number }).n;
    const failedRecent = (await db.get(`SELECT COUNT(*) as n FROM job_instances ji ${scopedJobJoin} WHERE ji.status = 'failed' AND ji.created_at >= to_char((now() AT TIME ZONE 'utc' - interval '24 hour'), 'YYYY-MM-DD HH24:MI:SS')${scopedJobWhere}`, ...scopedJobParams) as { n: number }).n;
    const doneRecent = (await db.get(`SELECT COUNT(*) as n FROM job_instances ji ${scopedJobJoin} WHERE ji.status = 'done' AND ji.created_at >= to_char((now() AT TIME ZONE 'utc' - interval '24 hour'), 'YYYY-MM-DD HH24:MI:SS')${scopedJobWhere}`, ...scopedJobParams) as { n: number }).n;
    const enabledTemplates = (await db.get(`SELECT COUNT(*) as n FROM agents WHERE enabled = 1 ${enabledAgentProjectWhere}`, ...agentProjectParams) as { n: number }).n;
    const tokensLast24h = await getDashboardTokenUsageLast24h(db, projectId, tenantId);

    const recentFailed = await db.all(`
      SELECT ji.*, a.job_title as job_title, a.name as agent_name
      FROM job_instances ji
      LEFT JOIN agents a ON a.id = ji.agent_id
      LEFT JOIN tasks t ON t.id = ji.task_id
      WHERE ji.status = 'failed' AND ji.created_at >= to_char((now() AT TIME ZONE 'utc' - interval '24 hour'), 'YYYY-MM-DD HH24:MI:SS')
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

async function startServer(): Promise<void> {
  // Startup is a hard, read-only gate. Nothing may listen or start a background writer until the
  // migration ledger has been verified, otherwise a stale process gets a window to mutate data
  // before the asynchronous verification failure terminates it.
  await verifyStartupSchema();
  // Analytics workers never dispatch agents or mutate workflow status. Capture
  // stays active even when operational automation is disabled.
  startTelemetryCaptureWorker(getDb(), { onError: () => console.error('[telemetry] Observation projection failed; pending facts will retry.') });
  startTelemetryQueryWorker(getDb());

  const automationDisabled = process.env.AGENT_HQ_DISABLE_AUTOMATION === '1';
  if (automationDisabled) {
    console.warn('[boot] Background automation disabled by AGENT_HQ_DISABLE_AUTOMATION=1');
  } else {
    startScheduler();
    startWatchdog();
    startReconciler();
  }

  // Workflow heartbeat: check every 5 min for time/run-limit exceeded workflows
  setInterval(async () => {
    try { await checkWorkflowCompletion(); } catch (err) { console.error('[workflows] Heartbeat error:', err); }
  }, 5 * 60 * 1000);

  const server = http.createServer(app);

  console.log('[boot] http server created', { port: Number(PORT), host: HOST });

  // WebSocket proxy for chat (bridges browser → Gateway wss://)
  console.log('[boot] creating chat websocket server', { path: '/api/v1/chat/ws' });
  const wss = new WebSocketServer({
    server,
    path: '/api/v1/chat/ws',
    // The browser opens this socket straight against the API port, past the UI proxy, so it
    // authenticates with the UI's login cookie; see createWebSocketAuthenticator.
    verifyClient: createChatWebSocketVerifier(apiAuthConfig, allowedBrowserOrigins),
  });
  console.log('[boot] calling setupChatProxy');
  setupChatProxy(wss);
  console.log('[boot] setupChatProxy returned');

  console.log('[boot] about to server.listen', { port: Number(PORT), host: HOST });
  server.listen(Number(PORT), HOST, () => {
    const displayHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
    console.log(`Agent HQ API running on http://${displayHost}:${PORT}`);
  });
}

void startServer().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

export default app;
