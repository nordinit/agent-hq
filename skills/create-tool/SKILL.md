---
name: create-tool
description: Create or repair Agent HQ capability tools in the Tools registry. Use when adding a new tool, fixing a broken tool record, updating a tool’s schema/permissions/tags, or preventing malformed tool payloads in Agent HQ. Especially useful when a user asks to create a tool for agents to use in the Capabilities tab.
---

# Create Tool

Create Agent HQ tool records carefully. A malformed tool can break the Capabilities UI or leave agents with unsafe or unusable automation.

## Workflow

1. Resolve whether the request is for:
   - a brand new tool
   - an update to an existing tool
   - a repair of a malformed tool record

2. Inspect existing tool shape first
   - Read a few live tool records from the Agent HQ API before writing a new one.
   - Confirm the exact payload format expected by the registry.
   - Use existing healthy tools as the schema reference, not memory.

3. Always populate the required tool fields
   - `name`
   - `slug`
   - `description`
   - `implementation_type`
   - `implementation_body`
   - `input_schema`
   - `permissions`
   - `tags`
   - `enabled`

4. Serialize fields exactly the way Agent HQ expects
   - `input_schema` must be stored as a JSON string representing an object schema
   - `tags` must be stored as a JSON string representing an array of strings
   - Do not double-encode either field
   - Before writing, validate that:
     - `json.loads(input_schema)` returns an object/dict
     - `json.loads(tags)` returns an array/list

5. Validate tool safety and usability
   - Prefer one atomic tool over a fragile multi-step operator sequence
   - Keep destructive power narrow and explicit
   - Add input validation inside the tool script, not only in the schema
   - Add locking or idempotence when multiple agents could collide
   - Prefer structured JSON success/error output when the tool will be consumed by agents

6. After creating or updating the tool, verify it live
   - Fetch the created tool back from the API
   - Confirm `input_schema` parses cleanly as an object
   - Confirm `tags` parses cleanly as an array
   - If the tool targets the Capabilities UI, confirm the returned shape would not break `tags.map(...)` style consumers

## Required payload checklist

Before creating or updating a tool, verify this checklist:

- `name`: human-readable label
- `slug`: stable lowercase identifier, snake_case or project-standard slug
- `description`: concise but specific purpose
- `implementation_type`: one of the registry-supported values
- `implementation_body`: the actual script/function handler body
- `input_schema`: JSON string of a valid JSON Schema object
- `permissions`: correct execution scope (`read_only`, `read_write`, `exec`, etc.)
- `tags`: JSON string of string array
- `enabled`: `1` or `true` unless intentionally disabled

## Output standard

When reporting back after creating/updating a tool, include:
- tool name
- slug
- whether it was created or updated
- whether `input_schema` round-trip validation passed
- whether `tags` round-trip validation passed
- any cautions before assigning it to agents

## Common failure mode to avoid

The most common Agent HQ tool creation mistake is double-encoding:
- bad: `input_schema` saved as a JSON string of a JSON string
- bad: `tags` saved as a JSON string of a JSON string
- result: Capabilities UI can break with errors like `t.map is not a function`

Always round-trip parse what you are about to send before writing it.

## When a tool is script-based

For bash tools:
- use `set -euo pipefail`
- validate required inputs early
- return machine-readable JSON on failure when practical
- guard shared resources with a lock when collisions are possible
- avoid assuming environment variables exist unless you check them

## Reference

If you need an example pattern or a live-safe checklist, read `references/tool-payload-checklist.md`.
