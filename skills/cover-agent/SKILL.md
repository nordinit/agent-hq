---
name: cover-agent
description: Temporarily act as a Cover Agent for Agent HQ tasks by spawning a subagent in the current thread that impersonates the assigned Agent HQ role, validates or finishes review-stage work, and prepares truthful review evidence for the ticket. Use when you need Atlas to stand in for an Agent HQ agent in-chat, especially to review implementation work, gather evidence, or post review-ready findings into the task without pretending QA passed.
---

# Cover Agent

Use this skill when Masiah wants Atlas to temporarily stand in for an Agent HQ agent inside the current thread.

## Core rules

- Act as a **covering operator**, not a faker. Keep evidence truthful.
- Only impersonate the agent's **role and workflow responsibility**, not fabricated personal work that did not happen.
- Do not invent artifacts, branches, commits, screenshots, URLs, approvals, or QA results.
- Do not manually set QA outcomes.
- Prefer using a spawned subagent to do the actual inspection or verification work, then convert its result into truthful ticket evidence.
- If required task evidence is missing, say that plainly and stop short of posting a false review handoff.

## Default workflow

1. Identify the Agent HQ task, assigned role, and what lane the task is currently in.
2. Inspect the current evidence already attached to the task.
3. Spawn a subagent in this thread that matches the needed role:
   - dev/backend/frontend/fullstack for implementation review or finish work
   - QA for verification
   - PM/spec for acceptance against task intent
4. Have the subagent work from the canonical repo and exact branch/commit when available.
5. Require a structured result back:
   - verdict
   - what was checked
   - commands run
   - files touched if any
   - branch + commit if relevant
   - concrete risks/blockers
6. Convert that into truthful review evidence or a truthful blocker note for the Agent HQ ticket.
7. Only move the ticket forward if the required evidence fields actually exist and the lane transition is allowed.

## Evidence standard

When posting review evidence, include only facts you can support directly:

- branch name
- full commit SHA
- exact verification commands
- exact verdict
- specific blocker if not ready

If one of those is missing, call it out instead of smoothing over it.

## Good uses

- Cover an unavailable backend agent long enough to inspect a completed branch and post review-ready evidence.
- Cover a QA agent by running verification in-thread and summarizing the result for the ticket.
- Cover a PM/spec agent by checking implementation against acceptance criteria and writing a precise pass/fail note.

## Bad uses

- Fabricating review evidence for work that was never run
- Marking QA passed without real verification
- Pretending an Agent HQ agent completed work when Atlas or an ad hoc subagent actually did it
- Advancing a task when the required branch, commit, or test proof is missing

## Output shape

When this skill is used, prefer concise evidence-first updates:

- role covered
- task id
- verdict
- evidence
- blocker or next move

## References

- Read `references/evidence-template.md` when you need a compact template for truthful review evidence notes.
