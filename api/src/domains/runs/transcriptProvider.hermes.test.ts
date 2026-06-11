import { jest } from '@jest/globals';

const mockGet = jest.fn();

jest.mock('../../db/client', () => ({
  getDb: () => ({
    prepare: () => ({ get: () => mockGet() }),
  }),
}));

import { RemoteTranscriptProvider, resolveTranscriptProviderByAgent } from './transcriptProvider';

describe('Hermes transcript provider mapping', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('uses the chat-message-backed remote transcript provider for Hermes agents', () => {
    mockGet.mockReturnValue({
      id: 41,
      name: 'Hermes Agent',
      runtime_type: 'hermes',
      runtime_config: null,
      session_key: 'agent:hermes:main',
      hooks_url: null,
      openclaw_agent_id: null,
    });

    const provider = resolveTranscriptProviderByAgent(41);
    expect(provider).toBeInstanceOf(RemoteTranscriptProvider);
    expect(provider.getTranscriptSource()).toBe('remote-hermes');
  });
});
