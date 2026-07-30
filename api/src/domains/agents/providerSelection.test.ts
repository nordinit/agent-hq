import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb, getDb } from '../../db/client';
import {
  defaultAgentModelForProvider,
  validateAgentProviderSelection,
} from './providerSelection';

let tempDir: string;

async function resetDb(): Promise<void> {
  closeDb();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-selection-'));
  process.env.AGENT_HQ_DB_PATH = path.join(tempDir, 'agent-hq-test.db');
  const db = getDb();
  await db.exec(`
    CREATE TABLE provider_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      slug TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
}

async function connectProvider(slug: string): Promise<void> {
  await getDb().run(`INSERT INTO provider_config (tenant_id, slug, status) VALUES (1, ?, 'connected')`, slug);
}

describe('agent provider/model selection', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterEach(() => {
    closeDb();
    delete process.env.AGENT_HQ_DB_PATH;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('allows OpenAI API-key providers to use arbitrary model identifiers', async () => {
    await connectProvider('openai');

    expect(defaultAgentModelForProvider('openai')).toBe('openai/gpt-5.5');
    expect(await validateAgentProviderSelection(1, 'openai', 'openai/gpt-5.5')).toBeNull();
    expect(await validateAgentProviderSelection(1, 'openai', 'openai/custom-provider-preview')).toBeNull();
  });

  it('keeps OpenAI Codex provider validation separate from connected OpenAI API keys', async () => {
    await connectProvider('openai');

    expect(await validateAgentProviderSelection(1, 'openai-codex', 'openai/gpt-5.5'))
      .toBe("preferred_provider 'openai-codex' is not currently connected");
  });

  it('keeps provider validation but does not catalog-gate Google models', async () => {
    await connectProvider('google');

    expect(defaultAgentModelForProvider('google')).toBe('google/gemini-2.5-pro');
    expect(await validateAgentProviderSelection(1, 'google', 'google/gemini-2.5-flash')).toBeNull();
    expect(await validateAgentProviderSelection(1, 'google', 'google/gemini-experimental-custom')).toBeNull();
  });

  it('accepts OpenRouter as a canonical provider slug with catalog-backed defaults', async () => {
    await connectProvider('openrouter');

    expect(defaultAgentModelForProvider('openrouter')).toBe('openrouter/auto');
    expect(await validateAgentProviderSelection(1, 'openrouter', 'openrouter/auto')).toBeNull();
    expect(await validateAgentProviderSelection(1, 'OpenRouter', 'openrouter/auto'))
      .toBe('preferred_provider must be one of: anthropic, openai, openai-codex, google, openrouter, ollama, mlx-studio, minimax');
  });

  it('allows freeform local and dynamic provider model identifiers', async () => {
    await connectProvider('ollama');
    await connectProvider('minimax');

    expect(await validateAgentProviderSelection(1, 'ollama', 'llama3.2:latest')).toBeNull();
    expect(await validateAgentProviderSelection(1, 'minimax', 'MiniMax-M2.7')).toBeNull();
    expect(await validateAgentProviderSelection(1, 'minimax', 'MiniMax-custom-preview')).toBeNull();
  });
});
