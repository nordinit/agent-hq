import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isUiSessionExpired } from './sessionExpiry.ts';

test('only the UI session answer sends the page to sign in', () => {
  assert.equal(isUiSessionExpired(401, { code: 'ui_session_required' }), true);
  // An API 401 about an MCP key is the route's own answer, not an ended session.
  assert.equal(isUiSessionExpired(401, { code: 'mcp_api_key_missing' }), false);
  assert.equal(isUiSessionExpired(403, { code: 'ui_session_required' }), false);
  assert.equal(isUiSessionExpired(401, null), false);
});
