# Hermes Runtime Adapter V1 Design

> Historical design note. The proxy-managed lifecycle model in this V1 design was deprecated by task #558; current Hermes runtime behavior uses Agent HQ MCP/capability lifecycle reporting plus runtime end-event/missing-outcome handling instead of parsed lifecycle blocks.
>
> Task #506 · Hermes Agent Runtime sprint
> Status: superseded historical design

## 1. Decisions

Hermes should ship in Agent HQ as a new local runtime adapter with these V1 rules:

- `runtime_type = 'hermes'`
- dispatch runs a local Hermes CLI process in the prepared Agent HQ task worktree
- lifecycle mode is **proxy-managed**, even though the runtime is local
- default invocation mode is **foreground one-shot** (`hermes -z`)
- default session behavior is **fresh Hermes session per Agent HQ instance**
- Agent HQ remains the source of truth for lifecycle, transcript persistence, timeout, abort, and final outcome handling
- Hermes gateway mode, ACP mode, background sessions, and `--worktree` are **out of scope for V1**

This keeps Hermes aligned with the existing `AgentRuntime` contract while avoiding control-plane ambiguity.

---

## 2. Adapter shape

Add a new runtime:

- `api/src/runtimes/HermesRuntime.ts`
- register in `api/src/runtimes/index.ts`
- export `HermesRuntimeConfig`

The adapter implements the existing interface:

```ts
interface AgentRuntime {
  dispatch(params: DispatchParams): Promise<{ runId: string }>;
  abort(runId: string, sessionKey: string): Promise<void>;
}
```

### Runtime classification

Hermes is a **local** runtime with **proxy-managed lifecycle**.

That means:

- `resolveTransportMode({ runtimeType: 'hermes' })` must return `'proxy-managed'`
- Agent HQ should render the proxy lifecycle contract into the prompt
- Hermes does **not** receive Agent HQ callback URLs as an execution contract in V1
- the adapter, not Hermes, calls `proxyStart`, `proxyHeartbeat`, `runPostStreamLifecycle`, `proxyOutcome`, and `proxyComplete`

This is the same lifecycle family as `veri`, but with a local child process instead of a remote SSE API.

---

## 3. Runtime config contract

```ts
export interface HermesRuntimeConfig {
  hermesBin?: string;
  profile: string;
  hermesHome?: string;
  lifecycleMode?: 'proxy';
  invocationMode?: 'z' | 'chat-q';
  sessionMode?: 'fresh';
  provider?: string | null;
  model?: string | null;
  workingDirectory?: string;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  extraArgs?: string[];
  env?: Record<string, string>;
  heartbeatIntervalMs?: number;
  killGraceMs?: number;
}
```

### Field rules

| Field | Required | Default | V1 rule |
|---|---|---:|---|
| `hermesBin` | no | `'hermes'` | Absolute path or PATH-resolved binary name |
| `profile` | **yes** | none | Dedicated Hermes profile for this Agent HQ agent |
| `hermesHome` | no | none | If set, exported as `HERMES_HOME` for stronger state isolation |
| `lifecycleMode` | no | `'proxy'` | Only allowed value in V1 |
| `invocationMode` | no | `'z'` | `chat-q` is allowed only as an explicit fallback/debug mode |
| `sessionMode` | no | `'fresh'` | Only allowed value in V1 |
| `provider` | no | `null` | Hermes provider override |
| `model` | no | `null` | Hermes model override |
| `workingDirectory` | no | none | Compatibility field only, overridden by `activeRepoRoot` during task dispatch |
| `ignoreUserConfig` | no | `false` | Adds Hermes user-config isolation when operators want it |
| `ignoreRules` | no | `false` | Disables Hermes local rules when required |
| `extraArgs` | no | `[]` | Validated allowlist only |
| `env` | no | `{}` | Additional process env for Hermes |
| `heartbeatIntervalMs` | no | `60000` | Runtime heartbeat cadence while process is alive |
| `killGraceMs` | no | `10000` | Grace period between terminate and force-kill |

### Config validation rules

V1 validation should reject:

- missing or empty `profile`
- `lifecycleMode` other than `'proxy'`
- `sessionMode` other than `'fresh'`
- `extraArgs` containing session reuse flags (`--resume`, `--continue`)
- `extraArgs` enabling nested workspace behavior (`--worktree`)
- `extraArgs` or positional values that switch Hermes into `gateway`, `acp`, `sessions`, or other long-lived subcommands

### Operational defaults

Recommended production config:

```json
{
  "profile": "agent-hq-cinder-backend",
  "lifecycleMode": "proxy",
  "invocationMode": "z",
  "sessionMode": "fresh",
  "heartbeatIntervalMs": 60000,
  "killGraceMs": 10000
}
```

If stricter runtime isolation is desired, add `hermesHome` and optionally `ignoreUserConfig: true`.

---

## 4. Dispatch mapping

Hermes dispatch must map existing `DispatchParams` into a local CLI launch.

### Path and workspace rules

| Dispatch input | Hermes behavior |
|---|---|
| `activeRepoRoot` | authoritative process cwd |
| `workspaceRoot` | broader workspace boundary only, passed as env metadata |
| `runtimeConfig.workingDirectory` | compatibility fallback only when `activeRepoRoot` is absent |
| `repoWorkspacePath` / `repoBranch` / `repoSource` | observability metadata only |

V1 rule: **never use Hermes `--worktree`**. Agent HQ already prepared the worktree and remains the source of truth for repo isolation.

### Prompt and execution mapping

| Dispatch input | Hermes launch mapping |
|---|---|
| `message` | prompt body passed to Hermes one-shot input |
| `name` | log/observability label only |
| `timeoutSeconds` | host-side process timeout enforced by the adapter |
| `model` | highest-precedence model override if compatible with Hermes |
| `thinking` | optional Hermes reasoning/effort mapping if Hermes exposes it, otherwise omit |
| `instanceId`, `taskId`, `sessionKey`, `agentSlug` | exported as env vars for observability and future bridge use |

### Env exported to the Hermes process

The adapter should always export:

- `AGENT_HQ_INSTANCE_ID`
- `AGENT_HQ_TASK_ID`
- `AGENT_HQ_SESSION_KEY`
- `AGENT_HQ_AGENT_SLUG`
- `AGENT_HQ_WORKSPACE_ROOT`
- `AGENT_HQ_ACTIVE_REPO_ROOT`

If configured:

- `HERMES_HOME=<runtime_config.hermesHome>`

Then merge `runtime_config.env` last.

### CLI assembly

V1 command shape:

```bash
hermes --profile <profile> -z "<prompt>"
```

Optional flags are appended from validated config:

- `--ignore-user-config`
- `--ignore-rules`
- provider/model override flags, when the installed Hermes build supports them
- validated `extraArgs`

Implementation note: provider/model flag assembly should live in one helper inside `HermesRuntime.ts`, because Hermes naming can evolve independently of Agent HQ.

### Precedence rules

1. `DispatchParams.model` wins when present and intentionally mapped into Hermes
2. else `runtime_config.model`
3. else Hermes profile/default config resolves the model

For provider:

1. `runtime_config.provider` when present
2. else Hermes profile/default config

Agent HQ should not attempt double routing after the adapter has handed explicit provider/model intent to Hermes.

---

## 5. Session semantics

Hermes profiles and Hermes sessions are different concepts. V1 should keep them separate.

### Profile semantics

- one Agent HQ Hermes agent maps to one dedicated Hermes profile
- profile reuse across multiple task instances for that same agent is allowed
- profile sharing across different Agent HQ agents is not recommended

### Session semantics

- every dispatched Agent HQ instance creates a **fresh** Hermes session
- Agent HQ does not pass `--resume` or `--continue`
- Hermes session ids, if later discovered, are metadata only in V1
- Agent HQ `sessionKey` remains the authoritative control-plane correlation key

### Why this split matters

- profile persistence gives Hermes stable auth, tools, and memory for the agent
- fresh per-task sessions keep Agent HQ evidence auditable and task-scoped
- this avoids accidental carry-over between unrelated Agent HQ tasks

---

## 6. Lifecycle and event flow

### Chosen strategy

**Proxy-managed lifecycle, owned by Agent HQ.**

Hermes should not be responsible for posting Agent HQ lifecycle callbacks in V1.

### Dispatch sequence

1. dispatcher resolves `runtime_type = 'hermes'`
2. dispatcher renders proxy-managed task contract into `message`
3. `HermesRuntime.dispatch()` calls `proxyStart()`
4. runtime persists the user prompt into `chat_messages`
5. runtime spawns Hermes in foreground mode
6. while the process is alive, runtime sends periodic `proxyHeartbeat()` calls
7. on successful stdout completion, runtime parses the final assistant output with `runPostStreamLifecycle()`
8. `runPostStreamLifecycle()` records review evidence, outcome, and instance completion
9. runtime persists assistant output and runtime-end metadata into `chat_messages`

### Transcript storage

V1 should persist a minimal Agent HQ-owned transcript, not depend on Hermes session storage.

Recommended message ids:

- `hermes-user-<instanceId>`
- `hermes-asst-<instanceId>`
- `hermes-runtime-end-<instanceId>`

### Transcript provider choice

For `runtime_type = 'hermes'`, `resolveTranscriptProviderByAgent()` should use the same chat-message-backed transcript strategy as current proxied runtimes, not the OpenClaw gateway/session provider.

A new dedicated `HermesTranscriptProvider` is optional. Reusing the existing chat-message-backed remote transcript pattern is sufficient for V1.

---

## 7. Failure, retry, and abort semantics

### 7.1 Dispatch/startup failures

Examples:

- Hermes binary not found
- Hermes binary not executable
- invalid profile/home path
- spawn failure before the child process is running

Behavior:

- adapter posts a truthful `proxyBlocker()` summary when instance/task context exists
- adapter throws from `dispatch()`
- dispatcher keeps ownership of backoff/retry behavior
- do **not** post a terminal task outcome for pre-launch dispatch failures

These are dispatch-path failures, not completed task runs.

### 7.2 Runtime failures after spawn

Examples:

- timeout
- terminated child process
- non-zero Hermes exit
- provider/auth/quota failure returned by Hermes
- output that never contains a valid lifecycle block

Behavior:

| Situation | Outcome |
|---|---|
| provider auth/rate/quota/model-availability infrastructure issue | `infra_failed` |
| other runtime/process failure after launch | `runtime_failed` |
| clean exit but missing or invalid lifecycle block | `blocked` via `runPostStreamLifecycle()` fallback |
| Hermes emits a valid lifecycle block with `failed`/`blocked`/other semantic outcome | respect the emitted semantic outcome |

### 7.3 Retry semantics

- automatic dispatcher retry applies only when `dispatch()` throws before handoff is complete
- once Hermes has started and the adapter records a terminal outcome, the task is no longer in dispatcher retry territory
- repeated runtime/provider failures should surface as truthful `infra_failed` or `runtime_failed`, not silent redispatch loops

### 7.4 Abort semantics

Run id format should be synthetic and stable:

```text
hermes:<instanceId>
```

Abort behavior:

- keep an in-process child handle map keyed by `instanceId`
- on `abort(runId, sessionKey)`, terminate the Hermes child
- wait `killGraceMs`
- if still alive, force-kill the process tree
- treat already-exited/missing child as success

V1 abort should not try to resume or manipulate Hermes session persistence.

---

## 8. Skill, tool, and workspace integration choices

### Skills

Map Hermes to concrete profile-level skill materialization in V1:

```ts
getSkillMaterializationAdapter('hermes') => new HermesSkillAdapter()
```

Materialization contract:

- Agent HQ remains the source of truth for assigned skills
- dispatcher materializes assigned skills into the Hermes profile `skills/` directory before launch
- Agent HQ also writes profile context artifacts under `.agent-hq/`, including an assigned-skills manifest and `SKILLS.md`
- stale removed skills are reconciled on the next materialization
- Agent HQ clears Hermes `.skills_prompt_snapshot.json` so Hermes rebuilds prompt state from the current derived skill set

This keeps Hermes skill access runtime-native without making Hermes profile files the canonical source of truth.

### MCP/tooling

Do not design V1 around Hermes gateway/plugin-managed lifecycle callbacks.

Hermes may still use its operator-configured tools/profile state, but Agent HQ should not require Hermes-specific MCP materialization before the adapter can work.

### Workspace

- cwd is the Agent HQ task worktree root
- no nested Hermes worktree
- no mutation of the canonical repo outside the prepared task worktree

---

## 9. Required implementation touchpoints

A faithful implementation of this design needs these repo changes:

1. `api/src/runtimes/HermesRuntime.ts`
   - local child-process dispatch
   - heartbeat timer
   - transcript persistence
   - lifecycle proxy integration
   - abort logic

2. `api/src/runtimes/index.ts`
   - export `HermesRuntime` / `HermesRuntimeConfig`
   - add `case 'hermes'`

3. `api/src/services/contracts/transportAdapters.ts`
   - classify `hermes` as `proxy-managed`

4. `api/src/domains/runs/transcriptProvider.ts`
   - map `hermes` to a chat-message-backed transcript provider

5. `api/src/domains/runs/stopInstanceExecution.ts`
   - call `runtime.abort()` for Hermes instances, same pattern as `veri`

6. `api/src/runtimes/skillMaterialization.ts`
   - map Hermes to `HermesSkillAdapter`
   - materialize assigned skills into Hermes profile `skills/`
   - write `.agent-hq/assigned-skills.json` and `.agent-hq/SKILLS.md`
   - clear stale Hermes prompt snapshot cache after reconciliation

7. agent create/update validation layers
   - accept `runtime_type = 'hermes'`
   - validate the Hermes config schema above

8. UI follow-up work
   - Hermes runtime type selector
   - config form fields for profile, binary, home, lifecycle mode, invocation mode, isolation flags

---

## 10. Non-goals for V1

Do not include these in the first implementation:

- Hermes gateway as the Agent HQ dispatch transport
- Hermes ACP as the dispatch transport
- Hermes-native callback plugins for Agent HQ lifecycle
- session resume/continue across Agent HQ tasks
- Hermes-managed nested git worktrees
- Hermes session DB as Agent HQ’s transcript source of truth

---

## 11. Final contract summary

Hermes V1 in Agent HQ is:

- a **local CLI runtime**
- with **proxy-managed lifecycle**
- using **foreground one-shot execution** by default
- running in the **Agent HQ-prepared task worktree**
- with **dedicated per-agent Hermes profiles**
- and **fresh per-task Hermes sessions**

That is concrete enough to implement without inventing a second control plane, while leaving room for later Hermes-native session or gateway integrations once the base adapter is stable.
