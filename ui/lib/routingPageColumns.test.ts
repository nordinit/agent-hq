import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const routingPageSource = readFileSync(join(process.cwd(), 'features/routing/RoutingPage.tsx'), 'utf8');
const routingSharedSource = readFileSync(join(process.cwd(), 'features/routing/workflowConfigShared.ts'), 'utf8');
const automaticTransitionsSection = readFileSync(join(process.cwd(), 'features/routing/sections/TransitionsSection.tsx'), 'utf8');
const taskRoutingSection = readFileSync(join(process.cwd(), 'features/routing/sections/RoutingRulesSection.tsx'), 'utf8');
const gateRequirementsSection = readFileSync(join(process.cwd(), 'features/routing/sections/TransitionRequirementsSection.tsx'), 'utf8');
const workflowEventsSource = readFileSync(join(process.cwd(), 'features/routing/ExternalEventsRoutingSection.tsx'), 'utf8');
const workflowConfigSource = readFileSync(join(process.cwd(), 'components/workflowConfig.tsx'), 'utf8');
const modelRoutingSource = readFileSync(join(process.cwd(), 'app/model-routing/page.tsx'), 'utf8');

function assertFirstColumns(source: string, labels: string[]) {
  let cursor = -1;
  for (const label of labels) {
    const columnLabel = `label="${label}"`;
    const next = source.indexOf(columnLabel, cursor + 1);
    assert.ok(next > cursor, `${columnLabel} should render after the previous leading column`);
    cursor = next;
  }
}

test('automatic transitions table does not render a Lane column', () => {
  assert.ok(automaticTransitionsSection.includes('label="Automatic Transitions"'));
  assert.ok(!automaticTransitionsSection.includes('TableColumnFilter label="Lane"'));
  assert.ok(!automaticTransitionsSection.includes('{t.lane || \'default\'}'));
  assert.ok(!automaticTransitionsSection.includes('value={newForm.lane}'));
  assert.ok(!automaticTransitionsSection.includes('value={editForm.lane}'));
  assert.ok(automaticTransitionsSection.includes('colSpan={9}'));
});

test('automatic transitions table renders persisted transition IDs', () => {
  assert.ok(automaticTransitionsSection.includes('label="ID"'));
  assert.ok(automaticTransitionsSection.includes('description={TRANSITION_COLUMN_HELP.id}'));
  assert.ok(automaticTransitionsSection.includes('#{t.id}'));
  assert.ok(automaticTransitionsSection.includes('min-w-[1040px]'));
  assert.ok(!automaticTransitionsSection.includes('#{filteredTransitions.indexOf(t)'));
});

test('task routing table does not render a Lane column', () => {
  assert.ok(taskRoutingSection.includes('label="Assignment Rules"'));
  assert.ok(routingPageSource.includes("{ id: 'rules', label: 'Assignment Rules' }"));
  assert.ok(!taskRoutingSection.includes('TableColumnFilter label="Lane"'));
  assert.ok(!taskRoutingSection.includes('>Lane</th>'));
});

test('task routing table omits workflow override shadowing indicators', () => {
  assert.ok(taskRoutingSection.includes('label="Scope"'));
  assert.ok(taskRoutingSection.includes('label="Assigned Agent"'));
  assert.ok(taskRoutingSection.includes('label="Priority"'));
  assert.ok(taskRoutingSection.includes("ScopeBadge kind={rule.scope_kind === 'sprint_type_default' ? 'default_scope' : rule.scope_kind}"));
  assert.ok(taskRoutingSection.includes("ScopeBadge"));
  assert.ok(workflowConfigSource.includes('>override</Badge>'));
  assert.ok(workflowConfigSource.includes('>default</Badge>'));
  assert.ok(!taskRoutingSection.includes('Overridden in selected workflow'));
  assert.ok(!taskRoutingSection.includes('Shadowed by a workflow override for this task-type scope and status.'));
});

test('task routing table renders canonical assignment rule IDs', () => {
  assert.ok(taskRoutingSection.includes('label="ID"'));
  assert.ok(taskRoutingSection.includes('description={ROUTING_RULE_COLUMN_HELP.id}'));
  assert.ok(taskRoutingSection.includes('#{rule.id}'));
  assert.ok(!taskRoutingSection.includes('#{filteredRules.indexOf(rule)'));
});

test('assignment rules table starts with ID, Task Type, Scope', () => {
  assertFirstColumns(taskRoutingSection, ['ID', 'Task Type', 'Scope', 'When Status']);
  assert.ok(taskRoutingSection.indexOf('ScopeBadge kind={rule.scope_kind') > taskRoutingSection.indexOf('getRoutingTaskTypeLabel(rule.task_type)'));
  assert.ok(taskRoutingSection.indexOf('ScopeBadge kind={rule.scope_kind') < taskRoutingSection.indexOf('statusBadgeClasses[rule.status]'));
});

test('task routing table has a mobile horizontal scroll wrapper', () => {
  assert.ok(taskRoutingSection.includes('<div className="overflow-x-auto">'));
  assert.ok(taskRoutingSection.includes('<table className="w-full min-w-[1040px] text-sm">'));
});

test('task routing priority input preserves editable text until save', () => {
  assert.ok(routingSharedSource.includes('function parseRoutingRulePriority(value: string): number | null'));
  assert.ok(taskRoutingSection.includes("priority: '0'"));
  assert.ok(taskRoutingSection.includes('priority: String(rule.priority ?? 0)'));
  assert.ok(taskRoutingSection.includes('const priority = parseRoutingRulePriority(newForm.priority);'));
  assert.ok(taskRoutingSection.includes('const priority = parseRoutingRulePriority(editForm.priority);'));
  assert.ok(taskRoutingSection.includes('setNewForm({ ...newForm, priority: e.target.value })'));
  assert.ok(taskRoutingSection.includes('setEditForm(form => ({ ...form, priority: e.target.value }))'));
  assert.ok(taskRoutingSection.includes('type="text"'));
  assert.ok(taskRoutingSection.includes('{error && <span className="text-right text-[10px] text-red-400">{error}</span>}'));
  assert.ok(!taskRoutingSection.includes('type="number"'));
  assert.ok(!taskRoutingSection.includes('priority: Number(e.target.value)'));
});

test('workflow events header matches the task routing tab header pattern', () => {
  assert.ok(workflowEventsSource.includes('<SectionHeader'));
  assert.ok(workflowEventsSource.includes('label="Workflow Events"'));
  assert.ok(workflowEventsSource.includes('Workflow events from Agent HQ runtime or trusted external systems map lifecycle signals'));
  assert.ok(workflowEventsSource.includes('<Plus className="h-3.5 w-3.5" /> Add Mapping'));
  assert.ok(!workflowEventsSource.includes('<h3 className="text-sm font-semibold text-white">Workflow Events</h3>'));
  assert.ok(!workflowEventsSource.includes('Conflict badges show overlapping enabled mappings at the same priority.'));
});

test('workflow events table keeps existing mapping management behavior', () => {
  assert.ok(workflowEventsSource.includes('function ScopeBadge'));
  assert.ok(workflowEventsSource.includes('TableColumnFilter label="Scope"'));
  assert.ok(workflowEventsSource.includes('api.createWorkflowEventMapping'));
  assert.ok(workflowEventsSource.includes('api.updateWorkflowEventMapping'));
  assert.ok(workflowEventsSource.includes('api.deleteWorkflowEventMapping'));
  assert.ok(!workflowEventsSource.includes("placeholder={actionKind === 'status' ? 'status key' : 'outcome key'}"));
});

test('workflow events save mappings with the selected workflow context', () => {
  assert.ok(routingPageSource.includes('sprintId={scopedSprintId}'));
  assert.ok(routingPageSource.includes('sprintType={scopedSprintType}'));
  assert.ok(workflowEventsSource.includes('buildPayload(form: MappingFormState, projectId: number | null, sprintId: number | null, sprintType: string | null)'));
  assert.ok(workflowEventsSource.includes('sprint_id: sprintId'));
  assert.ok(workflowEventsSource.includes('sprint_type: sprintId ? null : sprintType'));
  assert.ok(workflowEventsSource.includes('buildPayload(newForm, projectId, sprintId, sprintType)'));
  assert.ok(workflowEventsSource.includes('buildPayload(editForm, projectId, sprintId, sprintType)'));
  assert.ok(workflowEventsSource.includes('api.getWorkflowMetadata(sprintId ? { sprint_id: sprintId } : { sprint_type: sprintType })'));
});

test('workflow events table hides conflicts column', () => {
  assert.ok(!workflowEventsSource.includes('label="Conflicts"'));
  assert.ok(!workflowEventsSource.includes('description={EVENT_MAPPING_COLUMN_HELP.conflicts}'));
  assert.ok(!workflowEventsSource.includes('conflicts.join'));
});

test('workflow events table renders canonical mapping IDs', () => {
  assert.ok(workflowEventsSource.includes('label="ID"'));
  assert.ok(workflowEventsSource.includes('description={EVENT_MAPPING_COLUMN_HELP.id}'));
  assert.ok(workflowEventsSource.includes('#{mapping.id}'));
  assert.ok(workflowEventsSource.includes("mode === 'add' ? 'New' : id != null ? `#${id}`"));
  assert.ok(workflowEventsSource.includes('colSpan={12}'));
  assert.ok(!workflowEventsSource.includes('#{filteredMappings.indexOf(mapping)'));
});

test('workflow events table starts with ID, Task Type, Scope', () => {
  assertFirstColumns(workflowEventsSource, ['ID', 'Task Type', 'Scope', 'Source']);
  assert.ok(workflowEventsSource.indexOf('getTaskTypeLabel(mapping.task_type)') < workflowEventsSource.indexOf('<ScopeBadge mapping={mapping} />'));
});

test('automatic transitions table starts with ID, Task Type, Scope', () => {
  assertFirstColumns(automaticTransitionsSection, ['ID', 'Task Type', 'Scope', 'From']);
  assert.ok(automaticTransitionsSection.indexOf('<ScopeBadge kind={t.scope_kind} />') > automaticTransitionsSection.indexOf('getTaskTypeLabel(t.task_type)'));
  assert.ok(automaticTransitionsSection.indexOf('<ScopeBadge kind={t.scope_kind} />') < automaticTransitionsSection.indexOf('statusBadgeClass[t.from_status]'));
});

test('gate requirements table renders persisted requirement IDs', () => {
  assert.ok(routingPageSource.includes("id: 'transition-reqs'"));
  assert.ok(gateRequirementsSection.includes('label="Gate Requirements"'));
  assert.ok(gateRequirementsSection.includes('description={REQUIREMENT_COLUMN_HELP.id}'));
  assert.ok(gateRequirementsSection.includes('#{req.id}'));
  assert.ok(gateRequirementsSection.includes('colSpan={11}'));
  assert.ok(gateRequirementsSection.includes("showAdd || editingRequirementId !== null ? 'min-w-[1480px]' : 'min-w-[1160px]'"));
  assert.ok(!gateRequirementsSection.includes('#{filteredReqs.indexOf(req)'));
});

test('gate requirements table starts with ID, Task Type, Scope', () => {
  assertFirstColumns(gateRequirementsSection, ['ID', 'Task Type', 'Scope', 'Outcome']);
});

test('model routing table exposes leading ID, Task Type, Scope columns', () => {
  assertFirstColumns(modelRoutingSource, ['ID', 'Task Type', 'Scope', 'Label']);
  assert.ok(modelRoutingSource.includes('description={MODEL_ROUTING_COLUMN_HELP.id}'));
  assert.ok(modelRoutingSource.includes('description={MODEL_ROUTING_COLUMN_HELP.taskType}'));
  assert.ok(modelRoutingSource.includes('description={MODEL_ROUTING_COLUMN_HELP.scope}'));
  assert.ok(modelRoutingSource.includes('#{rule.id}'));
  assert.ok(modelRoutingSource.includes('All task types'));
  assert.ok(modelRoutingSource.includes('colSpan={13}'));
  assert.ok(modelRoutingSource.includes('min-w-[1180px]'));
});
