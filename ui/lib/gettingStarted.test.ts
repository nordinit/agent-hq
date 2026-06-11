import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GETTING_STARTED_STEPS } from './gettingStarted.ts';

test('getting started guide covers the current setup and monitoring surface', () => {
  const routes = GETTING_STARTED_STEPS.map(step => step.route);
  const requiredRoutes = [
    '/',
    '/projects',
    '/agents',
    '/capabilities',
    '/workflows',
    '/workflow-definitions',
    '/routing',
    '/model-routing',
    '/tasks',
    '/tasks/recurring',
    '/chat',
    '/telemetry',
    '/settings/api',
  ];

  for (const route of requiredRoutes) {
    assert.ok(routes.includes(route), `expected guide route ${route}`);
  }
});

test('getting started guide describes base defaults and manual configuration generically', () => {
  const guideText = GETTING_STARTED_STEPS
    .map(step => `${step.title}\n${step.description}\n${step.enterCommand && 'text' in step.enterCommand ? step.enterCommand.text : ''}`)
    .join('\n');

  assert.match(guideText, /Base installs/i);
  assert.match(guideText, /base defaults/i);
  assert.match(guideText, /optional manual configuration/i);
  assert.doesNotMatch(guideText, /Masiah/i);
  assert.doesNotMatch(guideText, /\/Users\/nordini/i);
});
