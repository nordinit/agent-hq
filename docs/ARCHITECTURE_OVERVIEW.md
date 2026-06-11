# Agent HQ Architecture Overview

This document is the public-facing system overview for Agent HQ. It complements the deeper implementation notes in [INFRASTRUCTURE.md](../INFRASTRUCTURE.md).

## System map

```mermaid
flowchart TB
    Human["Operator / PM"]
    UI["Agent HQ UI<br/>Next.js"]

    subgraph Control["Agent HQ control plane"]
      API["API<br/>Express + TypeScript"]
      Reconciler["Reconciler<br/>find eligible work"]
      Dispatcher["Dispatcher<br/>resolve route + launch run"]
      Watchdog["Watchdog<br/>stale-run recovery"]
    end

    DB[("SQLite<br/>tasks · agents · instances · transcripts")]

    subgraph Runtimes["Agent runtimes"]
      OpenClaw["OpenClaw<br/>local hooks + chat"]
      Claude["Claude Code<br/>local SDK / subprocess"]
    end

    Human --> UI
    UI --> API
    API <--> DB
    API --> Reconciler
    Reconciler --> Dispatcher
    API --> Dispatcher
    API --> Watchdog
    Dispatcher --> OpenClaw
    Dispatcher --> Claude
    OpenClaw --> API
    Claude --> API
```

## Core components

- `UI`: the operator surface for tasks, agents, chat, routing, projects, sprints, logs, and telemetry.
- `API`: the central control plane. It owns task state, lifecycle transitions, transcript persistence, MCP endpoints, and runtime integration.
- `Reconciler`: periodically finds tasks that are eligible to move forward and hands them to the dispatcher.
- `Dispatcher`: resolves the correct agent from routing rules, creates job instances, materializes runtime context, and launches the run.
- `Watchdog`: monitors stale or orphaned runs and applies recovery behavior.
- `SQLite`: the durable system of record for projects, tasks, agents, instances, routing, artifacts, and transcripts.

## Runtime model

Agent HQ supports multiple execution backends behind one workflow model:

- `OpenClaw`: local agents with hooks, chat sessions, shell access, and workspace tools.
- `Claude Code`: local SDK/subprocess-based runs with Agent HQ-provided context and callback contracts.
The dispatcher chooses the correct runtime from the agent record. Task lifecycle and routing semantics stay consistent across runtimes.

## Workflow model

The workflow configuration is the source of truth for task movement:

- `sprint_task_routing_rules` decide which agent handles a task for a given sprint, task type, and status.
- `sprint_task_transitions` decide which outcomes are valid from the current status and what status each outcome moves to.
- `sprint_task_transition_requirements` define sprint-specific evidence gates; global `transition_requirements` are the fallback.
- Workflow phase labels such as `implementation`, `review`, `release`, and `pm` are derived from status/outcome configuration for internal contract branching only. They are not persisted transition metadata and do not make evidence fields required.

Outcome validation and contract generation both read this configuration. The system should not infer blocking evidence requirements from workflow phase labels, status names, outcome names, or contract examples.

## Primary data flow

```mermaid
sequenceDiagram
    participant User
    participant UI
    participant API
    participant Reconciler
    participant Dispatcher
    participant Runtime as Agent runtime
    participant DB as SQLite

    User->>UI: Create task or move task to ready
    UI->>API: Persist task change
    API->>DB: Store task state
    Reconciler->>API: Evaluate eligible tasks
    API->>Dispatcher: Resolve route
    Dispatcher->>DB: Create job instance
    Dispatcher->>Runtime: Start run with prompt + contracts
    Runtime->>API: start / heartbeat / outcome / complete
    API->>DB: Persist transcripts, evidence, and lifecycle updates
    API->>UI: Serve updated state to operators
```

## Routing and execution lifecycle

At a high level:

1. A task is created or moved into a routable state such as `ready`.
2. The reconciler evaluates routing rules using sprint, task type, and current status.
3. The dispatcher picks the correct agent route, builds a contract from configured outcomes and evidence gates, and launches a job instance.
4. The runtime sends progress and completion signals back to the API.
5. The API records transcripts, evidence, and outcome transitions.
6. The watchdog intervenes if a run becomes stale or orphaned.
