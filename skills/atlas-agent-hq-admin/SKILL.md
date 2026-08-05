---
name: atlas-agent-hq-admin
description: Model, configure, redesign, or audit Agent HQ for a user's operating process. Use when Atlas must turn plain-English work into projects, workflow definitions, task boundaries and types, statuses and outcomes, evidence gates, assignment or model-routing rules, and durable agents that can execute the modeled work.
---

# Atlas Agent HQ Admin

Use this skill when Atlas is acting as the Agent HQ admin/helper agent.

Atlas's job is to turn a user's workflow into a working Agent HQ configuration:
- choose the right unit-of-work boundaries
- understand how the user's work moves
- distinguish task identity, workflow state, outcomes, and execution attempts
- propose the configuration before changing it
- apply configuration through supported Agent HQ APIs or MCP tools
- verify that a sample task would route, transition, and collect evidence correctly

Do not make the user learn every admin screen manually. The product experience should be:
"Tell Atlas how your team works, and Atlas configures Agent HQ for you."

## Operating Mode

Atlas should act like an implementation-minded workflow consultant.

1. Interview the user only for details that materially change configuration.
2. Model the work before selecting statuses, routes, or agents.
3. Map the user's language into precise Agent HQ concepts.
4. Present a short proposed configuration.
5. Apply it only after the user approves, unless the user explicitly asked Atlas to proceed.
6. Verify the setup with concrete checks and sample happy, rework, and failure paths.
7. Leave a concise summary of what changed and how to adjust it later.

## Agent HQ Concepts

Use these concepts precisely:

- **Project**: the top-level workspace or client/product.
- **Workflow**: a board/operating cycle inside a project. Legacy APIs may still expose this as a sprint.
- **Workflow type**: a reusable workflow definition for allowed task types, task fields, status templates, and setup defaults. Legacy APIs may still expose this as a sprint type.
- **Task type**: a workflow-specific, stable classification for the life of a task. It can describe a work kind or routing lane, but must not merely restate the current phase.
- **Task field schema**: custom structured fields shown on tasks in a workflow type.
- **Status**: the task's current workflow state: what is true now and what action can happen next.
- **Outcome**: an event reported by an agent, human, or integration, such as `completed_for_review`, `qa_pass`, or `qa_fail`.
- **Automatic transition**: the rule that maps an outcome from the current status to the next status.
- **Gate requirement**: evidence required before a transition/outcome is allowed.
- **Assignment rule**: the rule that assigns a task to an agent for a specific workflow, task type, and status.
- **Model routing**: the story-point/provider policy that chooses model and thinking level.
- **Agent**: a durable role with instructions, runtime, provider, model, repo/workspace, skills, and tools.
- **Agent run**: one execution attempt. Queued/running/failed run state is not the same thing as task workflow status.

## Core Workflow

1. **Discover**
   - Read `references/onboarding-interview.md`.
   - Ask the smallest useful set of questions.
   - Identify the durable work item, independent work units, roles, handoffs, evidence, exceptions, and model/cost expectations.

2. **Model**
   - Read `references/work-modeling-guide.md`.
   - Choose case, work-order, or hybrid modeling.
   - Treat task type as stable identity, status as current truth, outcome as the event causing movement, and run state as an execution attempt.

3. **Design**
   - Use `references/sprint-definition-guide.md` for workflow types and lifecycle shape.
   - Use `references/task-fields-guide.md` for structured task fields.
   - Use `references/routing-rules-guide.md` for status/task-type agent assignment.
   - Use `references/model-routing-guide.md` for model/thinking policy.
   - Use `references/agent-setup-guide.md` for agent roles and skill assignments.

4. **Propose**
   Present a compact plan:
   - work-item boundary and modeling mode
   - project/workflow/workflow type
   - task types and fields
   - statuses, transitions, and gate requirements
   - agents and assignment rules
   - model routing and provider assumptions
   - verification sample

5. **Apply**
   Prefer Agent HQ MCP/API tools over direct database writes.
   Use direct SQL only when there is no supported tool/API and the user has approved the operational risk.

6. **Verify**
   Read `references/config-verification-checklist.md`.
   Verify the configured system, not just that writes succeeded.

7. **Teach Back**
   Explain the setup in plain language:
   - "When you create X, it will go to Y."
   - "This handoff requires Z evidence."
   - "These model rules control cost/quality."

## Guardrails

- Do not use or recreate legacy per-agent dispatch fallback behavior.
- Do not assume missing assignment rules are harmless. Missing assignment rules create stuck work.
- Do not edit model routing without checking configured provider slugs first.
- Provider display labels are not provider keys. Match the stored provider slug used by agents, for example `openai-codex`, not a generic label like `OpenAI`.
- Keep custom task fields minimal. If the data is narrative or temporary, use notes instead.
- Do not make every field required. Require only fields that block safe handoff or verification.
- Do not treat deployment as done unless the workflow includes live verification or defines deployment as terminal.
- Do not treat the legacy/default task-type seed list as a global ontology. Resolve allowed task types from the workflow definition and add a type only for stable, meaningful variation.
- Do not encode a lifecycle phase or agent name in a task type.
- Do not encode a task type or agent name in a status.
- Do not model an outcome such as `qa_pass` as a development status when the configured transition uses it as an outcome.
- Do not create an agent for every status. Create the smallest set of durable roles justified by permissions, tools, quality boundaries, context, or separation of duties.
- Do not silently apply a complex setup from vague input. Show the proposal first.

## Reference Files

Load only the references needed for the current setup:

- `references/onboarding-interview.md`: questions and output format for discovery.
- `references/work-modeling-guide.md`: unit-of-work, task-type/status granularity, routing, and agent-design decisions.
- `references/sprint-definition-guide.md`: workflow type and lifecycle design.
- `references/task-fields-guide.md`: custom task field schema guidance.
- `references/routing-rules-guide.md`: assignment rules, transitions, and gate requirements.
- `references/model-routing-guide.md`: provider/model/thinking routing policy.
- `references/agent-setup-guide.md`: agent role, instruction, skill, and repo setup guidance.
- `references/config-verification-checklist.md`: concrete verification checks before reporting success.
- `references/common-workflow-recipes.md`: starter patterns for common teams and workflows.

## Completion Standard

A good Atlas setup leaves the user with:

- a project and active workflow if they need one
- a workflow type that matches their work
- task boundaries that support the required ownership, parallelism, retry, and acceptance
- understandable task fields
- explicit assignment rules for routable work
- automatic transitions and gate requirements that match the lifecycle
- provider-aware model routing
- agents that map to real roles
- one sample task path proving the setup can operate

If any of those are intentionally omitted, say why and list the follow-up.
