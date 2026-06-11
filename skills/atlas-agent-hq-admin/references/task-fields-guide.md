# Task Fields Guide

Task fields capture structured information that should travel with a task.

Use fields when information is:
- needed by multiple agents or lanes
- required before safe handoff
- useful for filtering, review, or reporting
- stable enough to be part of the workflow

Use notes when information is:
- narrative
- temporary
- a progress update
- too free-form to validate
- not needed for future filtering or gates

## Field Schema Layers

Agent HQ resolves fields in this order:

1. Task-type-specific schema for the workflow type.
2. Default task field schema for the workflow type.
3. Generic fallback schema.

Use the default schema for shared fields. Add task-type schemas only when a task type truly needs different fields.

## Good Field Candidates

Software:
- success criteria
- affected area
- repo or service
- reproduction steps
- expected behavior
- actual behavior
- rollout notes

QA:
- tested URL
- test account
- browser/device
- verified commit
- reproduction result

Release:
- merge commit
- deployed commit
- deploy target
- live verification owner
- rollback plan

Content:
- target audience
- channel
- draft URL
- approval owner
- publish date

Sales:
- company
- contact
- stage
- next follow-up date
- source
- value estimate

## Required Field Rules

Make a field required only when:
- work cannot start safely without it
- a handoff would be invalid without it
- QA/release/approval needs it as proof

Do not require fields merely because they are nice to have.

## Evidence Fields vs Custom Fields

Use built-in evidence fields for release/lifecycle proof when available:

- review evidence: `review_branch`, `review_commit`, `review_url`
- QA evidence: `qa_verified_commit`, `qa_tested_url`
- deploy evidence: `merged_commit`, `deployed_commit`, `deploy_target`, `deployed_at`
- live verification: `live_verified_by`, `live_verified_at`

Use custom task fields for domain-specific data that is not part of the release gate contract.

## Schema Proposal Template

```text
Default task fields:
- field:
  purpose:
  required:

Task-type overrides:
- task_type:
  fields:
  why this differs:
```

## Field Quality Bar

A good field:
- has a short key
- has a clear label
- has a reason to exist
- is not duplicating title/description/status
- is either optional or truly required

Avoid:
- long prose fields that duplicate notes
- fields only one person cares about once
- required fields that block task creation unnecessarily
- fields named after current agents instead of durable workflow concepts
