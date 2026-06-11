import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatSessionsPath, buildInstancesPath } from './apiQuery.ts';

test('buildChatSessionsPath includes project_id and limit query params', () => {
  const url = new URL(buildChatSessionsPath({ projectId: 7 }, 200), 'http://agent-hq.local');
  assert.equal(url.pathname, '/api/v1/chat/sessions');
  assert.equal(url.searchParams.get('project_id'), '7');
  assert.equal(url.searchParams.get('limit'), '200');
});

test('buildInstancesPath includes server-side agent and project filters', () => {
  const url = new URL(buildInstancesPath({ agentId: 3, projectId: 7, limit: 200 }), 'http://agent-hq.local');
  assert.equal(url.pathname, '/api/v1/instances');
  assert.equal(url.searchParams.get('agent_id'), '3');
  assert.equal(url.searchParams.get('project_id'), '7');
  assert.equal(url.searchParams.get('limit'), '200');
});
