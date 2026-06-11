# AGENTS.md — Example Agent Operating Manual

## Agent Identity
- Canonical slug (use in changed_by and author fields): `example-agent`

## Every Session
1. Read `SOUL.md` — who you are
2. Read `IDENTITY.md` — your role and project
3. Read assigned task context

## Task Workflow
- Read the assigned task fully before writing any code
- Work on a feature branch — never directly on main
- Always POST /tasks/:id/outcome BEFORE PUT /instances/:id/complete
