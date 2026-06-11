# `api/src/lib` phase-0 audit

`api/src/lib` is no longer the default home for backend business logic.

Use this directory for:
- generic or cross-domain utilities,
- shared vocabularies and adapters,
- compatibility exports that preserve older import paths during the refactor.

## Compatibility exports

| Module | Owner path |
| --- | --- |
| `instanceClose.ts` | `domains/runs/instanceClose` |
| `instanceStop.ts` | `domains/runs/instanceStop` |
| `lifecycleHandoff.ts` | `domains/runs/lifecycleHandoff` |
| `runObservability.ts` | `domains/runs/observability` |
| `sprintOutcomes.ts` | `domains/sprint-definitions/outcomes` |
| `sprintTaskPolicy.ts` | `domains/routing/policy` |
| `sprintTypeConfig.ts` | `domains/sprint-definitions/config` |
| `stopInstanceExecution.ts` | `domains/runs/stopInstanceExecution` |
| `taskContext.ts` | `domains/tasks/context` |
| `taskHistory.ts` | `domains/tasks/history` |
| `tokenBackfill.ts` | `domains/runs/tokenBackfill` |
| `tokenUsage.ts` | `domains/runs/tokenUsage` |
| `transcriptProvider.ts` | `domains/runs/transcriptProvider` |
| `workflowMetadata.ts` | `domains/sprint-definitions/workflowMetadata` |

## Generic/shared utilities retained in `lib`

| Module | Notes |
| --- | --- |
| `agentHqBaseUrl.ts` | Control-plane base URL helper used across runtimes and dispatch. |
| `atlasAgent.ts` | Workspace and agent identity helper for local runtime wiring. |
| `chatGatewayErrors.ts` | Chat and gateway error normalization for transport layers. |
| `chatMessageRoles.ts` | Shared role normalization for transcript persistence. |
| `defaultProject.ts` | Shared default-project DB helper. |
| `defectTypes.ts` | Shared defect-type vocabulary. |
| `evidenceValidation.ts` | Shared evidence payload validation. |
| `gatewayAuth.ts` | Gateway auth helper. |
| `gatewayHealth.ts` | Gateway health probe helper. |
| `gatewayPair.ts` | Gateway pairing helper. |
| `gatewaySettings.ts` | Shared gateway-settings persistence helper. |
| `githubIdentity.ts` | GitHub credential injection and identity resolution. |
| `jsonRequestErrors.ts` | Generic Express JSON error helper. |
| `mcpApiAuth.ts` | MCP API auth and actor resolution helper. |
| `openclawAutoPair.ts` | OpenClaw auto-pair integration helper. |
| `openclawCli.ts` | OpenClaw CLI invocation helper. |
| `openclawGatewayWs.ts` | Shared WebSocket connection options for the gateway. |
| `openclawMessageEvents.ts` | Shared OpenClaw event extraction and parsing. |
| `openclawOAuthProfiles.ts` | OAuth profile materialization for OpenClaw runtime flows. |
| `outcomeCatalog.ts` | Shared outcome semantics vocabulary. |
| `reconcilerConfig.ts` | Shared reconciler and scheduler config lookup. |
| `repoConfig.ts` | Shared repo and worktree configuration helper. |
| `sessionAdapters/ClaudeCodeSessionAdapter.ts` | Runtime session adapter. |
| `sessionAdapters/CronSessionAdapter.ts` | Runtime session adapter. |
| `sessionAdapters/OpenClawSessionAdapter.ts` | Runtime session adapter. |
| `sessionAdapters/index.ts` | Runtime session adapter registry. |
| `sessionAdapters/types.ts` | Runtime session adapter contract. |
| `sessionKeys.ts` | Shared session-key parsing and building helpers. |
| `starterCatalog.ts` | Shared starter and template vocabulary. |
| `taskStatuses.ts` | Shared task-status vocabulary. |
| `taskTypes.ts` | Shared task-type vocabulary. |
| `workspaceBoundary.ts` | Shared workspace boundary enforcement. |
| `workspaceProvider.ts` | Shared local and remote workspace provider abstraction. |

## Follow-up domain moves

| Module | Candidate owner |
| --- | --- |
| `canonicalSessions.ts` | `domains/chat` or `domains/runs` |
| `gatewayTranscriptCapture.ts` | `domains/runs` |
| `projectAudit.ts` | `domains/sprints` or a future `domains/projects` |
| `reflectionContext.ts` | `domains/runs` or a future `domains/sessions` |
| `sprintWorkflow.ts` | `domains/sprint-definitions` |
| `starterSetup.ts` | `domains/tasks` or a future starter/provisioning slice |
| `taskLifecycle.ts` | `domains/tasks` and `domains/runs` boundary cleanup |
| `taskNotifications.ts` | `domains/tasks` |
| `taskOutcome.ts` | `domains/tasks` |
| `taskRelease.ts` | `domains/tasks` |
| `taskStop.ts` | `domains/tasks` or `domains/runs` |

Tests remain colocated beside the current module path until their owner file moves.
