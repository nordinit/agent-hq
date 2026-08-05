import { mapRuntimeExecutionRow } from './runtimeView';

describe('mapRuntimeExecutionRow', () => {
  it('maps migration 18 columns and redacts nested sensitive metadata', () => {
    const result = mapRuntimeExecutionRow({
      id: 55,
      instance_id: 7,
      runtime_type: 'codex',
      driver: 'codex',
      backend: 'local-process',
      execution_target_id: 'local-api-process',
      state: 'running',
      boundary_version: 1,
      boundary_fingerprint: 'boundary-sha',
      boundary_json: JSON.stringify({ auth: { token: 'do-not-return', provider: 'openai-codex' } }),
      sanitized_launch_spec: JSON.stringify({ command: 'codex', envKeys: ['PATH'] }),
      opaque_handle: JSON.stringify({ kind: 'local-process', pid: 123 }),
      capability_snapshot: JSON.stringify(['inspect', 'signals', 'resume']),
      terminal_error: 'ANTHROPIC_API_KEY=operator-secret',
    }, { instanceId: 7, runtimeType: 'codex', state: 'starting' });

    expect(result).toMatchObject({
      id: 55,
      driver_type: 'codex',
      backend_type: 'local-process',
      execution_target_id: 'local-api-process',
      checkpoint_fingerprint: 'boundary-sha',
      capabilities: ['inspect', 'signals', 'resume'],
      handle: { kind: 'local-process', pid: 123 },
      launch_spec: { command: 'codex', envKeys: ['PATH'] },
      error: 'ANTHROPIC_API_KEY=[REDACTED]',
    });
    expect(result.boundary).toEqual({
      auth: { token: '[redacted]', provider: 'openai-codex' },
    });
    expect(JSON.stringify(result)).not.toContain('operator-secret');
  });
});
