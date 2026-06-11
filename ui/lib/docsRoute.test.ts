import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  API_DOCS_ROUTE,
  OPENAPI_DOCUMENT_PROXY_PATH,
  SELF_HOSTED_OPENAPI_SERVER_URL,
  withSelfHostedOpenApiServer,
} from './docsRoute.ts';
import { resolveSettingsRouteTarget } from './settingsRoute.ts';

test('docs route uses the same-origin OpenAPI proxy path', () => {
  assert.equal(API_DOCS_ROUTE, '/settings/api');
  assert.equal(OPENAPI_DOCUMENT_PROXY_PATH, '/api/v1/openapi.json');
  assert.equal(SELF_HOSTED_OPENAPI_SERVER_URL, '/api/v1');
  assert.ok(!OPENAPI_DOCUMENT_PROXY_PATH.startsWith('http'));
  assert.ok(!SELF_HOSTED_OPENAPI_SERVER_URL.startsWith('http'));
});

test('OpenAPI document normalization points the native console at the self-hosted UI proxy', () => {
  const document = withSelfHostedOpenApiServer({
    openapi: '3.0.3',
    servers: [{ url: 'https://example.invalid' }],
  });

  assert.deepEqual(document.servers, [
    {
      url: '/api/v1',
      description: 'Same-origin Agent HQ API proxy',
    },
  ]);
});

test('sidebar groups API docs under Settings instead of exposing top-level docs', () => {
  const source = readFileSync(join(process.cwd(), 'components/Sidebar.tsx'), 'utf8');

  assert.doesNotMatch(source, /label: 'API Docs'/);
  assert.match(source, /href: '\/settings', label: 'Settings'/);
  assert.match(source, /Display, providers, gateway, GitHub, logs, and API docs/);
});

test('untargeted settings navigation defaults to tenants', () => {
  const settingsPageSource = readFileSync(join(process.cwd(), 'app/settings/page.tsx'), 'utf8');
  const sidebarSource = readFileSync(join(process.cwd(), 'components/Sidebar.tsx'), 'utf8');
  const settingsLayoutSource = readFileSync(join(process.cwd(), 'app/settings/layout.tsx'), 'utf8');

  assert.match(settingsPageSource, /new URLSearchParams\(window\.location\.search\)\.get\('tab'\)/);
  assert.match(settingsPageSource, /resolveSettingsRouteTarget\(tab, window\.location\.hash\)/);
  assert.match(sidebarSource, /href: '\/settings', label: 'Settings'/);
  assert.match(settingsLayoutSource, /label: 'Tenants', href: '\/settings\/tenants'/);
  assert.match(settingsLayoutSource, /label: 'Display', href: '\/settings\/display'/);
});

test('explicit settings query and hash tab targets are preserved', () => {
  assert.equal(resolveSettingsRouteTarget(null), '/settings/tenants');
  assert.equal(resolveSettingsRouteTarget('providers'), '/settings/providers');
  assert.equal(resolveSettingsRouteTarget('display'), '/settings/display');
  assert.equal(resolveSettingsRouteTarget('mcp'), '/settings/mcp');
  assert.equal(resolveSettingsRouteTarget(null, '#providers'), '/settings/providers');
  assert.equal(resolveSettingsRouteTarget(null, 'display'), '/settings/display');
  assert.equal(resolveSettingsRouteTarget('unknown', '#github'), '/settings/github');
  assert.equal(resolveSettingsRouteTarget('unknown', '#unknown'), '/settings/tenants');
});

test('logs are grouped under Settings and legacy route redirects', () => {
  const sidebarSource = readFileSync(join(process.cwd(), 'components/Sidebar.tsx'), 'utf8');
  const settingsLayoutSource = readFileSync(join(process.cwd(), 'app/settings/layout.tsx'), 'utf8');
  const settingsLogsPageSource = readFileSync(join(process.cwd(), 'app/settings/logs/page.tsx'), 'utf8');
  const legacyLogsPageSource = readFileSync(join(process.cwd(), 'app/logs/page.tsx'), 'utf8');
  const dashboardSource = readFileSync(join(process.cwd(), 'features/dashboard/DashboardPage.tsx'), 'utf8');

  assert.match(settingsLayoutSource, /label: 'Logs', href: '\/settings\/logs'/);
  assert.match(settingsLogsPageSource, /@\/features\/observability\/LogsPage/);
  assert.match(legacyLogsPageSource, /redirect\('\/settings\/logs'\)/);
  assert.match(dashboardSource, /href: '\/settings\/logs', label: 'Execution Logs'/);
  assert.doesNotMatch(sidebarSource, /href: '\/logs', label: 'Logs'/);
});

test('settings API docs route uses the full-height docs surface', () => {
  const mainContentSource = readFileSync(join(process.cwd(), 'components/MainContent.tsx'), 'utf8');
  const settingsLayoutSource = readFileSync(join(process.cwd(), 'app/settings/layout.tsx'), 'utf8');
  const settingsApiPageSource = readFileSync(join(process.cwd(), 'app/settings/api/page.tsx'), 'utf8');
  const docsPageSource = readFileSync(join(process.cwd(), 'features/api-docs-page.tsx'), 'utf8');
  const legacyDocsPageSource = readFileSync(join(process.cwd(), 'app/docs/page.tsx'), 'utf8');
  const globalCss = readFileSync(join(process.cwd(), 'app/globals.css'), 'utf8');
  const packageJson = readFileSync(join(process.cwd(), 'package.json'), 'utf8');
  const packageLock = readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8');

  assert.match(legacyDocsPageSource, /redirect\(API_DOCS_ROUTE\)/);
  assert.match(mainContentSource, /isDocsRoute \? 'overflow-y-auto' : 'overflow-y-auto md:overflow-hidden'/);
  assert.match(settingsLayoutSource, /const isApiTab = pathname === '\/settings\/api'/);
  assert.match(settingsLayoutSource, /flex min-h-full flex-col p-4 md:p-5/);
  assert.match(settingsLayoutSource, /mt-4 flex min-h-0 flex-col/);
  assert.match(settingsApiPageSource, /flex min-h-full flex-col rounded-lg/);
  assert.match(docsPageSource, /Agent HQ API Console/);
  assert.match(docsPageSource, /summarizeOpenApiDocument/);
  assert.match(docsPageSource, /buildApiOperations/);
  assert.match(docsPageSource, /getFeaturedDocGroups/);
  assert.match(docsPageSource, /docs-mobile-group-nav/);
  assert.match(docsPageSource, /docs-mobile-mode/);
  assert.match(docsPageSource, /h-\[calc\(var\(--app-viewport-height\)-9rem\)\] min-h-\[34rem\] flex-col overflow-hidden md:grid/);
  assert.match(docsPageSource, /min-h-0 flex-1 overflow-y-auto bg-slate-950/);
  assert.match(docsPageSource, /overflow-x-auto rounded-lg border border-slate-700/);
  assert.match(docsPageSource, /OperationDetail/);
  assert.match(docsPageSource, /mobileMode === 'detail'/);
  assert.doesNotMatch(docsPageSource, /ApiReferenceReact/);
  assert.doesNotMatch(packageJson, /@scalar\/api-reference-react/);
  assert.doesNotMatch(packageLock, /@scalar\/api-reference-react/);
  assert.doesNotMatch(globalCss, /--scalar-/);
  assert.doesNotMatch(globalCss, /references-layout/);
  assert.match(globalCss, /\.agent-hq-docs-reference \.docs-mobile-group-nav/);
});

test('settings MCP route is discoverable and does not render sensitive MCP launch fields', () => {
  const settingsLayoutSource = readFileSync(join(process.cwd(), 'app/settings/layout.tsx'), 'utf8');
  const settingsMcpPageSource = readFileSync(join(process.cwd(), 'app/settings/mcp/page.tsx'), 'utf8');
  const mcpDocsPageSource = readFileSync(join(process.cwd(), 'features/mcp-docs-page.tsx'), 'utf8');

  assert.match(settingsLayoutSource, /label: 'MCP', href: '\/settings\/mcp'/);
  assert.match(settingsMcpPageSource, /data-tour-target="settings-mcp-main"/);
  assert.match(settingsMcpPageSource, /@\/features\/mcp-docs-page/);
  assert.match(mcpDocsPageSource, /Agent HQ MCP server docs/);
  assert.match(mcpDocsPageSource, /Capabilities &gt; MCP Servers/);
  assert.match(mcpDocsPageSource, /api\.getMcpCatalog\(\)/);
  assert.match(mcpDocsPageSource, /Required/);
  assert.match(mcpDocsPageSource, /Optional/);
  assert.match(mcpDocsPageSource, /Super-admin caveat/);
  assert.match(mcpDocsPageSource, /enumChoices/);
  assert.match(mcpDocsPageSource, /MCP Resources/);
  assert.match(mcpDocsPageSource, /MCP Tool Inventory/);
  assert.doesNotMatch(mcpDocsPageSource, /api\.getMcpServers\(\)/);
  assert.doesNotMatch(mcpDocsPageSource, /server\.env/);
  assert.doesNotMatch(mcpDocsPageSource, /server\.args/);
  assert.doesNotMatch(mcpDocsPageSource, /server\.command/);
  assert.doesNotMatch(mcpDocsPageSource, /server\.cwd/);
  assert.doesNotMatch(mcpDocsPageSource, /AGENT_HQ_MCP_API_KEY/);
});
