---
name: task-routing-rules
description: "Create, edit, delete, or verify Agent HQ Assignment Rules (formerly Task Routing rules) and related routing configuration."
---

# Assignment Rules (Task Routing)

Assignment rules are the renamed product surface for task routing rules. Use this whenever
changing Agent HQ Assignment Rules configuration on the Routing page:
- assignment rules
- workflow-type default assignment rules
- workflow override assignment rules
- routing transitions when they are part of the same Routing page workflow

## Naming Compatibility

- The UI label is **Assignment Rules** (Routing page → Assignment Rules tab).
- MCP tools use the `assignment_rules` naming (for example `agent_hq_list_assignment_rules`).
  Each tool has exactly one name; the `agent_hq_*_routing_rule*` spellings have been removed.
- Preferred REST paths are `/api/v1/routing/assignment-rules` (legacy `/api/v1/routing/rules`
  still works).
- The backing table is still `sprint_task_routing_rules` during the compatibility window, and
  payload fields still use `sprint_*` machine-readable names.

## Core Facts

- Use Agent HQ MCP routing tools only.
- Do not use raw API for Assignment Rules config changes.
- Do not use direct SQL for Assignment Rules config changes.
- Assignment rule priority is numeric and sorted **descending**: higher number wins.
- Workflow overrides are considered before workflow-type defaults.
- More specific task-type matches beat `task_type = null` catch-all rules.
- Stable tiebreaker is rule id ascending after scope, specificity, and priority.

## Scope Decision

Before writing, decide the intended scope explicitly:

- `sprint_type_default`: reusable default for a project + workflow type. This is the current machine-readable scope key.
- `sprint_override`: one workflow-specific exception. This is the current machine-readable scope key.

Do not create a workflow override when the user asked for a reusable default.
Do not edit a default when the user asked for one workflow only.

## Workflow

1. Resolve the target project, workflow, workflow type, status, task type, and agent ids.
2. Read existing assignment rules for the exact target scope.
3. Read inherited/default assignment rules if the change should override or reorder existing behavior.
4. Apply the smallest necessary create/update/delete through Agent HQ MCP routing tools only.
5. Read back the exact target scope after the write.
6. Verify the effective order:
   - workflow override before workflow-type default
   - exact task type before catch-all
   - higher priority before lower priority
7. Report rule id, scope, status, task type, agent, priority, and what remains inherited.

## Priority Rules

Do not guess priority semantics.

- Higher number = higher assignment-rule priority.
- Examples:
  - primary `120`, secondary `100`
  - workflow override `100`, default `0`
- Avoid negative priorities unless intentionally making a rule lower priority than zero.

If the UI copy, docs, or memory conflict with this, trust the dispatcher/routing policy implementation:
- `ORDER BY ... priority DESC, id ASC`

## Safety Checks

Before deleting:
- Confirm whether the visible rules are actual `sprint_override` rows or inherited defaults.
- Delete only the requested scope.
- After deletion, verify the remaining rules in both override and default scopes when relevant.

Before adding:
- Check for an existing equivalent rule to avoid duplicate behavior.
- If reordering two agents, update priority deliberately instead of adding ambiguous duplicates.

Before editing:
- Preserve `project_id`, `sprint_id`, `sprint_type`, `status`, and `task_type` unless the user asked to change them. `sprint_id` and `sprint_type` are currently the compatibility field names for workflow id and workflow type.
- Do not silently retarget the agent.
