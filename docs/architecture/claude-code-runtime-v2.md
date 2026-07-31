# Claude Code Runtime v2 — Design Plan

Status: **Phases 0–2 implemented** (branch `claude-code-runtime-v2`); Phase 3 open; Phase 4 deferred

## Implementation status

| Phase | Status | Where |
|---|---|---|
| 0 — verification spike (#534) | **done** | §6 Phase 0 below, all findings empirical against CLI 2.1.220 |
| 1 — CLI runtime with lifecycle parity (#537) | **done** | `api/src/runtimes/claudeCode/` |
| 2 — MCP materialization + readiness gate (#539) | **done** | `claudeCode/mcpConfig.ts`, `api/src/bin/agent-tool-mcp.ts` |
| 3 — unified transcript ingestion (#538) | **not started** | see §6 Phase 3 |
| 4 — resume + prompt bundle | deferred by design | gated on sprint 111 #903 |

`1360 tests pass, tsc --noEmit clean, npm run build clean.`

### End-to-end verification

Run against the real `claude` CLI (2.1.220) and a real throwaway SQLite database —
no mocks — with a stand-in Agent HQ MCP server. Two scenarios:

| Scenario | Result |
|---|---|
| **healthy** | MCP preflight ok (1 tool, 22 ms) → agent wrote `e2e-proof.txt`, called `agent_hq_post_task_outcome`, replied DONE. `runtime_end_success = 1`, tokens `628/574/1202`, cost `$0.0126`, `session_key` written pre-spawn, `turn_end` row + `response.runtimeEnd` persisted. |
| **broken-mcp** | Preflight rejected dispatch with `spawn /nonexistent/agent-hq-mcp ENOENT`. **0 tokens spent**, no side effects, agent never started. |

The E2E is what caught the finding-1 bug: the first implementation gated on the
event stream and **failed a run that had actually completed its work**. Unit tests
could not have caught it — they encoded the same wrong assumption as the code.

Note that in the healthy run Agent HQ still marked the instance `failed` with
"ended without required lifecycle outcome". That is correct: the stand-in MCP
server logs calls to a file rather than really posting, so no semantic outcome
reached the DB. It confirms the layering — the *runtime* succeeded
(`runtime_end_success = 1`) and the *workflow* layer independently flagged the
missing outcome.

### Deviations from the original plan, and why

1. **MCP materialization happens inside the runtime, not in the dispatcher.**
   The plan proposed widening the dispatcher's `openclaw|hermes` gate. In the end the
   runtime writes its own run-scoped `mcp-config.json` and passes it via
   `--mcp-config`, so `syncAssignedMcpForAgent` did not need a new branch at all.
   This keeps the API-key-bearing file out of the task worktree (a git checkout),
   which the dispatcher path could not have done.

2. **The state dir is scoped per AGENT, not per instance.** Per-instance scoping
   looked tidier but would hand `fetchAssignedMcpServers` an empty
   `previousServers` on every dispatch, minting a fresh never-revoked
   `mcp_api_keys` row each run. Per-agent scoping is what makes the carry-forward
   actually work; the file is written via temp+rename since concurrent dispatches
   of one agent now share it.

3. **No heartbeat was added.** The plan assumed Hermes heartbeats. It does not —
   `heartbeatIntervalMs` is validated and normalized but the timer is hard-coded
   `null` (`hermes/HermesRuntime.ts:368`). Heartbeats/staleness live in
   `scheduler/watchdog.ts` against the `instance_artifacts` table, so runtime
   parity here means *no* heartbeat. Claiming otherwise would have been cargo-culting.

4. **Failure classification rides in runtime-end metadata.** Agent HQ's
   `infra_failed` / `runtime_failed` split lives in
   `dispatcher.classifyDispatchStartupFailure()` and only fires when `dispatch()`
   *throws*. Rather than duplicate it, the runtime emits `error_code` /
   `error_family` / `retry_not_before` in the `RuntimeEndEvent` metadata.

5. **Cost is recorded in metadata, not a column.** There is no `total_cost_usd`
   column on `job_instances` and no cost helper anywhere. Adding one means a
   migration in three places; the CLI reports cost per run, so it is captured in
   the runtime-end blob rather than dropped, and the column is a follow-up.

6. **The Agent SDK dependency is gone entirely.** Removing the SDK runtime left
   `toolInjection.createAgentToolServer()` with no callers; deleting it dropped the
   last `@anthropic-ai/claude-agent-sdk` import, so the dependency, its jest
   `moduleNameMapper` entry, and `src/__mocks__/` were all removed. Registry tools
   (task #559) are now served out-of-process by `src/bin/agent-tool-mcp.ts`, which
   also runs them in the run's own cwd instead of inside the API process.

### Known gaps

- **Live transcript streaming is Phase 3.** The runtime currently persists the
  prompt, the final assistant text, and the `turn_end` row — Hermes parity. Events
  are already parsed incrementally, so the normalizer has a seam to plug into.
- **The tool shim only materializes from a built `dist/`.** Its path is resolved
  from `__dirname`; running the API from source via `tsx` resolves to a `.js` that
  was never emitted, and the `existsSync` guard degrades to "no registry tools".
  Same limitation `resolveAgentHqServerRuntimePaths` already has.
- **`prepareAuthProfiles` is still a no-op.** Per-agent credential isolation is
  available via `runtime_config.claudeConfigDir` but is opt-in; without it every
  claude-code agent shares the API process's `~/.claude`.

---

Original plan follows.

Status: proposal
Covers: sprint 65 tasks #534 (research), #537 (implement), #538 (transcripts), #539 (MCP materialization)
Informs: sprint 111 tasks #902–#906 (Agent Runtime Hardening)
Reference implementation studied: `paperclipai/paperclip` → `packages/adapters/claude-local`

---

## 1. Where we are today

`api/src/runtimes/ClaudeCodeRuntime.ts` (330 lines) drives a headless Claude Code session
**in-process** via `@anthropic-ai/claude-agent-sdk` `query()` (pinned `^0.2.81`).
`dispatch()` fires `_run()` through `setImmediate` and returns `claude-code:<instanceId>`
immediately; the async generator loop then runs inside the pm2-managed API process.

Compared with the two runtimes that have already been through a full-runtime conversion
(`openclaw/`, `hermes/`), it is missing most of the contract:

| Capability | OpenClaw | Hermes | claude-code (today) |
|---|---|---|---|
| Agent HQ MCP materialization at dispatch | yes (workspace bundle) | yes (`.mcp.json` + `config.yaml`) | **no** — dispatcher gates on `runtimeType === 'openclaw' \|\| 'hermes'` (`services/dispatcher.ts:1583`) |
| Agent HQ MCP lifecycle tools reachable by the agent | yes | yes (task #546) | **no** — agent gets `AGENT_HQ_CALLBACK_*` env vars and is expected to `curl` them |
| Terminal runtime state persisted (`runtime_ended_at`, `runtime_end_success/source/error`) | yes | yes (`applyRuntimeEndToJobInstance`) | **no** — never written; nothing calls `onRuntimeEnd` either |
| Heartbeats while running | yes | yes (`heartbeatIntervalMs`) | **no** |
| Timeout enforcement | yes | yes (SIGTERM → SIGKILL after `killGraceMs`) | **no** — `timeoutSeconds` is ignored entirely |
| Live transcript during the run | yes | yes (2 s session-JSON poll) | **no** — one post-run JSONL ingest |
| Truthful abort | process/session level | SIGTERM/SIGKILL | in-process `AbortController` only |
| Session resume | n/a | intentionally blocked | not attempted |
| Error classification (auth / quota / transient / refusal) | yes | yes (`infra_failed` vs `runtime_failed`) | **no** — non-Abort errors rethrow into a `.catch` that only `console.error`s |

Two smaller drifts worth fixing in passing: the default model is hardcoded
`'claude-sonnet-4-6'` (`ClaudeCodeRuntime.ts:226`), and the `effort` union omits `xhigh`
(`ClaudeCodeRuntime.ts:32`, `domains/agents/runtimeConfig.ts:13`) — `xhigh` is the
recommended level for coding/agentic work on the current models.

The net effect: a claude-code agent cannot post a lifecycle outcome through the same
mechanism every other full runtime uses, and when its run ends Agent HQ has no
transport-level record that it ended. This is exactly the failure class task #546 fixed
for Hermes.

---

## 2. What sprint 65 asks for

- **#534** — decide whether the headless CLI (`claude -p --output-format stream-json`)
  replaces the SDK path, coexists, or becomes the default.
- **#537** — implement the chosen path with materialized Agent HQ MCP connections,
  stream-json transcript capture, truthful cwd/session semantics.
- **#538** — one transcript ingestion path shared by Codex CLI, Claude Code CLI, Hermes,
  OpenClaw.
- **#539** — generalize MCP materialization beyond OpenClaw; decide per runtime whether
  `.mcp.json`, a runtime-specific config file, env injection, or an adapter-owned
  in-process tool server is the right vehicle.

Sprint 65's stated goal is "moving Agent HQ away from proxy-managed runtime lifecycle
patterns toward agent-native MCP-driven task execution". The claude-code runtime is
currently the last proxy-managed local runtime.

---

## 3. Decision: move to the CLI, retire the SDK path

**Recommendation: `runtime_type: 'claude-code'` becomes a CLI-backed child-process runtime.
The SDK path is deleted, not retained as a fallback.**

The deciding factors, in order:

1. **MCP materialization is the whole point of the sprint, and the CLI does it natively.**
   `--mcp-config <path> --strict-mcp-config` consumes exactly the `{"mcpServers": {...}}`
   file that `materializeAgentMcpConfig()` already writes, and `--strict-mcp-config`
   makes the tool surface auditable: these servers and no others. The existing
   `fetchAssignedMcpServers()` already emits stdio server configs and injects
   `AGENT_HQ_MCP_API_KEY` per agent for the `agent-hq` slug
   (`mcpMaterialization.ts:633`). Nothing new has to be invented — claude-code just
   stops being excluded from the dispatcher branch.

2. **Process isolation.** The SDK loop runs inside `agent-hq-api`. A hung or leaking run
   degrades the control plane. Hermes and OpenClaw are out-of-process; claude-code should
   be too. It also makes timeout and abort *real* (SIGTERM → SIGKILL after a grace
   period) rather than dependent on an async generator unwinding cleanly.

3. **Version decoupling.** The CLI is operator-managed and updates independently
   (local install is 2.1.220). The SDK is an npm pin that requires an `npm run build` +
   `pm2 restart agent-hq-api` to pick up new capabilities — which is why the runtime is
   already behind on `effort: xhigh` and model defaults.

4. **`--session-id <uuid>`.** Agent HQ can mint the session UUID *before* spawn. That
   removes the current race where `session_key` is only written after the SDK's `init`
   message arrives, makes the transcript path deterministic at dispatch time, and gives
   sprint 111's checkpointing story (#903) a stable handle from t=0.

5. **Transcript uniformity (#538).** Codex (`codex exec --json`) and Claude Code
   (`--output-format stream-json`) are both line-delimited JSON on stdout from a child
   process. One ingestion pipeline covers both; the SDK's typed message stream is a
   second, unshareable shape.

**The one real cost:** `runtimes/toolInjection.ts` uses the SDK's `createSdkMcpServer()`
to expose registry tools (task #559) in-process. There is no MCP-server equivalent today —
`mcp/domains/tool-registry.ts` is CRUD over tool *definitions*, not an executor.

**Mitigation, and it's an improvement:** ship a small stdio MCP shim
(`api/dist/bin/agent-tool-mcp.js --agent-id <n>`) that reuses the existing
`fetchAgentTools()` + tool-execution code from `toolInjection.ts`, and materialize it as
one more entry in the run's `mcp-config.json`. It runs in the run cwd (preserving the
workspace boundary that in-process execution blurs), and it becomes available to Codex,
Hermes, and OpenClaw instead of being claude-code-only.

---

## 4. What Paperclip's `claude-local` adapter is worth copying

Concrete, transferable findings from `packages/adapters/claude-local/src/server/`:

**Invocation shape** (`execute.ts:838`) — prompt over **stdin**, not argv:

```
claude --print - --output-format stream-json --verbose
       [--resume <uuid>]
       (--dangerously-skip-permissions | --allowedTools <curated list>)
       [--model <id>] [--effort <level>] [--max-turns <n>]
       [--append-system-prompt-file <path>]   # first turn only
       [--mcp-config <path> --strict-mcp-config]
       --add-dir <prompt-bundle-dir>
```

**Permissions differ by trust boundary** (`permissions.ts`). Local target →
`--dangerously-skip-permissions`. Remote/sandbox target → an explicit
`--allowedTools` allowlist, so a hosted target does not inherit blanket local bypass.
Agent HQ's analogue is worktree-on-host vs. any future remote/clone execution target;
worth adopting the same split now rather than retrofitting.

**Session resume is fingerprinted, not blind** (`execute.ts:729-791`). A stored session is
only passed to `--resume` when *all* of: valid UUID, cwd unchanged, prompt-bundle hash
unchanged, MCP server-set identity unchanged, execution-target identity unchanged.
Otherwise it logs why and starts fresh. This is the single most reusable idea in the
adapter and it maps directly onto sprint 111 #903.

**Stable prompt bundle for cache hits** (`prompt-cache.ts`). Skills and the appended
system prompt are hashed into a content-addressed directory passed via `--add-dir`;
the hash is the `promptBundleKey` that gates resume. Instructions are injected with
`--append-system-prompt-file` **only on a fresh session** — re-injecting on resume wastes
5–10K tokens per turn and the CLI may reject the combination.

**Error taxonomy** (`parse.ts`, `execute.ts:1064-1204`). Distinct codes for
`claude_auth_required`, `provider_quota`, `claude_transient_upstream`, `model_not_found`,
`max_turns_exhausted`, `claude_refusal`, `claude_poisoned_previous_message_id`, plus a
`retryNotBefore` extracted from quota-reset text. Agent HQ's `infra_failed` vs
`runtime_failed` split is coarser; this is the shape to grow into.

**Poisoned-session recovery** (`docs/adapters/claude-local.md:47`). A malformed
`previous_message_id` in the on-disk JSONL makes every `--resume` deterministically 400.
Their guards: auto-rotate to a fresh session on that 400, delete the poisoned
`<session>.jsonl`, never persist the session id, and set `clearSession` so the server
drops it. Only relevant once we enable resume — but it's the failure mode that makes
resume dangerous without a validate-before-persist rule.

**Usage accounting** (`parse.ts:28`). Read `modelUsage` from the `result` event, not the
top-level `usage` — the latter undercounts whenever subagents/sidechains ran. Cache-creation
tokens count as input. The current SDK runtime sums per-assistant-turn `usage` and will
under-report exactly this way; `total_cost_usd` from the result event also gives us cost,
which we don't record at all today.

**Terminal-result cleanup grace** (`execute.ts:929`). Treat "the `result` event has been
seen" as the signal that the run is logically done, and give lingering background children
a bounded grace period before force-kill.

---

## 5. Target module layout

Mirror `runtimes/hermes/` and `runtimes/openclaw/` so the three read the same way:

```
api/src/runtimes/claudeCode/
  ClaudeCodeRuntime.ts    # spawn, lifecycle, heartbeat, timeout, runtime-end
  config.ts               # runtime_config schema + validation (create/update + pre-spawn)
  args.ts                 # buildClaudeArgs() — pure, unit-testable
  streamJson.ts           # NDJSON parse: session id, model, usage, cost, result, errors
  transcript.ts           # stream-json events -> chat_messages (shared normalizer)
  resume.ts               # session fingerprint + resume eligibility
  abort.ts                # SIGTERM -> SIGKILL grace
  promptBundle.ts         # content-addressed skills + append-system-prompt dir
  errors.ts               # error classification -> errorCode / errorFamily / retryNotBefore
  index.ts
api/src/bin/agent-tool-mcp.ts   # stdio MCP shim exposing registry tools
```

`runtimes/toolInjection.ts` keeps `fetchAgentTools()` and the executor; only the
`createSdkMcpServer` wrapper moves into the shim. `ClaudeCodeSessionAdapter` and
`ClaudeCodeTranscriptProvider` stay — the JSONL layout under `~/.claude/projects/` is
unchanged by the CLI switch — but become the backfill path rather than the only path.

---

## 6. Phased plan

### Phase 0 — verification spike (task #534 deliverable) · DONE

Executed against Claude Code CLI **2.1.220**. All findings empirical.

**Flags — all confirmed working:**

| Flag | Result |
|---|---|
| `--session-id <uuid>` | Honored exactly; every event carries the pre-minted id. Session key can be written before spawn. |
| `--max-turns <n>` | **Works**, despite being absent from `claude --help`. Yields `subtype: "error_max_turns"`, `terminal_reason: "max_turns"`, `is_error: true`, `errors: ["Reached maximum number of turns (1)"]`. *Risk #1 in §8 is closed — `story_point_model_routing.max_turns` needs no new home.* |
| `--mcp-config <file>` | Tolerates extra top-level keys. `{"mcpServers":{…},"__agentHqManagedKeys":[…],"servers":{}}` parsed without complaint, so `materializeAgentMcpConfig()` output can be passed as-is. |
| `--append-system-prompt-file <path>` | Works (undocumented but real). |
| `--effort xhigh` | Accepted. |
| `--permission-mode bypassPermissions` | Honored; echoed in `init.permissionMode`. |
| `--tools "Bash,Read"` | Replaces the built-in tool set **entirely** — `init.tools` was exactly `["Bash","Read"]`. A cleaner boundary primitive than `--allowedTools` for #906. |

**Three findings that change the design:**

1. **`system/init` can be emitted more than once — but its MCP status is not a
   readiness signal.** ⚠️ *Corrected during implementation; the original reading of
   this finding was wrong and shipped a bug.*

   The first probe showed one init with `mcp_servers: [{status: "pending"}]` and a
   later one with `"connected"`, which suggested "read readiness from a later init".
   The E2E disproved it. Measured against the real CLI:

   - A **fully healthy** run emitted **one** init, server stuck at `"pending"`,
     never re-emitted — while the agent went on to successfully call
     `mcp__agent-hq__agent-42__agent_hq_post_task_outcome`.
   - A run with a **bogus** server command also reported `"pending"`.
   - MCP tools do **not** appear in `init.tools`; they are discovered lazily via
     `ToolSearch`.

   So `pending` means "unknown", not "broken", and `connected` only appears
   incidentally (the first probe's run happened to spawn a background task, which
   re-emitted init). A gate built on this fails **healthy** runs — which is exactly
   what happened on the first E2E attempt.

2. **A failed MCP server does not fail the run — it degrades silently.** A config
   pointing at `/nonexistent/definitely-not-here` produced
   `terminal_reason: "completed"`, `subtype: "success"`, exit 0. So a claude-code agent
   whose Agent HQ lifecycle server failed to start will run to apparent success while
   being structurally unable to post an outcome — the #546 Hermes failure, silent.

   Because finding 1 rules out any in-band signal, readiness is established
   **out-of-band**: `mcpPreflight.ts` starts each required server exactly as the CLI
   would and completes an `initialize` + `tools/list` handshake **before** spawn. A
   required server that fails preflight rejects the dispatch, so the dispatcher's
   existing `classifyDispatchStartupFailure` path handles it — and the run costs
   **zero model spend** instead of a full wasted run.

3. **Multiple `result` events per process.** A run that spawned a background task emitted
   two `result` events on the same `session_id` (`num_turns` 5 then 1). Terminal state is
   **process exit**, not the first `result`.
   - `modelUsage` is the **cumulative process-wide** ledger — byte-identical in both
     result events (`inputTokens: 620, outputTokens: 1576, costUSD: 0.0486388`).
   - top-level `usage` is **per-segment** and undercounts badly (43/1043 vs 620/1576).
   - Rule: take `modelUsage` and `total_cost_usd` from the **last** result event. Do not
     sum; do not use top-level `usage`. This empirically confirms Paperclip's
     `claudeModelUsageTotals` choice and explains *why* the current SDK runtime, which
     sums per-assistant-turn `usage`, under-reports.

**Event inventory for the #538 normalizer** (observed types):
`system/init`, `system/status`, `system/thinking_tokens`,
`system/task_started`, `system/task_progress`, `system/task_updated`,
`system/task_notification`, `system/background_tasks_changed`,
`assistant` (content blocks: `thinking` / `text` / `tool_use`),
`user` (content: `tool_result`; plus a `tool_use_result` sibling carrying
`{stdout, stderr, interrupted, isImage, noOutputExpected}`),
`rate_limit_event`, `result`.

**Bonus — structured quota signal.** `rate_limit_event` carries
`rate_limit_info: {status, resetsAt, rateLimitType, overageStatus, overageDisabledReason,
isUsingOverage}`. Agent HQ can classify quota exhaustion *structurally* and compute
`retryNotBefore` from `resetsAt` — strictly better than Paperclip's regex scraping of
error prose, and it should feed the existing `providerLimitFailure.ts` path.

**MCP tool naming:** `mcp__<serverName>__<toolName>` (e.g.
`mcp__agent-hq__agent-42__agent_hq_post_task_outcome`). This is the string the readiness
gate must match on.

### Phase 1 — CLI runtime with lifecycle parity (task #537) · ~2–3 days

1. Spawn `claude` as a child process with `--session-id <pre-minted uuid>`, prompt on
   stdin, cwd = `activeRepoRoot` (keep the existing `validateAndLogViolation` boundary check).
2. Write `job_instances.session_key = claude-code:<uuid>` **before** spawn.
3. Parse stdout NDJSON incrementally; on the `result` event capture `modelUsage`,
   `total_cost_usd`, `subtype`, `is_error`.
4. Heartbeat while alive (`heartbeatIntervalMs`, default 60 s — same shape as Hermes).
5. Enforce `timeoutSeconds`: SIGTERM, then SIGKILL after `killGraceMs`.
6. Emit a `RuntimeEndEvent` **and** call `applyRuntimeEndToJobInstance()` — the
   `AgentRuntime` contract in `types.ts:136` requires the runtime to persist terminal
   state itself, and today's implementation does neither.
7. Classify failures into `errorCode`/`errorFamily` per §4; map to the existing
   `infra_failed` / `runtime_failed` split at the job-instance level.
8. Fix the drifted defaults: model default → `claude-opus-5` (or leave unset and let
   dispatch/model-routing decide), and add `xhigh` to the `effort` union in both
   `claudeCode/config.ts` and `domains/agents/runtimeConfig.ts`.

Ship this with `--mcp-config` still absent so the change is bisectable.

### Phase 2 — MCP materialization for claude-code (task #539) · ~1–2 days

1. Widen the dispatcher branch at `services/dispatcher.ts:1583` from
   `openclaw|hermes` to include `claude-code`, with `effectiveMcpDir = activeRepoRoot`
   (same as Hermes).
2. Write a per-run `mcp-config.json` under a run-scoped state dir (Paperclip's
   `<stateDir>/runs/<runId>/mcp/mcp-config.json`, mode `0600`) rather than committing
   `.mcp.json` into the task worktree — the worktree is a git checkout and a stray
   `.mcp.json` with an API key in it is an evidence-integrity problem.
3. Pass `--mcp-config <path> --strict-mcp-config`.
4. Build and materialize the `agent-tool-mcp` stdio shim so task #559's registry tools
   survive the SDK removal.
5. Update the dispatch contract text (`services/contracts/`) so claude-code agents are told
   to use Agent HQ MCP lifecycle tools (`agent_hq_start_task_run`,
   `agent_hq_check_in_task_run`, `agent_hq_post_task_outcome`) instead of curling
   `AGENT_HQ_CALLBACK_*`.
6. **Readiness preflight (mandatory — see Phase 0 findings 1 and 2).** Before spawn,
   start each required MCP server exactly as the CLI would and complete an
   `initialize` + `tools/list` handshake (`mcpPreflight.ts`). Reject the dispatch if
   any required server fails. Do NOT try to read readiness from the event stream —
   finding 1 shows it fails healthy runs. Preflighting also means a broken lifecycle
   server costs nothing rather than a full wasted run.

Keep the `AGENT_HQ_CALLBACK_*` env vars for one release as a compatibility path, then delete
them — mirroring how #546 handled Hermes' fenced-block fallback.

### Phase 3 — unified transcript ingestion (task #538) · ~2 days

Define one normalizer interface consumed by Codex, Claude Code, Hermes, and OpenClaw:

```
RuntimeTranscriptEvent =
  | { kind: 'text',        role, text }
  | { kind: 'thought',     text }
  | { kind: 'tool_call',   toolName, input, callId }
  | { kind: 'tool_result', callId, output, isError }
  | { kind: 'usage',       inputTokens, outputTokens, cachedInputTokens, costUsd }
  | { kind: 'terminal',    success, reason, raw }
```

Each runtime supplies a source-specific decoder; a shared writer upserts into
`chat_messages` with deterministic ids (`<runtime>-<instanceId>-<seq>`), the same
idempotent-upsert trick Hermes uses (`hermes-json-<instanceId>-<i>-<j>`). Canonical-session
ingestion (`lib/canonicalSessions.ts`) stays the backfill path and becomes a
reconciliation check rather than the primary write.

Live streaming (write as events arrive) is the point — it removes the "run looks silent
until it finishes" gap that both claude-code and Codex have today.

### Phase 4 — resume + prompt bundle (optional, gates on sprint 111 #903)

Only worth doing once #903 settles resume semantics. Build the fingerprint first
(`{sessionId, cwd, promptBundleKey, mcpServerIdentity, model}`), persist it alongside the
instance, and refuse resume on any mismatch. Add the poisoned-session guards from §4 in the
same change — resume without validate-before-persist is how a task gets permanently stranded.

---

## 7. How this feeds sprint 111

The runtime is one node in the durable graph, and four of the five hardening tasks have a
cheap hook that should be built in Phase 1–2 rather than retrofitted:

| Sprint 111 task | Hook to build now |
|---|---|
| **#902** durable state graph | `applyRuntimeEndToJobInstance` on every terminal path gives the node a real terminal edge. Today claude-code runs have no transport-level end state at all, so any graph model built on `job_instances` is missing this runtime entirely. |
| **#903** checkpointing / resumability | Pre-minted `--session-id`, plus the resume fingerprint from §4. That fingerprint *is* the checkpoint record: what must match for a resumed run to be provably continuing the same task. |
| **#904** transitions / evidence gates | Unaffected by the runtime change, but Phase 2 is a precondition — an agent that cannot reach `agent_hq_post_task_outcome` cannot satisfy an evidence gate, which is precisely the #546 Hermes failure. |
| **#905** interrupts | A child process makes pause/stop/cancel truthful. Note for the planning task: `--input-format stream-json` supports realtime streaming input, which is the mechanism for *redirect* (steer a live run) rather than only *cancel*. Worth capturing in #905 as a capability the design can assume. |
| **#906** tool/runtime boundary contract | The CLI arg vector is the boundary payload made declarative: `--mcp-config`/`--strict-mcp-config` (tools), `--add-dir` (skills), `--tools`/`--allowedTools` (permissions), `--settings`/`--setting-sources` (config provenance), `--model`/`--effort` (model policy), cwd (repo). `args.ts` should be a pure function of a single typed boundary payload so #906 has a concrete schema to point at. |

---

## 8. Risks

- ~~**`--max-turns` may be gone.**~~ **Closed by Phase 0** — it works. Note the general
  hazard stands: the CLI silently ignores unknown flags, so any future flag rename is an
  invisible regression. `args.ts` should be covered by a test that asserts the exact argv,
  and operator-supplied `extraArgs` should be denylisted the way Hermes does.
- **Silent MCP degradation** (Phase 0 finding 2) is the highest-severity behavioural risk
  in this design. Without the Phase 2 readiness gate, the migration would make claude-code
  runs *look* healthier than the status quo while still being unable to post outcomes.
- **Auth ownership.** The SDK inherits the API process's environment. The CLI will too
  unless we set `CLAUDE_CONFIG_DIR` per agent. Recommend per-agent config dirs (Paperclip's
  managed-config model) so agents don't share credentials or session history — but note
  `prepareAuthProfiles()` currently returns `skipped` for claude-code, so this is new
  surface, not a port.
- **Secrets in the worktree.** Do not write `.mcp.json` into the task worktree; it carries
  `AGENT_HQ_MCP_API_KEY`. Run-scoped state dir, mode `0600`.
- **Existing claude-code agents.** `db/seed-dev.ts` has three (`Forge`, `Kai`, `Pixel`).
  `validateClaudeCodeRuntimeConfig` requires `workingDirectory`; the CLI path should treat
  it as a fallback behind `activeRepoRoot`, exactly as the SDK path already does
  (`ClaudeCodeRuntime.ts:104`) — no config migration needed.
- **Scope.** Phases 1–3 are the sprint-65 deliverable. Phase 4 should not start before
  #903 produces its brief.
