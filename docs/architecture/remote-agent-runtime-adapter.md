# Remote Agent Runtime Adapter Model

> Architecture specification for Agent HQ's generalized agent runtime system.
> Task #472 · Sprint: Remote Agent Runtime Support · 2026-03-30

## Status

**Historical specification.** The proxy-managed lifecycle portions of this document were deprecated by task #558. Current remote runtimes should report lifecycle through Agent HQ MCP/capability tools; runtime adapters no longer parse `agent_hq_lifecycle` blocks or post lifecycle callbacks on behalf of agents.

---

## 1. Overview

Agent HQ dispatches tasks to agents that run on different execution backends:
local OpenClaw instances, headless Claude Code sessions, HTTP webhook endpoints,
and remote AI platforms (e.g. Custom). The **runtime adapter model** provides a
uniform contract so the dispatcher, lifecycle system, workspace layer, and UI
treat all agents identically regardless of where they execute.

### Design Principles

1. **Adapter pattern** — each backend implements a shared interface; the
   dispatcher never branches on runtime type.
2. **Lifecycle proxy** — remote agents that cannot call back to Agent HQ get
   lifecycle events (start, heartbeat, outcome) driven by the runtime adapter.
3. **Workspace abstraction** — file operations route through `WorkspaceProvider`
   so local and remote filesystems share one API surface.
4. **Zero Custom-specific hacks** — Custom is the first remote adapter but the
   contracts are provider-agnostic. Any platform that speaks HTTP + SSE (or
   webhook callbacks) plugs in via the same boundaries.

---

## 2. Runtime Adapter Interface

### 2.1 Core Contract — `AgentRuntime`

The existing `AgentRuntime` interface is the adapter boundary. Every runtime
backend implements exactly these two methods:

```typescript
// runtimes/types.ts (existing — no changes required)

interface AgentRuntime {
  dispatch(params: DispatchParams): Promise<{ runId: string }>;
  abort(runId: string, sessionKey: string): Promise<void>;
}
```

**`dispatch()`** fires an isolated task run. Returns a backend-specific `runId`
that the dispatcher stores for audit and abort routing.

**`abort()`** requests cancellation. Implementations treat "already gone" as
success. Remote backends where abort is impossible return a no-op.

### 2.2 Dispatch Parameters — `DispatchParams`

```typescript
// runtimes/types.ts (existing — extend as noted)

interface DispatchParams {
  message: string;              // Full prompt including task + contract
  agentSlug: string;            // Canonical agent identifier
  sessionKey: string;           // Unique per-instance session key
  timeoutSeconds: number;       // Max wall-clock time for the run
  name: string;                 // Human-readable run label
  model?: string | null;        // Resolved model (after story-point routing)
  instanceId?: number;          // Agent HQ job_instances.id
  taskId?: number | null;       // Agent HQ tasks.id
  db?: Database.Database;       // DB handle (local runtimes only)
  workspaceRoot?: string | null;// Agent workspace path

  // ── Proposed additions (task #472) ─────────────────────────────
  runtimeConfig?: Record<string, unknown>;  // Per-dispatch config overrides
  callbackUrls?: CallbackUrls | null;       // Lifecycle callback endpoints
  capabilities?: AgentCapabilities;         // What the agent can do
}
```

### 2.3 Callback URLs

Remote agents that can make outbound HTTP calls receive callback URLs so they
can drive their own lifecycle. Agents that cannot (e.g. inference-only
endpoints) get lifecycle managed by the runtime adapter.

```typescript
interface CallbackUrls {
  start: string;      // PUT  /api/v1/instances/:id/start
  checkIn: string;    // POST /api/v1/instances/:id/check-in
  outcome: string;    // POST /api/v1/tasks/:id/outcome
  evidence: string;   // PUT  /api/v1/tasks/:id/review-evidence
}
```

The `WebhookRuntime` already provides these. For self-callback-capable runtimes
(OpenClaw, webhook targets with Agent HQ SDK), callback URLs are passed in the
dispatch payload. For proxy-managed runtimes (Custom, future inference-only
backends), the adapter handles callbacks internally and does not forward URLs.

---

## 3. Runtime Adapter Implementations

### 3.1 Adapter Registry

```
resolveRuntime(agent) → AgentRuntime
```

The existing factory function maps `runtime_type` → concrete class:

| `runtime_type` | Class                | Lifecycle Model     | Workspace Model |
|----------------|----------------------|---------------------|-----------------|
| `openclaw`     | `OpenClawRuntime`    | Self-callback       | Local FS        |
| `claude-code`  | `ClaudeCodeRuntime`  | SDK events + env    | Local FS        |
| `webhook`      | `WebhookRuntime`     | Self-callback (URLs)| Varies          |
| `veri`         | `CustomAgentRuntime`   | Runtime-proxied     | Remote API      |
| *(future)*     | *(new class)*        | *(either model)*    | *(either model)*|

Adding a new runtime requires:
1. Implement `AgentRuntime` (dispatch + abort)
2. Add a case to `resolveRuntime()`
3. Optionally add a `WorkspaceProvider` if the agent has a non-local filesystem

### 3.2 Lifecycle Model Classification

Every adapter falls into one of two lifecycle categories:

#### Self-Callback Agents
The agent process makes HTTP calls to Agent HQ lifecycle endpoints. The runtime
adapter only needs to dispatch and (optionally) abort.

- **OpenClaw agents** — the dispatched prompt includes `curl` callback contracts;
  the agent executes them during the run via shell tools.
- **Webhook agents** — `callbackUrls` are included in the dispatch payload; the
  remote process calls them.
- **Claude Code agents** — Agent HQ callback URLs are injected as environment
  variables (`AGENT_HQ_CALLBACK_START`, `AGENT_HQ_CALLBACK_CHECKIN`, etc.); the agent
  invokes them via Bash tool calls.

#### Runtime-Proxied Agents
The agent cannot (or should not) make outbound HTTP calls. The runtime adapter
consumes the agent's output (typically an SSE stream) and drives all lifecycle
callbacks on the agent's behalf.

- **Custom agents** — the adapter streams the response, sends periodic heartbeats,
  parses a structured `agent_hq_lifecycle` JSON block from the output, and posts
  outcome/evidence/completion to Agent HQ.
- **Future inference-only agents** — same pattern: consume output, proxy
  lifecycle.

This is configured per-adapter class, not per-agent-row. The adapter knows
whether it proxies lifecycle.

### 3.3 Adapter Capabilities Metadata

Each adapter can declare its capabilities so the dispatcher and UI can make
informed decisions:

```typescript
interface RuntimeAdapterMeta {
  /** Whether the adapter proxies lifecycle (true) or the agent self-callbacks (false). */
  proxiesLifecycle: boolean;
  /** Whether abort is meaningful (some remotes are fire-and-forget). */
  supportsAbort: boolean;
  /** Whether the adapter provides real-time streaming for transcript display. */
  supportsStreaming: boolean;
  /** Whether the adapter can forward workspace file operations to the agent. */
  supportsWorkspaceApi: boolean;
}
```

This metadata is informational — the dispatcher doesn't branch on it. It's
useful for UI displays (e.g. showing a "streaming" indicator) and for future
policy decisions (e.g. preferring self-callback agents for sensitive tasks).

---

## 4. Agent Metadata & Configuration

### 4.1 Agent Record (agents table)

The existing `agents` table already carries the critical fields:

| Column              | Type   | Purpose                                          |
|---------------------|--------|--------------------------------------------------|
| `runtime_type`      | TEXT   | Which adapter class to use                       |
| `runtime_config`    | JSON   | Backend-specific config (URLs, keys, model, etc.)|
| `workspace_path`    | TEXT   | Local workspace directory (null for remote)      |
| `hooks_url`         | TEXT   | Remote Gateway URL compatibility column          |
| `hooks_auth_header` | TEXT   | Remote Gateway Auth Header compatibility column  |
| `preferred_provider`| TEXT   | AI provider for model routing                    |
| `repo_path`         | TEXT   | Git repo for worktree isolation                  |
| `os_user`           | TEXT   | OS-level isolation user                          |

#### Proposed additions

| Column              | Type   | Purpose                                          |
|---------------------|--------|--------------------------------------------------|
| `capability_flags`  | JSON   | Structured capabilities (see §4.2)               |
| `health_check_url`  | TEXT   | Optional URL for runtime health monitoring       |
| `max_concurrent`    | INT    | Max simultaneous runs (default: 1)               |

### 4.2 Agent Capability Flags

```typescript
interface AgentCapabilities {
  /** Agent can execute shell commands (Bash, terminal). */
  canExecShell: boolean;
  /** Agent can read/write files in its workspace. */
  canFileOps: boolean;
  /** Agent can make outbound HTTP requests (for self-callback). */
  canHttp: boolean;
  /** Agent can run git operations (branch, commit, push). */
  canGit: boolean;
  /** Agent can run test suites. */
  canRunTests: boolean;
  /** Agent can access browser tools. */
  canBrowse: boolean;
  /** Maximum story points this agent should handle. */
  maxStoryPoints?: number;
}
```

Capability flags are informational inputs to the routing rules system. They
do NOT change dispatcher or adapter behavior — the adapter already knows what
it can do. These flags allow routing rules to match tasks to agents with the
right capabilities (e.g. "only route git-requiring tasks to agents with
`canGit: true`").

Default for local OpenClaw/ClaudeCode agents: all `true`.
Default for remote inference agents: typically `canExecShell: false`,
`canFileOps: true` (via workspace API), `canHttp: false`, `canGit: false`.

### 4.3 Runtime Config Schemas

Each runtime type has a typed config interface. The `runtime_config` JSON
column stores backend-specific settings:

**OpenClaw** — no config needed (uses gateway defaults).

**Claude Code:**
```typescript
interface ClaudeCodeRuntimeConfig {
  workingDirectory?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'max';
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
}
```

**Webhook:**
```typescript
interface WebhookRuntimeConfig {
  dispatchUrl: string;      // Required
  authHeader?: string;
  abortUrl?: string;
  timeoutMs?: number;
}
```

**Custom (and future remote agents):**
```typescript
interface RemoteAgentRuntimeConfig {
  baseUrl?: string;         // API base URL
  tenantApiUrl?: string;    // Tenant-specific dispatch URL
  apiKey?: string;          // Auth credential (prefer env var reference)
  agentSlug?: string;       // Agent identifier on the remote platform
  model?: string;           // Model override
  timeoutMs?: number;       // Request timeout
  heartbeatIntervalMs?: number;
  // Extensible — remote platforms may add their own fields
  [key: string]: unknown;
}
```

---

## 5. Dispatch Flow

### 5.1 Unified Dispatch Pipeline

```
┌─────────────┐    ┌──────────────┐    ┌───────────────────┐    ┌────────────────┐
│  Dispatcher  │───>│ resolveRuntime│───>│  AgentRuntime     │───>│  Backend       │
│  (scheduler) │    │  (factory)    │    │  .dispatch()      │    │  (actual run)  │
└─────────────┘    └──────────────┘    └───────────────────┘    └────────────────┘
      │                                         │
      │  1. Create job_instances row            │
      │  2. Resolve model (story-point routing) │
      │  3. Build message + lifecycle contract  │
      │  4. Write .agent-hq-run-context.json    │  (local only)
      │  5. Generate CLAUDE.md                  │  (claude-code only)
      │  6. Call runtime.dispatch()             │
      │                                         │
      │  On failure:                            │
      │  - Mark instance failed                 │
      │  - Backoff + retry or mark task failed  │
      │  - Cleanup worktree + context files     │
```

### 5.2 Session Key Contract

Every dispatched instance gets a deterministic, isolated session key:

```
hook:atlas:jobrun:<instanceId>
```

This key is:
- Passed to the runtime in `DispatchParams.sessionKey`
- Stored on `job_instances.session_key`
- Used by OpenClaw to scope the agent session
- Used by transcript lookup for chat history display

For remote agents that manage their own sessions, the session key is still
stored for Agent HQ-side audit/correlation but may not be meaningful to the remote
platform.

### 5.3 Model Resolution Pipeline

```
Story-point routing rule (provider-aware)
  └─ job_template.model
       └─ agent.model
            └─ gateway/runtime default (null → omit)
```

Remote agents (e.g. Custom) may bypass model resolution entirely if the remote
platform manages its own model selection. This is a per-adapter decision:
`CustomAgentRuntime` skips story-point routing and uses its own `DEFAULT_VERI_MODEL`.

---

## 6. Lifecycle Contract

### 6.1 Standard Lifecycle Events

Every task run, regardless of runtime, follows this lifecycle:

```
1. START        PUT  /instances/:id/start
2. HEARTBEAT    POST /instances/:id/check-in  (stage: heartbeat)
3. PROGRESS     POST /instances/:id/check-in  (stage: progress, meaningful_output: true)
4. BLOCKER      POST /instances/:id/check-in  (stage: blocker, blocker_reason: "...")
5. EVIDENCE     PUT  /tasks/:id/<evidence-endpoint> (configured gate fields)
6. OUTCOME      POST /tasks/:id/outcome          (terminal: closes instance + session)
```

### 6.2 Who Drives Lifecycle

| Lifecycle Event | Self-Callback Agent          | Proxied Agent                    |
|-----------------|------------------------------|----------------------------------|
| START           | Agent calls via curl/SDK     | Adapter calls before stream      |
| HEARTBEAT       | Agent calls periodically     | Adapter sends on timer           |
| PROGRESS        | Agent calls at milestones    | Adapter detects from stream      |
| EVIDENCE        | Agent calls with configured evidence | Adapter parses from structured output |
| OUTCOME         | Agent calls via curl/SDK     | Adapter parses from structured output |

### 6.3 Structured Output Protocol (for proxied agents)

Remote agents that cannot self-callback emit a structured JSON block that the
runtime adapter parses:

```markdown
```agent_hq_lifecycle
{
  "outcome": "completed_for_review",
  "summary": "Implemented the feature",
  "branch": "forge/task-123-feature",
  "commit": "abc1234",
  "dev_url": "http://localhost:3511/api/endpoint",
  "notes": "Optional reviewer notes"
}
```​
```

The adapter parses this with fallback strategies (fenced block → JSON with
`agent_hq_lifecycle` key → any JSON with `outcome` field in the last 2000 chars).

If no lifecycle block is found, the adapter defaults to `outcome: "blocked"`
with a diagnostic summary.

### 6.4 Agent Contract Template

The workflow configuration is the single source of truth for valid outcomes and
blocking evidence requirements. Contract templates provide the transport-specific
language included in dispatch messages. They use `{{placeholder}}` syntax and
are interpolated at dispatch time with instance-specific values plus configured
workflow context.

Self-callback agents receive the full contract with curl examples.
Proxied agents receive a simplified version instructing them to emit the
structured `agent_hq_lifecycle` block instead.

---

## 7. Workspace Access

### 7.1 WorkspaceProvider Interface

```typescript
interface WorkspaceProvider {
  readonly root: string;
  readonly isRemote: boolean;

  readDocs(filenames: string[]): Promise<DocResult[]>;
  tree(depth?: number): Promise<{ root: string; children: TreeNode[] }>;
  readFile(relPath: string): Promise<FileReadResult>;
  writeFile(relPath: string, content: string): Promise<FileWriteResult>;
  deleteFile(relPath: string): Promise<{ ok: boolean; path: string }>;
  mkdir(relPath: string): Promise<{ ok: boolean; path: string }>;
  rename(oldPath: string, newPath: string): Promise<{ ok: boolean }>;
  rawFile(relPath: string): Promise<RawFileResult>;
}
```

### 7.2 Provider Resolution

```typescript
resolveWorkspaceProvider(agentId?) → WorkspaceProvider
```

| Agent Type            | Provider                  | Backing Store          |
|-----------------------|---------------------------|------------------------|
| OpenClaw (local)      | `LocalWorkspaceProvider`  | `~/.openclaw/workspace-<id>` |
| Claude Code (local)   | `LocalWorkspaceProvider`  | `runtime_config.workingDirectory` |
| Webhook (varies)      | `LocalWorkspaceProvider`  | `agent.workspace_path` |
| Remote (Custom, etc.)   | `RemoteWorkspaceProvider` | HTTP API on remote host|

### 7.3 Remote Workspace Protocol

`RemoteWorkspaceProvider` proxies all operations through HTTP:

```
GET    /files           → tree listing
GET    /files/<path>    → read file
PUT    /files/<path>    → write file
DELETE /files/<path>    → delete file
```

Authentication via `Authorization: Bearer <apiKey>` header.
The base URL is derived from `runtime_config.baseUrl`.

### 7.4 Workspace Boundary Enforcement

Local agents have workspace boundaries enforced via `workspaceBoundary.ts`:
- `safePath()` prevents path traversal
- `AGENT_HQ_WORKSPACE_ROOT` env var tells the agent process its broader allowed workspace boundary
- `AGENT_HQ_ACTIVE_REPO_ROOT` env var tells the agent process the authoritative repo root for the current dispatched run
- Violations are logged to `boundary_violations` table

Remote agents rely on the remote platform's own access controls — Agent HQ does
not (and cannot) enforce filesystem boundaries on remote systems.

---

## 8. Chat & Transcript Access

### 8.1 Chat Message Storage

All runtime adapters persist transcripts to `chat_messages`:

| Column         | Type   | Purpose                                |
|----------------|--------|----------------------------------------|
| `id`           | TEXT   | Stable message ID (format varies)      |
| `agent_id`     | INT    | FK to agents table                     |
| `instance_id`  | INT    | FK to job_instances                    |
| `role`         | TEXT   | `user` or `assistant`                  |
| `content`      | TEXT   | Message text                           |
| `timestamp`    | TEXT   | ISO 8601                               |
| `event_type`   | TEXT   | `text`, `thought`, `tool_call`, etc.   |
| `event_meta`   | JSON   | Structured metadata per event type     |

### 8.2 Transcript Persistence by Runtime

| Runtime     | When Stored                                      | Message ID Format           |
|-------------|--------------------------------------------------|-----------------------------|
| OpenClaw    | After run completes (via OpenClaw session store)  | OpenClaw's internal IDs     |
| Claude Code | Via SDK session persistence + init session_id     | `claude-code:<sessionId>`   |
| Webhook     | Depends on remote (may not persist transcripts)   | N/A                         |
| Custom        | Streamed live + final upsert                      | `veri-user-<inst>`, `veri-asst-<inst>`, `veri-evt-<inst>-<n>` |

### 8.3 Structured Event Types

For runtimes that support streaming (currently Custom), individual events are
persisted as separate rows with typed `event_type`:

| Event Type    | Content                    | Meta Fields                |
|---------------|----------------------------|----------------------------|
| `text`        | Text delta                 | —                          |
| `thought`     | Internal reasoning         | —                          |
| `tool_call`   | Tool name                  | `name`, `args`             |
| `tool_result` | Output (truncated)         | `name`, `output`           |
| `turn_start`  | —                          | `turn`, `max_turns`        |
| `system`      | System message             | —                          |
| `error`       | Error description          | —                          |

---

## 9. Review & Artifact Reporting

### 9.1 Review Evidence

All agents report evidence through the same API surface:

```
PUT /api/v1/tasks/:id/review-evidence
{
  "review_branch": "forge/task-123-feature",
  "review_commit": "abc1234def",
  "review_url": "http://localhost:3511/api/endpoint",
  "summary": "Optional context"
}
```

- **Self-callback agents** call this directly via curl/SDK.
- **Proxied agents** include these fields in the `agent_hq_lifecycle` block;
  the adapter extracts and posts them. Proxied output may use `branch` and
  `commit` aliases, which the adapter maps to `review_branch` and
  `review_commit`.

### 9.2 QA Evidence (QA Workflow Category)

```
PUT /api/v1/tasks/:id/qa-evidence
{
  "qa_tested_url": "http://localhost:3511/tested-endpoint",
  "qa_verified_commit": "abc1234def",
  "notes": "QA findings"
}
```

### 9.3 Deploy Evidence (Release Workflow Category)

```
PUT /api/v1/tasks/:id/deploy-evidence
{
  "merged_commit": "abc1234",
  "deployed_commit": "abc1234",
  "deploy_target": "production",
  "deployed_at": "2026-03-30T22:00:00Z"
}
```

### 9.4 Task Outcome

The outcome endpoint is the **single exit path** for all runs:

```
POST /api/v1/tasks/:id/outcome
{
  "outcome": "completed_for_review",
  "summary": "One-sentence description",
  "changed_by": "forge",
  "instance_id": 7774
}
```

Terminal outcomes auto-close the instance and terminate the session.

---

## 10. Adding a New Remote Runtime

### Step-by-step checklist:

1. **Create `runtimes/YourRuntime.ts`** implementing `AgentRuntime`:
   - `dispatch()` — fire the task to your platform
   - `abort()` — cancel if supported, no-op otherwise
   - Choose lifecycle model: self-callback or proxied

2. **Define `YourRuntimeConfig`** interface for `runtime_config` JSON:
   - API URLs, auth, timeouts, model defaults
   - Keep secrets in env vars, reference by name in config

3. **Register in `runtimes/index.ts`**:
   - Add import and case to `resolveRuntime()` switch

4. **Workspace (if applicable)**:
   - If the agent has a remote filesystem, add a case in
     `resolveWorkspaceProvider()` returning a `RemoteWorkspaceProvider`
     (or a new provider implementation)
   - If local, use `LocalWorkspaceProvider` with the agent's `workspace_path`

5. **Transcript persistence** (for proxied runtimes):
   - Persist user prompt at dispatch time
   - Stream/buffer assistant response and upsert to `chat_messages`
   - Use stable message IDs: `<runtime>-user-<inst>`, `<runtime>-asst-<inst>`

6. **DB migration**:
   - No schema changes needed — `runtime_type` (TEXT) and `runtime_config`
     (JSON) are fully generic

7. **Tests**:
   - Unit test for dispatch/abort with mocked HTTP
   - Unit test for structured output parsing (if proxied)
   - Integration test via `runtimes.test.ts` registry

8. **Agent setup**:
   - Create agent row with `runtime_type = 'your-runtime'`
   - Set `runtime_config` JSON with your platform's config
   - Create routing rules to assign tasks to the agent

---

## 11. Architecture Diagram

```
                    ┌────────────────────────────────────┐
                    │           Agent HQ API              │
                    │                                    │
                    │  ┌──────────┐  ┌──────────────┐   │
                    │  │ Scheduler │  │ Task Router   │   │
                    │  │(reconcile)│  │(routing rules)│   │
                    │  └─────┬─────┘  └──────┬───────┘   │
                    │        │               │           │
                    │        ▼               ▼           │
                    │  ┌─────────────────────────────┐   │
                    │  │       Dispatcher              │   │
                    │  │  - model resolution           │   │
                    │  │  - message building            │   │
                    │  │  - instance creation           │   │
                    │  │  - worktree setup              │   │
                    │  └────────────┬───────────────┘   │
                    │               │                    │
                    │     resolveRuntime(agent)          │
                    │               │                    │
                    │    ┌──────────┴──────────┐        │
                    │    ▼                     ▼        │
                    │ ┌──────────┐   ┌──────────────┐   │
                    │ │  Local   │   │   Remote      │   │
                    │ │ Runtimes │   │  Runtimes     │   │
                    │ ├──────────┤   ├──────────────┤   │
                    │ │ OpenClaw │   │ Webhook      │   │
                    │ │ Claude   │   │ Custom         │   │
                    │ │ Code     │   │ (future...)  │   │
                    │ └────┬─────┘   └──────┬───────┘   │
                    │      │                │           │
                    └──────┼────────────────┼───────────┘
                           │                │
              ┌────────────┘                └────────────┐
              ▼                                         ▼
    ┌──────────────────┐                    ┌──────────────────┐
    │  Local Agent      │                    │  Remote Agent     │
    │  Process          │                    │  Platform         │
    │                   │                    │                   │
    │  Self-callback    │                    │  SSE stream or    │
    │  to Agent HQ      │◄──lifecycle──────►│  webhook callback │
    │  lifecycle API    │    proxy           │  to Agent HQ      │
    │                   │                    │                   │
    │  Local FS         │                    │  Remote workspace │
    │  workspace        │                    │  API              │
    └──────────────────┘                    └──────────────────┘
```

---

## 12. Migration Path

This spec does **not** require breaking changes. All proposed additions are
backward-compatible:

1. **`DispatchParams` extensions** (`runtimeConfig`, `callbackUrls`,
   `capabilities`) — optional fields, existing code unaffected.

2. **`capability_flags` column** — nullable JSON, defaults to null. UI
   interprets null as "all capabilities" for backward compat.

3. **`health_check_url` column** — nullable TEXT, no behavior change if null.

4. **`max_concurrent` column** — nullable INT, defaults to 1 (current behavior).

5. **Existing runtimes** — `OpenClawRuntime`, `ClaudeCodeRuntime`,
   `WebhookRuntime`, `CustomAgentRuntime` continue working unchanged.

Recommended implementation order:
1. Add `capability_flags`, `health_check_url`, `max_concurrent` columns (migration)
2. Populate capability_flags for existing agents (seed/migration)
3. Wire capability_flags into routing rules evaluation (optional)
4. Expose in UI agent settings panel
5. Document in agent setup guide

---

## 13. Security Considerations

- **Credentials** are stored as environment variable references, not raw values.
  `runtime_config.apiKey` is a fallback for non-env-var setups; the preferred
  pattern is `VERI_API_KEY`, `WEBHOOK_AUTH_TOKEN`, etc.

- **Workspace boundaries** are enforced by `workspaceBoundary.ts` for local
  agents. Remote agents must rely on their platform's access controls.

- **Network isolation** — remote agent dispatch uses `AbortSignal.timeout()` to
  prevent indefinite hangs. Callback URLs always use the internal (localhost)
  base URL unless the agent is remote (Tailscale/public URL).

- **Dispatch payloads** are marked with `allowUnsafeExternalContent: true`
  because Agent HQ is an internal trusted caller. Remote webhook payloads should
  be signed (future: HMAC signature header).

---

## Appendix A: Existing Runtime Implementations Summary

| Runtime       | File                        | Lines | Lifecycle    | Workspace      |
|---------------|-----------------------------|-------|-------------|----------------|
| OpenClaw      | `OpenClawRuntime.ts`        | ~180  | Self-callback| Local FS       |
| Claude Code   | `ClaudeCodeRuntime.ts`      | ~200  | SDK + env    | Local FS       |
| Webhook       | `WebhookRuntime.ts`         | ~120  | Self-callback| Provider-dependent |
| Custom          | `CustomAgentRuntime.ts`       | ~600  | Proxied      | Remote API     |

## Appendix B: Database Schema (runtime-relevant columns)

```sql
-- agents table (existing columns)
ALTER TABLE agents ADD COLUMN runtime_type TEXT NOT NULL DEFAULT 'openclaw';
ALTER TABLE agents ADD COLUMN runtime_config JSON;

-- Proposed additions (task #472)
ALTER TABLE agents ADD COLUMN capability_flags JSON;
ALTER TABLE agents ADD COLUMN health_check_url TEXT;
ALTER TABLE agents ADD COLUMN max_concurrent INTEGER DEFAULT 1;
```

## Appendix C: Glossary

| Term                | Definition                                                    |
|---------------------|---------------------------------------------------------------|
| Runtime Adapter     | Implementation of `AgentRuntime` for a specific backend       |
| Self-Callback       | Agent drives its own lifecycle via HTTP calls to Agent HQ      |
| Proxied Lifecycle   | Runtime adapter drives lifecycle on behalf of the agent       |
| Workspace Provider  | Implementation of `WorkspaceProvider` for local or remote FS  |
| Dispatch Contract   | Workflow-configured lifecycle guidance rendered through a transport template |
| Structured Output   | `agent_hq_lifecycle` JSON block emitted by proxied agents     |
