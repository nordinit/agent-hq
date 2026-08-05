# Work Modeling Guide

Use this reference before choosing workflow definitions, routing rules, or agents.

## Contents

- Core ontology
- Choose the unit of work
- Choose task-type and status granularity
- Map the model into Agent HQ
- Design outcomes and gates
- Compile assignment rules
- Hand off to agent design
- Detect modeling smells
- Produce the proposal

## Core Ontology

Apply these invariants:

- **Task type** describes what remains true for the life of a task.
- **Status** describes what is true now and what can happen next.
- **Outcome** describes the event that just occurred.
- **Agent run state** describes one execution attempt, not the workflow lifecycle.
- **Agent** describes a durable execution role, not a temporary task variation.

Do not choose between “specific task types” and “specific statuses” globally. Put specificity on the axis where the real variation exists.

## Choose The Unit Of Work

First identify the durable object moving through the process: a change, lead, incident, article, request, campaign, or other case.

Choose one of three modes:

### Case

Use one long-lived task with domain-specific statuses when the same object changes hands and accumulates evidence.

Example:

```text
lead: intake -> qualification -> research -> outreach_draft -> human_approval -> sent -> follow_up -> done
```

### Work Order

Use separate, specific tasks with a broad lifecycle when each deliverable can be scheduled, assigned, retried, or accepted independently.

Example:

```text
research_brief: todo -> ready -> in_progress -> review -> done
outreach_copy: todo -> ready -> in_progress -> review -> done
```

### Hybrid

Keep a durable parent/case task and create related executable tasks for independently owned deliverables. Use configured task relationships for dependency or provenance semantics.

Prefer hybrid modeling when work must both preserve end-to-end case history and support parallel execution.

Split work into another task when it can be:

- assigned independently
- run in parallel
- blocked without stopping the whole case
- retried independently
- accepted with its own evidence
- prioritized or scheduled independently

Keep it as a status change when the same deliverable persists and only its current responsibility or valid next action changes.

## Choose Task-Type And Status Granularity

Create a distinct task type when stable differences affect one or more of:

- input field schema
- definition of done
- required tools or repository access
- routing capability
- risk, model, or cost policy
- evidence contract

Do not create a task type merely for a lifecycle phase, agent name, priority, story points, or one-off instruction.

Task-type names can represent either a work kind (`bug`, `incident`, `lead`) or a durable routing lane (`backend`, `frontend`, `data`). State which interpretation the workflow uses. If both dimensions matter, use the task type for the dimension that controls schema and routing most strongly, and use fields or related tasks for the other. Do not invent unsupported payload fields.

Create a distinct status when the same task persists but one or more of these changes:

- responsible actor or role
- allowed outcomes
- required handoff evidence
- dispatch eligibility
- human, event, or timer wait condition
- meaningful SLA or reporting boundary

Do not create a status for an agent's internal micro-step. Use run history, notes, evidence fields, or subtasks instead.

Prefer statuses that describe current truth:

- Prefer `awaiting_response` to `message_sent` when waiting is the current condition.
- Prefer `review` plus outcome `qa_pass` to an intermediate `qa_pass` status when passing QA moves directly to the next actionable state.
- Treat `failed` as a task status only when the workflow has actually ended or entered a distinct recovery lane; a failed run can leave the task in its current workflow state.

Treat `blocked` and `needs_attention` carefully. Use a dedicated status only when it creates a distinct recovery owner or path. Otherwise preserve the current phase and represent the impediment through relationships, failure detail, blocker reason, or other supported task context.

## Map The Model Into Agent HQ

Map the user process as follows:

```text
repeatable process                  -> workflow type
operating instance / board         -> workflow
durable or independently owned unit -> task
stable task classification         -> task type
current actionable/waiting state   -> status
event that moves work              -> outcome
proof required for the event       -> gate requirement
who acts in a state                -> assignment rule
one execution attempt              -> agent run
```

Classify each nonterminal status during design as one of:

- agent-actionable
- human-waiting
- event-waiting
- timer-waiting
- manual hold

This classification is a design annotation, not necessarily a stored status field. Configure only supported Agent HQ objects:

- Agent-actionable states need assignment coverage.
- Human-waiting states need an explicit human action and an escalation expectation.
- Event-waiting states need a workflow event mapping or a documented manual fallback.
- Timer-waiting states need a supported scheduled/event mechanism or a documented manual fallback.
- Manual holds must say who can resume them.

Do not create an assignment rule merely to silence a graph warning for an intentionally non-agent state. Explain and verify the intended trigger instead.

## Design Outcomes And Gates

Name outcomes as events or results, not destinations:

```text
completed_for_review
qa_pass
qa_fail
approval_granted
approval_rejected
deployed_live
live_verified
```

Keep transitions independent of the current agent lineup:

```text
current status + outcome + optional task type -> next status
```

Use task-type-specific transitions only when that type has a genuinely different lifecycle. If most transitions diverge by task type, consider separate workflow types.

Require evidence only when it establishes safe handoff, approval, release truth, or auditability. An outcome gate should prove the claimed event; it should not collect optional narrative.

For the development workflow, treat `qa_pass` as an outcome and gate key:

```text
review + qa_pass -> ready_to_merge
```

Do not recreate an intermediate `qa_pass` status unless the user explicitly designs a separate post-QA holding state with meaningful behavior.

## Compile Assignment Rules

Compile assignment from the modeled responsibilities:

```text
workflow scope + current status + optional task type -> agent
```

Use an all-task-types rule when the same durable role owns a status for every type. Add type-specific rules only where capability or authority differs.

Typical development pattern:

```text
backend + ready -> backend implementer
frontend + ready -> frontend implementer
all task types + review -> reviewer
all task types + ready_to_merge -> release agent
```

If a status should not auto-dispatch, do not create an assignment rule for it.

Prefer reusable workflow-type defaults. Use workflow overrides only for a real instance-specific exception. Keep precedence visible in the proposal.

## Hand Off To Agent Design

Derive roles from responsibility boundaries after the workflow is modeled. Give the agent designer:

- owned task types and statuses
- required inputs and field schemas
- allowed outcomes
- evidence obligations
- tools, repositories, and permissions
- prohibited actions and escalation conditions
- expected workload, concurrency, risk, and model policy

Do not equate every status with a separate agent. Reuse one agent across statuses when the mission, authority, tools, and quality bar remain coherent.

## Detect Modeling Smells

Reconsider the model when:

- a task type is named after an agent
- a status combines role and activity, such as `frontend_doing_work`
- a task changes type as it advances
- `qa_pass` or another event is used as both an outcome and an unnecessary holding status
- many task types exist only to obtain different agents
- many statuses exist only to record internal execution steps
- every task type needs a mostly different transition graph
- one task contains independently assignable parallel deliverables
- an intentional waiting status has neither an event, human action, timer, nor manual owner
- a routable intersection has no assignment rule

## Produce The Proposal

Before applying configuration, present:

```text
Work model:
- Durable work item:
- Modeling mode: case | work order | hybrid
- Task boundary:
- Task types and why each is stable:
- Statuses and what is true in each:
- Non-agent waiting states and triggers:

Workflow policy:
- Outcomes and transitions:
- Evidence gates:
- Assignment rules:
- Rework, blocked, failure, and cancellation paths:

Agent design inputs:
- Durable roles:
- Required tools/permissions:
- Separation-of-duties boundaries:
- Model/cost assumptions:

Verification traces:
- Happy path:
- Rework path:
- Failure or blocked path:
- Human/event/timer path, if applicable:
```
