# Create Project Checklist

Use this when actually bootstrapping a project in Agent HQ.

## Inputs to resolve

Confirm or infer:
- Project name
- Internal or client project
- One-line goal
- Initial team / jobs needed
- Whether an active sprint should be created now
- Whether assignment rules should be created now

## Minimum bootstrap sequence

1. Create project
2. Capture returned `project_id`
3. Create initial sprint for that `project_id`
4. Create required job templates for that `project_id`
5. Capture returned `job_id` values
6. Create assignment rules using those `job_id` values
7. Verify the project by listing:
   - project
   - sprints
   - jobs
   - assignment rules

## Suggested starter sprint names

Pick the smallest name that matches the phase:
- `Launch Sprint`
- `Sprint 1 — Setup`
- `Sprint 1 — Implementation`
- `Client Onboarding`
- `Initial Build`

## Suggested default job sets

### Small software project
- Software Engineer
- QA Tester

### Split product build
- Frontend Engineer
- Backend Engineer
- QA Tester
- PM

### Client delivery / agency project
- PM
- Frontend Engineer and/or Backend Engineer
- QA Tester

### Trading / operations project
- Trader or Ops
- Software Engineer
- QA Tester

## Suggested assignment defaults

### Engineering + QA
- `frontend` + `ready` → frontend engineer or software engineer
- `backend` + `ready` → backend engineer or software engineer
- `fullstack` + `ready` → software engineer
- `data` + `ready` → backend / software engineer
- `review` stage for implementation work → QA job
- `qa` + `ready` → QA job

### PM present
- `pm` + `ready` → PM job

### Ops / trader present
- `ops` + `ready` → ops / trader job
- `other` + `ready` → most appropriate generalist lane

## Verification checklist

Before reporting success, verify all of these:
- Project appears in Agent HQ
- At least one sprint exists if expected
- Every created job belongs to the new project
- Assignment rules point at the intended jobs
- The project has no obvious dispatch hole for the task types the user expects to use first

## What to report back

Return a compact summary with:
- project name + project_id
- sprint name + sprint_id
- jobs created with job ids
- assignment rules created
- any assumptions made
- any follow-up still needed
