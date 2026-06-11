import { describe, expect, it } from '@jest/globals';

function computeOverrideSessionKey(params: {
  deepLinkAgentId: string | null;
  overrideSessionKeyParam: string | null;
  overrideResolvedKey: string | null;
}) {
  const deepLinkAgentIdNum = params.deepLinkAgentId ? Number(params.deepLinkAgentId) : null;
  const hasDeepLinkAgent = Number.isFinite(deepLinkAgentIdNum);
  return hasDeepLinkAgent ? null : (params.overrideSessionKeyParam ?? params.overrideResolvedKey);
}

describe('chat deep-link selection', () => {
  it('does not switch to override-session mode when agentId accompanies instanceId', () => {
    const override = computeOverrideSessionKey({
      deepLinkAgentId: '12',
      overrideSessionKeyParam: null,
      overrideResolvedKey: 'run:123',
    });

    expect(override).toBeNull();
  });

  it('still supports instance-only deep links by using the resolved session key', () => {
    const override = computeOverrideSessionKey({
      deepLinkAgentId: null,
      overrideSessionKeyParam: null,
      overrideResolvedKey: 'run:123',
    });

    expect(override).toBe('run:123');
  });

  it('ignores invalid agentId values and falls back to the resolved session key', () => {
    const override = computeOverrideSessionKey({
      deepLinkAgentId: 'not-a-number',
      overrideSessionKeyParam: null,
      overrideResolvedKey: 'run:123',
    });

    expect(override).toBe('run:123');
  });
});
