---
name: create-agent
description: Provision a fully-initialized OpenClaw agent with isolated workspace, identity documents, Agent HQ registration, and openclaw.json entry. Use when creating a new agent for any project — dev, QA, frontend, backend, PM, or any other role. Covers the complete setup checklist so nothing gets missed.
---

# Create Agent

Provision a complete, properly-isolated OpenClaw agent end-to-end.

## Preferred Path

**Use one atomic backend call when available.**

Target design:
- `POST /api/v1/agents/provision-full`

This endpoint should eventually own the full provisioning workflow:
- create the agent DB row
- create workspace + `memory/`
- scaffold full identity/memory docs from canonical templates
- create agentDir
- copy `auth-profiles.json`
- register the agent in `openclaw.json`
- persist runtime/session/repo/timeouts/project fields
- create instructions / job-template equivalent
- create assignment rules
- create weekly reflection job
- optionally assign skills/tools
- restart gateway
- verify everything and return structured results

**Until that endpoint exists, use the checklist fallback flow in `references/checklist.md`.**

## Operating Principle

The skill should spend effort on the high-value creative parts of agent design:
- role definition
- name and identity
- model/provider choice
- project placement
- routing intent
- tool/skill selection
- instruction quality
- deciding what belongs in `job_instructions` vs `AGENTS.md` vs `TOOLS.md`

The platform should own the operational provisioning steps.

## Context Layering Standard

Use this structure for all new agents:

- **`job_instructions`**
  - role identity
  - execution style
  - quality bar
  - critical behavioral constraints
  - keep it short and role-focused

- **`AGENTS.md`**
  - startup flow
  - workflow rules
  - lane/process rules
  - debugging heuristic
  - memory discipline
  - for implementation agents: explicit rule to work in their own workspace clone/worktree, never the canonical production repo checkout

- **`TOOLS.md`**
  - stable environment facts
  - prod URLs, repo paths, machine-specific notes
  - do not put task-specific dev ports here unless they are truly stable

- **task dispatch prompt**
  - task objective
  - scope
  - acceptance criteria
  - task-specific verification commands, ports, URLs, or environment targets

Default rule: if a fact is stable and environment-specific, put it in `TOOLS.md`, not `job_instructions`.

## Current Reality

Today the system is still split across:
- `POST /api/v1/agents`
- `POST /api/v1/agents/:id/provision`
- manual/checklist filesystem scaffolding
- direct DB patching in some cases
- separate routing/instruction/reflection setup

That split is temporary technical debt, not the desired long-term workflow.

## Critical Rules (while fallback flow still exists)

1. **Always check existing agent names before choosing one** — call `GET /api/v1/agents` first and pick a name not already in use. Every agent across all projects shares the same name pool. No two agents should have the same first name.

2. **Always set `repo_path` when the agent works on a codebase** — omit only for operator/trader roles or inactive projects.

3. **Implementation agents must work in their own workspace clone/worktree, never the canonical production repo checkout** — this rule should appear in their `AGENTS.md` by default.

4. **Do NOT create a `HEARTBEAT.md` in agent workspaces** — only Atlas runs heartbeats unless Masiah explicitly asks otherwise.

5. **If forced onto the fallback flow, treat the checklist as the source of truth** — do not improvise the operational steps from memory.

6. **When the atomic endpoint lands, prefer it immediately** — this skill should become a thin orchestration/spec layer, not a long provisioning runbook.


## Quick Reference

| What | Where |
|---|---|
| openclaw.json | `<openclaw-root>/openclaw.json` |
| Workspaces | `<openclaw-root>/workspace-<id>/` |
| Agent dirs | `<openclaw-root>/agents/<id>/agent/` |
| Agent HQ API | `http://localhost:3501/api/v1` |
| Agent HQ UI | `http://localhost:3500` |

## Workflow

1. Read `references/checklist.md` — follow it top to bottom
2. For workspace file content, use the templates in `references/templates.md`
3. After finishing, verify: docs visible in UI → agent session active → job template linked to correct project

## Naming Convention

Current/legacy agent IDs often use `<project>-<role>` format (e.g., `fortified-dev`, `agency-qa`, `acme-pm`).
Workspace is always `<openclaw-root>/workspace-<id>/`.
agentDir is always `<openclaw-root>/agents/<id>/agent/`.

Session key direction is moving toward richer canonical formats. Do not hardcode old session key patterns into identity docs or role templates unless the backend provisioning flow explicitly requires it.
