import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAgentProviderOptions,
  getAgentModelOptionsForProvider,
  getDefaultAgentModelForProvider,
  isDynamicModelProvider,
  isLocalModelProvider,
  isModelAllowedForProvider,
  isOpenClawOnlyProvider,
  isProviderSupportedByRuntime,
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

test('OpenAI API-key providers expose model suggestions without gating custom values', () => {
  const options = getAgentModelOptionsForProvider('openai');

  assert.equal(getDefaultAgentModelForProvider('openai'), 'openai/gpt-5.5');
  assert.deepEqual(options.map(option => option.value), ['openai/gpt-5.5', 'openai/gpt-5.4']);
  assert.equal(isModelAllowedForProvider('openai/gpt-5.5', 'openai'), true);
  assert.equal(isModelAllowedForProvider('openai-codex/gpt-5.4', 'openai'), true);
});

test('Google has suggested models and accepts custom model identifiers', () => {
  assert.equal(getDefaultAgentModelForProvider('google'), 'google/gemini-2.5-pro');
  assert.equal(isModelAllowedForProvider('google/gemini-2.5-flash', 'google'), true);
  assert.equal(isModelAllowedForProvider('google/gemini-experimental-custom', 'google'), true);
});

test('OpenRouter is a canonical provider slug with optional model suggestions', () => {
  assert.equal(getDefaultAgentModelForProvider('openrouter'), 'openrouter/auto');
  assert.equal(isModelAllowedForProvider('openrouter/auto', 'openrouter'), true);
  assert.equal(isModelAllowedForProvider('custom/provider-model', 'openrouter'), true);
});

test('local and dynamic providers both allow free-form model text', () => {
  assert.equal(isLocalModelProvider('ollama'), true);
  assert.equal(isLocalModelProvider('mlx-studio'), true);
  assert.equal(isModelAllowedForProvider('llama3.2:latest', 'ollama'), true);

  assert.equal(isDynamicModelProvider('minimax'), true);
  assert.equal(isModelAllowedForProvider('MiniMax-M2.7', 'minimax'), true);
  assert.equal(isModelAllowedForProvider('MiniMax-custom-preview', 'minimax'), true);
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

test('Codex OAuth is available to Codex without becoming an OpenClaw-only provider', () => {
  assert.equal(isOpenClawOnlyProvider('openai-codex'), false);
  assert.equal(isProviderSupportedByRuntime('openai-codex', 'codex'), true);
  assert.equal(isProviderSupportedByRuntime('anthropic', 'codex'), false);
  assert.equal(isProviderSupportedByRuntime('minimax', 'codex'), false);
});
