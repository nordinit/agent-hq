# OpenClaw registry refresh: investigation and implementation specification

Status: functional fixes deployed to all three APIs at `4b233348`; normal dispatch restored. The change-only optimization remains disabled pending the Stage B gates below. Investigated September 28–29, 2026 against Agent HQ `78eb8e74` and installed OpenClaw `2026.9.6`; rollout completed September 29–30. Scope: fix 2, eliminating blocking and redundant registry work without reintroducing stale or missing MCP tools.

## Implementation and validation update — September 29

The Agent HQ implementation now includes asynchronous registry maintenance with process cleanup, atomic/no-op bundle publication, workspace-specific plugin identities, gateway `plugins.reload` acknowledgements, direct probes of the intended bundle, and a final file-revision check before sending a turn. PostgreSQL migration 37 adds acknowledgement records and a transactional configuration-change queue; the optional worker starts only after HTTP listen. Uncertain gateway mutations are not automatically replayed by the socket client.

Implementation uncovered two additional compatibility requirements:

- OpenClaw 2026.9 uses keyed `agents.entries`; the older materializer read only `agents.list`. Both shapes are now supported.
- Unique bundle IDs do not themselves isolate tools. OpenClaw builds a configuration-wide bundle inventory. Agent HQ now generates short workspace-specific server namespaces and agent-level denials for foreign namespaces, applied before MCP connection. A sidecar records which deny rules Agent HQ owns so manual rules survive subsequent updates. The migration publishes all trust and agent policies together.

The actual installed OpenClaw 2026.9.6 gateway passed the isolated canary using Agent HQ's namespace and policy functions: each agent saw its own tools; argument and credential changes reached a reused session; wildcard filters took effect; last-server removal took effect; an unrelated active session completed across another agent's reload; and the asynchronous registry fallback accepted the scoped bundles. No paid model or business task was used. The successful fixture is `/var/folders/yh/ycw4zfh13kgd7bn2tlkchn6m0000gn/T/ahq-openclaw-canary-TiUF1z`.

Validation: 112 focused tests and the standalone migration test pass. Focused tests cover callback responsiveness and child cleanup, unchanged files/mtimes/credentials over ten publications, both agent configuration formats, manual policy preservation, duplicate workspace refusal, missing tools, cold/stale catalogs, no mutation replay after disconnect, superseding edits before admission, queue recovery and rollback, batched reconciliation and API/gateway reconnection. The API builds. SQL lint has four pre-existing findings in `openclawDeviceIdentity.ts` from the preceding device-identity change; these files are unchanged by this work.

The production and two development APIs share `/Users/nordini/.openclaw/openclaw.json`. The user authorized updating all three APIs together, and all three now run the compatible implementation at `4b233348`. This prevents an older API from rewriting the migrated bundle format. Each API uses `AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE=async-every-dispatch`; change-only maintenance and the optional background MCP worker remain disabled. Do not mistake the maintenance-owner environment flag for a distributed lock: cross-process ownership is still a Stage B release gate. Agent HQ generated configuration was migrated through its materializer and OpenClaw's supported registry/reload interfaces. Installed OpenClaw code and packages were not modified, and no direct OpenClaw state-database edits were made. The dashboard fix was deployed separately.

The remaining Stage B release gates include cross-process ownership, busy affected-plugin/drain-timeout testing, and full crash-injection and server-membership matrices. Until those gates pass, use the asynchronous awaited fallback. Do not claim that every proposed acceptance case below has been completed.

`api/scripts/migrate-openclaw-mcp-bundles.cjs` defaults to a read-only plan. The coordinated rollout applied its migration to 28 configured bundles and removed 49 obsolete generated global servers. `--apply` backed up every changed file and wrote its recovery index before publication; it does not modify OpenClaw packages or its state database. The migration test verifies plan-only behavior, backup fidelity, policy isolation, preservation of unrelated global servers, redaction and idempotence.

### Live rollout evidence — September 29–30

- Backed up all three PostgreSQL databases and private process/environment definitions under `/Users/nordini/agent-hq-rollout-backups/20260929-4b233348`. Restored each database into a temporary rehearsal database and verified migrations and startup schema checks before applying live changes. All three live databases are at migration 37.
- Published 58 changed Agent HQ configuration files, with a recovery index under `/Users/nordini/.openclaw/agent-hq-mcp-backups/2026-09-29T14-19-02-041Z`. The supported asynchronous registry refresh succeeded. A scoped `plugins.reload` acknowledged all 28 bundle IDs without requiring a gateway restart.
- James (`99974436`), Casper (`99974437`), and Kepler (`99974441`) passed live `/mcp/sync` with no warnings, followed by direct MCP initialization/tool-list probes of their exact assigned bundles and required tools. Temporary diagnostic sessions returned the expected cold-session `mcp-not-yet-connected` notice and were deleted afterward. These were startup-readiness checks, not business-task reruns; isolation and runtime freshness were separately verified by the isolated gateway canary above.
- During the three live syncs, 736 concurrent production health requests completed with zero failures, a 3 ms p95, and a 19 ms maximum. This demonstrates that the registry waits no longer block the API event loop.
- Production (`3501`), development (`3511`), and development 2 (`3521`) passed health and authenticated agent-list requests after normal dispatch was restored. Both development dashboards passed authenticated API proxy and page checks. The development environments now have separate operator credentials, stored locally in their respective `.env` files; credentials are not recorded in this document.

The rollout leaves the known inert development QA fixture (`qa-fixture:task-520-active-instance-filter-inert`, future-dated with no run ID) untouched. No business task or paid model turn was started for verification. Database and configuration backups are retained for recovery.

## Decision

Implement this in two separately verifiable stages:

1. Convert registry refresh to an asynchronous child process, keeping the current awaited ordering and failure behavior. This removes the API event-loop stall without changing which runs are allowed to start.
2. Replace unconditional refresh with reconciliation when configuration changes. A task may skip work only when its desired configuration has been reconciled with the running gateway. File writes, a fresh disk registry, and a gateway runtime receipt are different facts.

The earlier suggestion to refresh only when configuration changes needs this qualification: changing `.mcp.json` can require a new gateway plugin-cache generation even when the manifest has not changed. A background registry command alone does not establish that the gateway sees the changes.

## Why previous fixes reversed each other

The repository and its retained history show the following sequence. This establishes repeated changes in policy, not a claim that every historical incident had the same cause.

| Date / commit | Change and regression pressure |
| --- | --- |
| May 20, `2bebd0eb` | Added `plugins registry --refresh` after MCP sync, using `spawnSync`; refresh failure made sync fail. |
| June 3, `2f704e5` | Limited global MCP writes and refresh to explicit global sync. Shared configuration writes could interrupt live sessions. |
| June 9, `4418b09d` | Restored the workspace delivery path: plugin trust, correct routed workspace, and workspace isolation. Its commit message records that the previous restriction left bundles undiscoverable and agents without lifecycle tools. |
| June 13, `ba419735` | Removed boot-time trust pre-seeding because it created a stale plugin reference before a bundle existed. |
| July 7, `5b594c8d` | Explicitly disabled activation and registry refresh during dispatch. |
| July 19, `f1e3e85a` | Re-enabled activation and refresh during dispatch, with required-tool readiness checks, to prevent stale catalogs. |
| July 19, `1b974cf4`, 27 minutes later | Added direct probes and an exception for a cold session: its gateway tool catalog is not connected before the first turn. |
| September 19, `eaba594b` | Replaced synchronous reload/probe subprocesses with asynchronous calls so MCP permission callbacks could reach the API. The separate registry refresh remained synchronous. |

The old changes coupled four responsibilities: publishing files, granting plugin trust, repairing the persisted registry, and checking the running session. Removing one block sometimes removed a guarantee supplied by another operation in that block.

## Current behavior and newly verified constraint

`api/src/services/dispatcher.ts` requests activation and registry refresh for each OpenClaw dispatch. `syncAssignedMcpForAgent` runs refresh whenever materialization succeeds and has at least one assigned server. It does not compare content with the previous successful configuration. The materializer also rewrites both MCP files and the manifest on unchanged runs.

`refreshOpenClawPluginRegistry` in `api/src/runtimes/mcpMaterialization.ts` calls `spawnSync` with a 60-second timeout. While it runs, the API cannot service normal requests or callbacks from other MCP processes. The registry operation itself is metadata maintenance; this investigation does not establish that it directly calls Agent HQ. Blocking unrelated MCP callbacks is sufficient to cause trouble. Moving the same synchronous call into `setImmediate` would still block the API once it executes.

Additional edge cases:

- Server edits already batch refresh once, but team edits call individual agent syncs and can refresh repeatedly.
- The `count > 0` condition does not represent change detection. Removing the last server is a real change even though the new count is zero.
- Tests described as checking a “no-op” cover an empty assignment set, not two identical nonempty materializations.
- Registry CLI `cwd` is not an agent-selection contract. Current OpenClaw can omit workspace discovery from control-plane inventory when multiple agents exist without an explicit system owner. A successful global registry command does not prove a particular workspace is discoverable.

An isolated experiment used the installed OpenClaw configuration loader, a synthetic workspace, and synthetic credentials. Reusing the same plugin cache kept the old configuration after each of these changes: command arguments, credential value, tool allowlist, added server, and removal of the last server. A new plugin cache observed each change and produced a different MCP fingerprint. Identical content retained its fingerprint.

This reproduces the cache behavior; it is not an end-to-end gateway reload test. It shows why relying on the existence of OpenClaw's MCP fingerprint calculation is insufficient: that calculation can receive cached file contents.

OpenClaw's installed documentation identifies `plugins registry --refresh` as persisted-index repair, not runtime activation. Its `plugins reload <ids...>` / `plugins.reload` operation goes through the running gateway, creates a new plugin cache, and returns a runtime application receipt. Documentation also says replacement can wait up to 60 seconds for in-flight work, and that a failure after publication may leave the new generation active. Both cases must be handled explicitly.

## Stage A: remove API blocking while preserving ordering

Change the refresh function and its injectable test interface to return `Promise<OpenClawPluginRegistryRefreshResult>`. Use asynchronous `spawn` or `execFile`, without a shell, with the existing `buildOpenClawEnv()` behavior. Update both agent sync and server-batch sync to await the result.

Preserve activation, refresh timing, and the existing failure-to-start behavior in this stage. A task still waits for its setup; the API remains free to answer requests while it waits. Keep the current 60-second registry deadline initially. Do not increase it to hide a stalled command.

The child-process adapter must distinguish launch failure, nonzero exit, timeout, signal, and cancellation. Cap captured output, sanitize errors, and do not print environment values or credentials. On timeout, terminate the child, allow a bounded grace period, escalate if necessary, and reap it before admitting another local registry operation. A caller cancelling its wait must not cancel work still needed by other waiters.

Use one local in-flight refresh per OpenClaw state/config target. Until change tracking is implemented, serialize different syncs rather than treating any in-progress refresh as sufficient for files written after it started. Preserve OpenClaw's own cross-process lifecycle lease; do not edit or bypass its SQLite locks.

This stage is the fallback build for the later optimization. It fixes event-loop blocking independently, but does not claim to solve all current OpenClaw registration or readiness failures.

## Stage B: track changes and reconcile the running gateway

### 1. Materialization returns what actually changed

Extend materialization results with stable configuration revisions and explicit change flags, alongside the existing paths and server names:

- MCP payload changed: commands, ordered arguments, cwd, environment/credential values, server membership, and tool filters.
- Plugin metadata changed: manifest, plugin identity, source path, or bundle existence.
- Activation/routing changed: effective enablement, agent slug, or resolved workspace.
- Deletion: a previous managed bundle or managed server was removed, including the transition to zero servers.

Compare canonical content, sorting object keys while preserving array order where meaningful. Retain valid existing keys. No-op sync must not mint credentials or rewrite files. Include the runtime executable/build and relevant OpenClaw version in reconciliation identity so an upgrade or deployment is not mistaken for an unchanged configuration.

Write changed files through same-directory temporary files and atomic rename. Finish the agent's file publication before acknowledging its revision. Serialize publications and admission for the same agent, and retain the current workspace isolation checks. Preserve unmanaged content. Do not use mtimes or the number of servers as the change detector.

### 2. Keep three separate records of progress

Track desired revision, materialized revision, and gateway-applied revision. Registry repair has its own result and timestamp; it is not the gateway-applied revision.

Persist pending reconciliation state in Agent HQ's PostgreSQL database, keyed by execution target and agent, with opaque revision identifiers, state, retry time, and sanitized failure details. Record pending work as part of configuration mutation, so a process crash after saving an edit does not lose the sync request. On startup, recover pending work and reconcile agents whose published files or receipts cannot be verified. Dispatch also detects drift as a recovery path.

A gateway receipt belongs to that gateway instance and the applicable runtime generation. Treat a gateway restart, uncertain reconnect, changed executable/version, changed workspace mapping, or missing file as invalidating the relevant acknowledgement. If no dependable gateway identity is available, conservatively re-establish the receipt after reconnection. Database state alone must never authorize reuse indefinitely.

Do not persist MCP secrets in the job record, logs, or receipt. Keep any credential-bearing content digest internal; expose an opaque revision identifier in diagnostics.

### 3. One coordinator owns reconciliation

Add an OpenClaw MCP reconciliation service used by dispatch, provisioning, explicit MCP sync, agent/server changes, and team changes. Changes enqueue desired state; the worker rereads authoritative state instead of replaying an old credential-bearing payload.

Within an API process, merge waiters for the same target and desired revision. Batch rapid edits with a short debounce, initially 250 ms, and flush that delay when a dispatch is waiting. A later edit supersedes older queued revisions. If revision B arrives while A is being applied, completing A must not mark B ready; schedule one follow-up pass and make B's waiters await it.

Across processes, use OpenClaw's supported lifecycle owner and cross-process lease for plugin mutations. A local promise map is only a load optimization, not a distributed lock. Production and development targeting the same OpenClaw state must be detected and assigned a single maintenance owner, or configured to separate targets, before enabling the optimized mode. Database-local locking cannot coordinate two different databases that share one gateway. Never hold a database transaction or row lock while waiting for OpenClaw or MCP callbacks.

### 4. Perform the operation appropriate to the change

| Situation | Registry maintenance | Gateway / launch requirement |
| --- | --- | --- |
| Same files, same verified gateway configuration | None | Continue normal per-run readiness checks. |
| MCP payload changed, existing plugin metadata unchanged | No unconditional disk-registry rebuild | Apply the affected plugin through the supported gateway lifecycle and verify the result. |
| New/removed bundle, changed manifest, trust or routing change | Inspect/repair registry as required by the supported lifecycle | Reconcile gateway metadata and the affected agent before dispatch. |
| OpenClaw upgrade, missing/corrupt registry, unknown gateway state | One coordinated inspection/repair as needed | Re-establish gateway acknowledgement; no reuse of an old receipt. |
| Manual forced repair | One awaited asynchronous repair | Report registry and runtime outcomes separately. |

Use the documented `plugins.reload` gateway operation for existing discovered plugins, through a narrowly scoped client adapter. Verify discovery/metadata lifecycle behavior for new and removed bundles in the compatibility test before choosing the exact operation for those transitions. No direct imports of OpenClaw's private compiled modules in production code. The private imports used in the experiment are diagnostic only.

The compatibility test must establish that the receipt corresponds to newly loaded `.mcp.json` contents, including payload-only edits. A generation number by itself is insufficient evidence. Couple the receipt to the local revision only when the files remained stable throughout application and the tested gateway contract establishes visibility. If the supported operation cannot do this for workspace bundles, leave Stage B disabled and retain Stage A; specify the missing OpenClaw support rather than substitute a global restart on every dispatch.

### 5. Preserve a launch barrier

Dispatch materializes the current revision, requests reconciliation if needed, and awaits that revision's result asynchronously. Then it performs required-tool readiness checks and submits the run. Recheck for a superseding edit before submission; serialize the final admission decision with changes to that agent's desired state.

An unchanged agent can launch while unrelated maintenance is pending if its own acknowledged configuration remains valid. A changed or unverified agent cannot launch using an old acknowledgement. A background sync returning “queued” must not be reported as “applied.” Explicit `/mcp/sync` keeps its awaited success/error semantics.

Keep the cold-session distinction: before the first turn, `tools.effective` may report not connected. Preserve the required-tool checks and allow that condition only with the established configuration/connection evidence. A genuinely stale catalog, failed probe, or missing required tool remains a startup error.

This barrier has an interface dependency on fixes 1, 3 and 4: unambiguous bundle identity, a gateway-scoped update, and checks against the intended configuration. Stage A can ship independently. Stage B must not claim safety based on the current global CLI probes or ambiguous bundle identity. Those other fixes are outside this specification.

## Failure, concurrency, and permissions

- A failed required reconciliation blocks affected new runs and reports the specific stage. Healthy unrelated agents are not failed merely because another agent's update failed.
- Retain desired state after failure. For transient contention, use bounded backoff, initially 2, 5 and 15 seconds with jitter, then leave a visible failed/pending state. New dispatches join existing work or cooldown instead of starting a new CLI storm. Invalid configuration or duplicate identity is not repeatedly retried.
- Keep registry maintenance's initial 60-second deadline. Gateway reload needs a separate budget that accommodates its documented 60-second drain; start with a 90-second client deadline and inspect uncertain outcomes. A timeout is not proof that no change was published, and must not cause blind replay.
- Preserve OpenClaw's drain behavior. Do not kill unrelated active runs or automatically restart the gateway to satisfy a setup deadline.
- Removal and revocation are changes. Continue existing authorization checks at tool invocation; refresh optimization must not weaken them. The generation barrier blocks new runs with stale assignments. It does not invent a guarantee of immediate revocation for arbitrary external servers in already-running sessions.
- Keep agent-specific files, tool filters and credentials isolated. A shared host operation must not combine agent payloads into a common permission surface.

## Regression tests and acceptance criteria

Unit mocks alone missed the earlier architectural mistakes. Release evidence must include these cases:

1. **API remains responsive:** run a real child fixture that waits for an HTTP callback from the same API, while unrelated health and callback requests complete. Repeat with a stalled child and verify timeout and cleanup. The test must fail if `spawnSync` is restored anywhere on this path.
2. **Unchanged dispatch:** after initial successful reconciliation, ten dispatches with identical nonempty config cause zero registry refreshes and zero plugin reloads; files, mtimes and credentials remain unchanged. Per-run readiness still runs.
3. **Actual gateway freshness:** an isolated OpenClaw 2026.9.6 gateway and synthetic MCP server expose distinguishable configuration versions. Change arguments, credential, tool allowlist, add a server, remove a server, and remove the last server. Verify the gateway sees each change without restarting it. Test fresh and reused sessions.
4. **No runtime interruption:** while agent A's tool call is active, update agent B. A completes normally; B sees its new configuration. Also exercise a busy affected plugin and the documented drain-timeout path.
5. **Concurrency:** simultaneous same-revision requests share work; an edit arriving mid-refresh requires a later acknowledgement; rapid team/server edits batch correctly. Verify the owner rule when two API processes target the same state.
6. **Ordering and identity:** bundle exists before trust registration; routed workspace is authoritative; wrong/shared workspace is refused; API boot does not manufacture a stale trust entry.
7. **Cold versus broken:** an expected cold-session notice is handled; missing required tools, actual stale catalogs, invalid JSON and disabled plugins fail before the agent turn.
8. **Crash/restart:** kill the worker between file publication and acknowledgement, restart the API/gateway, and recover pending work without treating the old receipt as current.
9. **Partial/uncertain failures:** nonzero exit, timeout, invalid registry JSON, incomplete workspace scope, missing binary, reload error before publication, reload error after publication, and cancellation remain distinguishable and recoverable.
10. **Security and environment:** permissions and credential reuse remain correct; logs contain no secrets; existing TLS, PATH, and gateway selection behavior is preserved; non-OpenClaw runtimes are unchanged.

The callback test should prove completion before the slow child exits, not merely assert that an async function was called. The gateway test should verify actual tool/config behavior, not just a successful CLI exit or equal tool counts. Acceptance for responsiveness is no child-duration-sized stalls; use controlled local latency thresholds and report baseline versus loaded results.

## Files and rollout

Expected code areas: `api/src/runtimes/mcpMaterialization.ts`; a new `api/src/services/openclawMcpReconciliation.ts`; the existing gateway client adapter; `api/src/services/dispatcher.ts`; sync callers in agent/server/team routes; a small PostgreSQL migration for reconciliation state; focused materializer, dispatcher, coordinator, and gateway tests.

Stage A is a separate change with existing behavior retained. Stage B is enabled by an explicit mode such as `AGENT_HQ_OPENCLAW_MCP_RECONCILIATION_MODE=on-change`, with `async-every-dispatch` as the fallback. The old disable-refresh switch remains an explicit bypass and must never manufacture a valid reconciliation receipt.

Run the isolated gateway matrix before enabling Stage B for a canary agent. Exercise repeated launches, a real configuration edit, a concurrent active session, and a gateway/API restart. Expand only after those pass. Log desired/applied revision, reconciliation reason, changed-file count, command/RPC duration, deduplicated waiters, and sanitized failure stage. Replace the current unconditional “registry refresh complete” message with the actual operation and result.

Rollback disables the optimization and returns to asynchronous awaited behavior. It never restores `spawnSync`. A rollback with uncertain gateway state re-establishes readiness instead of trusting a stale receipt.

## Evidence and limits

Primary local evidence: the commits above; `mcpMaterialization.ts` around lines 267, 1225, 1533 and 1627; `dispatcher.ts` around line 1558; `OpenClawRuntime.ts` around line 213; OpenClaw's installed `docs/cli/plugins/inspect-and-diagnose.md` and `uninstall-and-update.md`; compiled `package-manifest-C8sTeZKW.mjs` (`readPluginCacheFile`), `agent-bundle-mcp-runtime-config-DPo3ZJlp.mjs`, and `server-plugin-reload-C4M_bRdn.mjs`.

The diagnostic is `/private/tmp/agent-hq-registry-freshness-analysis.mjs`. It completed successfully after explicitly testing both retained and fresh cache behavior. No production configuration, registry, gateway, or task was changed during the investigation. Implementation and the completed subset of the gateway matrix are recorded in the update above; the remaining matrix remains a release gate.
