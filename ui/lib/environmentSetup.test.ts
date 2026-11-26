import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeEnvironmentSetup } from './environmentSetup.ts';

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, '..', 'app', 'workflows', '[id]', 'page.tsx'), 'utf8');
const card = readFileSync(join(here, '..', 'components', 'WorkflowSetupCard.tsx'), 'utf8');

test('environment preparation reads the same whether saved as an object or JSON', () => {
  assert.equal(summarizeEnvironmentSetup(null)?.label, 'Off');
  assert.equal(summarizeEnvironmentSetup('{"mode":"off"}')?.description, 'Nothing runs before the agent starts. The agent starts in its workspace as it is.');
  assert.deepEqual(summarizeEnvironmentSetup({ mode: 'auto', roots: ['web', 'api'], timeoutSeconds: 600 }), {
    mode: 'auto', label: 'Automatic', roots: ['web', 'api'], steps: [], timeoutSeconds: 600,
    description: 'Agent HQ finds the project’s lockfile in web, api and runs the matching install (for example npm ci or uv sync), skipping it when nothing changed.',
  });
  const custom = summarizeEnvironmentSetup({ mode: 'custom', steps: [{ command: ['corepack', 'pnpm', 'install', '--frozen-lockfile'], cwd: '.' }, { command: ['npm', 'ci'], cwd: 'crm-mcp' }], timeoutSeconds: 900 });
  assert.deepEqual(custom?.steps, [{ command: 'corepack pnpm install --frozen-lockfile', cwd: '.' }, { command: 'npm ci', cwd: 'crm-mcp' }]);
  assert.equal(custom?.timeoutSeconds, 900);
  assert.equal(summarizeEnvironmentSetup({ mode: 'weird' }), null);
});

test('the workflow page shows environment preparation without opening Edit', () => {
  // On the Overview tab, whether or not metrics have loaded.
  assert.equal((page.match(/<WorkflowSetupCard workflow=\{workflow\} \/>/g) ?? []).length, 2);
  // And in the header on every tab.
  assert.match(page, /Preparation: \{preparation\.label\}/);
  assert.match(card, /Repository and environment preparation/);
  assert.match(card, /setup\.steps\.map/);
  assert.match(card, /<Link href="\/approvals"/);
});
