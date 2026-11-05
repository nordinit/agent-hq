---
name: agent-hq-ops
description: Operate the Agent HQ control plane — lifecycle contract, CLI commands, evidence gates, and where routing/workflow rules live. Use when onboarding, changing task lifecycle behavior, or running/verifying the stack.
---

# Agent HQ ops

Use when entering this repo, wiring a new agent/runtime, changing the task
lifecycle, or verifying the control plane runs.

## Lifecycle invariant

```text
task → route → agent run → evidence → outcome → transition → next status / next agent
```

Evidence gates are enforced: a run cannot transition without its required
evidence. Changes touching routing or outcomes must update `agent-contracts/`
and `skills/task-routing-rules` together.

## Commands

```bash
bash init.sh        # idempotent setup
npm run test:cli    # CLI tests (node --test cli/lib/*.test.mjs)
npm run start       # PM2 ecosystem up
npm run status      # smoke check
npm run stop
npm run open        # admin UI
```

## Where things live

- Routing rules / workflow definitions: `skills/task-routing-rules`, `skills/workflow-definitions`
- Contracts: `agent-contracts/`
- Extension points: `plugins/`
- Deployment: `ecosystem.*.config.js` (PM2), `docker-compose*.yml`
