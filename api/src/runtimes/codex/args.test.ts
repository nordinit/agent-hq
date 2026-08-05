import { buildCodexArgs, normalizeCodexModel } from './args';
import { normalizeCodexRuntimeConfig } from './config';
import {
  CODEX_DISABLED_AMBIENT_FEATURES,
  CODEX_FAST_MODE_FEATURE,
} from './policy';

const disabledFeatureArgs = CODEX_DISABLED_AMBIENT_FEATURES.flatMap((feature) => [
  '--disable',
  feature,
]);

describe('buildCodexArgs', () => {
  it('builds deterministic fresh exec argv and strips Agent HQ model namespace', () => {
    const args = buildCodexArgs({
      config: normalizeCodexRuntimeConfig({
        reasoningEffort: 'high',
        skipGitRepoCheck: true,
      }),
      model: 'openai/gpt-5.5',
    });
    expect(args).toEqual([
      'exec',
      '--json',
      '--strict-config',
      '--ignore-rules',
      ...disabledFeatureArgs,
      '--disable',
      CODEX_FAST_MODE_FEATURE,
      '--color',
      'never',
      '-c',
      'approval_policy="never"',
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'service_tier="default"',
      '-c',
      'allow_login_shell=false',
      '-c',
      'shell_environment_policy.inherit="core"',
      '-c',
      'shell_environment_policy.ignore_default_excludes=false',
      '-c',
      'model_reasoning_effort="high"',
      '--model',
      'gpt-5.5',
      '--skip-git-repo-check',
      '-',
    ]);
  });

  it('uses codex exec resume with JSONL and positional session/prompt last', () => {
    const args = buildCodexArgs({
      config: normalizeCodexRuntimeConfig({
        resumeSessionId: '019c1234-1234-7000-8000-123456789abc',
        sandboxMode: 'read-only',
        approvalPolicy: 'on-request',
        model: 'openai/gpt-5.4',
      }),
      configProfile: 'agent-hq-runtime-7-resume',
    });
    expect(args).toEqual([
      'exec',
      '--profile',
      'agent-hq-runtime-7-resume',
      'resume',
      '--json',
      '--strict-config',
      '--ignore-rules',
      ...disabledFeatureArgs,
      '--disable',
      CODEX_FAST_MODE_FEATURE,
      '-c',
      'approval_policy="on-request"',
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'service_tier="default"',
      '-c',
      'allow_login_shell=false',
      '-c',
      'shell_environment_policy.inherit="core"',
      '-c',
      'shell_environment_policy.ignore_default_excludes=false',
      '--model',
      'gpt-5.4',
      '019c1234-1234-7000-8000-123456789abc',
      '-',
    ]);
  });

  it('selects an internal v2 profile without changing the credential home', () => {
    const args = buildCodexArgs({
      config: normalizeCodexRuntimeConfig({}),
      configProfile: 'agent-hq-runtime-7-deadbeef',
    });
    expect(args.slice(0, 6)).toEqual([
      'exec',
      '--profile',
      'agent-hq-runtime-7-deadbeef',
      '--json',
      '--strict-config',
      '--ignore-rules',
    ]);
    expect(args).not.toContain('--ignore-user-config');
    for (const feature of CODEX_DISABLED_AMBIENT_FEATURES) {
      expect(args).toEqual(expect.arrayContaining(['--disable', feature]));
    }
    expect(args).not.toContain('--enable');
    expect(args).toEqual(expect.arrayContaining(['-c', 'service_tier="default"']));
    expect(args).not.toContain('--model');
    expect(args.some((value) => value.startsWith('model_reasoning_effort='))).toBe(false);
  });

  it('pins fast execution as both an enabled feature and explicit service tier', () => {
    const args = buildCodexArgs({
      config: normalizeCodexRuntimeConfig({}),
      fastMode: true,
    });
    expect(args).toEqual(expect.arrayContaining([
      '--enable',
      CODEX_FAST_MODE_FEATURE,
      '-c',
      'service_tier="fast"',
    ]));
    const disabled = args.flatMap((value, index) => (
      args[index - 1] === '--disable' ? [value] : []
    ));
    expect(disabled).not.toContain(CODEX_FAST_MODE_FEATURE);
  });

  it('normalizes only the canonical OpenAI provider prefix', () => {
    expect(normalizeCodexModel(' openai/gpt-5.5 ')).toBe('gpt-5.5');
    expect(normalizeCodexModel('gpt-5.5')).toBe('gpt-5.5');
    expect(normalizeCodexModel('openai-codex/gpt-5.5')).toBe('openai-codex/gpt-5.5');
  });
});
