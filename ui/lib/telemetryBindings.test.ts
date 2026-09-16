import assert from 'node:assert/strict';
import { test } from 'node:test';
import { telemetryBindingAttention, telemetryBindingPreviewRequest, telemetryBindingWrite } from './telemetryBindings.ts';
import type { TelemetryBindingPreview } from './telemetryTypes.ts';
const scope = { project_id: 1, workflow_id: 11, workflow_type: 'article' };
const binding = { family_key: 'first_pass', scope, metric_revision_id: 'definition-v2', version: 99, id: 'old-inherited-id' };
function reviewed(origin: 'exact' | 'inherited') {
  const preview: TelemetryBindingPreview = { family_key: 'first_pass', scope, current: { origin, winner: { family_key: 'first_pass', scope: origin === 'exact' ? scope : {}, version: 3, metric_revision_id: 'definition-v1' }, shadowed: [], narrower: [] }, proposed: { origin: 'exact', winner: { ...binding, id: 'proposed' }, shadowed: [], narrower: [] }, effect: 'replace' };
  return { requestKey: JSON.stringify(telemetryBindingPreviewRequest(binding, scope)), preview };
}
test('binding inspection can show inherited defaults before a metric revision is selected', () => {
  assert.deepEqual(telemetryBindingPreviewRequest({ family_key: ' first_pass ', scope }, scope), { family_key: 'first_pass', scope });
  assert.equal(telemetryBindingPreviewRequest({ family_key: ' ', scope }, scope), null);
});
test('saving a new workflow override does not send its inherited parent version or storage fields', () => {
  const write = telemetryBindingWrite(binding, scope, reviewed('inherited'));
  assert.equal(write.expected_version, undefined);
  assert.equal('id' in write, false); assert.equal('version' in write, false);
  assert.equal(write.metric_revision_id, 'definition-v2');
});
test('replacing an exact binding uses the authoritative preview version', () => {
  assert.equal(telemetryBindingWrite(binding, scope, reviewed('exact')).expected_version, 3);
});
test('a stale preview cannot authorize a different selection and disable does not retain obsolete references', () => {
  assert.throws(() => telemetryBindingWrite({ ...binding, metric_revision_id: 'definition-v3' }, scope, reviewed('exact')), /exact binding/);
  assert.throws(() => telemetryBindingWrite(binding, { ...scope, workflow_id: 12 }, reviewed('exact')), /exact binding/);
  assert.deepEqual(telemetryBindingPreviewRequest({ ...binding, disabled: true, profile_revision_id: 'obsolete' }, scope)?.override, { disabled: true, metric_revision_id: null, profile_revision_id: null });
});
test('retired signal bindings display attention and its reasons rather than appearing active', () => {
  assert.deepEqual(telemetryBindingAttention({ validation_state: 'needs_attention', validation_issues: ['Approved status generation was retired.'] }), ['Approved status generation was retired.']);
  assert.match(telemetryBindingAttention({ validation_state: 'needs_attention', validation_issues: [] })[0], /no longer valid/);
  assert.deepEqual(telemetryBindingAttention({ validation_state: 'active', validation_issues: [] }), []);
  assert.deepEqual(telemetryBindingAttention({}), []);
});
