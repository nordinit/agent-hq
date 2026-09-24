import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClientId } from './clientId.ts';
import { dashboardBlocks, dashboardFromReport, operationsDashboard } from './dashboardLayout.ts';
import type { TelemetryReport } from './telemetryTypes.ts';

const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('dashboard templates and imported reports load on HTTP without crypto.randomUUID', t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } });
  t.after(() => Object.defineProperty(globalThis, 'crypto', original));

  const overview = operationsDashboard();
  assert.equal(dashboardBlocks(overview.definition).length, 10);
  const report = { name: 'Existing dashboard', scope: {}, definition: { presentation: 'dashboard', metrics: [{ metric_revision_id: 'pinned' }] } } as TelemetryReport;
  const imported = dashboardFromReport(report);
  assert.equal(imported.definition.metrics[0].metric_revision_id, 'pinned');
  const pages = [overview.definition, imported.definition];
  const ids = pages.flatMap(page => page.sections.flatMap(section => [section.id, ...section.columns.flatMap(column => [column.id, ...column.blocks.map(block => block.id)])]));
  ids.push(imported.definition.metrics[0].id, ...Array.from({ length: 100 }, createClientId));
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
