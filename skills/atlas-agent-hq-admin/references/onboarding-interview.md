# Atlas Onboarding Interview

Use this reference to discover enough workflow structure to configure Agent HQ.

Ask only questions that change configuration. If a detail is obvious from the user's request, infer it and state the assumption in the proposal.

## Minimum Questions

1. What kind of work will Agent HQ manage?
   - software delivery
   - content/editorial
   - sales/CRM
   - operations/incidents
   - research
   - personal task management
   - mixed/custom

2. What roles touch the work?
   - PM/planner
   - frontend/backend/fullstack
   - QA/reviewer
   - release/devops
   - ops/sales/content/editor
   - user/human approval

3. What are the main task categories?
   Use canonical task types when possible:
   - `frontend`
   - `backend`
   - `fullstack`
   - `qa`
   - `design`
   - `marketing`
   - `pm`
   - `pm_analysis`
   - `pm_operational`
   - `ops`
   - `data`
   - `adhoc`
   - `other`

4. How should a task move from start to finish?
   Ask for the real handoffs, for example:
   - plan -> ready
   - ready -> in progress
   - implementation -> review
   - QA pass/fail
   - approval
   - deploy
   - live verify
   - done

5. What evidence is required before handoff?
   Examples:
   - branch and commit
   - tested URL
   - QA notes
   - approval owner
   - deployed commit
   - live verification timestamp
   - external ticket/customer link

6. What should be optimized for model routing?
   - cheapest acceptable model for small tasks
   - stronger model for high-risk tasks
   - provider preference
   - thinking level expectations
   - budget limits or max turns

## Follow-Up Questions

Ask these only when needed:

- Should tasks be auto-dispatched immediately when moved to `ready`?
- Does every implementation task need QA?
- Does every QA pass require a release step?
- Is production deployment part of this workflow?
- Should Atlas create agents now, or only define the workflow?
- Are there existing providers already configured?
- Are there existing agents to reuse?
- Should the workflow be reusable as a workflow type?

## Discovery Output

Before changing configuration, summarize:

```text
Workflow summary:
- Work type:
- Project:
- Workflow / workflow type:
- Roles:
- Task types:
- Lifecycle:
- Required evidence:
- Model/provider policy:
- Assumptions:
- Open questions:
```

## Proposal Output

Use this structure when asking for approval:

```text
Proposed Agent HQ setup:
- Project/workflow:
- Workflow type:
- Task field schema:
- Agents:
- Routing rules:
- Automatic transitions:
- Gate requirements:
- Model routing:
- Verification sample:
```

If the user says "go ahead", apply the proposal. If the user asks for changes, update the proposal first.
