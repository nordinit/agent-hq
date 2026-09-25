# Agent HQ documentation

Start with the [project README](../README.md). The documents below describe the current system.
When a document and the code disagree, the code is right; please open an issue or a PR.

## Install and operate

- [SELF_HOSTING.md](SELF_HOSTING.md) — Docker Compose and native installs, configuration, authentication, upgrades, and troubleshooting.
- [../cli/README.md](../cli/README.md) — the `agent-hq` CLI launcher: modes, commands, and the operator token.
- [../SECURITY.md](../SECURITY.md) — security model and how to report a vulnerability.
- [BACKUP_RESTORE.md](BACKUP_RESTORE.md) — PostgreSQL logical backups, restore checks, and file volumes.
- [database-migration-runbook.md](database-migration-runbook.md) — schema install, migration, and status commands, and upgrade order.
- [workflow-terminology-migration.md](workflow-terminology-migration.md) — upgrade notes for migration 32, which renamed the schema and API to workflow terminology.
- [operations/workflow-environment-setup.md](operations/workflow-environment-setup.md) — per-workflow dependency preparation and cleanup for task workspaces.

## Architecture

- [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md) — components, runtimes, workflow model, and the main data flow.
- [INFRASTRUCTURE.md](INFRASTRUCTURE.md) — processes, background loops, routes, data model, dispatch, and the watchdog.
- [architecture/agent-runtime-boundary-v1.md](architecture/agent-runtime-boundary-v1.md) — the run contract and acceptance gates for local CLI runtimes (Claude Code, Codex).
- [architecture/backend-domain-architecture.md](architecture/backend-domain-architecture.md) — where backend business logic lives.
- [architecture/frontend-ui-folder-architecture.md](architecture/frontend-ui-folder-architecture.md) — frontend folder ownership boundaries.
- [agent-teams-plan.md](agent-teams-plan.md) — design, decisions, and as-built notes for agent teams.

## Runtimes and integrations

- [hermes-runtime.md](hermes-runtime.md) — running agents on the Hermes CLI.
- [github-identity-runtime-support.md](github-identity-runtime-support.md) — which GitHub identity delivery paths reach each runtime.
- [agent-hq-mcp.md](agent-hq-mcp.md) — the Agent HQ MCP server: stdio and Streamable HTTP transports, tools, permissions, and OAuth for connectors.
- [external-task-events.md](external-task-events.md) — the workflow events API for trusted external systems.
- [openapi.md](openapi.md) — the published OpenAPI document, tenants, and how to document new routes.
- [../plugins/openclaw-capability-tools/README.md](../plugins/openclaw-capability-tools/README.md) — the OpenClaw plugin that exposes an agent's assigned tools.
- [cli-onboarding.md](cli-onboarding.md) — design contract for guided first-install setup (`agent-hq init`); not all of it is implemented.

## Telemetry and dashboards

- [dashboard-pages.md](dashboard-pages.md) — configurable dashboard pages: editing, data behavior, storage, and API.
- [telemetry-analysis-and-dashboards.md](telemetry-analysis-and-dashboards.md) — analyzing a metric, saved views, and adding views to dashboards.
- [telemetry-title-regex.md](telemetry-title-regex.md) — filtering metrics by task title.
- [telemetry-capture-inventory.md](telemetry-capture-inventory.md) — how observations are captured, identified, and retained.
- [telemetry-performance.md](telemetry-performance.md) — the telemetry benchmark tool and its last recorded results.
- [telemetry-legacy-consumers.md](telemetry-legacy-consumers.md) — removal of the v1 telemetry API and the tables it left behind.

## Archive

[archive/](archive/) holds finished or superseded plans, audits, migration handoffs, design
records, and validation results. They are kept for history and are not maintained, so they
describe the system as it was when they were written.
