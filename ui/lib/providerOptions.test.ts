import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAgentModelOptionsForProvider,
  getDefaultAgentModelForProvider,
  isDynamicModelProvider,
  isLocalModelProvider,
  isModelAllowedForProvider,
} from './providerOptions.ts';

test('OpenAI API-key providers expose OpenAI models without Claude options', () => {
  const options = getAgentModelOptionsForProvider('openai');

  assert.equal(getDefaultAgentModelForProvider('openai'), 'openai/gpt-5.5');
  assert.deepEqual(options.map(option => option.value), ['openai/gpt-5.5', 'openai/gpt-5.4']);
  assert.equal(isModelAllowedForProvider('openai/gpt-5.5', 'openai'), true);
  assert.equal(isModelAllowedForProvider('anthropic/claude-sonnet-4-6', 'openai'), false);
});

test('Google has a catalog-backed model path', () => {
  assert.equal(getDefaultAgentModelForProvider('google'), 'google/gemini-2.5-pro');
  assert.equal(isModelAllowedForProvider('google/gemini-2.5-flash', 'google'), true);
  assert.equal(isModelAllowedForProvider('openai/gpt-5.5', 'google'), false);
});

test('local providers are freeform while dynamic providers are catalog-constrained', () => {
  assert.equal(isLocalModelProvider('ollama'), true);
  assert.equal(isLocalModelProvider('mlx-studio'), true);
  assert.equal(isModelAllowedForProvider('llama3.2:latest', 'ollama'), true);

  assert.equal(isDynamicModelProvider('minimax'), true);
  assert.equal(isModelAllowedForProvider('MiniMax-M2.7', 'minimax'), true);
  assert.equal(isModelAllowedForProvider('openai/gpt-5.5', 'minimax'), false);
});
