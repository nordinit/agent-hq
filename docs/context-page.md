# Context page

`/context` shows what an agent is given on each run and lets an operator edit the sources of
that context in one place. It complements the per-run context viewer (opened from a task's
runs), which stays available from the page's **Full viewer** button.

## Finding a run

The left rail narrows from the project down: **Project → Agent → Workflow → Task type → Recorded
run**. The project limits the agents (each agent belongs to one project), the agent's workflows
and its recorded runs. Workflows and task types come from the agent's recorded runs. Selecting a run sets the run
shown on the **Prompt** and **Task** tabs and the tool lists on **Tools**.

## Tabs

| Tab | Shows | Editable |
|---|---|---|
| Prompt | The prompt Agent HQ wrote for the selected run, by section | No |
| Instructions & skills | Job instructions, skills and how the runtime delivers them, team context sizes | Job instructions, the agent's own skills |
| Tools | Built-in tools, Agent HQ registry tools, each MCP server with the tool definitions it advertised and their size | The agent's own MCP tool allowlists |
| Workflow & project | The workflow goal and project context | Both |
| Task | The task description and, for recurring tasks, the series description template | Both |

Sizes are characters with an estimated token count. The prompt tab covers only the prompt
Agent HQ wrote; the runtime adds its own system prompt, the skill listing and tool
definitions, which the Instructions & skills and Tools tabs size separately.

### Skill delivery

- Claude Code: each skill is listed to the model as `agent-hq:<name>` with its description,
  and the Skill tool loads the full SKILL.md on demand.
- Codex: each skill is listed in Codex's available skills with its description and path, and
  the model reads the file when a task matches.

### MCP tool definitions

Every run records the tool definitions each of its MCP servers advertised (`tools/list`).
Definitions are stored once per distinct server configuration and tool list
(`agents.mcp_tool_snapshots`, migration 59) and each run links to the ones it used
(`runs.run_mcp_tool_snapshots`). Servers that launch preflight already probes cost nothing
extra; any other server is probed after the agent process starts, only when its configuration
has no snapshot from the last day. Claude Code offers every tool on a server to the model and
lets only allowed tools run; Codex offers only the allowed tools.

## Staging and publishing

Edits are staged, not saved. The footer lists them; **Publish all** sends them in one request
(`POST /api/v1/context/publish`). Each edit carries the hash of the value it was made against:

- If any source changed since the page loaded, nothing is written. The conflicting edits are
  marked; discard them, or choose **Publish mine over it**.
- Otherwise every edit is applied in one transaction. Agents whose job instructions or skills
  changed get a new runtime revision that is published and bound in the same transaction, so
  their next run launches with the new profile.

Workflow goals, project context, task descriptions, series templates and MCP allowlists are not
part of an agent's approved profile and need no re-approval.

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/v1/context/agents/:id` | Agent sources, skills, tools and workflows, with hashes |
| `GET /api/v1/context/tasks/:id` | Task description and series template, with hashes |
| `GET /api/v1/context/runs?project_id=&agent_id=&workflow_id=&task_type=&task_id=&limit=` | Recorded runs, newest first |
| `GET /api/v1/context/runs/:id/mcp-tools` | Tool definitions recorded for one run |
| `POST /api/v1/context/publish` | Publish staged changes (`job_instructions`, `agent_skills`, `mcp_allowlist`, `workflow_goal`, `project_context`, `task_description`, `series_template`) |

The run's prompt itself comes from `GET /api/v1/instances/:id/context`. These routes are for
operators; agent credentials need `admin.full_access`.
