'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  BookOpen,
  Boxes,
  CheckCircle2,
  ExternalLink,
  FileJson,
  KeyRound,
  Layers3,
  LockKeyhole,
  Network,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  TerminalSquare,
} from 'lucide-react';
import { api, type McpCatalog, type McpCatalogArg, type McpCatalogTool } from '@/lib/api';

type GroupedTools = {
  domain: string;
  tools: McpCatalogTool[];
};

const domainLabels: Record<string, string> = {
  project_files: 'Project Files',
  routing_rules: 'Assignment Rules',
  assignment_rules: 'Assignment Rules',
  routing_transitions: 'Routing Transitions',
  model_routing: 'Model Routing',
  task_definitions: 'Task Definitions',
  mcp_servers: 'MCP Servers',
};

function labelDomain(domain: string) {
  return domainLabels[domain] ?? domain
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function schemaType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'unknown';
  if (Array.isArray(schema.enum)) return 'enum';
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf
      .map((item) => schemaType(item as Record<string, unknown>))
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(' | ');
  }
  if (schema.type === 'array') {
    const itemType = schemaType((schema.items ?? {}) as Record<string, unknown>);
    return `${itemType}[]`;
  }
  if (schema.type === 'integer') return 'integer';
  if (typeof schema.type === 'string') return schema.type;
  return 'object';
}

function enumChoices(schema: Record<string, unknown> | undefined): string[] {
  if (!schema) return [];
  if (Array.isArray(schema.enum)) return schema.enum.map(String);
  if (Array.isArray(schema.anyOf)) {
    return schema.anyOf.flatMap((item) => enumChoices(item as Record<string, unknown>));
  }
  return [];
}

function objectNote(schema: Record<string, unknown> | undefined): string | null {
  if (!schema) return null;
  if (schema.type === 'object' && schema.additionalProperties) return 'Object payload';
  if (schema.type === 'array') return 'Array value';
  if (Array.isArray(schema.anyOf) && schema.anyOf.some((item) => (item as Record<string, unknown>).type === 'null')) {
    return 'Nullable';
  }
  return null;
}

function isTenantScoped(arg: McpCatalogArg) {
  return arg.name === 'tenant_id' || arg.description?.toLowerCase().includes('super-admin');
}

function ToolParameters({ tool }: { tool: McpCatalogTool }) {
  if (tool.args.length === 0) {
    return <p className="mt-4 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-sm text-slate-500">No parameters.</p>;
  }

  return (
    <div className="mt-4 space-y-3">
      {tool.args.map((arg) => {
        const choices = enumChoices(arg.schema);
        const note = objectNote(arg.schema);
        return (
          <div key={`${tool.canonical_name}-${arg.name}`} className="rounded-lg border border-slate-800 bg-slate-950/80 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-xs text-cyan-200">{arg.name}</code>
              <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{schemaType(arg.schema)}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                arg.required
                  ? 'bg-amber-500/10 text-amber-200 ring-1 ring-amber-500/25'
                  : 'bg-slate-700/60 text-slate-400 ring-1 ring-slate-600/60'
              }`}>
                {arg.required ? 'Required' : 'Optional'}
              </span>
              {isTenantScoped(arg) ? (
                <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-200 ring-1 ring-violet-500/25">
                  Super-admin caveat
                </span>
              ) : null}
              {note ? <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{note}</span> : null}
            </div>
            {arg.description ? <p className="mt-2 text-sm leading-6 text-slate-400">{arg.description}</p> : null}
            {choices.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {choices.map((choice) => (
                  <code key={choice} className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[11px] text-slate-300">
                    {choice}
                  </code>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ToolCard({ tool }: { tool: McpCatalogTool }) {
  return (
    <article id={tool.canonical_name} className="scroll-mt-6 rounded-lg border border-slate-800 bg-slate-900/80 p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <code className="break-all rounded bg-cyan-500/10 px-2 py-1 font-mono text-sm font-semibold text-cyan-200 ring-1 ring-cyan-500/20">
              {tool.canonical_name}
            </code>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{labelDomain(tool.domain)}</span>
          </div>
          <p className="mt-3 text-sm leading-6 text-slate-300">{tool.description}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-slate-950 px-2 py-1 text-slate-400 ring-1 ring-slate-800">
            {tool.args.length} param{tool.args.length === 1 ? '' : 's'}
          </span>
          {tool.rest_paths?.length ? (
            <span className="rounded-full bg-slate-950 px-2 py-1 text-slate-400 ring-1 ring-slate-800">
              {tool.rest_paths.length} backing path{tool.rest_paths.length === 1 ? '' : 's'}
            </span>
          ) : null}
        </div>
      </div>

      {tool.aliases.length > 0 ? (
        <div className="mt-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Aliases</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tool.aliases.map((alias) => (
              <code key={alias} className="rounded border border-slate-800 bg-slate-950 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
                {alias}
              </code>
            ))}
          </div>
        </div>
      ) : null}

      <ToolParameters tool={tool} />

      {tool.rest_paths?.length ? (
        <details className="mt-4 rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium text-slate-300">Backing API paths</summary>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tool.rest_paths.map((path) => (
              <code key={path} className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
                {path}
              </code>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

export default function McpDocsPage() {
  const [catalog, setCatalog] = useState<McpCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeDomain, setActiveDomain] = useState<string>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    api.getMcpCatalog()
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const grouped = useMemo<GroupedTools[]>(() => {
    const tools = catalog?.tools ?? [];
    const normalizedQuery = query.trim().toLowerCase();
    const filtered = tools.filter((tool) => {
      if (activeDomain !== 'all' && tool.domain !== activeDomain) return false;
      if (!normalizedQuery) return true;
      return [
        tool.canonical_name,
        tool.description,
        tool.domain,
        ...tool.aliases,
        ...tool.args.map((arg) => `${arg.name} ${arg.description ?? ''}`),
      ].some((value) => value.toLowerCase().includes(normalizedQuery));
    });
    const groups = new Map<string, McpCatalogTool[]>();
    for (const tool of filtered) {
      groups.set(tool.domain, [...(groups.get(tool.domain) ?? []), tool]);
    }
    return [...groups.entries()].map(([domain, toolsForDomain]) => ({ domain, tools: toolsForDomain }));
  }, [activeDomain, catalog?.tools, query]);

  const domains = catalog?.domains ?? [];
  const toolCount = catalog?.tools.length ?? 0;
  const resourceCount = catalog?.resources.length ?? 0;

  return (
    <div className="agent-hq-docs-reference flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950" data-tour-target="settings-mcp-main">
      <div className="border-b border-slate-800 bg-slate-950 px-4 py-4 md:px-6">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="max-w-4xl">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-200">
              <Server className="h-3.5 w-3.5" /> Built-in Agent HQ MCP Server
            </div>
            <h2 className="mt-3 text-2xl font-bold text-white md:text-3xl">Agent HQ MCP server docs</h2>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              The Agent HQ MCP server is the runtime-facing stdio bridge for typed Agent HQ tools and resources. Agents use it for lifecycle writes, task work, routing/admin reads, and tenant-scoped product operations without hand-building callback HTTP requests.
            </p>
          </div>
          <div className="grid gap-2 text-sm sm:grid-cols-3 xl:min-w-[28rem]">
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Tools</p>
              <p className="mt-1 text-2xl font-semibold text-white">{loading ? '-' : toolCount}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Resources</p>
              <p className="mt-1 text-2xl font-semibold text-white">{loading ? '-' : resourceCount}</p>
            </div>
            <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">Transport</p>
              <p className="mt-2 font-mono text-sm text-cyan-200">{catalog?.server.transport ?? 'stdio'}</p>
            </div>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="grid gap-6 p-4 xl:grid-cols-[18rem_1fr] md:p-6">
          <aside className="space-y-4 xl:sticky xl:top-0 xl:self-start">
            <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                <BookOpen className="h-4 w-4 text-cyan-300" /> Usage Model
              </h3>
              <ul className="mt-3 space-y-3 text-sm leading-6 text-slate-400">
                <li className="flex gap-2">
                  <TerminalSquare className="mt-1 h-4 w-4 flex-none text-cyan-300" />
                  Runtime-managed stdio server; no browser-exposed launch material.
                </li>
                <li className="flex gap-2">
                  <KeyRound className="mt-1 h-4 w-4 flex-none text-amber-300" />
                  Agent-bound MCP identity is issued and materialized outside this page.
                </li>
                <li className="flex gap-2">
                  <ShieldCheck className="mt-1 h-4 w-4 flex-none text-emerald-300" />
                  Normal access resolves to the agent tenant. Explicit cross-tenant selectors require super-admin policy.
                </li>
                <li className="flex gap-2">
                  <Layers3 className="mt-1 h-4 w-4 flex-none text-cyan-300" />
                  Task statuses and lifecycle outcomes come from workflow metadata; resolve them with agent_hq_get_workflow_metadata before relying on a value.
                </li>
              </ul>
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                <SlidersHorizontal className="h-4 w-4 text-cyan-300" /> Domains
              </h3>
              <div className="mt-3 space-y-1">
                <button
                  type="button"
                  onClick={() => setActiveDomain('all')}
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                    activeDomain === 'all' ? 'bg-cyan-500/10 text-cyan-200' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                  }`}
                >
                  <span>All Domains</span>
                  <span>{toolCount}</span>
                </button>
                {domains.map((domain) => {
                  const count = catalog?.tools.filter((tool) => tool.domain === domain).length ?? 0;
                  return (
                    <button
                      type="button"
                      key={domain}
                      onClick={() => setActiveDomain(domain)}
                      className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                        activeDomain === domain ? 'bg-cyan-500/10 text-cyan-200' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                      }`}
                    >
                      <span>{labelDomain(domain)}</span>
                      <span>{count}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                <ExternalLink className="h-4 w-4 text-cyan-300" /> Related Config
              </h3>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                External server registration remains under Capabilities &gt; MCP Servers.
              </p>
              <Link href="/capabilities" className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm font-medium text-slate-200 hover:border-cyan-500/60 hover:text-cyan-200">
                Open Capabilities <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </section>
          </aside>

          <main className="min-w-0 space-y-6">
            <section className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Network className="h-4 w-4 text-cyan-300" /> Purpose
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-400">
                  Typed MCP tools map agent actions to Agent HQ APIs with explicit parameter schemas and policy checks.
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <LockKeyhole className="h-4 w-4 text-amber-300" /> No Secrets
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-400">
                  This documentation renders names, schemas, and paths only. API keys, environment values, commands, and raw auth material are not displayed.
                </p>
              </div>
              <div className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
                <div className="flex items-center gap-2 text-sm font-semibold text-white">
                  <CheckCircle2 className="h-4 w-4 text-emerald-300" /> Tenant Scope
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-400">
                  Tenant-owned records stay in the resolved MCP identity scope. Arguments marked with super-admin caveats are rejected for normal tenant-bound MCP keys.
                </p>
              </div>
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
              <div className="flex items-start gap-3">
                <Layers3 className="mt-0.5 h-4 w-4 flex-none text-cyan-300" />
                <div>
                  <h3 className="font-semibold text-white">Dynamic Workflow Recipe</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-400">
                    Task statuses, outcomes, relationship types, and custom fields are workflow metadata. Workflow record lifecycle status is static board state; task status is workflow-configurable.
                  </p>
                </div>
              </div>
              <ol className="mt-4 grid gap-3 text-sm leading-6 text-slate-300 lg:grid-cols-2">
                {[
                  'Resolve tenant, project, task, and workflow context from the MCP identity and current task.',
                  'Call agent_hq_get_workflow_metadata with sprint_id, plus task_type when fields are task-type-specific.',
                  'Resolve custom fields with metadata or agent_hq_list_workflow_type_field_schemas before create/update.',
                  'Resolve dependency keys with agent_hq_get_task_relationship_types before creating task links.',
                  'Resolve outcome and gate evidence requirements before lifecycle writes.',
                  'Use dry_run on supported writes, then submit the real write with the validated payload.',
                ].map((step, index) => (
                  <li key={step} className="flex gap-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
                    <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-cyan-500/10 text-xs font-semibold text-cyan-200 ring-1 ring-cyan-500/25">
                      {index + 1}
                    </span>
                    <span>{step}</span>
                  </li>
                ))}
              </ol>
              <div className="mt-4 grid gap-4 xl:grid-cols-2">
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                  <h4 className="text-sm font-semibold text-white">Preferred transition path</h4>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    Use <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-cyan-200">agent_hq_post_task_outcome</code> for configurable workflow transitions. It validates outcome routes, gate evidence, and lifecycle semantics.
                  </p>
                  <pre className="mt-3 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-300"><code>{`{
  "task_id": 864,
  "outcome": "completed_for_review",
  "payload": {
    "review_branch": "feature/task-864",
    "review_commit": "abc1234"
  },
  "dry_run": true
}`}</code></pre>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                  <h4 className="text-sm font-semibold text-white">Compatibility path</h4>
                  <p className="mt-2 text-sm leading-6 text-slate-400">
                    <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-cyan-200">agent_hq_move_task</code> accepts a target status string for older callers and direct status moves. Resolve valid statuses from workflow metadata first.
                  </p>
                  <pre className="mt-3 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-300"><code>{`{
  "task_id": 864,
  "status": "review",
  "dry_run": true
}`}</code></pre>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
              <div className="flex items-start gap-3">
                <FileJson className="mt-0.5 h-4 w-4 flex-none text-cyan-300" />
                <div>
                  <h3 className="font-semibold text-white">Output Contracts</h3>
                  <p className="mt-1 text-sm leading-6 text-slate-400">
                    MCP tools return an <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-cyan-200">ok</code> envelope. Detail/context tools return full task state; write tools return the changed record or a mutation preview when <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-cyan-200">dry_run</code> is supported.
                  </p>
                </div>
              </div>
              <div className="mt-4 grid gap-4 xl:grid-cols-3">
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                  <h4 className="text-sm font-semibold text-white">Metadata</h4>
                  <pre className="mt-3 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-300"><code>{`{
  "ok": true,
  "data": {
    "workflow": {
      "id": 42,
      "workflow_type": "dev",
      "status": "active"
    },
    "task_statuses": [
      { "key": "ready", "label": "Ready" }
    ],
    "outcomes": [
      {
        "outcome_key": "completed_for_review",
        "to_status": "review",
        "required_fields": ["review_branch"]
      }
    ]
  }
}`}</code></pre>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                  <h4 className="text-sm font-semibold text-white">Relationship Types</h4>
                  <pre className="mt-3 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-300"><code>{`{
  "ok": true,
  "data": {
    "relationship_types": [
      {
        "key": "blocked_by",
        "direction_semantics": "target_blocks_source",
        "affects_dispatch_eligibility": true
      }
    ]
  }
}`}</code></pre>
                </div>
                <div className="rounded-lg border border-slate-800 bg-slate-950 p-4">
                  <h4 className="text-sm font-semibold text-white">Dry Run</h4>
                  <pre className="mt-3 overflow-x-auto rounded-lg border border-slate-800 bg-slate-900 p-3 text-xs leading-5 text-slate-300"><code>{`{
  "ok": true,
  "data": {
    "dry_run": true,
    "valid": false,
    "missing_required_fields": [
      "review_commit"
    ],
    "would_write": {
      "task_status": "review"
    }
  }
}`}</code></pre>
                </div>
              </div>
              <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950 p-4 text-sm leading-6 text-slate-400">
                Use relationship-first dependency tools for new automation: resolve with <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-cyan-200">agent_hq_get_task_relationship_types</code>, write with <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-cyan-200">agent_hq_create_task_relationship</code>, and treat <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-cyan-200">agent_hq_add_blocker</code> / <code className="rounded bg-slate-800 px-1 py-0.5 font-mono text-xs text-cyan-200">agent_hq_remove_blocker</code> as deprecated compatibility helpers.
              </div>
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 className="flex items-center gap-2 font-semibold text-white">
                    <Boxes className="h-4 w-4 text-cyan-300" /> MCP Resources
                  </h3>
                  <p className="mt-1 text-sm text-slate-400">Self-describing resource URIs exposed by the built-in Agent HQ MCP server.</p>
                </div>
                <code className="rounded bg-slate-950 px-2 py-1 font-mono text-xs text-slate-400">{catalog?.server.discoverability.catalog_endpoint ?? '/api/v1/mcp/catalog'}</code>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {(catalog?.resources ?? []).map((resource) => (
                  <div key={resource.id} className="rounded-lg border border-slate-800 bg-slate-950 p-3">
                    <code className="break-all font-mono text-xs text-cyan-200">{resource.uri}</code>
                    <p className="mt-2 text-sm leading-6 text-slate-400">{resource.description}</p>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/80 p-5">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <h3 className="flex items-center gap-2 font-semibold text-white">
                    <FileJson className="h-4 w-4 text-cyan-300" /> MCP Tool Inventory
                  </h3>
                  <p className="mt-1 text-sm text-slate-400">Complete catalog inventory with accepted parameters, required status, enum choices, and caveats.</p>
                </div>
                <label className="relative block lg:w-80">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search tools and parameters"
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-cyan-500/70"
                  />
                </label>
              </div>

              {loading ? (
                <div className="mt-5 flex h-40 items-center justify-center gap-2 text-sm text-slate-500">
                  <RefreshCw className="h-4 w-4 animate-spin" /> Loading MCP catalog...
                </div>
              ) : error ? (
                <div className="mt-5 flex items-start gap-3 rounded-lg border border-red-700/50 bg-red-950/30 p-4 text-sm text-red-200">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
                  <span>{error}</span>
                </div>
              ) : grouped.length === 0 ? (
                <div className="mt-5 rounded-lg border border-slate-800 bg-slate-950 p-6 text-center text-sm text-slate-500">
                  No MCP tools match the current filters.
                </div>
              ) : (
                <div className="mt-5 space-y-8">
                  {grouped.map((group) => (
                    <section key={group.domain} className="space-y-4">
                      <div className="flex items-center gap-3 border-b border-slate-800 pb-2">
                        <Layers3 className="h-4 w-4 text-cyan-300" />
                        <h4 className="font-semibold text-white">{labelDomain(group.domain)}</h4>
                        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{group.tools.length}</span>
                      </div>
                      <div className="space-y-4">
                        {group.tools.map((tool) => (
                          <ToolCard key={tool.canonical_name} tool={tool} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </section>
          </main>
        </div>
      </div>
    </div>
  );
}
