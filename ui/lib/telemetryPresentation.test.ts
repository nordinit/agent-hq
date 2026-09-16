import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTelemetryRequestGuard, formatTelemetryValue, parseTelemetryDraft, telemetryScopeQuery, telemetryExactValue } from './telemetryPresentation.ts';

test('zero, missing population, and rates have distinct presentations', () => {
  assert.equal(formatTelemetryValue(0, 'count'), '0');
  assert.equal(formatTelemetryValue(null, 'count'), '—');
  assert.equal(formatTelemetryValue(0.5, 'percent'), '50%');
  assert.equal(formatTelemetryValue(2 / 3, 'percent'), '66.67%');
});

test('exact decimals are not converted through an unsafe JavaScript number', () => {
  assert.equal(formatTelemetryValue({ decimal: '9007199254740993.25' }), '9007199254740993.25');
  assert.equal(formatTelemetryValue({ decimal: '0.333333333333333333' }, 'percent'), '33.33%');
  assert.equal(telemetryExactValue({ decimal: '0.333333333333333333' }), '0.333333333333333333');
  assert.equal(formatTelemetryValue({ decimal: '0.666666666666666666' }, 'percent'), '66.67%');
  assert.equal(formatTelemetryValue({ decimal: '0.999999999999999999' }, 'percent'), '100%');
  assert.equal(formatTelemetryValue({ decimal: '0.005' }, 'percent'), '0.5%');
  assert.equal(formatTelemetryValue({ decimal: '-0.01' }, 'percent'), '-1%');
});

test('an older response cannot replace a result after filters or drafts change', () => {
  const guard = createTelemetryRequestGuard();
  const firstScope = guard.begin();
  guard.invalidate();
  assert.equal(guard.isCurrent(firstScope), false);
  const currentScope = guard.begin();
  assert.equal(guard.isCurrent(currentScope), true);
  const refreshedScope = guard.begin();
  assert.equal(guard.isCurrent(currentScope), false);
  assert.equal(guard.isCurrent(refreshedScope), true);
});

test('advanced drafts preserve supplied business semantics and reject non-objects', () => {
  assert.deepEqual(parseTelemetryDraft('{"success":{"status":"submitted"},"denominator":"successful"}'), {
    success: { status: 'submitted' }, denominator: 'successful',
  });
  assert.throws(() => parseTelemetryDraft('[]'), /JSON object/);
  assert.throws(() => parseTelemetryDraft('null'), /JSON object/);
  assert.throws(() => parseTelemetryDraft('{'), SyntaxError);
});

test('all scope parameters are encoded without dropping explicit false values', () => {
  assert.equal(telemetryScopeQuery({ project_id: 2, workflow_type: 'review & ship', include_archived: false, workflow_id: undefined }), '?project_id=2&workflow_type=review+%26+ship&include_archived=false');
});
