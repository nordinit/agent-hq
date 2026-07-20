import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = process.cwd();
const agentsPage = readFileSync(join(here, 'app/agents/page.tsx'), 'utf8');
const agentDetailPage = readFileSync(join(here, 'app/agents/[id]/page.tsx'), 'utf8');

test('agent create form uses free-form model input with suggestions', () => {
  assert.match(agentsPage, /placeholder="e\.g\. openai-codex\/gpt-5\.4"/);
  assert.match(agentsPage, /list="agent-model-suggestions"/);
  assert.match(agentsPage, /<datalist id="agent-model-suggestions">/);
  assert.doesNotMatch(agentsPage, /Selected model is not available for the chosen connected provider/);
});

test('agent detail mobile edit form preserves custom model text', () => {
  assert.match(agentDetailPage, /const model = preferredProvider === savedProvider \? agent\.model \?\? '' : '';/);
  assert.match(agentDetailPage, /placeholder="e\.g\. openai-codex\/gpt-5\.4"/);
  assert.match(agentDetailPage, /list="agent-edit-model-suggestions"/);
  assert.match(agentDetailPage, /<datalist id="agent-edit-model-suggestions">/);
  assert.doesNotMatch(agentDetailPage, /Current saved model is no longer available/);
});
