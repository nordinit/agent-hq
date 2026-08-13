# GitHub identity: runtime support

Agent HQ resolves a GitHub identity for every dispatch and delivers it three ways. Which of those
actually reach the agent depends on the runtime, and one runtime receives almost none of them.

**OpenClaw agents do not get an enforced GitHub identity.** Every agent that currently holds a
dedicated identity is an OpenClaw agent, so in practice enforcement is not active anywhere today.

## What gets delivered, and to which runtime

| Mechanism | What it sets | claude-code | codex | hermes | openclaw |
|---|---|---|---|---|---|
| `configureWorktreeGitIdentity()` | `user.name` / `user.email` in worktree git config | yes | yes | yes | yes |
| `injectGitHubCredentials()` | `.atlas-gh-token`, `.atlas-gh-identity.env` in the repo root | yes | yes | yes | yes |
| `DispatchParams.secretEnv` | `GH_TOKEN`, `GITHUB_TOKEN`, `GIT_AUTHOR_*`, `GIT_COMMITTER_*` in the process env | yes | yes | yes | **no** |

The first two are filesystem writes against the working directory, so they work regardless of how
the agent is started. The third is process environment, and that is where OpenClaw differs.

## Why OpenClaw cannot receive it

The other three runtimes spawn a child process per dispatch, so Agent HQ builds that process's
environment directly (`buildAgentRuntimeEnv` in `api/src/runtimes/environment.ts`).

OpenClaw does not work that way. `OpenClawRuntime.dispatch()` sends `chat.send` over the gateway
websocket to a long-lived daemon that Agent HQ did not start and does not own — on this host, a
launchd service (`ai.openclaw.gateway`). There is no child process being created whose environment
we control, so there is nothing to inject into. `OpenClawRuntime` has no `buildEnv` method and never
reads `runtime_config.env`; both are inert for this runtime.

## Consequences

- The commit author **is** enforced on OpenClaw. `git config --worktree user.name/user.email` is a
  file write, so a commit carries the right author whether the agent cooperates or not.
- The push credential **is not** enforced on OpenClaw. The token exists only in
  `.atlas-gh-token` / `.atlas-gh-identity.env`, and using it requires the agent to choose to read
  one of them. An agent that skips that step still pushes — as whatever ambient credential the
  gateway host has.
- The dispatch prompt used to carry a GitHub identity block telling the agent those files existed.
  It was removed when the credential moved into the environment
  (`api/src/services/dispatch/prompt/githubIdentitySegment.ts`, deleted in `5c826b7e`). Because that
  segment was part of the shared context bundle rather than a claude-code-only path, OpenClaw agents
  lost the instruction without gaining the environment that replaced it.

## Options if enforcement on OpenClaw is needed

None of these are implemented. Ordered by cost.

1. **Git credential helper in the worktree config.** Write
   `credential.https://github.com.helper` alongside `user.name`/`user.email`, so `git push`
   authenticates from git's own config without agent cooperation. Works on every runtime today with
   no upstream change. Covers `git`; does **not** cover `gh` CLI API calls, which read
   `GH_TOKEN`/`GITHUB_TOKEN` from the environment.
2. **Restore the prompt segment for OpenClaw.** Cheap, but it is instruction rather than
   enforcement — an agent can still skip it, which is the gap the removal was meant to close.
3. **Per-agent MCP server env.** `mcp.servers.<server>__agent-<id>.env` in `~/.openclaw/openclaw.json`
   already carries per-agent values that Agent HQ writes (`api/src/runtimes/mcpMaterialization.ts`).
   That env reaches the MCP server subprocess only, not the agent's shell, so it cannot help `git`.
4. **Gateway service environment.** `~/.openclaw/service-env/ai.openclaw.gateway.env` is sourced by a
   wrapper before the daemon starts, and non-sandboxed exec inherits it. This is machine-global and
   needs a gateway restart, so every agent would share one token — the opposite of per-agent
   identity. The file is also OpenClaw-generated and marked not to be edited by hand.
5. **Sandbox env.** `agents.list[].sandbox.docker.env` under `scope: "agent"` is a genuine per-agent
   environment surface, but requires enabling Docker sandboxing, which changes the execution model,
   workspace access, and networking. Values are also readable via `docker inspect`.
6. **Upstream change.** OpenClaw is MIT (`github.com/openclaw/openclaw`). Adding `agents.list[].env`
   merged into the exec tool's child environment would follow the precedent already set by
   `tools.loopDetection`, which is documented as global with a per-agent override.

## Related

- `api/src/runtimes/environment.ts` — env layering for runtimes that spawn a process
- `api/src/lib/githubIdentity.ts` — identity resolution, credential files, worktree git config
