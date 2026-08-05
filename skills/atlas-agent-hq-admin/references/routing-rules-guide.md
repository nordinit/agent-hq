# Assignment Rules Guide

Assignment Rules control who owns dispatched work.

Keep three concepts separate:

- **Assignment rule**: assigns a task in a sprint for `task_type + status` to an agent.
- **Automatic transition**: maps an outcome from one status to the next status.
- **Gate requirement**: requires evidence before a transition/outcome can proceed.

## Assignment Rule Design

Create explicit sprint-scoped assignment rules for every routable lane.

Typical pattern:

```text
sprint_id + task_type + status -> agent_id
```

Examples:

```text
backend + ready -> backend agent
frontend + ready -> frontend agent
fullstack + ready -> fullstack agent
all task types + review -> QA agent
all task types + ready_to_merge -> release/devops agent
```

If a status should not auto-dispatch, do not create an assignment rule for it.

## Automatic Transition Design

Automatic transitions answer: "When an agent posts this outcome from this status, where should the task go?"

Examples:

```text
in_progress + completed_for_review -> review
review + qa_pass -> ready_to_merge
review + qa_fail -> ready
ready_to_merge + deployed_live -> deployed
deployed + live_verified -> done
```

Transitions should reflect the user's real workflow, not the agent lineup.

## Gate Requirement Design

Gate requirements answer: "What proof must exist before this outcome is allowed?"

Examples:

```text
completed_for_review requires review_branch and review_commit
qa_pass requires qa_verified_commit and qa_tested_url
deployed_live requires deployed_commit, deploy_target, deployed_at
live_verified requires live_verified_by and live_verified_at
```

Use gate requirements for truth and auditability. Do not use them for optional notes.

## Assignment Rule Checklist

For each sprint:

- List allowed task types.
- Classify statuses as agent-actionable or intentionally waiting for a human, event, timer, or manual resume.
- List agent-actionable statuses that should dispatch.
- For each `task_type + status`, choose exactly one primary agent unless intentional fan-out is supported.
- Confirm each chosen agent is enabled and assigned to the right project/workflow.
- Confirm there are no duplicate high-priority rules that would make ownership ambiguous.

## Avoid Legacy/Fallback Assumptions

Do not rely on legacy per-agent config or "last assigned agent" fallback behavior.

If Atlas cannot point to an explicit assignment rule for a task type and status, say that the task may not dispatch.

## Common Missing Routes

Watch for:

- `review` status without QA routing.
- `ready_to_merge` without release/devops routing.
- PM task types without PM routing.
- `qa_fail` transitions that move work to a status with no implementation routing.
- Intentional waiting statuses with no configured or documented trigger.
- New task types added to a workflow type but not added to assignment rules.

## Proposal Template

```text
Assignment rules:
- task_type + status -> agent

Automatic transitions:
- from_status + outcome -> to_status

Gate requirements:
- outcome -> required fields
```

## Verification

After creating rules, create or inspect one sample task per major task type and state:

```text
Sample: backend task, 3 points, status ready
Expected route: backend + ready -> Cinder
Expected model route: provider/model/thinking
Expected next transition: completed_for_review -> review
Required evidence: review_branch, review_commit
```
