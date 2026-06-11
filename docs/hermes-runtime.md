# Hermes Runtime Support

Hermes runtime support lets Agent HQ dispatch a task to a local Hermes CLI process while Agent HQ remains the source of truth for task lifecycle, routing, evidence, and transcripts.

This document reflects the implemented Agent HQ adapter path in `api/src/runtimes/HermesRuntime.ts` and the agent API validation in `api/src/routes/agents.ts`.

## Runtime Model

Hermes is registered as `runtime_type: "hermes"` and is launched by the Agent HQ API as a local child process.

The implemented dispatch path:

1. Resolves the agent's `runtime_config`.
2. Uses the task `activeRepoRoot` as the Hermes process cwd when available.
3. Materializes assigned MCP server config into the task worktree, and into `hermesHome` when configured.
4. Prepends an Agent HQ run context block with `instance_id`, `durable_run_id`, `task_id`, and `session_key` markers.
5. Starts `hermes --profile <profile> -z <prompt>` by default.
6. Polls Hermes' native session JSON while the child process is alive and imports matching transcript rows into `chat_messages`.
7. Persists fallback stdout/stderr output only when no richer Hermes JSON transcript rows were imported.
8. Tracks run end metadata on the job instance.
9. Uses the Hermes process exit, timeout, or abort result to classify runtime completion.

Hermes is currently classified by Agent HQ's contract system as a local runtime. That means normal Agent HQ dispatch instructions can provide MCP lifecycle/task tools to the Hermes-run agent.

## Host Setup Assumptions

Agent HQ does not install Hermes for you. Every host that may execute Hermes-backed agents must provide:

- A working Hermes CLI binary on `PATH`, or an absolute path in `runtime_config.hermesBin`.
- A dedicated Hermes profile for each Agent HQ Hermes agent.
- Provider credentials and model configuration available to that Hermes profile or passed through runtime env.
- Filesystem access from the Agent HQ API process to the prepared task worktree.
- Permission for the Agent HQ API process to spawn the Hermes binary.
- Any MCP/tool dependencies required by the assigned agent's Hermes profile.

Recommended operator setup:

```bash
hermes --profile agent-hq-example auth
hermes --profile agent-hq-example model
hermes --profile agent-hq-example -z "Say ready"
```

Use a profile name that clearly belongs to Agent HQ, such as `agent-hq-cinder-backend`. Do not point scheduled Agent HQ agents at a developer's personal default Hermes profile unless state bleed is explicitly acceptable.

For stronger state isolation, configure `hermesHome` to a directory owned by the Agent HQ service account. Agent HQ exports that value as `HERMES_HOME` and also materializes the agent MCP config there.

## Runtime Config

Store Hermes settings on the agent as `runtime_config`.

```json
{
  "profile": "agent-hq-cinder-backend",
  "invocationMode": "z",
  "sessionMode": "fresh",
  "hermesBin": "hermes",
  "hermesHome": "/var/lib/agent-hq/hermes/cinder-backend",
  "provider": "openai",
  "model": "openai/gpt-5",
  "ignoreUserConfig": false,
  "ignoreRules": false,
  "extraArgs": [],
  "env": {
    "HERMES_LOG_LEVEL": "info"
  },
  "heartbeatIntervalMs": 60000,
  "killGraceMs": 10000
}
```

| Field | Required | Implemented behavior |
|---|---:|---|
| `profile` | yes | Passed as `--profile <profile>`. This is the primary Hermes isolation boundary. |
| `hermesBin` | no | Defaults to `hermes`; can be an absolute path or PATH-resolved command. |
| `hermesHome` | no | Treated as the Hermes home root; Agent HQ exports the resolved profile home as `HERMES_HOME`, materializes MCP config there, and reads native transcript JSON from the profile `sessions` directory. |
| `invocationMode` | no | Defaults to `"z"` for one-shot `hermes -z`; `"chat-q"` runs `hermes chat -q`. |
| `sessionMode` | no | Only `"fresh"` is supported. Agent HQ does not pass resume/continue flags. |
| `provider` | no | Passed as `--provider <provider>` when set. |
| `model` | no | Passed as `--model <model>` when set. The dispatch model overrides runtime config model when present. |
| `workingDirectory` | no | Fallback only when dispatch has no `activeRepoRoot` or `workspaceRoot`. |
| `ignoreUserConfig` | no | Adds `--ignore-user-config`. |
| `ignoreRules` | no | Adds `--ignore-rules`. |
| `extraArgs` | no | Appended before the invocation command after validation. |
| `env` | no | Merged into the child process env after Agent HQ metadata env vars. Values must be strings. |
| `heartbeatIntervalMs` | no | Runtime heartbeat cadence while the Hermes process is alive. Defaults to 60000. |
| `killGraceMs` | no | Grace period before force-kill after timeout or abort. Defaults to 10000. |

Agent create/update validation rejects:

- Missing or empty `profile`.
- Removed `lifecycleMode` config; Hermes agents must use Agent HQ MCP/capability lifecycle tools.
- `invocationMode` values other than `"z"` or `"chat-q"`.
- `sessionMode` values other than `"fresh"`.
- Non-array or non-string `extraArgs`.
- `extraArgs` that enable unsupported runtime shapes: `--resume`, `--continue`, `--worktree`, `gateway`, `acp`, or `sessions`.
- `env` values that are not strings.

The runtime adapter performs a second validation pass before spawning Hermes. That lower-level validation also blocks argument entries that would override adapter-owned invocation or profile control, including `--profile`, `-p`, `-z`, `chat`, `tools`, `skills`, `config`, `model`, and `auth`.

## Lifecycle and Transcripts

Agent HQ treats the job instance and `sessionKey` as the authoritative control-plane identifiers. Hermes session ids are not required for V1 correctness.

The dispatched Hermes prompt includes this Agent HQ run context block before the task prompt:

```text
<Agent HQ run context>
instance_id: <job instance id>
durable_run_id: <durable run id>
task_id: <task id>
session_key: <session key>
</Agent HQ run context>
```

Hermes native session JSON is ingested only when a session file contains an exact run marker for the active `instance_id`, `durable_run_id`, or `session_key`. If more than one Hermes session file matches, Agent HQ treats the match as ambiguous and does not import any native rows for that poll.

The native session directory is resolved as:

- `<runtime_config.hermesHome>/profiles/<profile>/sessions` when `hermesHome` is configured as a Hermes root, with compatibility for direct profile-home or sessions paths.
- `~/.hermes/profiles/<profile>/sessions` otherwise.

While the Hermes child process is running, the adapter polls the native session JSON every 2 seconds. It also performs one final ingest after process exit and before writing the terminal `hermes-runtime-end-<instanceId>` row.

Imported Hermes `messages[]` are converted into `chat_messages` rows:

- `role=user` text becomes `event_type=text`.
- Assistant plain text becomes `event_type=text`.
- Assistant `tool_calls[]` become `event_type=tool_call`, role `assistant`, content set to the tool/function name.
- `role=tool` output becomes `event_type=tool_result`, role `tool`.
- Assistant `reasoning_content` becomes `event_type=thought` only when it is already plain text.

Rows use deterministic IDs of the form `hermes-json-<instanceId>-<messageIndex>-<eventIndex>`, so repeated polls update the same rows and append newly written messages without duplicates. Imported rows include `session_key`, `durable_run_id` when available, `event_meta`, and timestamps from the message/session metadata with file mtime fallback.

The adapter also persists these Agent HQ-owned transcript records when a database handle is available:

- `hermes-user-<instanceId>` for the prompt sent to Hermes.
- `hermes-asst-<instanceId>` for stdout or stderr output when native transcript rows were not imported.
- `hermes-runtime-end-<instanceId>` for terminal metadata.

For transcript resolution, Hermes agents use the chat-message-backed remote transcript provider with source `remote-hermes`. Existing `/api/v1/sessions/import/instance/:id` ingestion and active-session sync copy `chat_messages` into `session_messages`; Hermes does not expose a separate public transcript API.

On failures:

- Spawn failures call the lifecycle blocker path when lifecycle context is available and throw `Hermes runtime failed to launch`.
- Timeouts terminate the process with `SIGTERM`, then `SIGKILL` after `killGraceMs`.
- Non-zero exits are classified as `infra_failed` when stderr/stdout looks like auth, provider, quota, permission, or model infrastructure failure; otherwise they are `runtime_failed`.
- Abort sends `SIGTERM`, then `SIGKILL` after `killGraceMs`.

## Known Limitations

- Hermes gateway mode is not the Agent HQ dispatch path.
- Hermes ACP mode is not the Agent HQ dispatch path.
- Hermes `--worktree` is intentionally blocked; Agent HQ already prepares and owns task worktrees.
- Session reuse is intentionally blocked; `--resume` and `--continue` are not allowed in V1.
- Process termination may not undo every side effect of tools Hermes started before timeout or abort.
- Provider/model ids are passed through to Hermes; Agent HQ does not validate that a given Hermes installation supports them before spawn.
- Hermes profile config, credentials, tools, plugins, and memory are operator-owned host state.

## Troubleshooting

### Hermes binary is missing

Symptoms:

- Dispatch fails before Hermes starts.
- Runtime error includes `spawn ENOENT`.
- Agent HQ reports `Hermes runtime failed to launch`.

Checks:

```bash
which hermes
hermes --version
```

Fix:

- Install Hermes for the same OS user that runs the Agent HQ API, or set `runtime_config.hermesBin` to an absolute executable path.
- Restart the Agent HQ API if its service environment does not include the updated `PATH`.

### Profile is missing or wrong

Symptoms:

- Agent create/update returns `runtime_config.profile is required for hermes runtime`.
- Hermes starts but uses the wrong memory, tools, provider config, or auth.

Checks:

```bash
hermes --profile <profile> -z "Say ready"
```

Fix:

- Set a non-empty `runtime_config.profile`.
- Use a dedicated profile per Agent HQ Hermes agent.
- Configure provider auth and model defaults inside that profile before assigning production tasks.

### Bad provider or model config

Symptoms:

- Hermes exits non-zero.
- Runtime metadata is classified as `infra_failed`.
- stderr mentions auth, API key, quota, provider, unsupported model, or permission errors.

Checks:

```bash
hermes --profile <profile> --provider <provider> --model <model> -z "Say ready"
```

Fix:

- Correct `runtime_config.provider` and `runtime_config.model`, or remove them and let the Hermes profile resolve defaults.
- Verify the credentials are visible to the Agent HQ API process, not only to an interactive shell.

### Unsupported session or host assumptions

Symptoms:

- Agent create/update rejects `extraArgs`.
- Dispatch behaves as if it is in a different repo or a nested workspace.

Fix:

- Remove `--resume`, `--continue`, `--worktree`, and long-running Hermes subcommands from `extraArgs`.
- Let Agent HQ provide the task worktree through `activeRepoRoot`.
- Use `hermesHome` and `profile` for isolation instead of Hermes worktree mode.

### Callback or lifecycle gaps

Symptoms:

- Hermes output exists, but the task did not move to the expected next workflow step.
- Review evidence or outcome is missing.
- Transcript has `hermes-asst-<instanceId>` but no valid task outcome.

Checks:

- Inspect the final Hermes output stored in Agent HQ chat messages.
- Confirm the dispatched contract included the Agent HQ MCP/capability lifecycle instructions.
- Confirm the active workflow allows the outcome the agent tried to post.
- Confirm required evidence fields, such as `review_branch` and `review_commit`, were present before the outcome.

Fix:

- Make sure the dispatched agent has access to Agent HQ MCP lifecycle/task tools.
- If no explicit outcome was posted, inspect the configured workflow event or missing-outcome path for the run.
- Retry from Agent HQ after correcting the profile, contract, or task evidence problem.

### Hermes hangs or times out

Symptoms:

- Heartbeats continue until the configured task timeout.
- Runtime end reason is `timeout`.

Fix:

- Check whether the Hermes profile is waiting on authentication, an interactive prompt, or a long-running tool.
- Prefer `invocationMode: "z"` for deterministic one-shot execution.
- Increase task timeout only after confirming the run is legitimately long.
- Keep `killGraceMs` high enough for clean shutdown but low enough that stuck processes do not linger.

## Related Implementation Files

- `api/src/runtimes/HermesRuntime.ts`
- `api/src/runtimes/HermesRuntime.test.ts`
- `api/src/routes/agents.ts`
- `api/src/routes/agents.hermesRuntime.test.ts`
- `api/src/services/contracts/transportAdapters.ts`
- `api/src/domains/runs/transcriptProvider.ts`
- `docs/architecture/hermes-runtime-adapter-v1.md`
