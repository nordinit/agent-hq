import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatTextSize, formatEstimatedTokens, formatRecordedTokens } from './tokenCounts.ts';

test('run totals prefer recorded totals and preserve zero and partial counts', () => {
  assert.deepEqual(formatRecordedTokens({ token_input: 2000, token_output: 500, token_total: 3000 }), {
    label: '3,000 tokens', breakdown: '2,000 in / 500 out',
  });
  assert.deepEqual(formatRecordedTokens({ token_input: 0, token_output: 10 }), {
    label: '10 tokens', breakdown: '0 in / 10 out',
  });
  assert.deepEqual(formatRecordedTokens({ token_output: 10 }), { label: '10 output tokens', breakdown: '' });
  assert.deepEqual(formatRecordedTokens({ token_total: 0 }), { label: '0 tokens', breakdown: '' });
  assert.equal(formatRecordedTokens({ token_total: null }), null);
});

test('chat fallback estimates loaded conversation text and excludes events', () => {
  const size = chatTextSize([
    { id: '1', timestamp: '', role: 'user', content: 'Hi' },
    { id: '2', timestamp: '', role: 'assistant', event_type: 'text', content: 'Hello' },
    { id: '3', timestamp: '', role: 'assistant', event_type: 'tool_result', content: 'Tool data' },
    { id: '4', timestamp: '', role: 'system', content: 'Startup' },
  ]);
  assert.equal(size, 7);
  assert.equal(formatEstimatedTokens(size), '≈2 tokens');
  assert.equal(formatEstimatedTokens(8), '≈3 tokens');
  assert.equal(formatEstimatedTokens(0), '≈0 tokens');
});
