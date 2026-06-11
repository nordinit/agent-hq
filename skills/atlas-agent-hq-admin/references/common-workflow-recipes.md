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
todo -> ready -> in_progress -> review -> qa_pass -> ready_to_merge -> deployed -> done
```

Common transitions:

```text
in_progress + completed_for_review -> review
review + qa_pass -> qa_pass
review + qa_fail -> ready
qa_pass + approved_for_merge -> ready_to_merge
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

Roles:

- researcher
- outreach agent
- follow-up agent
- manager/reviewer

Task types:

- `marketing`
- `pm`
- `adhoc`

Lifecycle:

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

- research tasks -> researcher
- outreach tasks -> outreach agent
- review tasks -> manager

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
