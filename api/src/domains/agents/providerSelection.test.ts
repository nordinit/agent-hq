import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../../db/client';
import {
  defaultAgentModelForProvider,
  validateAgentProviderSelection,
} from './providerSelection';

let tempDir: string;

function resetDb(): void {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-selection-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  const db = getDb();
  db.exec(`
    CREATE TABLE provider_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      slug TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
}

function connectProvider(slug: string): void {
  getDb().prepare(`INSERT INTO provider_config (tenant_id, slug, status) VALUES (1, ?, 'connected')`).run(slug);
}

describe('agent provider/model selection', () => {
  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('allows OpenAI API-key providers to use arbitrary model identifiers', () => {
    connectProvider('openai');

    expect(defaultAgentModelForProvider('openai')).toBe('openai/gpt-5.5');
    expect(validateAgentProviderSelection(1, 'openai', 'openai/gpt-5.5')).toBeNull();
    expect(validateAgentProviderSelection(1, 'openai', 'openai/custom-provider-preview')).toBeNull();
  });

  it('keeps OpenAI Codex provider validation separate from connected OpenAI API keys', () => {
    connectProvider('openai');

    expect(validateAgentProviderSelection(1, 'openai-codex', 'openai/gpt-5.5'))
      .toBe("preferred_provider 'openai-codex' is not currently connected");
  });

  it('keeps provider validation but does not catalog-gate Google models', () => {
    connectProvider('google');

    expect(defaultAgentModelForProvider('google')).toBe('google/gemini-2.5-pro');
    expect(validateAgentProviderSelection(1, 'google', 'google/gemini-2.5-flash')).toBeNull();
    expect(validateAgentProviderSelection(1, 'google', 'google/gemini-experimental-custom')).toBeNull();
  });

  it('accepts OpenRouter as a canonical provider slug with catalog-backed defaults', () => {
    connectProvider('openrouter');

    expect(defaultAgentModelForProvider('openrouter')).toBe('openrouter/auto');
    expect(validateAgentProviderSelection(1, 'openrouter', 'openrouter/auto')).toBeNull();
    expect(validateAgentProviderSelection(1, 'OpenRouter', 'openrouter/auto'))
      .toBe('preferred_provider must be one of: anthropic, openai, openai-codex, google, openrouter, ollama, mlx-studio, minimax');
  });

  it('allows freeform local and dynamic provider model identifiers', () => {
    connectProvider('ollama');
    connectProvider('minimax');

    expect(validateAgentProviderSelection(1, 'ollama', 'llama3.2:latest')).toBeNull();
    expect(validateAgentProviderSelection(1, 'minimax', 'MiniMax-M2.7')).toBeNull();
    expect(validateAgentProviderSelection(1, 'minimax', 'MiniMax-custom-preview')).toBeNull();
  });
});
