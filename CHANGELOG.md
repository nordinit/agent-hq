# Changelog

All notable changes to Agent HQ are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Agent HQ uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor release may
change the API, the database schema, or configuration; when it does, its entry says so under
**Changed** or **Removed** with what to do.

## [Unreleased]

## [0.2.0] - Unreleased

The first release from this repository. Earlier `@nordinit/agent-hq` 0.1.x packages were preview
builds. Their databases can't be upgraded in place by this release, because the migrations are
now one consolidated schema; start 0.2.0 on a fresh database.

### Added

- **Workflows you configure, not code.** Projects, workflows, task types, custom fields, statuses,
  outcomes, assignment rules, transitions, and gates are all set up in the UI or through the API.
- **Deterministic assignment.** Tasks go to agents by workflow, task type, and status.
- **Outcome-driven transitions.** An outcome an agent posts maps to the task's next status.
- **Evidence gates.** An outcome can require specific fields, or matching values, before it moves
  a task forward.
- **Workflow events.** Runtime, deployment, and integration events can change a status or post an
  outcome.
- **Runtimes.** Dispatch to Claude Code, Codex, Hermes, OpenClaw, or webhook agents.
- **MCP server.** Agents and MCP clients call back into Agent HQ to start runs, check in, record
  evidence, post notes, and submit outcomes.
- **Worktree-backed execution.** Code workflows get an isolated git worktree or clone per task.
- **Teams.** Group agents under a shared goal, with shared tool and MCP grants and a routing
  template for the workflows the team owns.
- **Model routing.** Rules pick the model and thinking level from a task's project, workflow,
  and story points.
- **Configurable telemetry.** Versioned metrics, saved views, reports, and dashboard pages, with a
  drill-down into the records behind every number.
- **Project export and import.** Move a project's workflows, agents, routing, and model routing
  between installs as a JSON manifest, with a preview before import.
- **CLI.** `npx @nordinit/agent-hq start` runs Agent HQ with Docker Compose and PostgreSQL 17, or
  natively with `--no-docker`.

### Security

- Every API request needs the operator token or an agent's MCP key, and an agent key is limited to
  the capabilities granted to that agent.
- The API and UI listen on `127.0.0.1` by default and refuse cross-origin browser requests unless
  the origin is allowed.
- Agent HQ launches an agent only when the agent has an explicit `host.execute` grant and its
  runtime profile is a published revision bound to that agent. Edits made with the operator token
  publish and bind the new revision as they save; edits made with an agent's MCP key wait for
  review. Onboarding grants `host.execute` to the starter agents it creates and says so first.
- Dependencies are updated so that `npm audit` reports no known vulnerabilities in the API or UI.

[Unreleased]: https://github.com/nordinit/agent-hq/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nordinit/agent-hq/releases/tag/v0.2.0
