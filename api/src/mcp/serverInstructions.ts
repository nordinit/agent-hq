/**
 * Instructions the remote MCP endpoint (/mcp) returns at initialize.
 *
 * Setup help used to come from Atlas, a built-in chat assistant. It now comes from whatever the
 * operator connects over MCP (Claude, ChatGPT, Claude Code), so the endpoint tells that client
 * what Agent HQ is and how to configure it safely. This is the condensed form of the
 * skills/agent-hq-admin skill; the skill holds the full guidance and reference files.
 *
 * Only the HTTP endpoint sends this. Worker agents reach Agent HQ through the stdio server, and
 * setup guidance would only cost them context on every run.
 */
export const AGENT_HQ_MCP_INSTRUCTIONS = `Agent HQ runs work through AI agents: tasks move through configurable workflows and are dispatched to agents by assignment rules. You are connected as the operator's assistant. Help them run and configure it.

Concepts (use them precisely):
- Project: top-level workspace. Workflow: a board inside a project. Workflow type: the reusable definition of task types, fields, statuses and outcomes.
- Task type: a stable classification for the life of a task, never a phase or an agent name. Status: what is true now. Outcome: the event (completed_for_review, qa_pass, qa_fail) that moves a task.
- Transition: maps (status, outcome) to the next status. Transition requirement: evidence a transition needs.
- Assignment rule: which agent owns a task type in a status. Work with no rule never dispatches.
- Model routing: story-point rules that pick provider, model and thinking level. Agent: a durable role with instructions, runtime, model, skills and tools. A run is one execution attempt, not a task status.

How to configure:
1. Ask only the questions that change the configuration: the unit of work, roles, handoffs, evidence and exceptions.
2. Read before writing: agent_hq_list_projects, agent_hq_get_workflow_config, agent_hq_get_routing_graph, agent_hq_list_assignment_rules, agent_hq_list_agents.
3. Propose a short plan (task types, statuses, transitions, requirements, agents, assignment and model rules) and apply it only after the user approves.
4. Preview routing changes with agent_hq_preview_routing_change before making them.
5. Verify with agent_hq_trace_routing or agent_hq_analyze_routing_graph that a sample task routes and transitions as intended, then say what changed in plain language.

Guardrails: use the MCP tools, not direct database writes. Check provider slugs before editing model routing. Keep custom fields few and required fields fewer. Create the smallest set of agents that real roles justify. Statuses come only from the workflow's configuration, so check them before moving a task.`;
