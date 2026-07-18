# Agent Creation Checklist

Follow this checklist in order. Use Agent HQ MCP tools for Agent HQ state changes whenever the required tool exists.

## 1. Confirm a New Agent Is Needed

- List existing agents.
- Reuse an existing agent when it already owns the recurring role.
- Create a new agent only when the project or workflow needs a distinct durable owner.
- Resolve the target project and the workflows the agent will serve.

## 2. Design the Identity

Choose:

- **Name:** short, distinctive, and realistic, such as `Kepler`, `Atlas`, `Rook`, `Nova`, or `Cinder`.
- **Role:** the durable job or function, such as `Project Manager`, `Backend Engineer`, `QA Engineer`, or `XYZ System Administrator`.
- **Project:** the Agent HQ `project_id`, unless the agent is intentionally project-independent.

Before finalizing the name, call `agent_hq_list_agents` and check for a case-insensitive conflict. Agent HQ also rejects duplicate names during creation.

Do not encode the project and role into the display name. Let Agent HQ derive the runtime slug, workspace path, and canonical session key unless an existing integration requires an override.

## 3. Choose Runtime and Execution Settings

Resolve:

- runtime type;
- connected provider and compatible model;
- provider connection when the runtime requires one;
- run timeout;
- enabled state;
- stable `job_instructions`;
- skills, tools, and MCP servers;
- routing intent.

Use the platform/provider defaults when the user has no model preference. Do not hardcode a provider or model without checking current Agent HQ configuration.

The default timeout is 900 seconds. Increase it deliberately for roles whose normal work can exceed that duration, such as long-running engineering, QA, or operations work.

## 4. Configure Repository Access on Workflows

Do not include `repo_path`, `repo_url`, or `repo_access_mode` in any agent payload.

For every code-bearing workflow the agent will serve, read the workflow and configure one of:

- **Worktree mode:** `repo_access_mode=worktree` and an absolute `repo_path`.
- **Clone mode:** `repo_access_mode=clone` and a reachable `repo_url`.

Use `agent_hq_update_workflow` or `agent_hq_create_workflow` for this state. Read the workflow back after the change.

Repository settings in workspace documents are informational only. The workflow record is authoritative for dispatch.

## 5. Write Stable Agent Instructions

Keep `job_instructions` concise. Include:

- the agent's role and mandate;
- what it owns and does not own;
- its execution and communication style;
- its quality and verification bar;
- critical safety or escalation constraints.

Do not include task-specific acceptance criteria, temporary URLs/ports, or a fixed repository path. Those belong to the task or workflow.

## 6. Create the Agent

### OpenClaw

Use `agent_hq_provision_full_agent`. Supply only resolved fields, for example:

```json
{
  "name": "Kepler",
  "role": "Backend Engineer",
  "project_id": 12,
  "runtime_type": "openclaw",
  "preferred_provider": "<connected-provider>",
  "model": "<compatible-model>",
  "job_instructions": "Own backend implementation for this project. Work from the assigned task and dispatch-provided working directory, keep changes scoped, verify behavior before handoff, and escalate blockers with evidence.",
  "timeout_seconds": 3600,
  "skill_names": ["<needed-skill>"]
}
```

Omit optional fields that are not needed. In particular, omit repository fields and generated identity fields unless compatibility requires an override.

The provisioning call owns the Agent HQ row, workspace scaffold, runtime registration, provider credential materialization, skill/MCP materialization, and verification report.

### Hermes

The REST endpoint `POST /api/v1/agents/provision-full` also supports `runtime_type=hermes`. Supply a valid Hermes `runtime_config`, including its required isolated `profile`. The endpoint scaffolds the workspace and materializes Hermes runtime credentials without registering the agent as an OpenClaw-native agent.

The current `agent_hq_provision_full_agent` MCP schema accepts OpenClaw only. Use direct REST for atomic Hermes provisioning when permitted; otherwise use `agent_hq_create_agent` and verify the runtime-specific setup separately.

### Other Runtimes

Use `agent_hq_create_agent` with the runtime-specific configuration supported by the selected adapter. Do not call the OpenClaw-only `POST /api/v1/agents/:id/provision` endpoint for non-OpenClaw runtimes. Verify any required working directory, endpoint, or credential connection for that runtime.

## 7. Customize Workspace Documents When Needed

For a provisioned local workspace, customize the documents Agent HQ generated rather than rebuilding the workspace. Use `references/templates.md` as a content guide.

Keep these documents aligned:

- `SOUL.md`
- `IDENTITY.md`
- `USER.md`
- `AGENTS.md`
- `TOOLS.md`
- `MEMORY.md`
- `LESSONS.md`

Preserve platform-generated identifiers or runtime details that remain accurate. Do not overwrite existing user-authored content blindly.

## 8. Configure Assignment Rules

Agents are project-scoped; Assignment Rules own workflow dispatch.

- Use the `task-routing-rules` skill and Agent HQ MCP CRUD.
- Choose deliberately between a workflow-type default and a workflow-specific override.
- Map valid workflow statuses and task types to the canonical `agent_id`.
- Use higher numeric priority for the preferred agent.
- Read back the exact rule scope and effective ordering.

The atomic provisioning payload can create simple rules for current non-closed project workflows, but use dedicated Assignment Rule tools when scope or inheritance matters.

Never patch routing tables directly.

## 9. Verify End to End

Check the provisioning response and read back the state:

1. `report.validation`, `report.agent`, and `report.verification` succeeded.
2. `report.workspace`, `report.auth`, and `report.capabilities` match the selected runtime and requested assignments.
3. `agent_hq_get_agent` returns the intended name, role, project, runtime, provider/model, instructions, timeout, and enabled state.
4. `agent_hq_get_agent_docs` returns the expected workspace documents for a provisioned local runtime.
5. Relevant workflows contain the intended repository configuration.
6. Assignment Rules route the intended task types/statuses to the new agent.

Restart the gateway through the provisioning option only when explicitly required. Do not add a separate manual restart step by default.

## 10. Report the Result

Return:

- agent name and `agent_id`;
- role and project;
- runtime, provider, and model;
- workspace/runtime slug when provisioned;
- assigned skills/tools/MCP servers;
- Assignment Rules created or verified;
- workflow repository configuration verified;
- any remaining follow-up.

## Common Failures

| Failure | Cause | Fix |
|---|---|---|
| Agent create rejects repository fields | Repository configuration is workflow-owned | Remove the fields from the agent payload and update the workflow |
| Duplicate-name conflict | The name is already registered | Choose another short, realistic name |
| Provider/model validation fails | Provider is disconnected or the model does not belong to it | Read current provider configuration and select a compatible pair |
| Agent exists but never receives work | Assignment Rules are missing, disabled, or scoped incorrectly | Create/read back the correct default or workflow override |
| Code task cannot dispatch | Workflow repository configuration is missing or incomplete | Configure worktree path or clone URL on the workflow |
| Instructions drift into task detail | Stable and task-specific context were mixed | Keep durable behavior on the agent and move task detail to dispatch |
| Scheduled behavior does not run | Per-agent scheduling is deprecated | Create a Recurring Task Series when recurring work is explicitly required |
