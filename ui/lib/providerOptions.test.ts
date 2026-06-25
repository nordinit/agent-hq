import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAgentProviderOptions,
  getAgentModelOptionsForProvider,
  getDefaultAgentModelForProvider,
  isDynamicModelProvider,
  isLocalModelProvider,
  isModelAllowedForProvider,
} from './providerOptions.ts';
import type { ProviderRecord } from './api/types.ts';

function provider(overrides: Partial<ProviderRecord>): ProviderRecord {
  return {
    id: 1,
    slug: 'openai',
    display_name: 'OpenAI',
    status: 'connected',
    config: {},
    last_validated_at: null,
    validation_error: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

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

test('provider dropdown options include only connected configured providers', () => {
  const options = getAgentProviderOptions([
    provider({ id: 1, slug: 'openai-codex', display_name: 'OpenAI Codex', status: 'connected' }),
    provider({ id: 2, slug: 'openai', display_name: 'OpenAI failed', status: 'failed' }),
    provider({ id: 3, slug: 'anthropic', display_name: 'Anthropic pending', status: 'pending' }),
    provider({ id: 4, slug: 'google', display_name: 'Google untested', status: 'untested' }),
    provider({ id: 5, slug: 'mlx-studio', display_name: '', status: 'connected' }),
  ]);

  assert.deepEqual(options, [
    { value: 'openai-codex', label: 'OpenAI Codex' },
    { value: 'mlx-studio', label: 'MLX Studio' },
  ]);
});
