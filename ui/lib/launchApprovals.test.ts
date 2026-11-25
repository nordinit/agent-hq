import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (...parts: string[]) => readFileSync(join(here, '..', ...parts), 'utf8');
const banner = read('components', 'LaunchHoldBanner.tsx');
const detail = read('features', 'tasks', 'TaskDetailPanel.tsx');
const board = read('features', 'tasks', 'TaskBoardComponents.tsx');
const page = read('features', 'approvals', 'ApprovalsPage.tsx');
const drawer = read('features', 'approvals', 'ApprovalDrawer.tsx');
const explainer = read('features', 'approvals', 'HowApprovalsWork.tsx');
const client = read('lib', 'api', 'approvals.ts');
const sidebar = read('components', 'Sidebar.tsx');

test('a task Agent HQ refused to start says why and links to the approval', () => {
  assert.match(banner, /Can&apos;t start/);
  assert.match(banner, /\{hold\.reason\}/);
  assert.match(banner, /href=\{`\/approvals\?agent=\$\{hold\.agent_id\}`\}/);
  assert.equal((detail.match(/<LaunchHoldBanner hold=\{localTask\.launch_hold\} \/>/g) ?? []).length, 2);
  assert.match(board, /task\.launch_hold && <span[^>]*title=\{task\.launch_hold\.reason\}>Can&apos;t start<\/span>/);
});

test('the approvals page is a grid of every agent against each check', () => {
  assert.match(client, /getApprovals:[\s\S]*\/api\/v1\/execution\/approvals/);
  assert.match(client, /approvePending:[\s\S]*method: 'POST'/);
  for (const column of ['Agent', 'Allowed to run', 'Agent setup', 'Workflow setups', 'Tasks']) {
    assert.match(page, new RegExp(`<ColumnHeaderLabel label="${column}" description=\\{COLUMN_HELP\\.`));
  }
  // Agents needing attention by default, with every agent one click away.
  assert.match(page, /useState<View>\('attention'\)/);
  assert.match(page, /Needs attention \(\$\{attention\.length\}\)/);
  assert.match(page, /All agents \(\$\{inProject\.length\}\)/);
  // A task's "Review and approve" link opens that agent's row.
  assert.match(page, /new Set\(linkedAgentId \? \[linkedAgentId\] : \[\]\)/);
  // Stopping routing is a link to the agent's rules for that workflow, not an action here.
  assert.match(page, /<Link href=\{routingRulesHref\(check\.workflow\.id, entry\.agent\.id\)\}/);
  assert.match(sidebar, /\{ href: '\/approvals', label: 'Approvals', icon: ShieldCheck \}/);
});

test('the page explains approvals before asking for one', () => {
  assert.match(explainer, /How approvals work/);
  for (const check of ['Allowed to run here', 'Agent setup approved', 'Workflow setup approved']) assert.match(explainer, new RegExp(check));
  assert.match(explainer, /Approval is per agent and per workflow/);
  assert.match(explainer, /What the colours mean/);
});

test('the review drawer shows what changed and approves exactly what was reviewed', () => {
  assert.match(drawer, /What changed since you approved it/);
  assert.match(drawer, /What you would approve/);
  assert.match(drawer, />Approved<\/p>[\s\S]*>Now<\/p>/);
  assert.match(drawer, /digest: check\.digest!/);
  // host.execute is granted only for the permission itself, or when the operator ticks it.
  assert.match(drawer, /const \[alsoAllow, setAlsoAllow\] = useState\(false\)/);
  assert.match(drawer, /const granting = target\.kind === 'permission' \|\| \(!entry\.host_execute && alsoAllow\)/);
  assert.match(drawer, /Approving this alone won’t start its tasks/);
  // Every setting says what it is, why it needs approval, its value in words, and where it is changed.
  assert.match(drawer, /const guide = fieldGuide\(change, context\)/);
  assert.match(drawer, /Why it needs your approval:/);
  assert.match(drawer, /describeValue\(path, value\)/);
  assert.match(drawer, /Change it: \{guide\.where\.label\}/);
});
