# Agent and team capability maps

Open **Capability map** on an agent's detail page, or the tab with the same name on a team. The workflow graph's assignment inspector also links to an agent's map.

## Letting an agent run

Agent HQ starts an agent's runtime only when two things are true:

- **The agent may run on this machine.** It has the `host.execute` permission (**Launch approved host processes**). To grant it here, tick that permission, then **Preview tool access** and **Save policy**. Don't use the **executor** preset for this: a preset replaces the whole draft, including the task permissions the agent already has. Onboarding grants `host.execute` to the starter agents it creates and says so before you apply. An agent you add later starts without it.
- **Its setup is approved.** Agent HQ records an approved revision of everything that decides what the agent runs: model, provider, runtime settings, workspace, instructions, skills (including team skills), webhook and credential references. It also records the setup of each workflow the agent works in, and each tool and MCP server it uses. Before every launch it compares the agent's current setup with the approved one and refuses to start if they differ.

Changes you make in the UI, or with the operator token from the CLI or API, are approved when you save them: creating or editing an agent, its skills, a skill it uses, its team, its credentials, a workflow's repository or environment setup, a routing rule, or a tool or MCP server assignment. Changes made with an agent's MCP key are never approved this way and wait for review. A save approves only what was already approved before it: if something else changed the agent since its last approval, your edit leaves that change waiting for review rather than approving it on your behalf.

### When a task can't start

When Agent HQ refuses to start an agent, no run exists, so the reason goes on the task instead. The task card shows **Can't start**, and the task page says why: the agent isn't allowed to run on this machine, its setup was never approved, or its setup (or the workflow's setup) changed after it was approved. The task also gets one note saying so, and another only if the reason changes. Agent HQ keeps trying about every 12 seconds and starts the task on the first check after the problem is fixed.

**Review and approve** on the task opens **Approvals** (also in the sidebar) with that agent's row open. The page starts with **How approvals work**, which explains the three checks Agent HQ makes before it starts an agent on a task, and a colour legend. Close it once you know it; the page remembers.

The grid has one row per agent and one column per check:

| Column | What it checks |
| --- | --- |
| Allowed to run | The agent has `host.execute`, so Agent HQ may start it on this machine at all. |
| Agent setup | Its instructions, skills, model, runtime settings and credentials match what you approved. |
| Workflow setups | For each workflow a routing rule sends the agent work in, that workflow's repository and setup commands are approved for this agent. |
| Tasks | Tasks that can't start right now because a check failed. |

Red means a task is waiting on that check now. Amber means work routed to the agent would wait, though nothing is waiting yet. Green passes. Grey fails but nothing is routed there, so nothing waits on it. Approval is per agent and per workflow, so an agent can work normally in one workflow while another workflow routed to it is not approved; it shows amber, not red.

**Needs attention** (the default) shows agents with a red or amber check; **All agents** shows the rest too, and **Project** narrows either view. Select a row to see each check with a plain reason and what you can do:

- **Review** opens the check beside the grid: what it is, why it is listed, and for a setup the approved value next to the current one (secrets and credentials show only that they changed), or everything you would approve if it was never approved.
- For an agent without `host.execute`, reviewing **Allowed to run on this machine** offers **Allow it to run**, and reviewing a setup offers **Also allow it to run on this machine**. Both add the permission to the agent's current permissions; they never replace them.
- **Stop routing it here** opens the routing page's rules for that agent and workflow. Turn them off there if the agent shouldn't work in that workflow.

The drawer says when approving one check won't start the agent's tasks on its own, and names what else is still needed.

**Approve** approves exactly what the drawer showed you. If the setup changes again before you select it, nothing is approved and the page asks you to review the new change. Only the operator can approve here; an agent's key can't.

**Review and approve executable revisions** on this page still works on one revision at a time, by kind and ID, for tools and MCP servers as well.

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
