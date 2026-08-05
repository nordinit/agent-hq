import { resolveInstanceAbortTransport } from './stopInstanceExecution';

describe('resolveInstanceAbortTransport', () => {
  it.each([null, undefined, '', 'openclaw'])(
    'routes the default runtime %p through OpenClaw',
    (runtimeType) => {
      expect(resolveInstanceAbortTransport(runtimeType)).toBe('openclaw-gateway');
    },
  );

  it.each(['claude-code', 'hermes', 'webhook', 'veri', 'future-managed-runtime'])(
    'routes explicit runtime %p through its AgentRuntime.abort implementation',
    (runtimeType) => {
      expect(resolveInstanceAbortTransport(runtimeType)).toBe('runtime');
    },
  );
});
