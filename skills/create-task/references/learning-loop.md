# Task Creation Learning Loop

Use a lightweight structured feedback loop instead of trying to make the skill self-modify blindly.

## Goal

Improve task creation quality over time by measuring whether created tasks were:
- routed correctly
- scoped correctly
- easy for agents to execute
- likely to pass QA without rework

## Recommended architecture

### 1. Capture at task creation time
Store one structured record per task creation event.

Suggested fields:
- `created_at`
- `task_id`
- `title`
- `project_id`
- `sprint_id`
- `job_id`
- `priority`
- `request_summary`
- `task_type`
- `creator` (`atlas`, user, automation)
- `confidence` (high/medium/low)
- `assumptions[]`
- `open_questions[]`

### 2. Attach downstream outcome signals
When the task finishes or stalls, enrich the same record with:
- `final_status`
- `first_pass_qa` (true/false)
- `reopened_count`
- `notes_count`
- `cycle_time_hours`
- `blocked` (true/false)
- `split_after_creation` (true/false)
- `rerouted_after_creation` (true/false)
- `outcome_summary`

### 3. Review for patterns
Look for failure modes such as:
- wrong board or sprint selected
- wrong job assigned
- tasks too large and later split
- missing acceptance criteria
- missing dependency/blocker info
- descriptions too vague, causing clarification churn

## Best place to implement this

This is better as a **system-level Agent HQ capability** than as skill-local memory.

Why:
- multiple agents and skills create tasks
- the same telemetry should apply regardless of who created the task
- outcomes live in the task system, QA flow, and notes — not inside one skill directory
- reporting can become dashboardable

## Minimal implementation path

### Phase 1 — cheap and useful
Add a `task_creation_events` table or JSONL log with the creation-time fields only.

### Phase 2 — join outcomes
Enrich events from task status changes, notes, QA results, and reopen events.

### Phase 3 — improvement report
Generate a weekly review:
- top misrouting patterns
- highest rework categories
- tasks most often split after creation
- agents most often needing clarification
- prompts/templates that correlate with clean completion

## How the skill should use the loop

The skill should:
- create consistently structured tasks
- optionally emit a small structured metadata payload alongside creation
- not try to rewrite itself automatically

Humans or a PM/ops agent should review the telemetry and then update the skill on purpose.

## Suggested success metrics

- % tasks completed without reassignment
- % tasks passing QA first try
- median cycle time by task type
- % tasks needing split after creation
- % tasks with blockers discovered late
- clarification messages per task

## Recommended next implementation step

Add structured task creation logging to Agent HQ first. Then let this skill standardize the inputs that feed that logging.
