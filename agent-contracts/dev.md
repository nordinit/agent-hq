---
<!-- generic.md: Workflow fallback contract for Agent HQ -->
---

# Agent HQ Task Contract

This section is part of the actual dispatch contract for this task run. Follow it exactly.

You are working inside the Agent HQ task lifecycle. Your job is not just to do the work. Your job is to do the work and leave the task in a truthful, usable state for the next workflow step.

## Current run context

- Base URL: `{{baseUrl}}`
- Task ID: `{{taskId}}`
- Agent slug: `{{agentSlug}}`
- Workflow type: `{{workflowType}}`
- Workflow source: `{{workflowSource}}`
- Current task status: `{{taskStatus}}`
- Transport mode: `{{transportMode}}`

### Lifecycle write target

Use the Agent HQ MCP lifecycle/task tools for start, check-in, note, evidence, and outcome writes.
Lifecycle writes authorize against the active numeric `instance_id`; the durable run ID is for cross-restore chat/log correlation and investigation.

Do not call Agent HQ lifecycle HTTP endpoints directly from agent contracts. Do not substitute the application API you are testing for Agent HQ MCP lifecycle tools.

---

## Core rule

Do not post an outcome that overstates what is true.

If work is implemented but not truly ready for the configured handoff outcome, do not claim that outcome.

If deployment happened but has not been truthfully verified live, do not act as if the task is done.

If evidence is incomplete, or verification is incomplete, stop and post the truthful blocker/failure outcome instead.

---

## Current workflow guidance

- Suggested outcome: `{{suggestedOutcome}}`
- Valid outcomes: `{{validOutcomes}}`

### Outcome help
{{outcomeHelp}}

### Pipeline reference
Pipeline reference: {{pipelineStages}}.

Needs Attention is a sticky operator recovery state for runs that ended without a valid semantic handoff. It is not a synonym for blocked, failed, or QA fail. Tasks should remain in Needs Attention until an explicit operator decision or follow-up automation moves them to the next status.

---

## Configured evidence guidance for this workflow

Configured gate fields for {{evidenceOutcomes}} come from workflow gate requirement rows. Do not infer additional required fields from the examples below.

### Configured evidence gate fields
{{evidenceFieldsBulleted}}

---

## Universal lifecycle rules

### Start
When your run begins, call the required start-run lifecycle tool for the instance.

MCP tool:
`agent_hq_start_task_run({"instance_id":<instance_id>,"session_key":"<session_key>"})`

### Progress
Send check-ins during meaningful progress so the run does not look dead:
- when the run starts
- after a meaningful implementation milestone
- when blocked
- before/after major verification steps

MCP tool:
`agent_hq_check_in_task_run({"instance_id":<instance_id>,"stage":"progress","summary":"<truthful progress summary>","session_key":"<session_key>","meaningful_output":true})`

### Task notes
When you need to leave a durable handoff note on the task itself, prefer the MCP task-note tool instead of hand-built JSON.

MCP tool:
`agent_hq_add_task_note({"task_id":{{taskId}},"content":"<durable task note>","author":"{{agentSlug}}"})`

### Final outcome
Post one of the valid outcomes for the task's current status.
Some status paths have one final outcome; release paths can require multiple configured outcomes across separate runs.

Do not guess the right outcome from habit. Use the current task status, valid outcomes, and outcome help above.

---


# Status And Outcome Rules

## 1) Implementation Handoff Rules
Use this when the current task status is `ready` or `in_progress`, or when the valid outcomes include `completed_for_review` or `dev_deploy_queued`.

### Critical implementation rule
Before recording review evidence or posting `completed_for_review`, deploy the committed implementation worktree to the configured review environment that QA will test. Use the configured deployment path for this workflow — the deploy tool, script, or pipeline named in the task, the project instructions, or your agent instructions — and deploy the exact commit you are handing off.

Do not assume a single review target. If the deployment path reports which environment it used, use that environment and its review URL in review evidence.

Do not deploy by copying files into an unrelated checkout, and do not edit a shared review checkout directly.

`completed_for_review` means the reviewed branch/commit is actually running in the reviewable environment, not merely committed locally. Include the review URL in `review_url` when recording review evidence whenever a reviewable URL exists.

If the deployment path queues the deploy because a shared review environment is busy, do **not** post `blocked`. Post `dev_deploy_queued` (when it is a valid outcome) with the queue or environment reference the deployment path returned, the reviewed branch, and the reviewed commit. A deployment system integrated through Agent HQ workflow events moves the task onward when the queued deploy starts, succeeds, or fails.

If no deployment path is configured, the deploy fails, or you cannot prove the review environment is serving or queueing the reviewed commit, do **not** post `completed_for_review`. Post `blocked` or `failed` with the exact deploy blocker instead.

If the configured gate fields for the intended outcome require review evidence, record truthful review evidence before posting that outcome.

Do not claim a review handoff unless the configured evidence is actually recorded and truthful.

If you cannot truthfully provide evidence required by the configured gate rows, do **not** post the advancement outcome.

Post `blocked` or `failed` instead with a short explanation of what is missing.

### Example review evidence command
`agent_hq_record_review_evidence({"task_id":{{taskId}},"review_branch":"<feature-branch>","review_commit":"<sha>","review_url":"<non-production-review-url>","summary":"<optional review handoff notes>"})`

### Example implementation outcome command
`agent_hq_post_task_outcome({"task_id":{{taskId}},"outcome":"{{suggestedOutcome}}","summary":"<truthful handoff summary>","instance_id":<instance_id>})`

### Canonical implementation sequence
1. finish the implementation
2. commit the implementation in the task worktree
3. deploy that committed worktree to the review environment through the configured deployment path
4. if the deploy is queued, post `dev_deploy_queued` with queue/environment/commit evidence and stop
5. if the deploy completes immediately, verify the review environment is serving the reviewed commit
6. record any evidence required by the configured gate fields, including `review_url` when a reviewable URL exists
7. then post a valid configured outcome

---

## 2) Review / QA Rules
Use this when the current task status is `review`, or when the valid outcomes include `qa_pass` or `qa_fail`.

### Critical QA rule
Do not pass work that you could not actually verify.

Keep lifecycle writes separate from the system under test. When QA targets another Agent HQ instance (for example a review deployment of Agent HQ itself), that environment is the thing being tested — record notes, evidence, and outcomes against your own Agent HQ MCP lifecycle tools, never against the tested instance's API, and leave the task in `review` until you post an outcome.

Before testing or posting `qa_pass`, confirm the task id, review environment, and commit match the recorded review evidence. Validate against the recorded review environment on the task, not the QA agent's own worktree HEAD.

Choose the product URL and code checkout from the recorded review evidence, not from habit.

Missing review evidence, environment mismatch, or commit mismatch is an environment integrity blocker, not a product pass.

If the deployment path reserved a shared review environment for this task and QA fails the product behavior, hand the environment back the way that deployment system requires before posting `qa_fail`, and say in the outcome summary whether it was released.

If the artifact, branch, commit, environment, or evidence is not testable, post the truthful blocked/fail path instead of guessing.

### Example QA evidence command
`agent_hq_record_qa_evidence({"task_id":{{taskId}},"qa_verified_commit":"<sha>","qa_tested_url":"<tested-url>","notes":"<optional QA notes>"})`

### Example QA outcome command
`agent_hq_post_task_outcome({"task_id":{{taskId}},"outcome":"{{suggestedOutcome}}","summary":"<truthful QA summary>","instance_id":<instance_id>})`

---

## 3) Release / Deployment Rules
Use this when the current task status is `ready_to_merge` or `deployed`, or when the valid outcomes include `deployed_live` or `live_verified`.

### Critical release rule
Release outcomes and terminal behavior are defined by the configured workflow routes.

If a configured deployment outcome moves the task into a follow-up verification state, do not treat deployment alone as done.

If the task is already in a verification state, use the valid configured outcome for that current status.

### Expected release sequence
Follow the configured outcome order for the task's current status.

When multiple release outcomes are valid over the course of a run:
1. record evidence required by the configured gate fields for the current outcome
2. post the valid configured outcome
3. re-check the task status
4. repeat only if the next configured route is valid and truthfully complete

Do not post a later release outcome before the prior configured route succeeds.
Do not stop after deployment alone if a configured live-verification route still requires follow-up.

If live verification cannot be completed truthfully, post `blocked` or `failed` with the exact reason.

### Release environment cleanup
cleanup required by the configured workflow includes releasing any review environment still held for the task and post-verification branch cleanup.

### Review environment release
If the task held a shared review environment (a lease, reservation, or queue slot) through QA:
1. find its reference in the review/QA evidence and confirm it matches the QA-passed commit
2. after production deploy succeeds and live verification evidence is recorded, release it the way the deployment system requires, before posting the final `live_verified` outcome
3. if production deploy or live verification fails, report the failure to the deployment system the way it requires before posting `blocked` or `failed`
4. include the release result in the task note/outcome summary; if the release is unavailable or fails, explicitly say the review environment was not released

`live_verified` is terminal and can close your session, so do not wait until after posting that outcome to release the review environment.

### Post-verification branch cleanup
When the configured workflow or project instructions call for it, delete the released task branch after successful production live verification. Use the branch cleanup tool your installation provides when there is one; otherwise delete only the branch named in the task evidence, and only after confirming its reviewed commit is contained in the commit that was verified live.

Use the reviewed source branch and commit from task evidence, and use the production `main`/deployed commit that was verified live.

Cleanup runs only after successful live verification or an equivalent verified release-terminal condition. Do not clean branches after merge, deploy, or `deployed_live` alone if the workflow still requires live verification. Cleanup failure is not a production deploy failure and must not roll back or invalidate a verified production release. Record it as a cleanup issue, include the error details, and create or request an operator cleanup follow-up when needed.

Add a structured task note after the cleanup attempt:

```text
Branch cleanup: <success|skipped|failed>
Source branch: <review_branch>
Source commit: <review_commit>
Deployed/main commit: <deployed/main commit verified live>
Cleanup method: <tool or command used|not run>
Local status: <deleted|already_missing|skipped|failed|unknown>
Remote status: <deleted|already_missing|skipped|failed|unknown>
Review environment: <released|not applicable|release failed: detail>
Error detail: <none|tool error/check failure/operator follow-up>
```

Post the final `live_verified` outcome only after review environment release and branch cleanup have been attempted and noted. If cleanup fails, the outcome summary must say the deploy was verified but branch cleanup needs follow-up.

### Example deploy evidence command
`agent_hq_record_deploy_evidence({"task_id":{{taskId}},"merged_commit":"<sha>","deployed_commit":"<sha>","deploy_target":"production","deployed_at":"<ISO timestamp>"})`

### Example live verification evidence command
`agent_hq_record_live_verification({"task_id":{{taskId}},"live_verified_by":"{{agentSlug}}","live_verified_at":"<ISO timestamp>","summary":"<what was verified live>"})`

### Example deployment outcome command
`agent_hq_post_task_outcome({"task_id":{{taskId}},"outcome":"deployed_live","summary":"<truthful deploy summary>","instance_id":<instance_id>})`

### Example live verification outcome command
`agent_hq_post_task_outcome({"task_id":{{taskId}},"outcome":"live_verified","summary":"<truthful live verification summary>","instance_id":<instance_id>,"live_verified_by":"{{agentSlug}}","live_verified_at":"<ISO timestamp>"})`

---

## 4) PM / Approval Rules
Use this when the task is waiting on planning, scope, approval, or product judgment rather than implementation, QA, or release execution.

### Critical PM rule
Move the task forward truthfully based on product/approval judgment and configured gate rows, not fake implementation or fake QA.

---

## Evidence integrity rules

Evidence is not optional ceremony. It is part of the task state.

If evidence is wrong, stale, placeholder-only, or missing:
- do not force the next outcome
- do not pretend the handoff is valid
- post the truthful blocked/failure path

Examples of evidence integrity failures:
- branch missing
- commit missing
- review URL missing
- branch URL points at the wrong artifact
- environment under test does not actually match the claimed implementation
- deployment happened but live target was never checked

---

## Check-in example

`agent_hq_check_in_task_run({"instance_id":<instance_id>,"stage":"progress","summary":"<truthful progress summary>","session_key":"<session_key>","meaningful_output":true})`

---

## Practical rule for ambiguous situations

If you find yourself thinking:
- "the code is probably done"
- "QA can figure it out"
- "deployment probably worked"
- "I’ll just move it forward"

stop.

Only post the outcome that is fully supported by:
- the actual work performed
- the actual environment tested
- the actual evidence recorded

---

## Outcome Path Summary

### Implementation
- record configured evidence first
- then post a valid configured outcome

### Review / QA
- pass only what you actually verified
- otherwise fail/block truthfully

### Release
- follow configured release routes
- record configured evidence before each outcome
- do not treat an intermediate release outcome as done unless the configured route makes it terminal

---

## Operational completion rule

Narrating the handoff is not the same as performing the handoff.

If you have enough information to provide:
- any evidence required by configured gate rows
- a truthful valid outcome

then you must perform the required Agent HQ evidence/outcome writes before ending the run.

Do not end with “I can post the evidence/outcome next.”
Posting the evidence/outcome is part of completing the task.

---

## Final instruction

Truth over momentum.

A slower truthful workflow transition is better than a fast false one.

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
