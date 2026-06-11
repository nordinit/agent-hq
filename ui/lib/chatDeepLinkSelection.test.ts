import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFallbackInstanceFromChatSession,
  mergeDeepLinkedInstance,
  mergeTargetChatSessions,
  shouldAutoOpenDefaultChat,
  shouldPreserveSelectedDeepLink,
  sortInstancesByCreatedAtDesc,
} from './chatDeepLinkSelection.ts';

test('mergeDeepLinkedInstance inserts a prompt-only starting run missing from the fetched agent list', () => {
  const deepLinked = { id: 4581, agent_id: 97, created_at: '2026-06-03T08:00:00.000Z' };
  const fetched = [{ id: 4000, agent_id: 97, created_at: '2026-06-02T08:00:00.000Z' }];

  const merged = mergeDeepLinkedInstance(fetched, deepLinked, 97);

  assert.equal(merged[0].id, 4581);
  assert.equal(merged.length, 2);
});

test('mergeDeepLinkedInstance does not duplicate runs already returned by the instance index', () => {
  const deepLinked = { id: 4581, agent_id: 97, created_at: '2026-06-03T08:00:00.000Z' };
  const fetched = [deepLinked];

  assert.equal(mergeDeepLinkedInstance(fetched, deepLinked, 97), fetched);
});

test('shouldPreserveSelectedDeepLink keeps selection pinned while runs reload', () => {
  assert.equal(shouldPreserveSelectedDeepLink(4581, 4581), true);
  assert.equal(shouldPreserveSelectedDeepLink(null, 4581), false);
  assert.equal(shouldPreserveSelectedDeepLink(4582, 4581), false);
});

test('shouldAutoOpenDefaultChat preserves desktop and explicit deep-link auto-open only', () => {
  assert.equal(shouldAutoOpenDefaultChat(false, false), true);
  assert.equal(shouldAutoOpenDefaultChat(false, true), true);
  assert.equal(shouldAutoOpenDefaultChat(true, true), true);
  assert.equal(shouldAutoOpenDefaultChat(true, false), false);
});

test('mergeTargetChatSessions keeps instance-filtered raw chat session metadata visible', () => {
  const general = [{ instance_id: 1 }];
  const target = [{ instance_id: 4581 }];

  assert.deepEqual(mergeTargetChatSessions(general, target), [{ instance_id: 4581 }, { instance_id: 1 }]);
});

test('buildFallbackInstanceFromChatSession creates a visible run from a prompt-only session row', () => {
  const fallback = buildFallbackInstanceFromChatSession({
    instance_id: 4581,
    session_key: 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
    agent_id: 97,
    agent_name: 'Cinder',
    project_id: 6,
    started_at: '2026-06-03T09:00:00.000Z',
    last_activity: '2026-06-03T09:00:01.000Z',
  });

  assert.deepEqual(fallback && {
    id: fallback.id,
    agent_id: fallback.agent_id,
    project_id: fallback.project_id,
    session_key: fallback.session_key,
    status: fallback.status,
    started_at: fallback.started_at,
  }, {
    id: 4581,
    agent_id: 97,
    project_id: 6,
    session_key: 'run:4581:244f30ff-cf5d-4c86-96f9-273787cf8062',
    status: 'dispatched',
    started_at: null,
  });
});

test('buildFallbackInstanceFromChatSession ignores direct chats and incomplete session rows', () => {
  assert.equal(buildFallbackInstanceFromChatSession({ instance_id: null }), null);
  assert.equal(buildFallbackInstanceFromChatSession({ instance_id: 4581, agent_id: 97 }), null);
});

test('sortInstancesByCreatedAtDesc keeps the newest run first after deep-link merge', () => {
  const sorted = sortInstancesByCreatedAtDesc([
    { id: 1, agent_id: 97, created_at: '2026-06-01T00:00:00.000Z' },
    { id: 2, agent_id: 97, created_at: '2026-06-03T00:00:00.000Z' },
  ]);

  assert.equal(sorted[0].id, 2);
});
