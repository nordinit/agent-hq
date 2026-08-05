import { redactSensitiveRuntimeText, sanitizeRuntimeLaunchArguments } from './sensitiveText';

describe('redactSensitiveRuntimeText', () => {
  it('redacts structured, environment, bearer, key, and URL credential shapes', () => {
    const input = [
      '{"access_token":"oauth-value","safe":"visible"}',
      'ANTHROPIC_API_KEY=operator-secret',
      'Authorization: Bearer bearer-secret',
      'direct sk-ant-oat01-verysecretvalue',
      'mcp ahq_mcp_runtime-secret',
      'postgres://agent:database-password@db.internal/agent_hq',
      'https://service.test/run?api_key=query-secret&X-Amz-Signature=signed-secret&safe=visible',
    ].join('\n');

    const result = redactSensitiveRuntimeText(input);

    for (const secret of [
      'oauth-value',
      'operator-secret',
      'bearer-secret',
      'sk-ant-oat01-verysecretvalue',
      'ahq_mcp_runtime-secret',
      'database-password',
      'query-secret',
      'signed-secret',
    ]) {
      expect(result).not.toContain(secret);
    }
    expect(result).toContain('"safe":"visible"');
    expect(result).toContain('[REDACTED]');
  });

  it('handles a large unbroken stderr token without pathological backtracking', () => {
    const noise = 'x'.repeat(256 * 1024);
    expect(redactSensitiveRuntimeText(noise)).toBe(noise);
  });
});

describe('sanitizeRuntimeLaunchArguments', () => {
  it('redacts separate, inline, URL, and embedded credential values', () => {
    expect(sanitizeRuntimeLaunchArguments([
      'exec',
      '--api-key',
      'separate-secret',
      '--access-token=inline-secret',
      '--endpoint=https://service.test/run?token=query-secret&safe=visible',
      'postgres://agent:database-secret@db.internal/agent_hq',
      '--model',
      'safe-model',
    ])).toEqual([
      'exec',
      '--api-key',
      '[REDACTED]',
      '--access-token=[REDACTED]',
      '--endpoint=https://service.test/run?token=[REDACTED]&safe=visible',
      'postgres://agent:[REDACTED]@db.internal/agent_hq',
      '--model',
      'safe-model',
    ]);
  });
});
