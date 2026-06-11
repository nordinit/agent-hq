import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));

test('agent detail renders Remote Gateway URL terminology for the stored hooks_url field', () => {
  const detailPage = readFileSync(join(here, '../app/agents/[id]/page.tsx'), 'utf8');

  assert.match(detailPage, /Remote Gateway URL/);
  assert.doesNotMatch(detailPage, />\s*Hooks URL\s*</);
});

test('agent API type documents hooks_url as the Remote Gateway URL compatibility field', () => {
  const apiTypes = readFileSync(join(here, 'api.ts'), 'utf8');

  assert.match(apiTypes, /Remote Gateway URL/);
  assert.match(apiTypes, /hooks_url for compatibility/);
});
