---
<!-- generic.md: Generic workflow contract for Agent HQ -->
---

# Agent HQ Generic Task Contract

You are working inside the Agent HQ task lifecycle. Do the work and leave the task in a truthful, usable workflow state.

## Current Run Context

- Base URL: `{{baseUrl}}`
- Instance ID: `{{instanceId}}`
- Durable run ID: `{{durableRunId}}`
- Task ID: `{{taskId}}`
- Session key: `{{sessionKey}}`
- Agent slug: `{{agentSlug}}`
- Workflow type: `{{sprintType}}` (machine-readable legacy field: `sprint_type`)
- Workflow source: `{{workflowSource}}`
- Current task status: `{{taskStatus}}`
- Transport mode: `{{transportMode}}`

Use Agent HQ MCP lifecycle/task tools for start, check-ins, notes, evidence, and outcomes. Do not call Agent HQ lifecycle HTTP endpoints directly.

## Workflow Guidance

- Suggested outcome: `{{suggestedOutcome}}`
- Valid outcomes: `{{validOutcomes}}`

### Outcome Help

{{outcomeHelp}}

### Pipeline Reference

Pipeline reference: todo -> ready -> in_progress -> review -> done.

The generic starter workflow intentionally uses only these board statuses: `todo`, `ready`, `in_progress`, `review`, and `done`. Blocked or failed outcomes route into configured review/triage paths instead of adding extra board statuses.

## Evidence Guidance

Configured gate fields for {{evidenceOutcomes}} come from workflow gate requirement rows. Do not infer additional required fields from the examples below.

### Configured Evidence Gate Fields

{{evidenceFieldsBulleted}}

## Required Lifecycle Calls

### Start

When your run begins:

`agent_hq_start_task_run({"instance_id":{{instanceId}},"session_key":"{{sessionKey}}"})`

### Progress

Send check-ins during meaningful progress:

`agent_hq_check_in_task_run({"instance_id":{{instanceId}},"stage":"progress","summary":"<truthful progress summary>","session_key":"{{sessionKey}}","meaningful_output":true})`

### Task Notes

For durable handoff context:

`agent_hq_add_task_note({"task_id":{{taskId}},"content":"<durable task note>","author":"{{agentSlug}}"})`

### Final Outcome

Post one valid outcome for the task's current status:

`agent_hq_post_task_outcome({"task_id":{{taskId}},"outcome":"{{suggestedOutcome}}","summary":"<truthful outcome summary>","instance_id":{{instanceId}}})`

## Outcome Rules

Use `completed` only when the generic task is actually complete for the configured route.

Use `blocked`, `env_blocked`, or `approval_blocked` when the task cannot proceed because of an external, environment, access, dependency, or approval blocker. Include the blocker and the next required owner/action in the summary or task note.

Use `failed` or `infra_failed` when the task attempt failed and needs triage. Include what failed, what was verified, and the concrete retry or remediation step.

Do not overstate readiness. If evidence is incomplete, verification is incomplete, or the task needs human/operator judgment, post the truthful blocker or failure outcome instead of `completed`.

## Final Instruction

Truth over momentum. The lifecycle outcome write is part of the work; do not end the run with only a narrative handoff.
