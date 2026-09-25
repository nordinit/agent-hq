import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClientId } from './clientId.ts';
import { blankDashboard, dashboardBlocks, operationsDashboard } from './dashboardLayout.ts';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('dashboard templates load on HTTP without crypto.randomUUID', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', original));

  const overview = operationsDashboard();
  assert.equal(dashboardBlocks(overview.definition).length, 10);
  const pages = [overview.definition, blankDashboard().definition];
  const ids = pages.flatMap(page => page.sections.flatMap(section => [section.id, ...section.columns.flatMap(column => [column.id, ...column.blocks.map(block => block.id)])]));
  ids.push(...Array.from({ length: 100 }, createClientId));
  for (const id of ids) assert.match(id, uuidV4);
  assert.equal(new Set(ids).size, ids.length);
});

test('content IDs still work when the browser has no Web Crypto API', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
  t.after(() => Object.defineProperty(globalThis, 'crypto', original));
  const ids = Array.from({ length: 100 }, createClientId);
  for (const id of ids) assert.match(id, uuidV4);
  assert.equal(new Set(ids).size, ids.length);
});
