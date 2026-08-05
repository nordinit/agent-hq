import {
  SUPPORTED_AGENT_RUNTIME_TYPES,
  validateAgentRuntimeConfig,
} from './runtimeConfig';

describe('agent runtime config', () => {
  it('accepts the Codex runtime type and its safe defaults', () => {
    expect(SUPPORTED_AGENT_RUNTIME_TYPES).toContain('codex');
    expect(validateAgentRuntimeConfig('codex', {
      codexBin: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'never',
    })).toBeNull();
  });

  it('keeps danger-full-access behind an explicit safety latch', () => {
    expect(validateAgentRuntimeConfig('codex', {
      sandboxMode: 'danger-full-access',
    })).toContain('allowDangerousFullAccess');
    expect(validateAgentRuntimeConfig('codex', {
      sandboxMode: 'danger-full-access',
      allowDangerousFullAccess: true,
    })).toBeNull();
  });
});
