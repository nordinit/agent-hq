import { AGENT_MCP_CAPABILITY_CATALOG } from '../lib/mcpApiAuth';

// The routing graph endpoints exist so an agent and the canvas reason over one
// representation. That only holds if the tools are actually registered AND the
// capability actually gates them — a capability with no enforcement is decorative,
// and a toggle that does nothing is worse than no toggle.

describe('routing graph MCP capability', () => {
  const capability = AGENT_MCP_CAPABILITY_CATALOG
    .find((entry) => entry.key === 'workflow.analyze_routing_graph');

  it('is registered under the Workflow access group', () => {
    expect(capability).toBeDefined();
    expect(capability?.group).toBe('Workflow');
    expect(capability?.label).toBe('Analyze routing graph');
  });

  it('covers every routing graph and trace endpoint', () => {
    // If a new trace route is added without listing it here, it silently falls through
    // to the admin.full_access default and the capability stops describing reality.
    expect(capability?.endpoints).toEqual(expect.arrayContaining([
      'GET /api/v1/routing/graph',
      'GET /api/v1/routing/trace',
      'POST /api/v1/routing/trace',
      'GET /api/v1/tasks/:id/trace',
    ]));
  });

  it('is off for scoped runtime keys and on for trusted admin keys', () => {
    // A graph spans a whole project and workflow type, not the agent's own task, so
    // ordinary task runtimes should not get it by default. Atlas-style trusted keys do.
    expect(capability?.defaultEnabled.scoped_runtime).toBe(false);
    expect(capability?.defaultEnabled.trusted_admin).toBe(true);
  });

  it('grants no write access', () => {
    expect(capability?.endpoints.every((endpoint) => endpoint.startsWith('GET ')
      || endpoint === 'POST /api/v1/routing/trace')).toBe(true);
  });
});

describe('routing graph MCP tools', () => {
  // Registration runs through the shared registrar, so assert against the catalog the
  // server actually publishes rather than the domain module's source.
  const loadCatalog = async () => {
    const { getMcpCatalog } = await import('./catalog');
    const { registerAgentHqMcpCatalog } = await import('./registerCatalog');
    registerAgentHqMcpCatalog();
    return getMcpCatalog();
  };

  it('publishes all four graph and trace tools', async () => {
    const catalog = await loadCatalog();
    const names = catalog.tools.map((tool) => tool.canonical_name);
    expect(names).toEqual(expect.arrayContaining([
      'agent_hq_get_routing_graph',
      'agent_hq_analyze_routing_graph',
      'agent_hq_trace_routing',
      'agent_hq_trace_task_path',
    ]));
  });

  it('publishes each graph tool under exactly one name', async () => {
    // Tools carry no aliases: one operation, one name. A second name would double the
    // definition every client loads for no capability it did not already have.
    const catalog = await loadCatalog();
    const graph = catalog.tools.find((tool) => tool.canonical_name === 'agent_hq_get_routing_graph');
    expect(graph?.aliases).toEqual([]);
  });

  it('requires a workflow type on the graph tools, since a graph is always type-scoped', async () => {
    const catalog = await loadCatalog();
    for (const name of ['agent_hq_get_routing_graph', 'agent_hq_analyze_routing_graph']) {
      const tool = catalog.tools.find((entry) => entry.canonical_name === name);
      const sprintType = tool?.args.find((arg) => arg.name === 'sprint_type');
      expect(sprintType?.required).toBe(true);
    }
  });

  it('requires from_status and outcome on the hypothetical trace', async () => {
    const catalog = await loadCatalog();
    const tool = catalog.tools.find((entry) => entry.canonical_name === 'agent_hq_trace_routing');
    const required = tool?.args.filter((arg) => arg.required).map((arg) => arg.name) ?? [];
    expect(required).toEqual(expect.arrayContaining(['sprint_type', 'from_status', 'outcome']));
  });

  it('maps each tool to the REST path it wraps', async () => {
    const catalog = await loadCatalog();
    const pathFor = (name: string) => catalog.tools
      .find((tool) => tool.canonical_name === name)?.rest_paths ?? [];
    expect(pathFor('agent_hq_get_routing_graph')).toContain('/api/v1/routing/graph');
    expect(pathFor('agent_hq_trace_routing')).toContain('/api/v1/routing/trace');
    expect(pathFor('agent_hq_trace_task_path')).toContain('/api/v1/tasks/:id/trace');
  });
});

// The canvas never writes a routing change without costing it first. Giving Atlas the write
// endpoints without the preview would hand it the sharp half of the contract and keep the
// safe half for people.

describe('routing config edit MCP capability', () => {
  const capability = AGENT_MCP_CAPABILITY_CATALOG
    .find((entry) => entry.key === 'workflow.edit_routing_config');

  it('is registered under the Workflow access group', () => {
    expect(capability).toBeDefined();
    expect(capability?.group).toBe('Workflow');
  });

  it('covers preview and audit', () => {
    expect(capability?.endpoints).toEqual(expect.arrayContaining([
      'POST /api/v1/routing/preview',
      'GET /api/v1/routing/audit',
    ]));
  });

  it('grants no writes of its own', () => {
    // Preview applies mutations inside a transaction that never commits, and audit is a read.
    // The actual write still needs routing_rules / routing_transitions /
    // transition_requirements manage_project_scope, which is what makes this safe to enable
    // wherever those already are.
    const writes = (capability?.endpoints ?? []).filter((endpoint) =>
      endpoint.startsWith('PUT ') || endpoint.startsWith('DELETE ')
      || (endpoint.startsWith('POST ') && endpoint !== 'POST /api/v1/routing/preview'));
    expect(writes).toEqual([]);
  });

  it('is off for scoped runtime keys and on for trusted admin keys', () => {
    expect(capability?.defaultEnabled.scoped_runtime).toBe(false);
    expect(capability?.defaultEnabled.trusted_admin).toBe(true);
  });

  it('does not overlap the analyze capability', () => {
    // Two capabilities claiming one endpoint means the guard's answer depends on which block
    // runs first, which is not something a permissions UI can explain.
    const analyze = AGENT_MCP_CAPABILITY_CATALOG
      .find((entry) => entry.key === 'workflow.analyze_routing_graph');
    const analyzeEndpoints = new Set<string>(analyze?.endpoints ?? []);
    const overlap = (capability?.endpoints ?? []).filter((endpoint) => analyzeEndpoints.has(endpoint));
    expect(overlap).toEqual([]);
  });
});

describe('routing config edit MCP tools', () => {
  const loadCatalog = async () => {
    const { getMcpCatalog } = await import('./catalog');
    const { registerAgentHqMcpCatalog } = await import('./registerCatalog');
    registerAgentHqMcpCatalog();
    return getMcpCatalog();
  };

  it('publishes the preview and audit tools under one name each', async () => {
    const catalog = await loadCatalog();
    const names = catalog.tools.map((tool) => tool.canonical_name);
    expect(names).toEqual(expect.arrayContaining([
      'agent_hq_preview_routing_change',
      'agent_hq_get_routing_audit',
    ]));
    const preview = catalog.tools.find((tool) => tool.canonical_name === 'agent_hq_preview_routing_change');
    expect(preview?.aliases ?? []).toEqual([]);
  });

  it('requires at least one operation on the preview', async () => {
    // An empty operations array would report "no rows written, no lint introduced", which
    // reads as a safe change rather than as no change at all.
    const catalog = await loadCatalog();
    const preview = catalog.tools.find((tool) => tool.canonical_name === 'agent_hq_preview_routing_change');
    expect(preview).toBeDefined();
    const operations = preview?.args.find((arg) => arg.name === 'operations');
    expect(operations).toBeDefined();
    expect(operations?.required).toBe(true);
  });

  it('maps each tool to the REST path it wraps', async () => {
    const catalog = await loadCatalog();
    const byName = new Map(catalog.tools.map((tool) => [tool.canonical_name, tool]));
    expect(byName.get('agent_hq_preview_routing_change')?.rest_paths).toEqual(['/api/v1/routing/preview']);
    expect(byName.get('agent_hq_get_routing_audit')?.rest_paths).toEqual(['/api/v1/routing/audit']);
  });
});
