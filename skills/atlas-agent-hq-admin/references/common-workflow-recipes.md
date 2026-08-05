# Common Workflow Recipes

Use these as starter patterns. Adjust them to the user's workflow before applying.

## Software Delivery

Roles:

- PM/Atlas
- frontend engineer
- backend engineer
- fullstack engineer if needed
- QA
- release/devops

Task types:

- `frontend`
- `backend`
- `fullstack`
- `qa`
- `pm`
- `ops`

Lifecycle:

```text
todo -> ready -> in_progress -> review -> ready_to_merge -> deployed -> done
```

Common transitions:

```text
in_progress + completed_for_review -> review
review + qa_pass -> ready_to_merge
review + qa_fail -> ready
ready_to_merge + deployed_live -> deployed
deployed + live_verified -> done
```

Common gates:

- `completed_for_review`: `review_branch`, `review_commit`
- `qa_pass`: `qa_verified_commit`, `qa_tested_url`
- `deployed_live`: `deployed_commit`, `deploy_target`, `deployed_at`
- `live_verified`: `live_verified_by`, `live_verified_at`

## Content / Editorial

Roles:

- strategist/PM
- writer
- editor
- publisher

Task types:

- `marketing`
- `design`
- `pm`
- `adhoc`

Lifecycle:

```text
todo -> ready -> in_progress -> editorial_review -> approved -> published -> done
```

Fields:

- target audience
- channel
- draft URL
- approval owner
- publish date

Routing:

- `marketing + ready` -> writer
- `marketing + editorial_review` -> editor
- `marketing + approved` -> publisher

## Ops / Incident

Roles:

- triage/PM
- operator
- verifier

Task types:

- `ops`
- `data`
- `pm_operational`
- `adhoc`

Lifecycle:

```text
todo -> ready -> in_progress -> verification -> done
```

Fields:

- incident/source
- impact
- affected system
- mitigation
- verifier

Routing:

- `ops + ready` -> operator
- `ops + verification` -> verifier
- `pm_operational + ready` -> PM/triage

## Sales / CRM

Choose the modeling mode before applying this recipe.

Case mode keeps one lead task moving through domain-specific statuses:

```text
intake -> qualification -> research -> outreach_draft -> human_approval -> sent -> follow_up -> done
```

Work-order mode creates independently owned tasks such as `lead_research`, `outreach_copy`, and `follow_up`, each with a broad lifecycle:

```text
todo -> ready -> in_progress -> review -> done
```

Hybrid mode keeps a lead case and relates independently executable research, drafting, or follow-up tasks to it. Prefer hybrid mode when those deliverables run in parallel or need separate acceptance.

Roles:

- researcher
- outreach agent
- follow-up agent
- manager/reviewer

Example work-order task types:

- `lead_research`
- `outreach`
- `follow_up`
- `sales_review`

For case mode, prefer a stable workflow-specific type such as `lead` rather than changing the task type at every stage.

Work-order lifecycle:

```text
todo -> ready -> in_progress -> review -> done
```

Fields:

- company
- contact
- source
- stage
- next follow-up date
- value estimate

Routing:

- `lead_research + ready` -> researcher
- `outreach + ready` -> outreach agent
- `follow_up + ready` -> follow-up agent
- `all task types + review` -> manager

## Lightweight Personal Workflow

Roles:

- Atlas/helper
- optional specialist agents

Task types:

- `pm`
- `adhoc`
- `ops`
- `other`

Lifecycle:

```text
todo -> ready -> in_progress -> done
```

Fields:

- success criteria
- due date
- context link

Routing:

- `pm + ready` -> Atlas/helper
- `adhoc + ready` -> generalist agent

Keep this workflow simple. Do not add QA/release gates unless the user explicitly needs them.
