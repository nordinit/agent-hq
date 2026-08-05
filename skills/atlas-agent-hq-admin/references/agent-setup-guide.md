# Agent Setup Guide

Agents are durable roles, not temporary task assignees.

Create or configure agents when the workflow has a recurring owner for a type of work.

Model the workflow first. Derive agents from durable responsibility boundaries instead of creating one agent per task type or status.

## Common Agent Roles

Software workflow:

- PM / Atlas helper
- frontend engineer
- backend engineer
- fullstack engineer
- QA/reviewer
- release/devops

Content workflow:

- strategist
- writer
- editor
- publisher

Ops workflow:

- triage
- operator
- verifier
- incident commander

Sales workflow:

- researcher
- outreach agent
- follow-up agent
- manager/reviewer

## Agent Configuration Inputs

For each agent, decide:

- display name
- durable role
- project/workflow ownership
- runtime type
- provider slug
- model
- repo access mode and repo path, when applicable
- timeout
- assigned skills/tools
- instructions
- routing ownership

## Agent Boundary Decision

Create a separate agent when one or more of these differ materially:

- authority or permissions
- tools, runtime, or repository access
- quality bar or separation-of-duties requirement
- durable specialty or context
- prohibited actions or escalation policy
- model, cost, or latency profile

Reuse an agent across multiple task types or statuses when its mission, authority, tools, and quality bar remain coherent.

Do not create a separate agent merely because a status has a different name, a task has a different priority, or a one-off instruction differs.

## Agent Contract

Define every proposed agent with:

```text
Agent role:
- Mission:
- Owned task types/statuses:
- Required input context:
- Tools, runtime, repositories, and permissions:
- Expected deliverables:
- Allowed outcomes:
- Required evidence:
- Prohibited actions:
- Escalation conditions:
- Provider/model policy:
- Concurrency/session expectations:
```

Keep role names conceptual while designing reusable workflows, then bind those roles to actual Agent HQ agents through assignment rules. Do not invent unsupported role-binding configuration.

## Instructions

Agent instructions should define stable role behavior, not task-specific detail.

Good instructions include:

- what the agent owns
- quality bar
- environment discipline
- lifecycle callback expectations
- evidence expectations
- what not to do
- allowed outcomes and when to report each one
- escalation and stop conditions

Task-specific details belong in the task description and dispatch contract.

## Skills And Tools

Assign skills when the agent repeatedly performs a specialized workflow.

Examples:

- Atlas admin/helper: `atlas-agent-hq-admin`
- project creation: `create-project`
- task creation: `create-task`
- agent provisioning: `create-agent`
- tool creation: `create-tool`

Avoid assigning every skill to every agent. Skills should reduce ambiguity, not flood context.

## Routing Ownership

After agent setup, create assignment rules for the task types/statuses the agent should own.

Agent setup is incomplete if:

- the agent exists but no assignment rule points to it
- an assignment rule points to a disabled agent
- an agent is assigned to the wrong project/workflow
- provider/model settings do not match model routing policy

## Provider/Model Consistency

Check:

- agent `preferred_provider`
- agent model
- model-routing provider rows
- provider auth/connection status

Provider slugs must match exactly. For OpenAI Codex OAuth agents, use `openai-codex` as the provider key.

## When Not To Create A New Agent

Do not create a new agent when:

- an existing agent already owns that recurring role
- the work is a one-off task
- the difference is only priority or story points
- the user is still deciding the workflow shape
- an existing agent can own the work without expanding its authority incoherently
- the difference can be handled by task context, a relevant skill, or model routing

Use routing, workflow type, or model routing changes first when those solve the problem.
