# Atlas Onboarding Interview

Use this reference to discover enough workflow structure to configure Agent HQ.

Ask only questions that change configuration. If a detail is obvious from the user's request, infer it and state the assumption in the proposal.

## Minimum Questions

1. What durable thing is moving through the process?
   Examples: software change, lead, incident, article, request, campaign, or case.

2. Which parts are independently assignable or completable?
   Ask what can run in parallel, be retried separately, have its own blocker, or require separate acceptance. Use the answer to choose case, work-order, or hybrid modeling.

3. What kind of work will Agent HQ manage?
   - software delivery
   - content/editorial
   - sales/CRM
   - operations/incidents
   - research
   - personal task management
   - mixed/custom

4. What roles touch the work, and where are the real responsibility boundaries?
   - PM/planner
   - frontend/backend/fullstack
   - QA/reviewer
   - release/devops
   - ops/sales/content/editor
   - user/human approval

5. Which stable task differences change schema, tools, routing capability, evidence, or definition of done?
   Derive task types from these differences. Resolve allowed values from the workflow definition; do not assume the legacy/default task-type seed list is globally authoritative.

6. How should the durable item or each independent task move from start to finish?
   Ask for the real handoffs, for example:
   - plan -> ready
   - ready -> in progress
   - implementation -> review
   - QA pass/fail
   - approval
   - deploy
   - live verify
   - done

7. Which steps wait for an agent, human, external event, timer, or manual resume?
   This determines assignment coverage and which states intentionally have no agent route.

8. What evidence is required before handoff?
   Examples:
   - branch and commit
   - tested URL
   - QA notes
   - approval owner
   - deployed commit
   - live verification timestamp
   - external ticket/customer link

9. What should be optimized for model routing?
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
- Is QA a stage for the same task or an independent QA deliverable?
- Does `blocked` preserve the current phase or enter a separately owned recovery lane?
- Which roles require different permissions, tools, or independent review?

## Discovery Output

Before changing configuration, summarize:

```text
Workflow summary:
- Work type:
- Durable work item:
- Modeling mode: case | work order | hybrid
- Independent task boundaries:
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
- Work-item model:
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
