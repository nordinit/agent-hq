import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GETTING_STARTED_PARTS, getGettingStartedPart } from './gettingStarted.ts';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));
const allSteps = GETTING_STARTED_PARTS.flatMap(part => part.steps);

function routesOf(partId: 'essentials' | 'advanced') {
  return getGettingStartedPart(partId).steps.map(step => step.route);
}

function listTsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listTsxFiles(path);
    return path.endsWith('.tsx') ? [path] : [];
  });
}

test('the guide is split into an essentials part followed by an advanced part', () => {
  assert.deepEqual(GETTING_STARTED_PARTS.map(part => part.id), ['essentials', 'advanced']);
  for (const part of GETTING_STARTED_PARTS) {
    assert.ok(part.steps.length > 0, `${part.id} has steps`);
  }
});

test('part 1 covers the essentials for running a first task', () => {
  const routes = routesOf('essentials');
  for (const route of ['/', '/projects', '/agents', '/settings/providers', '/workflows', '/routing', '/tasks', '/chat', '/workspaces']) {
    assert.ok(routes.includes(route), `expected part 1 route ${route}`);
  }
});

test('part 2 covers the advanced surface, including teams and tenants', () => {
  const routes = routesOf('advanced');
  for (const route of ['/workflow-definitions', '/routing', '/model-routing', '/capabilities', '/teams', '/tasks/recurring', '/telemetry', '/settings/mcp', '/settings/tenants']) {
    assert.ok(routes.includes(route), `expected part 2 route ${route}`);
  }
  const essentials = routesOf('essentials');
  assert.ok(!essentials.includes('/teams'), 'teams belongs in part 2');
  assert.ok(!essentials.includes('/settings/tenants'), 'tenants belongs in part 2');
});

test('step ids are unique across both parts', () => {
  const ids = allSteps.map(step => step.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every step targets an element that exists in the UI', () => {
  const source = [...listTsxFiles(join(uiRoot, 'app')), ...listTsxFiles(join(uiRoot, 'features')), ...listTsxFiles(join(uiRoot, 'components'))]
    .map(path => readFileSync(path, 'utf8'))
    .join('\n');

  for (const step of allSteps) {
    assert.ok(step.selectors.length > 0, `${step.id} has a selector`);
    for (const selector of step.selectors) {
      const match = /^\[data-tour-target="([^"]+)"\]$/.exec(selector);
      assert.ok(match, `${step.id} selector ${selector} uses a data-tour-target attribute`);
      const name = match[1];
      assert.ok(
        source.includes(`data-tour-target="${name}"`) || source.includes(`'${name}'`),
        `${step.id} targets data-tour-target="${name}", which no page renders`,
      );
    }
  }
});

test('the agents step recommends Claude Code and names every other runtime option', () => {
  const agentsStep = getGettingStartedPart('essentials').steps.find(step => step.id === 'agents');
  assert.ok(agentsStep);
  assert.match(agentsStep.description, /recommend Claude Code/);

  const agentsPage = readFileSync(join(uiRoot, 'app', 'agents', 'page.tsx'), 'utf8');
  const optionsBlock = /const RUNTIME_TYPE_OPTIONS[^=]*=\s*\[([\s\S]*?)\];/.exec(agentsPage);
  assert.ok(optionsBlock, 'agents page defines RUNTIME_TYPE_OPTIONS');
  const labels = [...optionsBlock[1].matchAll(/label:\s*'([^']+)'/g)].map(match => match[1]);
  assert.ok(labels.length > 1);
  for (const label of labels) {
    assert.ok(agentsStep.description.includes(label), `agents step mentions the ${label} runtime`);
  }
});

test('each part ends by opening Atlas with an editable prompt', () => {
  for (const part of GETTING_STARTED_PARTS) {
    const last = part.steps[part.steps.length - 1];
    assert.equal(last.continueLabel, 'Finish');
    assert.equal(last.enterCommand?.type, 'open-chat-with-draft');
  }
});

test('guide copy describes base defaults and manual configuration generically', () => {
  const guideText = allSteps
    .map(step => `${step.title}\n${step.description}\n${step.enterCommand && 'text' in step.enterCommand ? step.enterCommand.text : ''}`)
    .join('\n');

  assert.match(guideText, /Base installs/i);
  assert.match(guideText, /base defaults/i);
  assert.match(guideText, /optional manual configuration/i);
  assert.doesNotMatch(guideText, /\/Users\/|\/home\//);
});
