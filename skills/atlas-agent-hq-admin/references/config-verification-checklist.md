# Configuration Verification Checklist

Use this before telling the user Agent HQ is configured.

## Project And Sprint

- Project exists and is active.
- At least one active sprint exists if the workflow needs a board.
- Sprint is linked to the correct project.
- Workflow type is correct.

## Workflow Definition

- Durable work-item and independent task boundaries match the user's ownership, parallelism, retry, and acceptance needs.
- Allowed task types match the user's workflow.
- Task types describe stable work variation rather than lifecycle phases or agent names.
- Statuses describe current workflow truth rather than internal micro-steps or past events.
- Outcomes such as `qa_pass` are not duplicated as unnecessary intermediate statuses.
- Default field schema exists if common structured data is needed.
- Task-type schema overrides exist only where needed.
- Required fields are actually required for start, handoff, or verification.
- No stale/deprecated wording teaches legacy per-agent routing.

## Routing

- Every agent-actionable `task_type + status` has an explicit assignment rule.
- Every intentionally unassigned nonterminal status has a verified human, event, timer, or manual-resume path.
- Review/QA statuses route to the correct QA/review agent.
- Release statuses route to the correct release/devops agent when needed.
- PM task types route to PM/Atlas when intended.
- No route points to a disabled or wrong-project agent.
- No expected route depends on legacy per-agent config fallback.

## Automatic Transitions

- Each intended outcome has a transition from the correct status.
- QA fail routes back to a status that can be picked up by implementation.
- Deployment and live verification are separate if the workflow requires both.
- Terminal statuses are used only when the task is truly finished.

## Gate Requirements

- Implementation handoff requires review evidence when appropriate.
- QA pass requires QA evidence when appropriate.
- Deployment requires deploy evidence when appropriate.
- Live verification requires live verification evidence when appropriate.
- Requirements match the user's workflow, not generic assumptions.

## Model Routing

- Provider rows use configured provider slugs.
- Agent `preferred_provider` values match model-routing provider rows.
- Story-point buckets cover the task sizes users will create.
- Thinking levels are intentional and supported.
- A sample dispatch would populate both `effective_model` and `effective_thinking_level` when a thinking level is configured.

## Agents

- Required roles have agents.
- Each agent corresponds to a durable responsibility boundary rather than a status name.
- Agents are enabled.
- Agents have appropriate provider/model/runtime.
- Agents that work on code have a repo/workspace strategy.
- Agents have only relevant skills/tools.
- Atlas has admin/helper guidance available when it is expected to configure Agent HQ.
- Agent instructions define allowed outcomes, evidence, prohibited actions, and escalation conditions.

## Sample Task Verification

Create or dry-run one sample task path:

```text
Task:
- project:
- sprint:
- task_type:
- story_points:
- status:

Expected:
- assignment rule:
- agent:
- model route:
- first transition:
- required evidence:
```

If the user wants the system live immediately, create a real `todo` sample task first. Move to `ready` only when the user wants an agent to pick it up.

Also trace at least one materially relevant exception: rework, blocked/failure, or human/event wait.

## Report Template

```text
Configured:
- project/workflow:
- workflow type:
- agents:
- routing:
- transitions:
- gates:
- model routing:

Verified:
- sample task route:
- sample model route:
- evidence gates:

Follow-up:
- remaining decisions:
- optional improvements:
```
