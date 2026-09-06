# Task 1048 investigation — 2026-09-06

Task: Reconcile successful external submission when Agent HQ task state regresses.
Scope: investigation only. No workflow rule, marketplace submission, or lead task status was changed. Task 1048 remains paused.

## Findings

### 1. A global runtime mapping overwrites the approved business state

Live mapping 27 matches `source=agent_hq_runtime`, `event_name=agent_started`, with no project, workflow, task type, or included-status restriction. It sets `in_progress`. Its excluded statuses are development-oriented and omit `approved`, `submitted`, `closed`, and `poc_pending`.

Task 1175 in Agency project 99 / Lead Generation workflow 114 is a current reproduction:

| UTC time on 2026-09-04 | Event |
| --- | --- |
| 23:45:53 | Review outcome moves task from review to approved. |
| 23:47:37 | Submission instance 99977791 starts; Casper's callback moves approved to in_progress. |
| 23:48:08.318 | CRM records successful Freelancer bid 493880589. |
| 23:49:17 | Agent records that submit_external was refused because in_progress allows ready_for_review or close. |
| 23:49:33 | Runtime ends without a semantic outcome; missing-outcome mapping 18 preserves the status. |

Sources: task history entries 237777, 237783, 237785, 237794; notes 130593–130600; live workflow metadata. Transition 5292 permits approved → submitted. There is no in_progress → submitted transition.

Code: `api/src/domains/runs/callbacks.ts:31` applies the configured start event; its status write at line 123 does not constrain the previous status. `api/src/domains/routing/externalEventMappings.ts:112` seeds the broad mapping. The resolver at line 1159 skips rules whose status guards do not match and falls back to a broader rule.

**Immediate configuration fix:** add an explicit workflow-114 `agent_started` ignore rule for protected business states, at minimum approved and submitted, also preserving closed and poc_pending. Prefer a workflow-specific catch-all ignore plus a higher-priority ready → in_progress start rule after checking the full workflow. A ready-only rule by itself is insufficient: approved would still fall through to global rule 27. Do not change the global mapping indiscriminately.

**Code hardening:** constrain callback status writes to the state and active instance read earlier, and re-resolve or stop if either changed. Prevent stale lifecycle callbacks from overwriting a newly completed business transition. This race is a code concern, not the proven cause of task 1175's regression.

### 2. Outcome payloads silently discard workflow-specific proof

`agent_hq_post_task_outcome` advertises workflow evidence under `payload`. `normalizeOutcomeBody` merges that payload, but `extractInlineEvidence` only keeps `INLINE_EVIDENCE_FIELD_KEYS`, which are derived exclusively from development lifecycle fields. `submission_proof_url` and `platform_bid_id` are discarded.

Reproduced against the built Agent HQ code without writes:

```text
input: { submission_proof_url: realProofUrl, platform_bid_id: "493880589" }
extractInlineEvidence(input): {}
required proof gate with payload-only evidence: valid=false
same gate with proof already persisted on task: valid=true
```

Code: `api/src/lib/starterCatalog.ts:61`, `api/src/lib/evidenceValidation.ts:303`, `api/src/domains/tasks/release.ts:197`.

This explains a payload-only proof rejection. It does not prove why the original report said already-persisted proof was rejected: task 1047's current API/history reads return Task not found. Task 1175 has persisted proof, and its notes specifically identify the invalid starting state as the remaining rejection.

**Agent HQ code fix:** validate and atomically persist fields allowed by the resolved workflow schema, then evaluate the transition against the merged record in the same transaction. Preserve tenant, role, instance, field-type, and outcome controls; reject unknown/protected fields. Do not simply allow arbitrary payload keys or only add one lead-specific field to the development allowlist.

### 3. CRM already has the successful bid; recovery must read it

Production readback of `/api/submissions?lead_id=108` confirms:

- CRM submission 2, proposal 19, lead 108, organization 550e8400-e29b-41d4-a716-446655440000.
- Platform bid 493880589, Freelancer project 40691397, USD 500, seven days.
- Submitted at 2026-09-04T23:48:08.318Z.
- Approval d98c3fa7-dde7-4d71-bce8-51a3b9fda0f6 is consumed.
- Stored submission evidence correlates Agent HQ task 1175 and run a4073eb3-fa98-4144-99a9-b3b4714b525a.
- Task notes record approval snapshot sha256:8383cab1621854b566ee0a8b2cc876c43bdc19dc88237b6f85dbfb34de8338e7. Recovery must verify this against the CRM snapshot bound to that exact approval, not trust the note.

The normal Agency CRM submit route checks for an unconsumed approval before submission. The CRM MCP operation ledger can replay a completed response only for the same key and exact request hash; that hash includes run context. A later run may differ, and unfinished receipt finalization also requires operator handling. This mechanism is not a general task-state reconciliation API.

The current typed `crm_get_proposal` and lead-context read paths do not return the complete bid receipt. An existing `/api/submissions` GET can read the bid, but it has no organization filter in its handler and is not an adequate scoped recovery contract. The separate lead-generation `confirm_submission` receipt mechanism should not be assumed to cover the older core submission route.

**Agency CRM / crm-mcp code:** expose a scoped, read-only authoritative submission receipt, joining the bid, consumed approval, and exact historical approval snapshot. Reuse persisted bid evidence; do not invoke Freelancer. Bind organization, proposal, lead, task, platform project, approval, amount, currency, and snapshot. Fail closed on missing or conflicting provenance.

**Agent HQ code:** consume that verified receipt through a dedicated reconciliation operation. Atomically write proof and a uniquely keyed reconciliation receipt, move an eligible regressed task to submitted, and record truthful history. Permit a scoped operator or authorized recovery worker to reconcile an ended run without impersonating its old instance. A replay must be a no-op; incompatible terminal states require review. This operation must never place a bid or increment CRM bid counts.

Do not add an unrestricted in_progress → submit_external transition as a substitute for verifying the receipt.

### 4. Related CRM crash window deserves a bounded follow-up

`app/api/integrations/freelancer/submit/route.ts` calls Freelancer before beginning the transaction that persists the successful bid. Its shared error handler resets a submitting approval to approved. If the external bid succeeds but local persistence fails, that handler can misclassify the result and restore apparent retry eligibility. This was found by code inspection; it is not evidence that it occurred for task 1175, whose bid is persisted.

Separate definitive platform rejection from unknown/post-success persistence failure, retain an unresolved submission state, and reconcile before any retry. Do not expand task 1048 into a new bidding system.

## Proposed implementation order and verification

1. Configure and test protected start states in workflow 114; verify normal ready starts still work and other workflows retain their behavior.
2. Fix Agent HQ workflow-evidence extraction and atomic outcome persistence. Cover payload-only proof, persisted proof, unknown fields, rollback, and role/tenant denial.
3. Add the scoped CRM receipt read and Agent HQ reconciliation operation. Cover exact snapshot/task binding, fabricated proof, mismatched organization, replay, concurrent consumption, ended runs, and zero marketplace calls / zero additional bid counts.
4. Reconcile task 1175 using existing CRM submission 2. Locate or restore task 1047 through an authorized process before attempting its original acceptance check; do not recreate or resubmit its bid based only on a note.
5. Address the CRM persistence crash window with an injected post-platform-success database failure test.

Ownership: Agent HQ owns lifecycle mappings, evidence handling, and task reconciliation. The `agency` repository owns CRM receipt provenance and the `crm-mcp` interface. No OpenClaw source change is indicated by this investigation.
