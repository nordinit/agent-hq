# Agent Runtime Boundary v1

Status: local boundary and durability baseline implemented; production verification remains
Scope: Claude Code and Codex local runtimes now; SSH, sandbox, and managed-agent targets later

## Objective

Agent HQ must treat an agent run as a durable control-plane operation, not merely a child process that was successfully spawned. A production-ready run has a validated input contract, an explicit execution target, isolated credential ownership, observable progress, a truthful terminal result, and a recovery decision after control-plane restart.

“100% working” means every applicable local-runtime acceptance gate in this document passes for the supported CLI/version matrix. It does not mean a vendor CLI can never change; unsupported versions must fail diagnosis instead of silently changing behavior. Remote-only gates become applicable when a remote target is enabled, not before.

The design follows the useful parts of [Paperclip's adapter model](https://github.com/paperclipai/paperclip/blob/master/docs/adapters/overview.md): runtime-specific invocation stays inside an adapter, session state survives the adapter object, prompt and workspace identity are explicit, and trust posture depends on the execution target. Paperclip now pairs local CLI/ACP drivers with host, SSH, and managed-sandbox targets and makes credential-home ownership explicit. Agent HQ adds a versioned, secret-free boundary and a durable lifecycle store so the same control plane can later operate those target shapes without changing workflow semantics.

## Sprint coverage

| Sprint work | Implemented baseline | Deliberately still open |
|---|---|---|
| 65 #533/#536 — Codex research and adapter | Native JSONL adapter, isolated config/profile policy, exact MCP preflight, transcript normalization, diagnostics, supported-version enforcement | Real production-profile fresh/resume canaries; automatic trusted resume producer |
| 65 #534/#537 — Claude headless refresh | CLI child-process adapter, strict settings/tool policy, run-scoped MCP config, live stream-json transcript, truthful stop/timeout | Claude resume/reattach and poisoned-session recovery |
| 65 #538/#539 — transcripts and generalized MCP | Shared normalized event/writer layer for Claude and Codex; tenant-scoped assignments and exact lifecycle-tool preflight | Migrating Hermes/OpenClaw writers; scoped API transport for registry tools |
| 111 #902 — durable state graph | Versioned runtime execution state, immutable boundary, local handle, atomic launch/terminal transitions, restart loss reconciliation | Full workflow transition graph and remote target leases |
| 111 #903 — checkpoints/resume | Ordered PostgreSQL checkpoints, native session capture, resume-sensitive fingerprint and Codex resume verifier | Dispatcher recovery producer, stream reattachment, end-to-end resume canaries |
| 111 #904 — transitions/evidence | Runtime terminal evidence and durable/job half-commit repair | Complete workflow evidence-gate orchestration |
| 111 #905 — interrupt/pause/redirect | Tenant-scoped stop, interrupt checkpoint, process-group TERM/KILL and timeout | Live pause/redirect protocol and adopted-process steering |
| 111 #906 — tool/runtime boundary | `RuntimeBoundaryV1`, exact assignments, auth references, target capabilities, executable identity | Concrete SSH/sandbox/managed target implementations |

## Current implementation boundary

Both dispatcher paths construct a `RuntimeBoundaryV1` and pass it to the selected adapter. Claude Code and Codex have local-process supervision, exact required-tool MCP preflight, live transcript normalization, durable PostgreSQL execution/checkpoint writers, runtime diagnostics, and an operator runtime-status view. Their normal scheduling path is fresh-session only. Normal dispatch also resolves one canonical host executable, fingerprints it, and probes it against the verified version family before launch; caller-selected binaries are rejected unless the host explicitly allowlists their absolute paths. Runtime-owned environment values cannot replace executable, shell, loader, or config-home resolution.

The following capabilities are deliberately not claimed as complete:

- `buildRuntimeBoundaryV1()` currently emits `priorCheckpoint: null`. Codex has a fail-closed checkpoint verifier and tested resume argv, but no dispatcher/recovery producer yet supplies the trusted checkpoint reference; a direct `runtime_config.resumeSessionId` is rejected. Claude Code has no `--resume` launch path.
- Restart reconciliation can verify a same-host local PID and its process-birth fingerprint, and can mark a disappeared or reused PID `lost` after two observations. It cannot reattach stdout/stderr, recover the detached child's exit status, or resume it.
- A leaderless process group that survives an API restart is deliberately quarantined rather than killed by numeric PGID. Safely adopting or killing that group requires a stronger target owner such as a container, cgroup, or Windows Job Object.
- SSH, sandbox, and managed-agent targets are schema and architecture extension points only. No remote target inspector, lease, callback receiver, or managed launch adapter is implemented by this local-runtime work.

Accordingly, automatic resume/reattach and the remote contract are future capabilities, not local Claude Code/Codex release gates. Real PostgreSQL concurrency/tenant tests, production-profile diagnostics, fresh-session CLI/MCP canaries, and a kill/restart/loss canary remain release evidence that must be collected in the deployment environment.

## Control-plane split

```text
dispatcher
  -> RuntimeBoundaryV1 (what may run)
  -> runtime driver     (Claude/Codex protocol and event decoding)
  -> execution target  (where/how it launches, inspects, stops, and resumes)
  -> normalized events + checkpoints
  -> workflow lifecycle (what the task outcome means)
```

These layers have different responsibilities:

| Layer | Owns | Must not own |
|---|---|---|
| Dispatcher | tenant/run identity, workspace, prompt fingerprint, tool assignments, credential references, policy | CLI argument quirks or resolved credential values |
| Runtime driver | Claude/Codex arguments, stdin/stdout protocol, native session ID, transcript normalization, error classification | target transport or workflow outcome |
| Execution target | launch, inspect, heartbeat/lease, interrupt, resume, target handle | prompt semantics or provider-specific event parsing |
| Workflow lifecycle | start/check-in/outcome/evidence/completion semantics | inferring process health from task outcome |

Today, `ClaudeCodeRuntime` and `CodexRuntime` combine the driver and the local-process target in one class. That is acceptable for the first implementation only if the persisted records keep `driver`, `backend`, and `execution_target_id` distinct. A future target interface should expose `launch`, `inspect`, `interrupt`, `resume`, and event streaming without changing `RuntimeBoundaryV1` or workflow code.

## RuntimeBoundaryV1

The dispatcher creates and validates one boundary before authentication materialization or launch. It is the complete, auditable input to the runtime driver:

- `identity`: tenant, project/workflow/task/instance, durable run, and agent identity.
- `runtime`: runtime type, driver version, canonical executable fingerprint, config revision, model/reasoning policy, timeout, token budget, and turn limit.
- `workspace`: container root, authoritative active repository root, repository source/mode/revision, and a workspace fingerprint.
- `prompt`: a prompt-bundle fingerprint, not a second mutable copy of the prompt.
- `executionTarget`: stable target ID, `local-process | ssh | sandbox | managed`, trust level, and negotiated capabilities.
- `tools`: built-ins, MCP assignments and required tools, lifecycle tools, and skill revisions.
- `auth`: provider and opaque credential references only.
- `evidence`, `callback`, `priorCheckpoint`, and observability correlation.

The boundary must never contain tokens, cookies, API keys, OAuth payloads, resolved environment values, callback secrets, signed URL parameters, or URL fragments. Durable launch specs likewise store only the canonical executable path and non-secret file fingerprint, sanitized arguments, and environment variable names. Operator-visible errors and terminal metadata must be redacted before persistence.

`fingerprintRuntimeBoundaryV1()` canonicalizes and hashes the resume-sensitive fields. Ordering differences do not change the hash. Observability data and `priorCheckpoint` are deliberately excluded because they change during recovery. Once a recovery producer supplies a trusted checkpoint, a resume may be permitted only when:

1. the stored boundary validates at its declared version;
2. the recomputed fingerprint matches the checkpoint;
3. workspace/repository identity still matches;
4. model, tool, MCP, skill, auth-reference, callback, and target policy still match; and
5. the target reports the required `resume` capability.

Any mismatch starts a new execution or fails closed; it must not attach to the old native session. Today Codex implements the fail-closed validation side of this contract, while ordinary dispatch cannot produce the required `priorCheckpoint`; Claude Code remains fresh-session only.

## Local Claude Code and Codex targets

The local target launches the CLI without a shell, sends prompts over stdin, decodes structured stdout, and supervises the entire POSIX process group. Stop and timeout send `SIGTERM`, wait the configured grace interval, then send `SIGKILL`. Normal leader exit is not terminal until the complete owned process group is absent; lingering descendants are terminated and absence is confirmed first. An abort response is successful only when the target was identified and signalled or was already gone; an absent in-memory handle is not a confirmed stop. Windows local execution fails closed until a Job Object (or equivalent verifiable tree owner) is implemented.

The process supervisor intentionally has API-process lifetime. Durable records are the cross-restart source of truth, but a stored PID or process-group ID must never be signalled blindly after restart because of PID/PGID reuse. A durable local launch is rejected before prompt delivery when a process-birth fingerprint cannot be established. The reconciler verifies hostname, leader existence, group existence, and the leader fingerprint. A live leaderless group is quarantined: it is neither signalled nor converged terminal because its numeric PGID is not durable authority. A legacy fingerprint-less live PID is likewise inconclusive rather than “alive.” Only after the complete group is absent does the reconciler begin the two-observation, at-least-15-second `lost` confirmation. An explicit tenant-scoped operator stop may signal a durable handle only after same-host birth-identity verification, waits for group absence, and escalates to `SIGKILL` when required.

The runtime driver is responsible for:

- exact, tested CLI argument order for the supported version matrix;
- an authoritative cwd equal to `activeRepoRoot` when present;
- MCP materialization and exact required-tool preflight before model spend; a required lifecycle boundary with a missing, duplicate, mismatched, unreadable, or incomplete Agent HQ server fails closed;
- native session/thread ID persistence as soon as it is known;
- live normalized transcript ingestion;
- timeout, abort, authentication, quota, transient, refusal, and protocol-error classification; and
- exactly one durable terminal transition plus the independent workflow lifecycle update.

## Credential and config-home ownership

Credential ownership must be unambiguous for every provider connection.

### Claude Code

Claude Code owns its login in the effective `CLAUDE_CONFIG_DIR`. Agent HQ stores only an opaque provider/profile reference and does not copy Claude OAuth credentials. Dispatch checks the effective profile with fixed `claude auth status --json` arguments and does not expose account output. The adapter disables ambient user/project/local settings, hooks, plugins, marketplaces, slash commands, and browser integration; strict MCP plus `--tools`, `dontAsk`, and `--allowedTools` form the callable-tool boundary. Without a selected provider connection, the operator-managed home is still used and is now checked rather than silently assumed. The code permits fallback to shared `~/.claude`, so multi-tenant deployments must enforce a dedicated, permission-restricted config directory as policy.

Claude MCP launch state is split deliberately. A minimal reusable `0600` snapshot under immutable numeric tenant/agent IDs contains only `AGENT_HQ_MCP_API_KEY`; it never carries a third-party server entry, URL, command, or secret. Every instance/session gets a unique run config, so concurrent runs cannot overwrite each other's `--mcp-config` input. Spawn/preflight failures remove that config immediately, while normal/error terminal paths remove it only after the complete owned process group is confirmed absent. Dispatch also scavenges inactive crash-left configs after 15 minutes while protecting in-process paths and active instance IDs from `runtime_executions`.

The materialized server-name set must equal the boundary exactly before preflight and assignment fingerprints/revisions are re-read immediately before spawn. An ad-hoc boundaryless launch may materialize no MCP servers. A server without `toolFilter.include` is represented explicitly as Claude's `mcp__<server>__*` wildcard; an explicit empty or fail-closed sentinel remains zero authority. Enabled registry tools currently reject Claude dispatch because the separate registry assignment system is not represented in `RuntimeBoundaryV1`.

### Codex

Codex has two explicit modes:

- Without a runtime-owned provider connection, Agent HQ creates a stable tenant-and-agent-ID-scoped `CODEX_HOME` below its runtime-state root and may materialize the selected `openai-codex` credential into that home. Slugs are never storage authority.
- With a provider connection, Codex owns the exact configured credential home, login refresh, and keyring state. Agent HQ verifies it but never overwrites `auth.json` or copies a global credential into it.
- Every dispatch writes a unique native Codex v2 profile rather than modifying the credential home's shared `config.toml`. The CLI receives that profile before the `resume` subcommand and explicitly disables ambient app, browser/computer-use, hook, plugin, memory, remote-plugin, and capability-discovery features. Codex 0.146's `--ignore-user-config` also suppresses the selected v2 profile, so the adapter does not use it: the credential home's user config must instead match a strict allowlist of inert settings, while dotted/quoted keys, multiline values, unsupported tables, exec-policy references, and all unknown fields fail closed. Applicable project `.codex/config.toml` and system config layers also fail closed before materialization and again immediately before spawn because project configuration outranks profiles. The enforced built-ins are `shell` and `apply_patch`; assigned MCP remains separate and exact.
- The ephemeral profile is removed on normal/error exit. A later dispatch also scavenges inactive crash-left profiles after a 15-minute race grace while protecting active execution IDs. The reusable Agent HQ MCP-key snapshot is tenant/agent-scoped outside the credential home.

An explicitly boundaryless Codex ad-hoc launch does not invent a tenant or agent identity and never falls back to shared ambient credentials. It requires a selected, authenticated provider-owned home, creates a random `0700` `CODEX_HOME` below the Agent HQ run-state root, links only that provider's `auth.json`, materializes an isolated zero-MCP profile, and removes the nonce directory only after confirmed process-tree absence. If descendant cleanup cannot be confirmed, the directory is retained with the quarantined tree instead of deleting credentials/configuration out from under it.

`CODEX_HOME` must survive API restarts because it contains native sessions as well as authentication and configuration. Boundary and operator-facing provider metadata use an opaque digest/reference and `credential_owner`; filesystem paths and account identifiers are not credential references and must not be persisted in the boundary.

For both runtimes, adapter-owned identity and config-home variables win over `runtime_config.env`. Configuration validation rejects protected identity, credential, executable-resolution, home/config, shell-startup, loader, proxy, and language-path variables case-insensitively rather than relying on merge order alone. Runtime children, auth/version probes, MCP preflight, provider discovery, and process inspection start from an explicit environment allowlist; database URLs, provider tokens, deployment credentials, proxy credentials, `NODE_OPTIONS`, SSH-agent sockets, and GPG signing handles are not inherited from the API process. Signing access can be added later only as an explicit target capability and credential reference.

The current Agent HQ MCP key remains a plaintext, permission-restricted value in materialized runtime configuration and the minimal tenant/agent-scoped reuse snapshot. The schema stores only its hash and has no lease/expiry/revocation lifecycle, so this cannot be fixed by redaction alone. Crash-left Claude run configs and Codex launch profiles may retain another copy until the next dispatch's 15-minute scavenger threshold. Run-scoped opaque credential exchange and revocation remain a release requirement for untrusted or strongly isolated multi-tenant targets. PostgreSQL registry-tool execution is disabled until it has a scoped API transport; Agent HQ does not pass `DATABASE_URL` into a model-readable tool shim.

Local process execution also remains an operating-system-user trust boundary, not a strong tenant sandbox. Permission-restricted files, environment scrubbing, exact tool policy, and process groups prevent accidental cross-run leakage but cannot stop another process running as the same host user from inspecting readable files or process state. Strong multi-tenant isolation requires the future sandbox/managed target with per-run credentials and leases.

## Durable executions and checkpoints

PostgreSQL migration `20-runtime-executions-and-checkpoints.sql` separates runtime transport state from task/workflow outcome:

- `runtime_executions` holds one current execution per tenant/instance: boundary and fingerprint, driver/backend/target, sanitized launch, opaque handle, native session, capability snapshot, lease/heartbeat, state, and terminal data.
- `runtime_checkpoints` is append-only and monotonically sequenced per execution. It records prepared/launched/session/progress/interrupt/terminal/reconciled observations and optional transcript cursor data.

The runtime state machine is:

```text
preparing -> starting -> running -> succeeded | failed
                         |       -> interrupting -> cancelled | failed | lost
                         +-------------------------------> lost
```

Same-state writes are idempotent and terminal states never reopen. After a confirmed spawn, dispatch claims the instance's execution and writes its `launched` checkpoint in one transaction; only a byte-equivalent retry is idempotent, and a conflicting process can never replace the authoritative handle. The losing caller tears down its newly spawned process group before returning failure. Session discovery appends a `session` checkpoint. Operator cancellation persists `interrupting` plus `interrupt_requested` atomically. Terminal process observation persists the final execution state plus its terminal checkpoint atomically, even when the agent has already posted its workflow outcome.

Runtime transport truth and the `job_instances` workflow projection remain separate commits because they represent different layers. Runtime monitors contain projection failures rather than creating unhandled rejections, and the reconciler repairs either half-commit: an active execution with a terminal job projection is converged only after process-tree absence, while a durable terminal execution with a missing/nonterminal job projection repairs the job without reopening or downgrading terminal runtime truth.

The implemented local reconciler scans active local-process rows and handles only rows from the current host with a parseable local handle. A matching live leader and process-birth fingerprint remains `running`. If `job_instances` already contains a terminal runtime projection while that verified group survives, reconciliation performs identity-safe group teardown and converges only after absence is confirmed. A leaderless surviving group, mismatched identity, failed inspection, missing PGID, or Windows process without a Job Object is quarantined with evidence and is neither signalled nor terminalized. Once the entire group is absent, disappearance must be observed twice across the confirmation window before the reconciler writes terminal state `lost` and appends a `reconciled` checkpoint. Cross-host rows and malformed handles are skipped rather than guessed.

This is loss reconciliation, not process reattachment. An API restart loses the in-memory stdout/stderr decoder and supervisor handle. If the child is still alive, the reconciler can only report it alive; when it later disappears, the durable result becomes `lost` because its real exit status and final stream are unavailable. An explicit stop can terminate the identity-verified surviving process group, but the code does not adopt its event stream, recover its exit status, or resume a replacement. A kill-and-restart test must exercise this exact behavior before local production rollout. Reattach/resume, observed detached terminal results, remote inspection, and lease-based recovery remain future execution-target work.

## Diagnostics and operations

`POST /api/v1/runtime-drivers/diagnose` is a no-model-spend prerequisite check. For an agent-scoped request it remains tenant-scoped and reports configuration validity, canonical executable path/fingerprint, supported CLI version, effective workspace, effective config home, and authentication readiness. Invalid configuration is never executed. The default `claude`/`codex` commands resolve only through absolute entries in the host-owned `PATH`; any custom absolute path must be present in `AGENT_HQ_ALLOWED_CLAUDE_BINARIES` or `AGENT_HQ_ALLOWED_CODEX_BINARIES`. A successful `--version` probe alone does not prove a runtime can execute.

`GET /api/v1/instances/:id/runtime` is the operator view of the durable execution. It must expose the actual migration schema, redact all nested sensitive values, and fall back to `job_instances` only for historical/pre-migration runs.

Deployment sequence:

1. Apply and verify the PostgreSQL migration before accepting runtime work.
2. Install an explicitly supported Claude Code and Codex CLI version on every local target.
3. Create isolated config homes with restrictive permissions and complete interactive/device login as the owning runtime user.
4. Run diagnostics for each production agent; warnings require an explicit operator decision.
5. Run fresh-session canaries for Claude Code and Codex in disposable worktrees with the real MCP lifecycle server. Run a Codex resume canary only after a trusted-checkpoint producer is enabled; Claude Code resume is not currently supported.
6. Confirm the runtime endpoint, transcript, token usage, workflow outcome, execution terminal state, and checkpoint sequence agree.
7. Exercise abort, timeout, API restart, and the current two-observation `lost` path before enabling normal scheduling. Do not interpret a still-live detached child as reattached.

## Managed and remote execution path

A remote Claude managed agent, SSH host, or sandbox adds an execution-target implementation instead of adding remote conditionals to the dispatcher. The boundary uses `repoAccessMode: remote`, a stable non-secret workspace/revision locator, an opaque `managed-identity` or provider-connection reference, and a target capability snapshot.

The target launch call uses `durableRunId` as its idempotency key and returns a `RemoteExecutionHandleV1` containing only the provider run ID, target ID, and start time. Credential values are resolved at the target boundary immediately before launch. Events arrive through a normalized stream, authenticated webhook, or polling adapter and feed the same transcript and checkpoint writers as local processes.

A remote target is eligible only when it proves every capability required by the boundary. Managed callbacks must be tenant-bound, signed, replay-resistant, and correlated to both durable run ID and external run ID. Loss of a webhook does not imply success or failure; lease-based reconciliation queries the provider and records the result.

This preserves the key invariant: moving Claude or Codex from a local CLI to a managed service changes the driver/target pairing, not task lifecycle semantics, authorization scope, or the durable audit model.

## Production acceptance gates

The local gates below are required for both Claude Code and Codex unless a row explicitly names one runtime. Future/remote-only rows do not block a local-runtime release, but become mandatory before that capability is enabled.

| Area | Pass condition |
|---|---|
| Registry | Selecting the runtime resolves the intended adapter; unknown runtime types fail closed rather than defaulting to another runtime. |
| Boundary | Every production dispatch supplies a valid, secret-free `RuntimeBoundaryV1`; persisted fingerprint is deterministic and changes for every resume-sensitive policy change, including executable identity. Boundaryless invocation is limited to explicitly ad-hoc calls with no database or durable instance context. |
| Supported CLI | Real installed CLI smoke tests assert exact fresh invocation/event shapes for both runtimes; unsupported versions fail both diagnosis and normal credential preparation. Verified ranges are Claude Code `>=2.1.220,<2.2.0` and Codex `>=0.146.0,<0.147.0`. Codex resume argv/checkpoint validation remains covered fail-closed until a trusted-checkpoint producer enables a real resume canary; Claude Code is fresh-only. |
| Authentication | The effective isolated home is the one used at launch; selected provider profiles and deployment diagnostics check auth without exposing account/credential output; Codex provider-owned homes are never overwritten. A shared Claude operator home requires an explicit deployment-policy decision. |
| Workspace | CLI cwd and reported active repository root match; local workspace escape attempts fail before launch. |
| Permissions | Default uses an explicit productive allowlist rather than an unrestricted bypass; dangerous/full-access modes require an explicit persisted opt-in; protected env and adapter-owned flags cannot be overridden. |
| MCP and skills | One assignment snapshot drives materialization and boundary construction. Immediately before launch the live MCP assignment fingerprints, live skill assignment set/revisions, and exact materialized server-name set must still match that immutable boundary. Boundaryless ad-hoc runs have zero assigned MCP. Every required tool is advertised by its exact assigned server before model spend; lifecycle tools are also included in Claude's callable allowlist. Claude uses unique run configs, an API-key-only tenant/agent snapshot, confirmed-cleanup plus a 15-minute active-ID-aware scavenger, and an explicit wildcard only when `toolFilter.include` is absent. Missing/unreadable materialization or registry capabilities outside the boundary fail closed. |
| Transcript | Prompt, reasoning/tool events, result, native session ID, usage, and terminal event survive malformed/partial lines without leaking sensitive stderr. |
| Lifecycle | The launch claim plus `launched` checkpoint, interrupt transition plus checkpoint, and terminal transition plus checkpoint are transactional. Conflicting launches cannot overwrite the first process handle; monitor-side projection failures are rejection-contained; reconciliation repairs either durable-runtime/job-projection half-commit without downgrading terminal truth. Session and reconciliation checkpoints remain ordered, and transport success remains independent from workflow outcome. |
| Stop/timeout | Descendant processes are terminated, result is truthful, duplicate stop is idempotent, and no run remains falsely `running`. |
| Restart loss reconciliation | Killing the API during an active local run preserves a matching same-host leader/group as alive and marks a completely absent group `lost` only after two identity-aware observations. A leaderless/unverifiable surviving group is quarantined without signalling. Reconciliation may tear down an identity-matched group only when a durable terminal job projection already exists, and must confirm group absence before convergence; a tenant-scoped explicit stop follows the same identity and absence rules. The canary must also demonstrate that this is not stream reattachment. |
| Diagnostics | Agent-scoped checks are tenant-safe and cover config, binary, supported version, workspace, effective config home, and auth without starting a model turn. |
| Observability | Runtime endpoint reads the live schema, redacts nested secrets, and agrees with execution/checkpoint rows and workflow records. |
| PostgreSQL | Migration, transactional checkpoint ordering, concurrent terminal/interrupt writes, and tenant isolation pass against real PostgreSQL. |
| Automatic resume/reattach (future; not a local release gate) | A trusted checkpoint producer, target adoption/inspection, and end-to-end canaries prove safe continuation without losing streams or terminal truth. |
| Remote contract (future; remote-only) | Before any managed target is enabled, a fake target proves immutable remote revision identity, idempotent launch, signed event handling, polling reconciliation, capability rejection, abort, resume, and target loss. |

No runtime should be described as production-ready while an applicable gate is skipped because a test database, credential, or CLI is unavailable. The release report must name every skipped local gate and keep that runtime disabled in environments that depend on it. An unavailable remote target is not a reason to block local execution; it is a reason to keep the remote capability disabled.
