---
name: create-task
description: Create well-scoped Agent HQ tasks with the right board placement, workflow, job, priority, blockers, schedule, and acceptance criteria. Use when a user asks to create a task, ticket, backlog item, follow-up, bug, feature request, or implementation brief, especially when the task must be routed to the correct project/workflow/job or when the request is ambiguous and needs structuring before creation.
---

# Create Task

Create tasks as if downstream execution quality depends on the brief - because it does.

## Workflow

1. **Resolve placement before writing**
   - Identify the target `project_id`, workflow id (`sprint_id` compatibility field), and `job_id`.
   - If the user names a board, map it explicitly.
   - If the correct board is unclear, inspect existing Agent HQ projects/workflows/jobs/tasks for matching patterns before asking.
   - Prefer assigning the task to the execution lane that will actually do the work:
     - frontend/UI → frontend job
     - backend/API → backend job
     - QA/review-only → QA job
     - planning/routing/spec work → PM job

2. **Classify the task type**
   - Feature
   - Bug fix
   - Refactor / tech debt
   - QA / audit
   - PM / coordination
   - Research / discovery
   - Scheduled / recurring work

3. **Write the task for execution, not for discussion**
   Include only what materially improves delivery:
   - clear title
   - objective / user-visible outcome
   - scope bullets
   - implementation notes only when they reduce ambiguity
   - acceptance criteria
   - dependencies / blockers
   - board placement

4. **Set assignment fields deliberately**
   - `project_id`: portfolio/project container
   - `sprint_id`: compatibility field for the workflow/board the task should appear under
   - `task_type`: **required** - this is what assignment rules match on to assign the right agent. Never leave null. Use: `backend`, `frontend`, `fullstack`, `data`, `qa`, `ops`, `pm`, `other`
   - `status`: use `todo` when creating tasks for human review before work begins; use `ready` when the task should be picked up immediately by agents
   - `priority`: `high`, `medium`, or `low`
   - `story_points`: **always set** - use the 1/2/3/5/8 scale: 1=trivial, 2=small bug/tweak, 3=medium feature, 5=large/cross-cutting, 8=architectural. Set your best estimate at creation time. Story points are the task creator's responsibility; dev agents do not set or change them.
   - `job_id`: **do NOT set manually** unless you have a specific reason to override assignment. The assignment rules engine assigns the correct agent automatically based on `task_type` + `status`. Setting `job_id` manually bypasses assignment and can send tasks to the wrong agent.
   - `blockers`: set when a task has real upstream dependencies - use `[{"task_id": <id>, "reason": "<why blocked>"}]` format. This is how dependency chains are expressed and enforced on the board.
   - `recurring` / scheduling: only when the task itself is meant to recur

5. **Verify dependencies and task_type before submitting**
   - Before creating a batch of tasks, map out the dependency chain: which tasks must complete before others can start?
   - Set `blockers` on downstream tasks referencing the upstream task IDs
   - Confirm `task_type` routes to the right agent for each task - a PM spec task should have `task_type: pm`, a backend migration task `backend`, a QA verification task `qa`
   - Check that no task in a batch is blocked by a task that hasn't been created yet (create foundation tasks first, then reference their IDs in downstream blockers)

6. **Check for avoidable ambiguity**
   Tighten vague requests before filing:
   - "improve UI" → name the page, component, and expected behavior
   - "fix bug" → state the broken behavior, expected behavior, and trigger path
   - "make it like the old app" → identify the exact parity gaps

7. **Create the task**
   Use Agent HQ API or the local system's standard task creation path.

8. **Record learnable metadata**
   After creating the task, capture enough metadata to improve future task creation. See `references/learning-loop.md`.

## Default task template

Use this structure unless the request is tiny:

- **Title** - short, specific, scoped to one outcome
- **Objective** - what should exist or behave differently when done
- **Scope**
  - bullet list of required work
- **Implementation notes**
  - routes, files, dependencies, data shape, UI placement, or constraints
- **Acceptance criteria**
  - observable done conditions
- **Board placement**
  - project / workflow / job

## Assignment heuristics

Use nearby existing tasks to infer placement.

- Agent HQ UI changes usually belong on the Agency project if that is where product/support work is being managed.
- Put tasks in the workflow that matches the operating lane the user named, not just the repo being changed.
- Match the task to the agent that can complete it end-to-end. Do not route a frontend-heavy task to backend just because it touches data.
- If a task spans frontend + backend and cannot be cleanly split, assign to the lane that owns the user-facing deliverable and note backend support needed.
- Always set `task_type` when assignment rules use it. Use a concrete execution type such as `backend`, `frontend`, `fullstack`, `qa`, `pm`, or another project-standard value rather than leaving it null.
- For Agent HQ / Agency routing today, treat missing `task_type` as a task-creation defect because it can prevent automatic review/QA pickup.

## Description quality bar

A good task lets the worker start without asking basic assignment questions.

Aim for:
- one outcome per task
- enough implementation detail to avoid guesswork
- acceptance criteria that QA can verify

Avoid:
- giant multi-feature bundles unless the user explicitly wants one umbrella task
- speculative architecture notes that are not needed to execute
- vague verbs like "improve", "clean up", or "support" without specifics

## Scheduling rules

If the request includes timing or cadence:
- one-time future action → create/suggest a scheduled task or cron-backed reminder
- repeated operational work → make recurrence explicit
- if scheduling is external to the task, keep the task static and schedule the worker separately

## Learning loop

This skill should not try to learn by stuffing more text into task descriptions.

Prefer a system-level feedback loop:
- log what was requested
- log what task was created
- log execution outcome later
- compare original spec vs final result vs QA outcome

Read `references/learning-loop.md` when designing or improving the feedback mechanism.

## Questions to ask only when necessary

Ask only if the answer materially changes routing or scope and cannot be inferred quickly:
- Which board/workflow should own this?
- Should this be split into frontend/backend tasks?
- Is this a one-off task or part of a recurring workflow?
- Is there an existing task this should block or depend on?

If the likely placement is already clear from context, create the task first and report the placement.
