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
const client = read('lib', 'api', 'approvals.ts');
const sidebar = read('components', 'Sidebar.tsx');

test('a task Agent HQ refused to start says why and links to the approval', () => {
  assert.match(banner, /Can&apos;t start/);
  assert.match(banner, /\{hold\.reason\}/);
  assert.match(banner, /href=\{`\/approvals\?agent=\$\{hold\.agent_id\}`\}/);
  assert.equal((detail.match(/<LaunchHoldBanner hold=\{localTask\.launch_hold\} \/>/g) ?? []).length, 2);
  assert.match(board, /task\.launch_hold && <span[^>]*title=\{task\.launch_hold\.reason\}>Can&apos;t start<\/span>/);
});

test('the approvals page shows what changed and approves exactly what was reviewed', () => {
  assert.match(client, /getPendingApprovals:[\s\S]*\/api\/v1\/execution\/approvals/);
  assert.match(client, /approvePending:[\s\S]*method: 'POST'/);
  assert.match(page, /Changed since you approved it/);
  assert.match(page, /Never approved: this is what you would approve/);
  assert.match(page, />Approved<\/p>[\s\S]*>Now<\/p>/);
  assert.match(page, /digest: profile\.digest!/);
  // host.execute is granted only when the operator ticks it.
  assert.match(page, /useState\(false\)[\s\S]*grant_host_execute: !entry\.host_execute && allowRun/);
  assert.match(sidebar, /\{ href: '\/approvals', label: 'Approvals', icon: ShieldCheck \}/);
});
