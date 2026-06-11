# Workflow events API

Workflow events are task lifecycle signals that Agent HQ can receive from its own runtime or from trusted external systems. Existing external-task-event endpoints remain compatible, but the preferred product language is **workflow events**.

Trusted services can report narrow task facts to Agent HQ through:

- `POST /api/v1/external/task-events` (compatibility endpoint)

This endpoint is intentionally event-based. It does **not** expose arbitrary task mutation.

## Authentication

The route reuses Agent HQ MCP API key auth already mounted on `/api/v1`.

Use either:

- `x-api-key: <agent-hq-mcp-api-key>`
- or `Authorization: Bearer <agent-hq-mcp-api-key>` together with `x-agent-hq-mcp-client: 1`

For the lease-manager integration, the authenticated MCP identity must be either:

- the `dev_environment_lease_manager` service agent slug, or
- an Atlas system agent

## Event sources

Workflow event mappings include explicit source metadata. Canonical sources include:

- `agent_hq_runtime` — internal Agent HQ runtime events such as `agent_started`
- `dev_environment_lease_manager` — lease-backed Dev deploy and QA handoff callbacks
- other trusted MCP/server callback sources when authorized by identity

A `NULL` mapping source is still supported as a wildcard compatibility alias for older integrations.

## Supported lease-manager events

- `dev_deploy_queued`
- `dev_deploying`
- `deployed_for_qa`
- `deploy_failed`
- `database_backup_failed`
- `database_migration_failed`
- `database_integrity_failed`
- `api_boot_failed`
- `api_health_failed`
- `ui_health_failed`
- `process_restart_failed`
- `checkout_failed`
- `build_failed`
- `cancelled`
- `superseded`

## Mapping APIs

Preferred routes:

- `GET /api/v1/routing/workflow-event-mappings`
- `POST /api/v1/routing/workflow-event-mappings`
- `PUT /api/v1/routing/workflow-event-mappings/:id`
- `DELETE /api/v1/routing/workflow-event-mappings/:id`
- `GET /api/v1/workflow-events/definitions`
- `GET /api/v1/workflow-events/mappings`

Compatibility aliases still work:

- `/api/v1/routing/external-event-mappings...`
- `/api/v1/external-task-events/definitions`
- `/api/v1/external-task-events/mappings`

## Request body

```json
{
  "source": "dev_environment_lease_manager",
  "event": "deployed_for_qa",
  "task_id": 449,
  "environment_id": "agent-hq-dev",
  "queue_id": "queue-123",
  "lease_id": "lease-123",
  "branch": "cinder-backend/task-449-external-task-events",
  "commit_sha": "1234567890abcdef1234567890abcdef12345678",
  "review_url": "http://127.0.0.1:3510",
  "message": "Lease-backed deploy completed and is ready for QA."
}
```

## Canonical Agent HQ effects

Accepted workflow events are translated into canonical writes:

- create a task note
- create task history rows for event source, event name, environment, queue, lease, branch, commit, review URL, and message
- persist an idempotency receipt
- resolve a workflow-event mapping by source, event, project, task type, and current status

`deployed_for_qa` writes review evidence and uses canonical outcome semantics to post `completed_for_review` when valid. `deploy_failed` and structured deployment failures use canonical outcome semantics to post `env_blocked` and record failure detail. `agent_started` is an internal `agent_hq_runtime` workflow event that can move a dispatched task to `in_progress`.

## Idempotency

Agent HQ stores a receipt for each normalized payload fingerprint. If the same payload is sent again, the route returns `200 OK` with `duplicate: true` and does not repeat task notes, history writes, or status transitions.
