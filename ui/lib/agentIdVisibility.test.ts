import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));

test('agents list cards render the canonical agent id', () => {
  const agentsPage = readFileSync(join(here, '../app/agents/page.tsx'), 'utf8');

  assert.match(agentsPage, /Agent #\{agent\.id\}/);
});

test('agent detail header renders the canonical agent id', () => {
  const detailPage = readFileSync(join(here, '../app/agents/[id]/page.tsx'), 'utf8');

  assert.match(detailPage, /Agent #\{agent\.id\}/);
});
