# Agent and team capability maps

Open **Capability map** on an agent's detail page, or the tab with the same name on a team. The workflow graph's assignment inspector also links to an agent's map.

## Agent resolution

The graph shows configured registry tools, MCP servers, skills and Agent HQ MCP permissions. Select a node to inspect every contributing source, the winning grant, overridden team grants, explicit agent opt-outs and globally disabled resources. Search and category filters keep larger configurations readable; graph nodes support keyboard selection.

Resolution shares the dispatch tool/server candidate loaders and precedence functions. It does not duplicate the grant rules in the browser. Skills retain their existing union semantics. Team context uses the existing dispatch resolver: workflow owner membership, sole enabled team, unique primary team, then none. Selecting a workflow is restricted to the agent's tenant and project and loads the same routing graph used by the routing page. Assignment rows are eligible rules, not a guarantee that the agent wins every task-type/priority contest.

Findings explain ambiguous context, disabled agents, explicit policies replacing default permissions, excluded resources, missing workflow-team membership, and routing references without MCP lifecycle write permission. They do not infer capability requirements from arbitrary task prose.

Permission defaults reflect the strongest live key role used by the existing policy snapshot. The preview identifies its selected live key role. Configured grants do not prove a runtime can execute a tool: credentials, external server allowlists, runtime support and call-time scope checks still apply. Model display is the configured agent model, not a prediction of task-specific model routing.

## Editing and historical context

Select a permission and change its draft checkbox, then **Preview tool access** before **Save policy**. Saving creates an explicit policy. A policy fingerprint and a transaction lock reject stale edits rather than overwrite another operator's policy. Existing permission authorization and escalation restrictions remain enforced.

The team matrix compares effective grants across enabled memberships. **Edit shared skills** previews each member's gains and losses using the real resolver inside a transaction that is always rolled back. Direct grants and other teams can retain a removed skill. Saving checks the team's context version. Preview requests never dispatch or materialize runtime files.

**Inspect an actual run** opens the existing captured-context viewer, including prompt segments, runtime boundary and differences from the preceding captured run of that task. This is historical evidence; it does not regenerate an old run using today's entire dispatch configuration.

Tool/server assignments, team membership, models and charters remain editable through their existing forms, linked from the source inspector. Shared tool/server mutation previews and complete historical-versus-current dispatch replay are not implemented by this change. No columns or configuration layers are removed.

## API and access

- `GET /api/v1/agents/:id/resolution?workflow_id=...`
- `GET /api/v1/teams/:id/resolution`
- `POST /api/v1/teams/:id/resolution/preview`, with `skill_names: string[]`
- Existing agent permission writes accept optional `expected_revision`.
- Existing team patches accept optional `expected_context_version`.

`agent_hq_analyze_agent_capabilities` exposes the agent resolution snapshot through MCP. Scoped callers need both `agents.manage_project_agents` and either permission-policy read or write access; the target must belong to their assigned project. Team endpoints retain the existing operator/admin access boundary. Resolution projections omit tool implementation bodies, launch commands, environment values and credential overrides.

No database migration is required. Deploy the API and UI together; running services are not restarted by this source change.
