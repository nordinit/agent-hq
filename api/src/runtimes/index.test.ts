import {
  CodexRuntime,
  normalizeCodexRuntimeConfig,
  resolveRuntime,
  validateCodexRuntimeConfig,
} from './index';

describe('runtime registry', () => {
  it('constructs CodexRuntime for object and serialized configs', () => {
    expect(resolveRuntime({
      runtime_type: 'codex',
      runtime_config: { sandboxMode: 'read-only' },
    })).toBeInstanceOf(CodexRuntime);
    expect(resolveRuntime({
      runtime_type: 'codex',
      runtime_config: JSON.stringify({ reasoningEffort: 'high' }),
    })).toBeInstanceOf(CodexRuntime);
  });

  it('exports the Codex config contract from the registry boundary', () => {
    expect(validateCodexRuntimeConfig({ sandboxMode: 'workspace-write' })).toBeNull();
    expect(normalizeCodexRuntimeConfig({}).approvalPolicy).toBe('never');
  });

  it('fails closed for an unknown runtime instead of silently dispatching OpenClaw', () => {
    expect(() => resolveRuntime({ runtime_type: 'codxe' })).toThrow(
      'Unsupported agent runtime type: codxe',
    );
  });
});
