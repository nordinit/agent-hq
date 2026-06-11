import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getTaskStatusEmoji, normalizeTaskStatusEmojiInput } from './taskStatusEmoji.ts';

test('getTaskStatusEmoji prefers the direct emoji field and falls back to metadata', () => {
  assert.equal(getTaskStatusEmoji({ emoji: '🧱', metadata: { emoji: '📦' } }), '🧱');
  assert.equal(getTaskStatusEmoji({ metadata: { emoji: '📦' } }), '📦');
  assert.equal(getTaskStatusEmoji({ emoji: '   ', metadata: { emoji: '📦' } }), '📦');
  assert.equal(getTaskStatusEmoji({ metadata: {} }), '');
});

test('normalizeTaskStatusEmojiInput trims values and returns null for empty input', () => {
  assert.equal(normalizeTaskStatusEmojiInput(' 🧪 '), '🧪');
  assert.equal(normalizeTaskStatusEmojiInput('   '), null);
});
