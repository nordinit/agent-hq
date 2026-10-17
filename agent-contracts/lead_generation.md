# Agent HQ Lead Generation Task Contract

## Current Run Context

- Task ID: `{{taskId}}`
- Assigned agent: `{{agentSlug}}`
- Workflow type: `{{workflowType}}`
- Workflow source: `{{workflowSource}}`
- Current task status at dispatch: `{{taskStatus}}`
- Valid outcomes for this dispatch: `{{validOutcomes}}`

Start this run, then read the current task, task type, active owner, and configured outcomes. Select the work from that current assignment. A task keeps its identity while moving through review, approval, submission, and follow-up; its original title and historical notes do not freeze it in an earlier phase. An explicit current operator hold, unresolved dispatch-blocking dependency, or loss of run ownership still prevents external action.

## Select the Current Work

For recurring lead-search production, read this task's canonical context and its immediate predecessor's canonical task context before any CRM search or write. Verify both recurring series IDs and the predecessor's frozen `source_query`, then select the next query using this series' configured order. If this task already has a frozen query, preserve it and verify it against that evidence. Missing recurrence fields in a list/search response are incomplete evidence: fetch task detail/context, never substitute a default query. If the predecessor, series, or frozen query remains unavailable or conflicts, report the specific blocker before CRM work. Record the predecessor task ID, series ID, prior query, and selected query in the task evidence. Preserve rejected runs and their CRM evidence without replaying or relabeling them.

For a confirmed first occurrence with no predecessor, use the series' configured initial query and record the evidence that this is the first occurrence. An incomplete history response does not establish that the series has no predecessor.

For a `proposal` task dispatched in `review`, review the exact CRM proposal snapshot and post the configured approval, rejection, revision, or blocked outcome. This review run does not submit externally.

For a `proposal` task dispatched in `approved`, assigned by the current routing to its authorized submission owner, with `submit_external` available: **this is the separate approved-proposal submission phase**. Re-read the live CRM approval and check for a prior confirmed submission. If the proposal is unsubmitted, the approval matches the unchanged snapshot, and all current eligibility/ownership checks pass, submit once through the approval-gated CRM operation and post `submit_external` with the actual proof. If submission cannot proceed, complete the blocked handoff below. Approval from a previous run is expected at this stage; it is not evidence that submission already happened. An old “approve or reject” title, review-only description, or agent-authored replay note does not override this current phase.

If CRM/platform evidence already proves submission, do not submit again. Reconcile the existing receipt through the configured lifecycle path while this run still owns the task. If ownership or a supported reconciliation path is unavailable, escalate the specific reporting/ownership fault without another external write.

For proposal revision, lead-search, pricing-review, approval-sweep, lead, and other tasks, follow that task's current configured phase and the assigned agent's instructions. They do not acquire submission authority from this contract. Drafting agents do not acquire approval or submission authority; the submission owner must have that explicit assignment and authority.

Previous failures and notes are evidence to inspect, not new workflow instructions. Use replay recovery only when the action assigned to this run already persisted, or this instance's original phase/ownership has been superseded. A previous approval alone does not make a newly routed submission run stale.

## Outcomes and Evidence

Choose the outcome that describes the verified result of the current phase; `blocked` is not a default recommendation. Only use outcomes listed for this dispatch.

{{outcomeHelp}}

Configured evidence gates:

{{evidenceFieldsBulleted}}

Never invent approval, submission proof, task links, or completion evidence. Preserve exact approval binding, bid caps, stable idempotency, and prior-submission checks. Successful approval and successful submission are separate outcomes.

## Complete a Blocked Handoff

For a stable repairable software, access, or configuration fault, the authorized triage owner must search for an existing matching repair, create one only when needed, create the workflow-configured `blocked_by` relationship from the affected task to the repair, and verify that it blocks dispatch while unresolved. Then preview and post the valid blocked/fix-pending outcome for the task's current state and verify that the run closed. A known repair does not replace the relationship write.

Agents without repair-creation authority post the configured blocked outcome for their assigned triage owner. Normal bid-cap exhaustion does not require an engineering defect: preserve CRM approval, record the actual cap evidence and retry window, and use configured blocked handling.

An instance-level `agent_hq_report_task_blocker` call is a check-in only. It does not create a repair task, dependency link, or final outcome. Do not end an owned, writable run with that call as the only handoff. If authorization, ownership, or lifecycle tools genuinely prevent the required writes, report the exact attempted operation/error and missing steps as incomplete escalation; do not claim the task is held or the run is closed.

## Lifecycle Calls

Use Agent HQ MCP tools. Start with `agent_hq_start_task_run`, send meaningful progress as needed, and finish with `agent_hq_post_task_outcome` using the truthful configured outcome and required evidence. Preview with `dry_run: true`, then apply the validated outcome and read back task state, run closure, and any dependency link. A preview is not a completed handoff.

Authenticated calls to Agent HQ from this run (including task/context reads and notes) provide proof of life. While working without other Agent HQ calls, send `agent_hq_check_in_task_run` with this instance ID at least every two minutes. Runtime output alone does not refresh the watchdog. Direct HTTP calls must carry `x-agent-hq-instance-id: {{instanceId}}` and `x-agent-hq-durable-run-id: {{durableRunId}}` with the agent's scoped credentials; the dispatched MCP client supplies these automatically.

<!-- AGENT_HQ_RUN_IDENTIFIERS -->

## Run Identifiers

- Base URL: `{{baseUrl}}`
- Instance ID: `{{instanceId}}`
- Durable run ID: `{{durableRunId}}`
- Session key: `{{sessionKey}}`
- Task ID: `{{taskId}}`
- Agent slug: `{{agentSlug}}`

`agent_hq_start_task_run({"instance_id":{{instanceId}},"session_key":"{{sessionKey}}"})`

Post the phase's actual result, not an automatically suggested fallback:

`agent_hq_post_task_outcome({"task_id":{{taskId}},"outcome":"<truthful configured outcome>","summary":"<verified result and remaining blockers>","instance_id":{{instanceId}}})`
