# Agent teams

A **team** is a named group of agents with a shared goal, awareness of each other's roles, a
default capability bundle, and a reusable routing shape that can be stamped onto a workflow.

Without teams, every workflow re-declares the same "implementer → reviewer → releaser" routing,
every participating agent carries its own copy of the tools, skills, and MCP servers that shape
implies, and no agent's prompt says who else is working the same workflow.

## Model

```
teams  ──< team_members >──  agents
  │
  ├──< team_tool_assignments >── tools
  ├──< team_mcp_assignments >── mcp_servers
  ├──  teams.skill_names (JSON, mirrors agents.skill_names)
  └──< team_routing_rules            (templates, keyed by workflow_type)
              │
              │  materialized on explicit apply
              ▼
       workflow_task_routing_rules  (with source_team_* provenance)
              ▲
              │
    workflows.team_id  ── a workflow is owned by at most one team
```

A team provides four things:

1. **Mutual context.** Each member's prompt carries the team goal and charter, its own role, and
   every teammate's role and responsibilities.
2. **Capability defaults.** Tools, skills, and MCP servers granted to the team flow to every
   member.
3. **Workflow ownership.** A workflow can be assigned to one team.
4. **Routing defaults.** The team's routing template can be applied to workflows it owns.

## Which team an agent is on at dispatch

Agents may belong to any number of teams. At dispatch time the team is resolved as:

1. The workflow's team, **if the agent is a member of it**.
2. Otherwise, the agent's only enabled membership.
3. Otherwise, the membership flagged `is_primary` (at most one per agent).
4. Otherwise no team context is injected.

Rule 1 requires membership on purpose: an agent pulled in as a one-off on a team-owned workflow
should not be told about handoffs it cannot perform.

## Capability defaults

Team grants **union** with the agent's own. An agent-level row wins on conflict, and an
agent-level assignment with `enabled = 0` is an explicit opt-out from a team grant.
`GET /api/v1/agents/:id/effective-capabilities` shows which capabilities are the agent's own and
which are inherited.

## Routing defaults

Assigning a team to a workflow changes prompt context only. Applying the team's routing template
is a separate, explicit action, so a dropdown change never rewrites routing configuration.

Applying a template **materializes** real `workflow_task_routing_rules` rows stamped with
`source_team_id`, `source_team_rule_id`, and `source_team_applied_json` (the values written at the
last apply). Every existing routing path, the Routing UI, and routing audit keep working
unchanged, and drift is reported rather than prevented:

| Current rule vs. last apply | Last apply vs. template | Result |
|---|---|---|
| same | same | `unchanged` |
| same | differs | `update`: the template changed, resync |
| differs | — | `conflict`: an operator edited the rule, local wins |

`POST /api/v1/workflows/:id/team/apply-routing?dry_run=1` returns that diff without writing
anything. Applying writes `routing_config_audit_log` rows under one `batch_id`.

When a template rule names a `member_role` instead of an agent, it resolves to the enabled member
holding that role. No match is reported as a skip; more than one match is an error in the dry run.

## API

```
GET|POST              /api/v1/teams
GET|PATCH|DELETE      /api/v1/teams/:id                        (DELETE is a soft delete)
GET|POST              /api/v1/teams/:id/members
PATCH|DELETE          /api/v1/teams/:id/members/:agentId
GET|POST              /api/v1/teams/:id/tools                  DELETE .../tools/:toolId
GET|POST              /api/v1/teams/:id/mcp-servers            DELETE .../mcp-servers/:serverId
GET|POST              /api/v1/teams/:id/routing-rules          DELETE .../routing-rules/:ruleId
GET                   /api/v1/teams/:id/context-preview?agent_id=N
GET                   /api/v1/teams/:id/resolution             POST .../resolution/preview
PUT                   /api/v1/workflows/:id/team
POST                  /api/v1/workflows/:id/team/apply-routing[?dry_run=1]
GET                   /api/v1/agents/:id/teams
GET                   /api/v1/agents/:id/effective-capabilities
```

`context-preview` renders exactly what a member's prompt will contain. Teams are also exposed
through the Agent HQ MCP server, so an admin agent can build and maintain teams itself.

## Where the code is

| Concern | Location |
|---|---|
| Schema | `db/pg-migrations/21-agent-teams.sql` |
| Context renderer (pure) | `api/src/services/dispatch/prompt/teamContext.ts` |
| Team resolution at dispatch | `api/src/domains/teams/context.ts` |
| Capability union | `api/src/domains/teams/effectiveCapabilities.ts` |
| Routing templates | `api/src/domains/teams/routingTemplates.ts` |
| REST | `api/src/routes/teams.ts` |
| MCP | `api/src/mcp/domains/teams.ts` |
| UI | `ui/app/teams/`, `ui/components/WorkflowTeamCard.tsx`, `ui/components/AgentTeamsCard.tsx` |

`domains/teams/effectiveCapabilities.ts` imports only a type from `db/adapter`. That keeps the
standalone tool server (`api/src/bin/agent-tool-mcp.ts`) and the dispatcher on the same resolver
without pulling the runtime layer into every process that mounts the tool server.
