---
name: create-agent
description: Create and provision a durable Agent HQ agent, including its identity, role, runtime, provider/model selection, project association, instructions, capabilities, workspace documents, and assignment rules. Use when adding a recurring project role such as a project manager, engineer, QA reviewer, operator, or system administrator.
---

# Create Agent

Create a durable role in Agent HQ and let Agent HQ provision the runtime-owned state.

Follow the workflow in this file. When the bundled references are available, use `references/checklist.md` for execution detail and `references/templates.md` only when customizing generated workspace documents.

## Agent Design

### Name

Choose a short, distinctive, realistic name such as `Kepler`, `Atlas`, `Rook`, `Nova`, or `Cinder`.

- Check existing agents before choosing the name.
- Use one memorable name, not a role label such as `Backend Bot` or a project-role identifier such as `acme-backend`.
- Keep the name stable across projects, prompts, workspace documents, and audit records.
- Let Agent HQ derive the runtime slug and session key unless a compatibility constraint requires explicit overrides.

### Role

Describe the durable job or function the agent fulfills.

- Broad roles are valid when the scope is broad: `Project Manager`, `Backend Engineer`, `QA Engineer`.
- Specific roles are valid when the project needs a narrow owner: `XYZ System Administrator`, `Payments API Maintainer`, `Production Release Engineer`.
- Avoid vague labels such as `Helper`, `Worker`, or `Agent` when a real function is known.
- Put stable role behavior in `job_instructions`; put task-specific objectives and acceptance criteria in the task.

Create a new agent only for a recurring owner. Reuse an existing agent when the work is one-off or already fits an established role.

## Configuration Ownership

| Concern | Owner |
|---|---|
| Name, role, runtime, provider, model, project, timeout, instructions, skills, tools | Agent |
| Repository access mode, local repo path, clone URL | Workflow |
| Task type/status to agent mapping | Assignment Rules |
| Objective, scope, acceptance criteria, verification | Task |
| Scheduled work | Recurring Task Series |

Repository configuration is workflow-owned. Never send `repo_path`, `repo_url`, or `repo_access_mode` in an agent create, provision, or update payload; Agent HQ rejects those fields. For code-bearing work, configure each relevant workflow with:

- `repo_access_mode=worktree` plus `repo_path`, or
- `repo_access_mode=clone` plus `repo_url`.

## Preferred Creation Path

Use Agent HQ MCP tools when available.

1. Read the current agents, projects, workflows, providers, and capabilities.
2. Design the name, role, runtime, provider/model, instructions, and routing intent.
3. For an OpenClaw agent, call `agent_hq_provision_full_agent` once. This is the MCP path over `POST /api/v1/agents/provision-full`.
4. For a Hermes agent, use the same atomic REST endpoint when direct API access is appropriate; the current MCP provisioning schema is OpenClaw-only.
5. For Claude Code, webhook, or custom runtimes, use `agent_hq_create_agent` with the runtime-specific configuration supported by Agent HQ.
6. Configure workflow repository settings separately when needed.
7. Create or verify Assignment Rules through Agent HQ MCP. Use the `task-routing-rules` skill for scoped defaults or workflow overrides.
8. Verify the stored agent, workspace documents, capabilities, and effective routing.

Do not recreate platform provisioning manually. Agent HQ owns workspace scaffolding, runtime registration, provider credential materialization, capability assignment, and generated runtime paths.

## Instruction Layers

- **`job_instructions`**: stable role identity, execution style, quality bar, and critical constraints. Keep it concise and role-focused.
- **`SOUL.md` / `IDENTITY.md`**: persona, mandate, role, and project identity.
- **`AGENTS.md`**: startup behavior, process rules, memory discipline, and durable operating constraints.
- **`TOOLS.md`**: stable environment facts and tool notes. Do not use it as repository configuration.
- **Task dispatch**: objective, scope, acceptance criteria, and task-specific verification details.

For implementation agents, instruct them to use the task working directory supplied by dispatch. Repository isolation comes from the workflow's access mode; agents should not assume or modify a canonical production checkout.

## Critical Rules

1. Check existing agent names first and choose an unused short name.
2. Make the role describe the actual recurring job.
3. Associate project-specific agents with the correct `project_id`.
4. Use only a connected provider and a model allowed for that provider.
5. Keep repository fields off the agent payload and configure them on workflows.
6. Prefer atomic provisioning for OpenClaw and Hermes agents.
7. Use Assignment Rules, not direct database writes, for dispatch ownership.
8. Verify the structured provisioning report and read back the created configuration before reporting success.

## Verification Standard

Provisioning is complete only when:

- the response reports `ok: true` and successful validation/verification phases;
- the agent readback has the intended name, normalized role, runtime, project, provider/model, instructions, and enabled state;
- the generated workspace and required identity documents are present for provisioned local runtimes;
- requested skills, tools, and MCP servers are assigned and materialized;
- workflow repository configuration is correct for code-bearing work; and
- Assignment Rules route the intended workflow statuses and task types to the new agent.
