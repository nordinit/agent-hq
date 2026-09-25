# OpenClaw capability tools plugin

This plugin fetches Agent HQ-assigned capability tools from the materialized endpoint and registers them inside an OpenClaw runtime as native tools.

## Credential

Every Agent HQ `/api/v1` request must authenticate, so the plugin needs a credential: the operator token (`AGENT_HQ_OPERATOR_TOKEN`) or an Agent HQ MCP key with administrative access. It is read, in order, from:

1. `apiToken` in the plugin's OpenClaw config.
2. `apiTokenFile` in the plugin's OpenClaw config: a file holding the token alone, or dotenv lines with `AGENT_HQ_OPERATOR_TOKEN` (such as the `~/.agent-hq/.env` that `agent-hq start` writes). Re-read on every fetch, so a rotated token is picked up without a restart.
3. `AGENT_HQ_API_TOKEN` in the gateway's environment.

Prefer `apiTokenFile`: it keeps the secret out of the gateway's environment and out of `openclaw.json`, a file that is often copied around while debugging.

Shell and script tools inherit the gateway's environment minus any Agent HQ credential: variables named `AGENT_HQ_*` containing `TOKEN`, `KEY`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `DATABASE_URL` are removed, so a tool never receives the plugin's token. A tool definition that needs one must set it in its own `env`.

The API URL comes from `apiUrl` in the plugin config, then `AGENT_HQ_API_URL`, then `http://127.0.0.1:3501`.

## OpenClaw configuration

`agent-hq start` configures this automatically, including `apiUrl` and `apiTokenFile`. If you install or wire the plugin manually, the OpenClaw gateway config must load the plugin, give it a credential, and allow its tools through the active tool policy:

```json
{
  "plugins": {
    "entries": {
      "agent-hq-capability-tools": {
        "enabled": true,
        "config": {
          "apiUrl": "http://127.0.0.1:3501",
          "apiTokenFile": "~/.agent-hq/.env"
        }
      }
    },
    "load": {
      "paths": [
        "/path/to/agent-hq/plugins/openclaw-capability-tools"
      ]
    }
  },
  "tools": {
    "profile": "coding",
    "alsoAllow": [
      "agent-hq-capability-tools"
    ]
  }
}
```

`plugins.load.paths` only loads the plugin. OpenClaw still filters tools through the configured `tools.profile`, so Agent HQ-assigned tools are not visible to agents unless the plugin id is included in `tools.alsoAllow` or the selected profile otherwise allows plugin tools.

The recommended setup is `profile: "coding"` plus `alsoAllow: ["agent-hq-capability-tools"]`. The `full` profile can also expose plugin tools, but it enables a broader built-in OpenClaw tool set than Agent HQ needs.

## What it does

1. Registers one dynamic OpenClaw tool factory.
2. Resolves the active OpenClaw agent id from the OpenClaw tool context.
3. Calls `GET /api/v1/tools/materialized/agents/:openclawAgentId`.
4. Uses Agent HQ's `agents.openclaw_agent_id` mapping to scope assignments.
5. Returns the assigned tools for that agent as native OpenClaw tools.
6. Executes the tool according to `execution_type`:
   - `shell`
   - `script`
   - `http`

Agent HQ remains the source of truth for assigned tool metadata, schemas, and execution definitions.

## Notes

- This is intentionally separate from the Agent HQ MCP path.
- Built to stay generic for future runtime/executor expansion.
- The plugin does not use `AGENT_HQ_AGENT_ID`; installing it once is enough for all Agent HQ-managed OpenClaw agents that have `openclaw_agent_id` populated.
- If OpenClaw does not provide an agent id in tool context, the plugin fails closed instead of falling back to the wrong agent.
