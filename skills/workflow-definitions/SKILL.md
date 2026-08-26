---
name: workflow-definitions
description: "Create, edit, delete, or verify Agent HQ Workflow Definitions page configuration."
---

# Workflow Definitions

Use this whenever changing Agent HQ Workflow Definitions page configuration:
- workflow types
- workflow type task/status definitions
- allowed task types
- task field schemas
- status templates
- workflow/status defaults shown or edited from Workflow Definitions
- evidence gate requirements when they are part of the Workflow Definitions workflow

## Naming Compatibility

The product surface is **Workflow Definitions**. MCP tool names have completed the rename;
machine-readable payload fields have not:

- MCP tools are named `agent_hq_*_workflow_type*` (for example `agent_hq_list_workflow_types`).
  Each tool has exactly one name — the `sprint_type` spellings and the `atlas_*` names are gone.
- Payload and response fields still use `sprint_type`, `sprint_id`, and similar keys.
- Do not invent `workflow_type` payload keys where the tool contract says `sprint_type`.

## Core Rules

- Use Agent HQ MCP tools only.
- Do not use raw Agent HQ API calls for Workflow Definitions page config changes.
- Do not use direct SQL for Workflow Definitions page config changes.
- Do not edit local config files as a substitute for changing Agent HQ Workflow Definitions.
- If an MCP tool does not exist for the needed Workflow Definitions change, stop and escalate instead of inventing an API or SQL workaround.

## Scope Decision

Before writing, decide the target scope explicitly:

- project
- workflow type
- task type
- status
- field schema
- gate or workflow default

Do not edit a project-wide or workflow-type default when the user asked for a one-off workflow change.
Do not create a one-off override when the user asked for a reusable definition.

## Workflow

1. Resolve the target project and workflow type from Agent HQ.
2. Read the existing Workflow Definitions configuration through MCP.
3. Identify the smallest config object that must change.
4. Apply the change through Agent HQ MCP only.
5. Read back the exact target configuration after the write.
6. Verify any affected inherited behavior, especially status availability, task-type availability, field requirements, gates, and transitions.
7. Report what changed and which project/workflow type it affects.

## Safety Checks

Before changing task/status definitions:
- Confirm existing tasks will not be stranded in removed statuses.
- Confirm assignment rules and transitions still reference valid statuses and task types.
- Prefer adding a new allowed value over renaming/removing an active one unless migration is part of the task.

Before changing field schemas:
- Preserve existing field keys unless the user explicitly asks for a schema migration.
- Do not make fields required unless they block safe dispatch, handoff, or verification.
- Read back stored JSON/schema shape after writing.

Before changing gates or workflow defaults:
- Verify the matching lifecycle transition still exists.
- Do not weaken QA/review requirements casually.
- Never manually set QA outcomes or advance QA lanes as part of verification.

## Output Standard

When finished, include:
- project id/name
- workflow type or definition changed
- specific config objects changed
- MCP readback result
- any follow-up needed for assignment rules, model routing, tasks, or agents
