import {ACCESS_CAPABILITIES} from './capabilities';

export type AgentMcpDefaultPolicy = 'scoped_runtime' | 'trusted_admin';

export interface AgentMcpCapabilityDefinition {
  key: string;
  group: string;
  label: string;
  description: string;
  endpoints: readonly string[];
  defaultEnabled: Record<AgentMcpDefaultPolicy, boolean>;
}

export const AGENT_MCP_CAPABILITY_CATALOG = [
  ...ACCESS_CAPABILITIES,
  {
    key: 'telemetry.read', group: 'Telemetry', label: 'Read project telemetry',
    description: 'Read the canonical telemetry catalog, saved metrics/profiles/reports, bindings, coverage, retained results and contributors within the credential agent\'s assigned project and tenant. Rechecks source access for retained results; does not run queries or change definitions.',
    endpoints: ['GET /api/v1/telemetry/v2/catalog', 'GET /api/v1/telemetry/v2/catalog/routing', 'GET /api/v1/telemetry/v2/metrics', 'GET /api/v1/telemetry/v2/metrics/:id', 'GET /api/v1/telemetry/v2/profiles', 'GET /api/v1/telemetry/v2/profiles/:id', 'GET /api/v1/telemetry/v2/dashboards', 'GET /api/v1/telemetry/v2/dashboards/:id', 'GET /api/v1/telemetry/v2/reports', 'GET /api/v1/telemetry/v2/reports/:id', 'GET /api/v1/telemetry/v2/bindings', 'GET /api/v1/telemetry/v2/queries/:id', 'GET /api/v1/telemetry/v2/queries/:id/contributors', 'GET /api/v1/telemetry/v2/reports/:id/snapshots', 'GET /api/v1/telemetry/v2/snapshots', 'GET /api/v1/telemetry/v2/coverage', 'GET /api/v1/telemetry/v2/backfills', 'GET /api/v1/telemetry/v2/settings'],
    defaultEnabled: { scoped_runtime: false, trusted_admin: true },
  },
  {
    key: 'telemetry.query', group: 'Telemetry', label: 'Calculate project telemetry',
    description: 'Validate, preview, calculate and cancel bounded telemetry queries in the assigned project using the same evaluator as the UI. Definitions, component references, filters, groups and retained evidence remain tenant/project authorized.',
    endpoints: ['POST /api/v1/telemetry/v2/definitions/validate', 'POST /api/v1/telemetry/v2/queries/preview', 'POST /api/v1/telemetry/v2/queries', 'DELETE /api/v1/telemetry/v2/queries/:id'],
    defaultEnabled: { scoped_runtime: false, trusted_admin: true },
  },
  {
    key: 'telemetry.manage_metrics', group: 'Telemetry', label: 'Manage project metrics and profiles',
    description: 'Create immutable metric/profile revisions and scoped bindings, and archive definitions inside the assigned project. Does not change task schemas, values, routing rules or runtime behavior. Importing a package also requires telemetry.manage_reports.',
    endpoints: ['POST /api/v1/telemetry/v2/metrics', 'POST /api/v1/telemetry/v2/metrics/:id/revisions', 'DELETE /api/v1/telemetry/v2/metrics/:id', 'POST /api/v1/telemetry/v2/profiles', 'POST /api/v1/telemetry/v2/profiles/:id/revisions', 'DELETE /api/v1/telemetry/v2/profiles/:id', 'PUT /api/v1/telemetry/v2/bindings', 'POST /api/v1/telemetry/v2/import'],
    defaultEnabled: { scoped_runtime: false, trusted_admin: true },
  },
  {
    key: 'telemetry.manage_reports', group: 'Telemetry', label: 'Manage project telemetry reports',
    description: 'Create immutable saved report revisions, freeze retained results as report snapshots and archive reports within the assigned project. Importing a package also requires telemetry.manage_metrics. Does not grant telemetry maintenance, retention changes or workflow edits.',
    endpoints: ['POST /api/v1/telemetry/v2/dashboards', 'POST /api/v1/telemetry/v2/dashboards/:id/revisions', 'DELETE /api/v1/telemetry/v2/dashboards/:id', 'POST /api/v1/telemetry/v2/reports', 'POST /api/v1/telemetry/v2/reports/:id/revisions', 'DELETE /api/v1/telemetry/v2/reports/:id', 'POST /api/v1/telemetry/v2/reports/:id/snapshots', 'POST /api/v1/telemetry/v2/import'],
    defaultEnabled: { scoped_runtime: false, trusted_admin: true },
  },
  {
    key: 'telemetry.export', group: 'Telemetry', label: 'Export project telemetry definitions',
    description: 'Export authorized metric/profile/report definitions and their canonical references for explicit destination remapping. This grant does not export another project\'s records or activate imported definitions.',
    endpoints: ['POST /api/v1/telemetry/v2/export'],
    defaultEnabled: { scoped_runtime: false, trusted_admin: true },
  },
  {
    key: 'discovery.read_catalog',
    group: 'Discovery',
    label: 'Read MCP catalog',
    description: 'Allows the Agent HQ MCP catalog and health endpoints used for capability discovery.',
    endpoints: [
      'GET /api/v1/mcp/catalog',
      'GET /api/v1/mcp/catalog/health',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.read_active_context',
    group: 'Task lifecycle',
    label: 'Read active task context',
    description: 'Allows reads for the agent\'s currently dispatched task, including context, notes, history, relationship inspection, and instance linkage.',
    endpoints: [
      'GET /api/v1/tasks/:id',
      'GET /api/v1/tasks/:id/context',
      'GET /api/v1/tasks/:id/notes',
      'GET /api/v1/tasks/:id/history',
      'GET /api/v1/tasks/:id/instances',
      'GET /api/v1/tasks/:id/relationships',
      'GET /api/v1/tasks/:id/relationship-types',
      'GET /api/v1/tasks/:id/active-owner',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.read_project_context',
    group: 'Task lifecycle',
    label: 'Read project task context',
    description: 'Allows read-only access to task detail, canonical context, notes, history, run state, active-owner context, relationships, and relationship types for tasks in the agent\'s assigned project. The project scope comes from the agent identity, not caller-supplied parameters. Does not allow task writes, relationship mutation, admin routes, tenant-wide reads, or cross-tenant access.',
    endpoints: [
      'GET /api/v1/tasks/:id',
      'GET /api/v1/tasks/:id/context',
      'GET /api/v1/tasks/:id/notes',
      'GET /api/v1/tasks/:id/history',
      'GET /api/v1/tasks/:id/instances',
      'GET /api/v1/tasks/:id/relationships',
      'GET /api/v1/tasks/:id/relationship-types',
      'GET /api/v1/tasks/:id/active-owner',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.search_project_tasks',
    group: 'Task lifecycle',
    label: 'Search project tasks',
    description: 'Allows bounded read-only task search for exact deduplication within the agent\'s assigned project. The project scope is derived from the MCP agent identity, not caller-supplied parameters. Results are minimal summaries and do not allow task mutation, lifecycle writes, relationship mutation, tenant-wide listing, or cross-project discovery.',
    endpoints: [
      'POST /api/v1/tasks/project-search',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.write_active_custom_fields',
    group: 'Task lifecycle',
    label: 'Update own active task custom fields',
    description: 'Allows an agent that owns the active dispatched run to persist supported custom fields on that task, and nothing else. The request body may carry only custom_fields (plus changed_by); any attempt to change status, title, assignment, or other task columns is refused. Workflow field-schema validation, tenant scope, and audit history still apply. Does not allow edits to any other task, cross-project or cross-tenant writes, or the broad project task management routes.',
    endpoints: [
      'PUT /api/v1/tasks/:id',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.write_active_lifecycle',
    group: 'Task lifecycle',
    label: 'Write active task lifecycle',
    description: 'Allows lifecycle notes, evidence, outcomes, and instance start/check-in callbacks for the active dispatched task.',
    endpoints: [
      'POST /api/v1/tasks/:id/notes',
      'PUT /api/v1/tasks/:id/review-evidence',
      'PUT /api/v1/tasks/:id/qa-evidence',
      'PUT /api/v1/tasks/:id/deploy-evidence',
      'PUT /api/v1/tasks/:id/live-verification',
      'POST /api/v1/tasks/:id/outcome',
      'PUT /api/v1/instances/:id/start',
      'POST /api/v1/instances/:id/check-in',
      'PUT /api/v1/instances/:id/complete',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.write_project_lifecycle',
    group: 'Task lifecycle',
    label: 'Write project task lifecycle',
    description: 'Allows notes, evidence, and configured outcomes on any task in the MCP agent\'s assigned project and tenant, without owning its active run. Project-wide outcomes require a nonblank summary/reason and record the authenticated actor and capability in task history. Workflow transitions and evidence gates still apply. Does not grant generic status edits, admin overrides, or callbacks for another agent\'s run.',
    endpoints: [
      'POST /api/v1/tasks/:id/notes',
      'PUT /api/v1/tasks/:id/review-evidence',
      'PUT /api/v1/tasks/:id/qa-evidence',
      'PUT /api/v1/tasks/:id/deploy-evidence',
      'PUT /api/v1/tasks/:id/live-verification',
      'POST /api/v1/tasks/:id/outcome',
    ],
    defaultEnabled: { scoped_runtime: false, trusted_admin: true },
  },
  {
    key: 'tasks.create',
    group: 'Task lifecycle',
    label: 'Create Tasks',
    description: 'Legacy scoped create capability. Allows creating new Agent HQ tasks only inside the MCP agent\'s assigned project and tenant. Prefer Project task CRUD for create/read/update/delete access.',
    endpoints: [
      'POST /api/v1/tasks',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.manage_project_tasks',
    group: 'Task lifecycle',
    label: 'Project task CRUD',
    description: 'Allows creating, reading, updating, and deleting generic tasks and workflow-configured task relationships only inside the MCP agent\'s assigned project and tenant. Project scope is resolved from the agent identity and validated against project_id, workflow_id, relationship peer tasks, target task project, and assignment agent_id. Does not allow active-task lifecycle writes, admin outcomes, cross-project edits, cross-tenant access, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/tasks/:id',
      'POST /api/v1/tasks',
      'PUT /api/v1/tasks/:id',
      'DELETE /api/v1/tasks/:id',
      'POST /api/v1/tasks/:id/relationships',
      'DELETE /api/v1/tasks/:id/relationships/:relationshipId',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'tasks.write_project_notes',
    group: 'Task lifecycle',
    label: 'Write notes on project tasks',
    description: 'Allows adding notes to any task in the MCP agent\'s assigned project, without owning a dispatched run on it. Notes only: project-wide evidence and outcomes require tasks.write_project_lifecycle; run callbacks require tasks.write_active_lifecycle. This grants no task CRUD or relationship access.',
    endpoints: [
      'POST /api/v1/tasks/:id/notes',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'routing_rules.read_project_scope',
    group: 'Workflow',
    label: 'Read project assignment rules',
    description: 'Allows reading assignment/routing rules only inside the MCP agent\'s assigned project and tenant. Does not allow rule creation, updates, deletion, or cross-project access.',
    endpoints: [
      'GET /api/v1/routing/rules',
      'GET /api/v1/routing/rules/:id',
      'GET /api/v1/routing/assignment-rules',
      'GET /api/v1/routing/assignment-rules/:id',
      'GET /api/v1/routing-rules',
      'GET /api/v1/routing-rules/:id',
      'GET /api/v1/assignment-rules',
      'GET /api/v1/assignment-rules/:id',
    ],
    defaultEnabled: { scoped_runtime: false, trusted_admin: true },
  },
  {
    key: 'routing_rules.manage_project_scope',
    group: 'Workflow',
    label: 'Manage project assignment rules',
    description: 'Allows reading, creating, updating, and deleting task assignment/routing rules only inside the MCP agent\'s assigned project and tenant. Does not allow all-project defaults, cross-project edits, cross-tenant edits, workflow transition changes, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/routing/rules',
      'GET /api/v1/routing/rules/:id',
      'POST /api/v1/routing/rules',
      'PUT /api/v1/routing/rules/:id',
      'DELETE /api/v1/routing/rules/:id',
      'GET /api/v1/routing/assignment-rules',
      'GET /api/v1/routing/assignment-rules/:id',
      'POST /api/v1/routing/assignment-rules',
      'PUT /api/v1/routing/assignment-rules/:id',
      'DELETE /api/v1/routing/assignment-rules/:id',
      'GET /api/v1/routing-rules',
      'GET /api/v1/routing-rules/:id',
      'POST /api/v1/routing-rules',
      'PUT /api/v1/routing-rules/:id',
      'DELETE /api/v1/routing-rules/:id',
      'GET /api/v1/assignment-rules',
      'GET /api/v1/assignment-rules/:id',
      'POST /api/v1/assignment-rules',
      'PUT /api/v1/assignment-rules/:id',
      'DELETE /api/v1/assignment-rules/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'routing_transitions.manage_project_scope',
    group: 'Workflow',
    label: 'Manage project workflow transitions',
    description: 'Allows reading, creating, updating, and deleting automatic workflow transition rows only inside the MCP agent\'s assigned project and tenant, including workflow-type defaults and workflow-specific overrides. Does not allow assignment-rule edits, workflow-definition edits, transition requirement edits, cross-project edits, cross-tenant edits, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/routing/transitions',
      'GET /api/v1/routing/transitions/:id',
      'POST /api/v1/routing/transitions',
      'PUT /api/v1/routing/transitions/:id',
      'DELETE /api/v1/routing/transitions/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'projects.read_active_project',
    group: 'Context',
    label: 'Read active project',
    description: 'Allows reading the project attached to the active dispatched task.',
    endpoints: [
      'GET /api/v1/projects/:id',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'projects.read_project_board',
    group: 'Context',
    label: 'Read project board',
    description: 'Allows the collection reads a board view needs: the tenant project list, and task, workflow, and workflow-metadata listings scoped to the MCP agent\'s assigned project. Task, workflow, and metadata reads must name the assigned project (or a workflow inside it) explicitly and are refused otherwise, so this cannot enumerate another project\'s work. Grants no writes. Intended for remote/read-first clients — a phone connector needs to list a board, which every other read capability deliberately scopes to a single record or to the agent\'s own dispatched task.',
    endpoints: [
      'GET /api/v1/projects',
      'GET /api/v1/tasks',
      'GET /api/v1/workflows',
      'GET /api/v1/workflows/workflow-metadata',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'projects.manage_active_files',
    group: 'Context',
    label: 'Manage active project files',
    description: 'Allows listing, reading, uploading, downloading, replacing, and deleting files on the project attached to the active dispatched task.',
    endpoints: [
      'GET /api/v1/projects/:id/files',
      'POST /api/v1/projects/:id/files',
      'GET /api/v1/projects/:id/files/:fileId',
      'GET /api/v1/projects/:id/files/:fileId/download',
      'GET /api/v1/projects/:id/files/:fileId/versions',
      'PUT /api/v1/projects/:id/files/:fileId',
      'DELETE /api/v1/projects/:id/files/:fileId',
      'GET /api/v1/projects/:projectId/workflows/:workflowId/files',
      'POST /api/v1/projects/:projectId/workflows/:workflowId/files',
      'GET /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId',
      'GET /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId/download',
      'GET /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId/versions',
      'PUT /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId',
      'DELETE /api/v1/projects/:projectId/workflows/:workflowId/files/:fileId',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'workflows.read_active_workflow',
    group: 'Context',
    label: 'Read active workflow',
    description: 'Allows reading the workflow attached to the active dispatched task.',
    endpoints: [
      'GET /api/v1/workflows/:id',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'agents.manage_project_agents',
    group: 'Context',
    label: 'Manage project agents',
    description: 'Allows listing, reading, creating, updating and deleting agents inside the MCP agent\'s assigned project and tenant, including their job instructions, role, model, skills and routing configuration, and their docs bundle. Refuses any create or update touching system_role, tenant_id or session_key, or naming the Atlas identity, because those still bind an agent\'s identity elsewhere in the product; MCP authority itself comes from the presented key\'s role and cannot be written through this API at all. Also refuses changing anything that decides what runs on the host, where, or with which credentials: workspace_path, runtime_type (after creation), the remote gateway URL and auth header, os_user, github_identity_id, provision_openclaw, and every runtime_config key other than model, effort, reasoningEffort, fastMode, provider, systemPromptSuffix, maxTurns and maxBudgetUsd; those may only be sent unchanged. project_id must name the assigned project, so this cannot move an agent between projects or reach one outside it. Does not allow provisioning, workspace or MCP sync, capability-policy edits, or tool allowlists.',
    endpoints: [
      'GET /api/v1/agents',
      'POST /api/v1/agents',
      'GET /api/v1/agents/:id',
      'PUT /api/v1/agents/:id',
      'DELETE /api/v1/agents/:id',
      'GET /api/v1/agents/:id/docs',
      'GET /api/v1/agents/:id/resolution',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflows.pause_active_workflow',
    group: 'Context',
    label: 'Pause and resume workflow',
    description: 'Allows moving a workflow between the non-terminal lifecycle statuses — planning, active, and paused — for the workflow attached to the MCP agent\'s active dispatched task, or, for a board-scoped client, any workflow inside its assigned project. The request body may carry nothing but status and an optional note: a patch that also touches name, goal, dates, repo configuration, or project_id is refused, so this cannot be used to reassign or reconfigure a workflow. Reversible by construction; it stamps no end date and stands down no agents. Does not allow completing or closing a workflow — that is workflows.complete_active_workflow.',
    endpoints: [
      'PUT /api/v1/workflows/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflows.complete_active_workflow',
    group: 'Context',
    label: 'Complete and close workflow',
    description: 'Allows ending an operating cycle — completing or closing the workflow attached to the MCP agent\'s active dispatched task, or, for a board-scoped client, any workflow inside its assigned project. Completing stamps ended_at and disables the workflow\'s agents; both write an audited status change naming the agent that asked. Held separately from workflows.pause_active_workflow because this is terminal for the cycle while pausing is reversible: an agent that may say "hold on" does not thereby get to say "this is finished". Reopening a completed or closed workflow needs workflows.pause_active_workflow.',
    endpoints: [
      'POST /api/v1/workflows/:id/complete',
      'POST /api/v1/workflows/:id/close',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow.read_active_configuration',
    group: 'Workflow',
    label: 'Read active workflow configuration',
    description: 'Allows reading workflow transitions and transition requirements for the active task\'s workflow and project.',
    endpoints: [
      'GET /api/v1/routing/transitions',
      'GET /api/v1/routing/transition-requirements',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow.analyze_routing_graph',
    group: 'Workflow',
    label: 'Analyze routing graph',
    description: 'Allows reading the routing configuration as a derived state machine — status nodes, transition edges, gate requirements, assigned agents and structural lint findings — plus hypothetical traces ("what happens on this outcome") and replays of a task\'s status history against that graph. Read-only analysis: it grants no ability to change rules, transitions, requirements or task state. Off by default for scoped runtime keys, because a graph spans a whole project and workflow type rather than the agent\'s own task.',
    endpoints: [
      'GET /api/v1/routing/graph',
      'GET /api/v1/routing/trace',
      'POST /api/v1/routing/trace',
      'GET /api/v1/tasks/:id/trace',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow.edit_routing_config',
    group: 'Workflow',
    label: 'Edit routing config with preview and audit',
    description: 'Allows costing a routing change before making it and reading the routing config audit trail — the same contract the canvas gives a person. POST /routing/preview applies the real mutation inside a transaction that never commits and reports what it touched: rows written per table, how many workflows it reaches, and the lint findings it introduces or resolves. That last part is what makes it worth granting: gate resolution replaces rather than accumulates across task types, so a change can silently drop the gates it looks like it is adding to, and the preview is the only place that shows it before the change lands. This capability grants no writes on its own — the write itself still needs routing_rules, routing_transitions or transition_requirements manage_project_scope — so it is safe to enable wherever those already are.',
    endpoints: [
      'POST /api/v1/routing/preview',
      'GET /api/v1/routing/audit',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow_definitions.read_project_scope',
    group: 'Workflow',
    label: 'Read project workflow definitions',
    description: 'Allows reading a whole workflow definition — the type, its task types, field schemas, statuses, outcomes, and relationship types — when it exists in the MCP agent\'s tenant and was created for or is used by a workflow in the assigned project. Shared definitions are accessible to each project using them. Does not allow unused tenant-wide definitions, global definitions, cross-tenant access, or mutations.',
    endpoints: [
      'GET /api/v1/workflows/config',
      'GET /api/v1/workflows/types/list',
      'GET /api/v1/workflows/types/:key',
      'GET /api/v1/workflows/types/:key/task-types',
      'GET /api/v1/workflows/types/:key/field-schemas',
      'GET /api/v1/workflows/types/:key/field-schemas/:schemaId',
      'GET /api/v1/workflows/types/:key/statuses',
      'GET /api/v1/workflows/types/:key/statuses/:statusKey',
      'GET /api/v1/workflows/types/:key/outcomes',
      'GET /api/v1/workflows/types/:key/outcomes/:outcomeId',
      'GET /api/v1/workflows/types/:key/relationship-types',
      'GET /api/v1/workflows/types/:key/relationship-types/:relationshipTypeId',
      'GET /api/v1/workflow-definitions/config',
      'GET /api/v1/workflow-definitions/types',
      'GET /api/v1/workflow-definitions/types/:key',
      'GET /api/v1/workflow-definitions/types/:key/task-types',
      'GET /api/v1/workflow-definitions/types/:key/field-schemas',
      'GET /api/v1/workflow-definitions/types/:key/field-schemas/:schemaId',
      'GET /api/v1/workflow-definitions/types/:key/statuses',
      'GET /api/v1/workflow-definitions/types/:key/statuses/:statusKey',
      'GET /api/v1/workflow-definitions/types/:key/outcomes',
      'GET /api/v1/workflow-definitions/types/:key/outcomes/:outcomeId',
      'GET /api/v1/workflow-definitions/types/:key/relationship-types',
      'GET /api/v1/workflow-definitions/types/:key/relationship-types/:relationshipTypeId',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'workflow_definitions.manage_project_scope',
    group: 'Workflow',
    label: 'Edit project workflow definitions',
    description: 'Allows creating workflow definitions for the assigned project and updating or deleting every part of a definition in the MCP agent\'s tenant when it was created for or is used by a workflow in that project. Covers task types, field schemas, statuses and their metadata, outcomes, and relationship types. Edits to shared definitions affect every project using them. Statuses and outcomes shape the transition graph, so this grants authority over how work flows. Does not allow unused tenant-wide definitions, global definitions, cross-tenant edits, or unrelated admin routes.',
    endpoints: [
      'POST /api/v1/workflows/types',
      'PUT /api/v1/workflows/types/:key',
      'DELETE /api/v1/workflows/types/:key',
      'PUT /api/v1/workflows/types/:key/task-types',
      'POST /api/v1/workflows/types/:key/field-schemas',
      'PUT /api/v1/workflows/types/:key/field-schemas/:schemaId',
      'DELETE /api/v1/workflows/types/:key/field-schemas/:schemaId',
      'POST /api/v1/workflows/types/:key/statuses',
      'PUT /api/v1/workflows/types/:key/statuses/:statusKey',
      'DELETE /api/v1/workflows/types/:key/statuses/:statusKey',
      'POST /api/v1/workflows/types/:key/outcomes',
      'PUT /api/v1/workflows/types/:key/outcomes/:outcomeId',
      'DELETE /api/v1/workflows/types/:key/outcomes/:outcomeId',
      'POST /api/v1/workflows/types/:key/relationship-types',
      'PUT /api/v1/workflows/types/:key/relationship-types/:relationshipTypeId',
      'DELETE /api/v1/workflows/types/:key/relationship-types/:relationshipTypeId',
      'POST /api/v1/workflow-definitions/types',
      'PUT /api/v1/workflow-definitions/types/:key',
      'DELETE /api/v1/workflow-definitions/types/:key',
      'PUT /api/v1/workflow-definitions/types/:key/task-types',
      'POST /api/v1/workflow-definitions/types/:key/field-schemas',
      'PUT /api/v1/workflow-definitions/types/:key/field-schemas/:schemaId',
      'DELETE /api/v1/workflow-definitions/types/:key/field-schemas/:schemaId',
      'POST /api/v1/workflow-definitions/types/:key/statuses',
      'PUT /api/v1/workflow-definitions/types/:key/statuses/:statusKey',
      'DELETE /api/v1/workflow-definitions/types/:key/statuses/:statusKey',
      'POST /api/v1/workflow-definitions/types/:key/outcomes',
      'PUT /api/v1/workflow-definitions/types/:key/outcomes/:outcomeId',
      'DELETE /api/v1/workflow-definitions/types/:key/outcomes/:outcomeId',
      'POST /api/v1/workflow-definitions/types/:key/relationship-types',
      'PUT /api/v1/workflow-definitions/types/:key/relationship-types/:relationshipTypeId',
      'DELETE /api/v1/workflow-definitions/types/:key/relationship-types/:relationshipTypeId',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'recurring_task_series.read_project_scope',
    group: 'Recurring tasks',
    label: 'Read project recurring task series',
    description: 'Allows read-only access to recurring task series, their generated-run history, and schedule previews only inside the MCP agent\'s assigned project and tenant. Schedule previews are non-mutating. Does not allow creating, editing, enabling, disabling, running, or deleting series, and does not allow tenant-wide, cross-project, or cross-tenant reads.',
    endpoints: [
      'GET /api/v1/recurring-task-series',
      'GET /api/v1/recurring-task-series/:id',
      'GET /api/v1/recurring-task-series/:id/history',
      'POST /api/v1/recurring-task-series/preview',
      'POST /api/v1/recurring-task-series/:id/preview',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'recurring_task_series.manage_project_scope',
    group: 'Recurring tasks',
    label: 'Manage project recurring task series',
    description: 'Allows creating, updating, enabling, disabling, running now, and deleting recurring task series only inside the MCP agent\'s assigned project and tenant. Running a series generates real tasks, so this is a write capability. Does not allow cross-project edits, cross-tenant edits, or unrelated admin routes.',
    endpoints: [
      'POST /api/v1/recurring-task-series',
      'PUT /api/v1/recurring-task-series/:id',
      'POST /api/v1/recurring-task-series/:id/enable',
      'POST /api/v1/recurring-task-series/:id/disable',
      'POST /api/v1/recurring-task-series/:id/run-now',
      'DELETE /api/v1/recurring-task-series/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'transition_requirements.manage_project_scope',
    group: 'Workflow',
    label: 'Project transition requirement CRUD',
    description: 'Allows reading, creating, updating, and deleting workflow gate requirements only inside the MCP agent\'s assigned project and tenant. Requires explicit project_id plus workflow_type, or workflow_id scoped to the assigned project. Does not allow global defaults, cross-project edits, cross-tenant edits, workflow transition changes, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/routing/transition-requirements',
      'POST /api/v1/routing/transition-requirements',
      'PUT /api/v1/routing/transition-requirements/:id',
      'DELETE /api/v1/routing/transition-requirements/:id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'external.write_task_events',
    group: 'Runtime',
    label: 'Post external task events',
    description: 'Allows lease-manager and runtime-style external task event callbacks.',
    endpoints: [
      'POST /api/v1/external/task-events',
    ],
    defaultEnabled: {
      scoped_runtime: true,
      trusted_admin: true,
    },
  },
  {
    key: 'external.manage_project_task_events',
    group: 'Runtime',
    label: 'Manage project external task events',
    description: 'Allows listing and reading external task-event receipts only for tasks in the MCP agent\'s assigned project and tenant. Does not allow posting callbacks, cross-project receipt access, cross-tenant receipt access, mapping mutation, or unrelated admin routes.',
    endpoints: [
      'GET /api/v1/external/task-events/receipts',
      'GET /api/v1/external/task-events/receipts/:receiptId',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'mcp_capability_policies.read',
    group: 'MCP capability policy',
    label: 'Read MCP capability policy',
    description: 'Allows reading effective Agent HQ MCP capability policy snapshots for agents in the caller agent\'s assigned project. Does not allow cross-project, cross-tenant, credential, secret, or policy mutation access.',
    endpoints: [
      'GET /api/v1/agents/:id/mcp-permissions',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'mcp_capability_policies.write',
    group: 'MCP capability policy',
    label: 'Legacy policy editing (retired)',
    description: 'Compatibility key retained for migrating existing policies. It no longer authorizes permission writes; use permissions.manage with explicit delegation limits.',
    endpoints: [
      'POST /api/v1/agents/:id/mcp-permissions',
      'PUT /api/v1/agents/:id/mcp-permissions',
      'DELETE /api/v1/agents/:id/mcp-permissions',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'admin.full_access',
    group: 'Administration',
    label: 'Tenant business administration',
    description: 'Tenant-local business administration. Does not grant executable registration, publication, assignment, invocation, host configuration, host execution or permission management; those require explicit capabilities.',
    endpoints: [
      'All other tenant-local /api/v1 Agent HQ MCP endpoints',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: true,
    },
  },
  {
    key: 'admin.cross_tenant',
    group: 'Super administration',
    label: 'Cross-tenant MCP access',
    description: 'Allows deliberate super-admin Agent HQ MCP access across tenants. Ordinary MCP keys always resolve to their key tenant and cannot send tenant selectors, even with regular admin access.',
    endpoints: [
      'Tenant selection via tenant_id, company_id, x-agent-hq-tenant-id, or x-tenant-id',
    ],
    defaultEnabled: {
      scoped_runtime: false,
      trusted_admin: false,
    },
  },
] as const satisfies readonly AgentMcpCapabilityDefinition[];

export type AgentMcpCapabilityKey = typeof AGENT_MCP_CAPABILITY_CATALOG[number]['key'];

export interface AgentMcpCapabilityState extends AgentMcpCapabilityDefinition {
  enabled: boolean;
  default_enabled: boolean;
  explicit_enabled: boolean | null;
}

export interface AgentMcpPermissionPolicySnapshot {
  agent_id: number;
  agent_name: string;
  agent_slug: string;
  policy_mode: 'default' | 'explicit';
  default_policy: AgentMcpDefaultPolicy;
  capabilities: AgentMcpCapabilityState[];
  updated_at: string | null;
}
