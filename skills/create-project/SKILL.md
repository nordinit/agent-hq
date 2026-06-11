---
name: create-project
description: "Bootstrap a new Agent HQ project end-to-end: create the project, stand up the initial workflow/board, add the required jobs/roles, and define assignment rules so tasks dispatch correctly. Use when the user asks to add a new project to Agent HQ, create a new client or internal project, or make a new project with a requested team mix such as DEV, QA, PM, frontend, backend, or trader."
---

# Create Project

Create projects as complete operating systems, not empty containers.

Use this skill to perform the full Agent HQ bootstrap:
- create the project
- create the initial workflow / board
- create the required jobs
- create assignment rules
- verify the project can actually receive and dispatch work

## Trigger examples

This skill should activate for requests like:
- "Create a new client project for X"
- "Set up a new internal project with PM, SWE, QA, and routing"
- "Let's add a new project to Agent HQ"
- "Make a new project for XYZ client, include DEV and QA"

## Workflow

1. **Clarify only the missing structural inputs**
   Resolve these before creating anything:
   - project name
   - client vs internal
   - initial team / jobs needed
   - whether a workflow / board should be created immediately
   - whether routing should be added now

   If the user already implied the team (for example "include DEV, QA"), do not re-ask obvious questions.

2. **Create the project shell first**
   Capture the minimum useful project metadata:
   - name
   - description / goal
   - status
   - client/internal context if supported

3. **Create the initial workflow / board**
   Unless the user says otherwise, create one active starter workflow so tasks have a home.
   Name it based on the project's first phase, for example:
   - `Launch Sprint`
   - `Sprint 1 — Setup`
   - `Implementation Sprint`

4. **Provision the jobs required to operate the project**
   Create only the roles the user asked for or that are clearly necessary.

   Common defaults:
   - implementation work → Software Engineer / Backend / Frontend
   - verification work → QA Tester
   - planning / routing → PM
   - trading / operational execution → Trader / Ops

   Every job should have:
   - clear title
   - linked agent
   - project_id
   - sane timeout / dispatch settings
   - job_instructions appropriate to the role

5. **Create assignment rules immediately**
   Do not leave the project half-configured.
   If the project is meant to auto-dispatch, add assignment rules during setup.

   Default routing pattern:
   - build work (`frontend`, `backend`, `fullstack`, `data`) → implementation job on `ready`
   - review / verification → QA job on `review`
   - `qa` work → QA job on `ready`
   - ops / execution work → trader or ops job on `ready`
   - `pm` work → PM job on `ready`
   - `other` → the most sensible generalist lane for the project

6. **Verify the bootstrap is operational**
   Check:
   - project exists
   - workflow exists
   - jobs exist and are attached to the correct project
   - assignment rules exist for the intended task types
   - no obvious dispatch gap remains

7. **Report the result cleanly**
   Summarize:
   - project created
   - workflow created
   - jobs created
   - assignment rules created
   - any follow-up still needed

## Decision rules

### When to create a workflow automatically

Create one by default unless:
- the user explicitly wants only the project shell
- the project is archival / inactive from day one

### When to create assignment automatically

Create assignment rules whenever the user expects the project to operate immediately.
If the user asks for a new project with roles, assume assignment is part of the bootstrap.

### How to choose task types

Use the standard Agent HQ task types:
- `frontend`
- `backend`
- `fullstack`
- `qa`
- `design`
- `marketing`
- `pm`
- `ops`
- `data`
- `other`

Do not invent new task types.

## Role-to-assignment heuristics

Use these defaults unless the project clearly needs a different split:

- Single dev + QA project:
  - `frontend`, `backend`, `fullstack`, `data` → dev
  - `review`, `qa` → QA
- Product / agency project:
  - `pm` → PM
  - implementation types → dev / frontend / backend as appropriate
  - `review`, `qa` → QA
- Trading / operations project:
  - `ops`, `other` → trader / ops
  - implementation types → engineer
  - `review`, `qa` → QA

## Quality bar

A good project bootstrap means a later task can be created without manual cleanup.

Avoid these failure modes:
- project exists but no workflow exists
- jobs exist but are attached to the wrong project
- jobs exist but assignment rules are missing
- assignment rules exist but task types are inconsistent with the project's actual workflow
- creating the project without enough structure for work to flow

## References

Read `references/checklist.md` when executing the bootstrap so nothing gets skipped.
