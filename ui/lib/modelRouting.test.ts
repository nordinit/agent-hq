import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEffectiveModel, shortModelName, type ModelRoutingRule } from './modelRouting.ts';

const rules: ModelRoutingRule[] = [
  { id: 1, max_points: 2, provider: 'openai', model: 'openai/gpt-4.1-mini', label: null, project_id: null, sprint_id: null },
  { id: 2, max_points: 8, provider: 'openai', model: 'openai/gpt-5', label: null, project_id: null, sprint_id: null },
  { id: 3, max_points: 3, provider: 'anthropic', model: 'anthropic/claude-sonnet-4-6', label: null, project_id: 10, sprint_id: null },
  { id: 4, max_points: 5, provider: 'anthropic', model: 'anthropic/claude-opus-4-1', label: null, project_id: 10, sprint_id: 20 },
];

test('resolveEffectiveModel prefers sprint-scoped rules over project and fallback rules', () => {
  assert.equal(resolveEffectiveModel(5, rules, 10, 20), 'anthropic/claude-opus-4-1');
});

test('resolveEffectiveModel prefers project rules over global fallback rules', () => {
  assert.equal(resolveEffectiveModel(3, rules, 10, null), 'anthropic/claude-sonnet-4-6');
});

test('resolveEffectiveModel uses the highest rule in scope when points exceed configured maximums', () => {
  assert.equal(resolveEffectiveModel(13, rules, null, null), 'openai/gpt-5');
});

test('resolveEffectiveModel ignores disabled rules', () => {
  assert.equal(resolveEffectiveModel(2, [
    { id: 10, max_points: 2, provider: 'openai', model: 'openai/disabled', label: null, project_id: 10, sprint_id: null, enabled: false },
    { id: 11, max_points: 5, provider: 'openai', model: 'openai/enabled', label: null, project_id: 10, sprint_id: null, enabled: true },
  ], 10, null), 'openai/enabled');
});

test('resolveEffectiveModel returns null when story points or rules are absent', () => {
  assert.equal(resolveEffectiveModel(null, rules, 10, 20), null);
  assert.equal(resolveEffectiveModel(3, [], 10, 20), null);
});

test('shortModelName maps known model families and falls back to provider slug tail', () => {
  assert.equal(shortModelName('anthropic/claude-haiku-4-5'), 'Haiku');
  assert.equal(shortModelName('google/gemini-flash-latest'), 'Gemini Flash');
  assert.equal(shortModelName('custom/special-model'), 'special-model');
});
