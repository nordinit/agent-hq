# Workflow Definition Guide

Workflow definitions are where Atlas turns a repeated operating process into reusable structure.

Use workflow definitions for:
- allowed task types
- default task field schema
- task-type-specific field schemas
- status templates
- setup defaults that should repeat across workflows

Keep runtime dispatch separate. Routing rules live in Task Routing, not in Workflow Definitions.

## When To Create A Workflow Type

Create a new workflow type when:
- the user has a repeatable workflow that differs from generic software delivery
- different task categories require different fields
- the lifecycle or statuses need domain-specific names
- the same workflow will be reused across multiple workflows/projects

Reuse an existing workflow type when:
- only the workflow name/date/goal changes
- the same task types and fields apply
- routing changes are agent-specific rather than workflow-specific

Avoid creating a workflow type for a one-off task unless the user wants reusable workflow setup.

## Workflow Type Shape

A good workflow type has:

- **Key**: stable lowercase identifier, for example `software_delivery`, `content_ops`, or `sales_pipeline`.
- **Display name**: human label.
- **Description**: one sentence explaining what work belongs here.
- **Allowed task types**: only the categories users should create in this workflow type.
- **Default task field schema**: fields most tasks share.
- **Task-type schema overrides**: only where a specific task type needs different fields.

## Status Design

Statuses should represent real workflow states, not every micro-step.

Common software lifecycle:

```text
todo -> ready -> dispatched -> in_progress -> review -> qa_pass -> ready_to_merge -> deployed -> done
```

Use fewer states when the workflow is simpler:

```text
todo -> ready -> in_progress -> review -> done
```

Use release states only if the user actually has release work:

```text
ready_to_merge -> deployed -> done
```

Use `needs_attention` only as an operator recovery state. It is not a synonym for blocked, failed, or QA fail.

## Allowed Task Types

Prefer canonical task types:

- `frontend`
- `backend`
- `fullstack`
- `qa`
- `design`
- `marketing`
- `pm`
- `pm_analysis`
- `pm_operational`
- `ops`
- `data`
- `adhoc`
- `other`

Only use `other` when none of the concrete types fit. Overuse of `other` weakens routing.

## Design Heuristics

- Put "what information does the task need?" in field schemas.
- Put "who handles this status?" in assignment rules.
- Put "what transition is allowed?" in automatic transitions.
- Put "what proof is required?" in gate requirements.
- Keep workflow definitions reusable and domain-focused.

## Anti-Patterns

- Creating custom task types for every small variation.
- Encoding agent names in workflow type fields.
- Making statuses such as "frontend doing work" instead of using task type plus routing.
- Adding required fields that are not needed for handoff or verification.
- Creating a workflow type without a sample task path to test it.

## Compatibility Names

Agent HQ is in a sprint-to-workflow compatibility window. Human-facing docs and prompts should say workflow. Some APIs, MCP tools, and database fields still use `sprint`, `sprint_id`, and `sprint_type`; treat those as machine-readable compatibility names until the data model is renamed.
