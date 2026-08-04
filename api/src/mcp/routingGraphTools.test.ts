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

  it('exposes atlas_ aliases alongside the agent_hq_ names', async () => {
    const catalog = await loadCatalog();
    const graph = catalog.tools.find((tool) => tool.canonical_name === 'agent_hq_get_routing_graph');
    expect(graph?.aliases).toEqual(expect.arrayContaining(['atlas_get_routing_graph']));
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
