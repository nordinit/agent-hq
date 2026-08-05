import { jest } from '@jest/globals';

const mockGet = jest.fn();

// Adapter shape — db.get(sql, ...) — not better-sqlite3's prepare(sql).get(). mockGet stays
// the source of truth for the row; only the calling convention changed.
jest.mock('../../db/client', () => ({
  getDb: () => ({
    get: async () => mockGet(),
    all: async () => [],
    value: async () => mockGet(),
    run: async () => ({ changes: 0, lastInsertId: null }),
    exec: async () => undefined,
  }),
}));

import { RemoteTranscriptProvider, resolveTranscriptProviderByAgent } from './transcriptProvider';

describe('Hermes transcript provider mapping', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('uses the chat-message-backed remote transcript provider for Hermes agents', async () => {
    mockGet.mockReturnValue({
      id: 41,
      name: 'Hermes Agent',
      runtime_type: 'hermes',
      runtime_config: null,
      session_key: 'agent:hermes:main',
      hooks_url: null,
      openclaw_agent_id: null,
    });

    const provider = await resolveTranscriptProviderByAgent(41);
    expect(provider).toBeInstanceOf(RemoteTranscriptProvider);
    expect(provider.getTranscriptSource()).toBe('remote-hermes');
  });

  it('uses the chat-message-backed provider for streamed Codex events', async () => {
    mockGet.mockReturnValue({
      id: 42,
      name: 'Codex Agent',
      runtime_type: 'codex',
      runtime_config: null,
      session_key: 'agent:codex:main',
      hooks_url: null,
      openclaw_agent_id: null,
    });

    const provider = await resolveTranscriptProviderByAgent(42);
    expect(provider).toBeInstanceOf(RemoteTranscriptProvider);
    expect(provider.getTranscriptSource()).toBe('remote-codex');
  });
});
