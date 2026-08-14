import {
  OPENCLAW_LEGACY_HOOK_PREFIX,
  buildGatewayRunSessionKey,
  buildRunSessionKey,
  normalizeAgentRoleLabel,
  parseAgentSessionKey,
  parseRunSessionKey,
  toGatewaySessionKey,
} from './sessionKeys';

describe('sessionKeys', () => {
  describe('normalizeAgentRoleLabel', () => {
    it('keeps the role the operator entered', () => {
      // Each of these was previously rewritten to a canonical label: "sales" and
      // "pm" matched word patterns, and the long one was clipped to its first
      // clause and title-cased.
      expect(normalizeAgentRoleLabel('Sales Manager')).toBe('Sales Manager');
      expect(normalizeAgentRoleLabel('PM')).toBe('PM');
      expect(normalizeAgentRoleLabel('QA')).toBe('QA');
      expect(normalizeAgentRoleLabel('Head of Sales Operations — EMEA, contract'))
        .toBe('Head of Sales Operations — EMEA, contract');
    });

    it('preserves the operator’s own casing', () => {
      expect(normalizeAgentRoleLabel('iOS engineer')).toBe('iOS engineer');
    });

    it('trims surrounding and repeated whitespace', () => {
      expect(normalizeAgentRoleLabel('  Sales   Manager  ')).toBe('Sales Manager');
    });

    it('falls back only when nothing was entered', () => {
      expect(normalizeAgentRoleLabel('')).toBe('Agent');
      expect(normalizeAgentRoleLabel('   ')).toBe('Agent');
      expect(normalizeAgentRoleLabel(null)).toBe('Agent');
      expect(normalizeAgentRoleLabel(undefined, 'Unassigned')).toBe('Unassigned');
    });
  });

  describe('buildRunSessionKey', () => {
    it('uses the canonical run format for new dispatched sessions', () => {
      expect(buildRunSessionKey(1928)).toBe('run:1928');
    });

    it('can include a durable run id for restore-safe dispatched sessions', () => {
      expect(buildRunSessionKey(1928, '9d0f-run')).toBe('run:1928:9d0f-run');
    });
  });

  describe('parseRunSessionKey', () => {
    it('parses canonical short run keys', () => {
      expect(parseRunSessionKey('run:1928')).toEqual({
        shortKey: 'run:1928',
        instanceId: 1928,
        durableRunId: null,
        format: 'canonical',
      });
    });

    it('parses durable canonical short run keys', () => {
      expect(parseRunSessionKey('run:1928:9d0f-run')).toEqual({
        shortKey: 'run:1928:9d0f-run',
        instanceId: 1928,
        durableRunId: '9d0f-run',
        format: 'canonical',
      });
    });

    it('parses legacy short run keys', () => {
      expect(parseRunSessionKey(`${OPENCLAW_LEGACY_HOOK_PREFIX}1928`)).toEqual({
        shortKey: `${OPENCLAW_LEGACY_HOOK_PREFIX}1928`,
        instanceId: 1928,
        durableRunId: null,
        format: 'legacy',
      });
    });

    it('parses canonical agent-prefixed run keys', () => {
      expect(parseRunSessionKey('agent:agent-hq:cinder:backend:run:1928')).toEqual({
        shortKey: 'run:1928',
        instanceId: 1928,
        durableRunId: null,
        format: 'canonical',
      });
    });

    it('parses legacy agent-prefixed run keys', () => {
      expect(parseRunSessionKey('agent:cinder-backend:hook:atlas:jobrun:1928')).toEqual({
        shortKey: `${OPENCLAW_LEGACY_HOOK_PREFIX}1928`,
        instanceId: 1928,
        durableRunId: null,
        format: 'legacy',
      });
    });
  });

  describe('parseAgentSessionKey', () => {
    it('parses canonical run session keys', () => {
      expect(parseAgentSessionKey('agent:agent-hq:cinder:backend:run:1928')).toEqual({
        raw: 'agent:agent-hq:cinder:backend:run:1928',
        format: 'canonical',
        scope: 'run',
        runtimeSlug: null,
        projectSlug: 'agent-hq',
        agentNameSlug: 'cinder',
        roleSlug: 'backend',
        channel: null,
        uniqueId: '1928',
        runSessionKey: 'run:1928',
        instanceId: 1928,
        durableRunId: null,
      });
    });

    it('parses durable canonical run session keys', () => {
      expect(parseAgentSessionKey('agent:cinder-backend:run:1928:9d0f-run')).toMatchObject({
        raw: 'agent:cinder-backend:run:1928:9d0f-run',
        format: 'legacy',
        scope: 'run',
        runtimeSlug: 'cinder-backend',
        uniqueId: '9d0f-run',
        runSessionKey: 'run:1928:9d0f-run',
        instanceId: 1928,
        durableRunId: '9d0f-run',
      });
    });

    it('parses legacy run session keys', () => {
      expect(parseAgentSessionKey('agent:cinder-backend:hook:atlas:jobrun:1928')).toEqual({
        raw: 'agent:cinder-backend:hook:atlas:jobrun:1928',
        format: 'legacy',
        scope: 'run',
        runtimeSlug: 'cinder-backend',
        projectSlug: null,
        agentNameSlug: 'cinder-backend',
        roleSlug: null,
        channel: null,
        uniqueId: '1928',
        runSessionKey: `${OPENCLAW_LEGACY_HOOK_PREFIX}1928`,
        instanceId: 1928,
        durableRunId: null,
      });
    });
  });

  describe('buildGatewayRunSessionKey', () => {
    const canonicalAgent = {
      session_key: 'agent:agent-hq:cinder:backend:main',
      openclaw_agent_id: 'cinder',
      name: 'Cinder',
    };

    const legacyAgent = {
      session_key: 'agent:cinder-backend:main',
      openclaw_agent_id: null,
      name: 'Cinder Backend',
    };

    it('builds canonical gateway run keys for canonical short keys', () => {
      expect(buildGatewayRunSessionKey(canonicalAgent, 'run:1928')).toBe('agent:cinder:run:1928');
    });

    it('builds restore-safe gateway run keys when a durable run id is present', () => {
      expect(buildGatewayRunSessionKey(canonicalAgent, 'run:1928:9d0f-run')).toBe('agent:cinder:run:1928:9d0f-run');
    });

    it('preserves legacy gateway run keys for legacy short keys', () => {
      expect(buildGatewayRunSessionKey(legacyAgent, `${OPENCLAW_LEGACY_HOOK_PREFIX}1928`)).toBe(
        'agent:cinder-backend:hook:atlas:jobrun:1928',
      );
    });
  });

  describe('toGatewaySessionKey', () => {
    it('keeps canonical short run keys short until reconstructed by instance-aware paths', () => {
      expect(toGatewaySessionKey('run:1928', { session_key: 'agent:agent-hq:cinder:backend:main' })).toBe('run:1928');
    });

    it('reconstructs canonical agent-prefixed run keys from canonical parsed keys', () => {
      expect(
        toGatewaySessionKey('agent:agent-hq:cinder:backend:run:1928', {
          session_key: 'agent:agent-hq:cinder:backend:main',
          openclaw_agent_id: 'cinder',
        }),
      ).toBe('agent:cinder:run:1928');
    });
  });
});
