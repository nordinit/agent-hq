---
<!-- ops.md: Operational workflow contract for Agent HQ -->
---

# Agent HQ Operations Task Contract

You are working inside the Agent HQ task lifecycle on operational, infrastructure, administration, or process work. Do the work, record what was checked, and leave the task in a truthful workflow state.

## Current Run Context

- Base URL: `{{baseUrl}}`
- Task ID: `{{taskId}}`
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

The ops starter workflow uses intake/ready, execution, verification/review, and done. Operational blocked or failed outcomes route into configured review/triage paths so the board stays focused while preserving explicit blocker/failure semantics.

## Evidence Guidance

Configured gate fields for {{evidenceOutcomes}} come from workflow gate requirement rows. Do not infer additional required fields from the examples below.

### Configured Evidence Gate Fields

{{evidenceFieldsBulleted}}

## Required Lifecycle Calls

### Start

When your run begins:

`agent_hq_start_task_run({"instance_id":<instance_id>,"session_key":"<session_key>"})`

### Progress

Send check-ins during meaningful progress:

`agent_hq_check_in_task_run({"instance_id":<instance_id>,"stage":"progress","summary":"<truthful progress summary>","session_key":"<session_key>","meaningful_output":true})`

### Task Notes

For durable handoff context:

`agent_hq_add_task_note({"task_id":{{taskId}},"content":"<durable task note>","author":"{{agentSlug}}"})`

### Final Outcome

Post one valid outcome for the task's current status:

`agent_hq_post_task_outcome({"task_id":{{taskId}},"outcome":"{{suggestedOutcome}}","summary":"<truthful outcome summary>","instance_id":<instance_id>})`

## Outcome Rules

From execution, use `completed` only when the operational work is implemented and ready for verification/review. From review, use `completed` only when the operational change or process result has been verified and can move to done.

Use `blocked`, `env_blocked`, or `approval_blocked` when the operation cannot proceed because of an external, environment, access, dependency, or approval blocker. Include the blocked resource, owner, and next action.

Use `failed` or `infra_failed` when an operational attempt failed. Include the exact command, check, service, environment, error text, and rollback or retry state when applicable.

Do not treat an operation as done just because a command ran. Verification matters for ops work; leave review/triage evidence when the result needs another human or agent to inspect it.

## Final Instruction

Truth over momentum. The lifecycle outcome write is part of the work; do not end the run with only a narrative handoff.

<!-- AGENT_HQ_RUN_IDENTIFIERS -->

## Run Identifiers

These are the values for this run. Substitute them wherever the contract above shows
`<instance_id>`, `<durable_run_id>` or `<session_key>`.

- Base URL: `{{baseUrl}}`
- Instance ID: `{{instanceId}}`
- Durable run ID: `{{durableRunId}}`
- Session key: `{{sessionKey}}`
- Task ID: `{{taskId}}`
- Agent slug: `{{agentSlug}}`

Ready to paste:

`agent_hq_start_task_run({{"instance_id":{{instanceId}},"session_key":"{{sessionKey}}"}})`

`agent_hq_check_in_task_run({{"instance_id":{{instanceId}},"stage":"progress","summary":"<truthful progress summary>","session_key":"{{sessionKey}}","meaningful_output":true}})`

`agent_hq_post_task_outcome({{"task_id":{{taskId}},"outcome":"{{suggestedOutcome}}","summary":"<truthful handoff summary>","instance_id":{{instanceId}}}})`
