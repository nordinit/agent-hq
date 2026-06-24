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

  it('allows OpenAI API-key providers to use OpenAI agent models', () => {
    connectProvider('openai');

    expect(defaultAgentModelForProvider('openai')).toBe('openai/gpt-5.5');
    expect(validateAgentProviderSelection(1, 'openai', 'openai/gpt-5.5')).toBeNull();
    expect(validateAgentProviderSelection(1, 'openai', 'anthropic/claude-sonnet-4-6'))
      .toBe("model 'anthropic/claude-sonnet-4-6' does not belong to preferred_provider 'openai'");
  });

  it('keeps OpenAI Codex provider validation separate from connected OpenAI API keys', () => {
    connectProvider('openai');

    expect(validateAgentProviderSelection(1, 'openai-codex', 'openai/gpt-5.5'))
      .toBe("preferred_provider 'openai-codex' is not currently connected");
  });

  it('provides a catalog-backed Google model path', () => {
    connectProvider('google');

    expect(defaultAgentModelForProvider('google')).toBe('google/gemini-2.5-pro');
    expect(validateAgentProviderSelection(1, 'google', 'google/gemini-2.5-flash')).toBeNull();
    expect(validateAgentProviderSelection(1, 'google', 'openai/gpt-5.5'))
      .toBe("model 'openai/gpt-5.5' does not belong to preferred_provider 'google'");
  });

  it('allows freeform local model providers and constrains dynamic catalogs', () => {
    connectProvider('ollama');
    connectProvider('minimax');

    expect(validateAgentProviderSelection(1, 'ollama', 'llama3.2:latest')).toBeNull();
    expect(validateAgentProviderSelection(1, 'minimax', 'MiniMax-M2.7')).toBeNull();
    expect(validateAgentProviderSelection(1, 'minimax', 'openai/gpt-5.5'))
      .toBe("model 'openai/gpt-5.5' does not belong to preferred_provider 'minimax'");
  });
});
