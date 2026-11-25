import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentApprovals, WorkflowCheck } from './api';
import {
  listStatuses,
  permissionStatus,
  routesSentence,
  routingRulesHref,
  setupStatus,
  sortApprovals,
  stillNeeded,
  tasksStatus,
  workflowExplanation,
  workflowsStatus,
  workflowStatus,
} from './approvalStatus.ts';

const hold = { task_id: 5959, task_title: 'Research run', reason_code: 'not_approved', reason: 'Not approved.', last_refused_at: '2026-11-25T21:12:29Z' };

function workflow(name: string, state: WorkflowCheck['state'], extra: Partial<WorkflowCheck> = {}): WorkflowCheck {
  return {
    resource_kind: 'workflow_setup', resource_id: name.length, resource_name: name, state,
    digest: 'd', approved_revision_id: null, changes: [], error: null, holds: [],
    workflow: { id: name.length, name, project_id: 99, project_name: 'Agency' },
    routes: { count: 5, statuses: ['blocked', 'deployed', 'failed', 'review', 'uat_review'] },
    ...extra,
  };
}

function agent(extra: Partial<AgentApprovals> = {}): AgentApprovals {
  return {
    agent: { id: 1, name: 'Reviewer', project_id: 99, project_name: 'Agency', runtime_type: 'claude-code' },
    host_execute: true, host_execute_holds: [], routed: true, needs_attention: true, holds: [],
    setup: { resource_kind: 'agent_runtime', resource_id: 1, resource_name: "Reviewer's setup", state: 'approved', digest: 'd', approved_revision_id: '1', changes: [], error: null, holds: [] },
    workflows: [workflow('Lead Generation', 'approved'), workflow('Client POC', 'not_approved')],
    ...extra,
  };
}

test('an agent with approved work and one unapproved routed workflow is not shown as stuck', () => {
  const reviewer = agent();
  assert.equal(permissionStatus(reviewer).tone, 'ok');
  assert.equal(setupStatus(reviewer).tone, 'ok');
  assert.deepEqual(workflowsStatus(reviewer), { label: '1 not approved', tone: 'attention', detail: 'Needs your review: Client POC.' });
  assert.deepEqual(tasksStatus(reviewer), { label: 'None waiting', tone: 'muted', detail: 'No task is waiting on this agent.' });
  const poc = reviewer.workflows[1];
  assert.equal(routesSentence('Reviewer', poc), '5 routing rules send Reviewer tasks here when they reach blocked, deployed, failed, review or uat review.');
  assert.equal(workflowExplanation(reviewer, poc), 'Never approved for Reviewer. No task is waiting on it, so nothing is blocked today.');
});

test('a check a task is waiting on is shown as blocking it', () => {
  const validator = agent({ holds: [hold], workflows: [workflow('PMT Research', 'not_approved', { holds: [hold] })] });
  assert.equal(workflowStatus(validator.workflows[0]).tone, 'blocked');
  assert.equal(workflowsStatus(validator).tone, 'blocked');
  assert.equal(tasksStatus(validator).label, "1 can't start");
  const fallback = agent({ host_execute: false, host_execute_holds: [hold], holds: [hold] });
  assert.deepEqual(permissionStatus(fallback), { label: 'Not allowed', tone: 'blocked', detail: "1 task can't start until you allow it." });
});

test('a failed check nothing is routed to is muted, not alarming', () => {
  const idle = agent({ routed: false, host_execute: false, workflows: [], setup: { ...agent().setup, state: 'not_approved' } });
  assert.equal(permissionStatus(idle).tone, 'muted');
  assert.equal(setupStatus(idle).tone, 'muted');
  assert.deepEqual(workflowsStatus(idle), { label: 'None routed', tone: 'muted', detail: 'No routing rule sends it work.' });
});

test('approving one check says what else its tasks still wait for', () => {
  const builder = agent({ host_execute: false, workflows: [workflow('Internal Tool Development', 'not_approved')] });
  assert.deepEqual(stillNeeded(builder, builder.workflows[0], false), ['allowing it to run on this machine']);
  assert.deepEqual(stillNeeded(builder, builder.workflows[0], true), []);
  assert.deepEqual(stillNeeded(builder, 'permission', true), ['approving its workflow Internal Tool Development']);
});

test('stuck agents sort first, then agents needing attention, then by name', () => {
  const sorted = sortApprovals([
    agent({ agent: { ...agent().agent, id: 2, name: 'Atlas' }, needs_attention: false }),
    agent({ agent: { ...agent().agent, id: 3, name: 'Bea' } }),
    agent({ agent: { ...agent().agent, id: 4, name: 'Zed' }, holds: [hold] }),
  ]);
  assert.deepEqual(sorted.map(entry => entry.agent.name), ['Zed', 'Bea', 'Atlas']);
});

test('the routing link opens only this agent’s enabled rules in that workflow', () => {
  const href = routingRulesHref(116, 42);
  const url = new URL(href, 'http://x');
  assert.equal(url.pathname, '/routing');
  assert.equal(url.searchParams.get('tab'), 'rules');
  assert.equal(url.searchParams.get('workflow_id'), '116');
  assert.equal(url.searchParams.get('rules_agent'), '42');
  assert.equal(url.searchParams.get('rules_enabled'), 'enabled');
  // Saved filters on the routing page must not hide the rules.
  for (const name of ['rules_task_type', 'rules_status', 'rules_priority']) assert.equal(url.searchParams.get(name), '');
  assert.equal(listStatuses(['review']), 'review');
  assert.equal(listStatuses(['review', 'blocked']), 'review or blocked');
});
