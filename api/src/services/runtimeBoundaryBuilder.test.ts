import {
  fingerprintRuntimeBoundaryV1,
  validateRuntimeBoundaryV1,
  type RuntimeBoundaryV1,
} from '../runtimes/runtimeBoundary';
import { buildClaudeArgs } from '../runtimes/claudeCode/args';
import { normalizeClaudeCodeRuntimeConfig } from '../runtimes/claudeCode/config';
import { buildCodexArgs } from '../runtimes/codex/args';
import { normalizeCodexRuntimeConfig } from '../runtimes/codex/config';
import {
  CODEX_BUILT_IN_TOOLS,
  CODEX_DISABLED_AMBIENT_FEATURES,
  CODEX_FAST_MODE_FEATURE,
  CODEX_RUNTIME_POLICY_REVISION,
} from '../runtimes/codex/policy';
import {
  buildRuntimeBoundaryV1,
  defaultRuntimeExecutionTarget,
  runtimeBoundaryDigest,
  sanitizeRuntimeConfigForRevision,
  type BuildRuntimeBoundaryV1Input,
} from './runtimeBoundaryBuilder';

function input(overrides: Partial<BuildRuntimeBoundaryV1Input> = {}): BuildRuntimeBoundaryV1Input {
  return {
    tenantId: 1,
    projectId: 86,
    workflowId: 111,
    taskId: 906,
    instanceId: 4711,
    durableRunId: 'durable-4711',
    agentId: 14,
    agentSlug: 'cinder-backend',
    runtimeType: 'claude-code',
    executableFingerprint: 'sha256:test-claude-executable',
    runtimeConfig: {
      model: 'claude-sonnet',
      effort: 'xhigh',
      maxTurns: 30,
      allowedTools: ['Bash', 'Read'],
    },
    model: 'claude-opus',
    reasoning: 'high',
    fastMode: false,
    timeoutSeconds: 900,
    prompt: 'Implement the runtime boundary.',
    workspaceRoot: '/work/agent',
    activeRepoRoot: '/work/agent/task-906',
    repoAccessMode: 'worktree',
    repoSource: 'worktree:/repo',
    branch: 'agent/task-906',
    provider: 'anthropic',
    providerConnectionId: 9,
    callbackIdentity: 'run:4711:durable-4711',
    requestedBy: 'dispatcher',
    ...overrides,
  };
}

describe('buildRuntimeBoundaryV1', () => {
  it('builds a valid, complete local runtime contract', () => {
    const boundary = buildRuntimeBoundaryV1(input());

    expect(validateRuntimeBoundaryV1(boundary)).toEqual({ ok: true, issues: [] });
    expect(boundary.identity).toMatchObject({
      tenantId: 1,
      projectId: 86,
      workflowId: 111,
      taskId: 906,
      instanceId: 4711,
      agentId: 14,
    });
    expect(boundary.runtime).toMatchObject({
      type: 'claude-code',
      driverVersion: 'claude-code-driver/1',
      executableFingerprint: 'sha256:test-claude-executable',
      model: 'claude-opus',
      reasoning: 'high',
      turnLimit: 30,
    });
    expect(boundary.tools.builtIn).toEqual(['Bash', 'Read']);
    expect(boundary.executionTarget).toEqual(defaultRuntimeExecutionTarget('claude-code'));
    expect(boundary.executionTarget.capabilities).not.toContain('resume');
    expect(boundary.auth).toEqual({
      provider: 'anthropic',
      providerConnectionId: 9,
      credentialRefs: [{ kind: 'provider-connection', reference: 'provider-connection:9' }],
    });
    expect(boundary.prompt.bundleFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(boundary.workspace.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(defaultRuntimeExecutionTarget('codex')).toMatchObject({
      id: 'local:codex',
      kind: 'local-process',
      capabilities: expect.arrayContaining(['inspect', 'resume', 'signals', 'workspace-write']),
    });
  });

  it('binds the selected executable identity into the resume fingerprint', () => {
    const boundary = buildRuntimeBoundaryV1(input());
    const changed = buildRuntimeBoundaryV1(input({
      executableFingerprint: 'sha256:replacement-claude-executable',
    }));

    expect(fingerprintRuntimeBoundaryV1(changed))
      .not.toBe(fingerprintRuntimeBoundaryV1(boundary));
  });

  it('snapshots Claude built-ins from the normalized driver policy', () => {
    const omittedPolicyConfig = { model: 'claude-sonnet' };
    const omitted = buildRuntimeBoundaryV1(input({ runtimeConfig: omittedPolicyConfig }));
    const explicitEmpty = buildRuntimeBoundaryV1(input({
      runtimeConfig: { ...omittedPolicyConfig, allowedTools: [] },
    }));
    const normalized = normalizeClaudeCodeRuntimeConfig(omittedPolicyConfig);
    const argv = buildClaudeArgs({ config: normalized, sessionId: 'boundary-policy-test' });
    const argvBuiltIns = argv[argv.indexOf('--tools') + 1]
      .split(',')
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));

    expect(omitted.tools.builtIn).toEqual([
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'WebFetch',
      'WebSearch',
      'Write',
    ]);
    expect(omitted.tools.builtIn).toEqual(argvBuiltIns);
    expect(explicitEmpty.tools.builtIn).toEqual([]);
    expect(fingerprintRuntimeBoundaryV1(explicitEmpty))
      .not.toBe(fingerprintRuntimeBoundaryV1(omitted));
  });

  it('snapshots Codex built-ins and ambient feature policy from shared driver constants', () => {
    const runtimeConfig = { model: 'openai/gpt-5.5' };
    const boundary = buildRuntimeBoundaryV1(input({
      runtimeType: 'codex',
      runtimeConfig,
      provider: 'openai-codex',
    }));
    const argv = buildCodexArgs({ config: normalizeCodexRuntimeConfig(runtimeConfig) });
    const disabledFeatures = argv.flatMap((value, index) => (
      argv[index - 1] === '--disable' ? [value] : []
    ));

    expect(boundary.tools.builtIn).toEqual([...CODEX_BUILT_IN_TOOLS].sort());
    expect(disabledFeatures).toEqual([
      ...CODEX_DISABLED_AMBIENT_FEATURES,
      CODEX_FAST_MODE_FEATURE,
    ]);
    expect(boundary.runtime.fastMode).toBe(false);
    expect(boundary.runtime.configRevision).toBe(runtimeBoundaryDigest('runtime-config-v1', {
      config: sanitizeRuntimeConfigForRevision(runtimeConfig),
      policyRevision: CODEX_RUNTIME_POLICY_REVISION,
      builtIn: [...CODEX_BUILT_IN_TOOLS].sort(),
      disabledFeatures: [...CODEX_DISABLED_AMBIENT_FEATURES, CODEX_FAST_MODE_FEATURE],
      fastServiceTier: 'default',
    }));

    const changedPolicy = JSON.parse(JSON.stringify(boundary)) as RuntimeBoundaryV1;
    changedPolicy.tools.builtIn.push('web_search');
    expect(fingerprintRuntimeBoundaryV1(changedPolicy))
      .not.toBe(fingerprintRuntimeBoundaryV1(boundary));
  });

  it('records hardened standard mode when Codex model and routing inputs are omitted', () => {
    const boundary = buildRuntimeBoundaryV1(input({
      runtimeType: 'codex',
      runtimeConfig: {},
      model: null,
      reasoning: null,
      fastMode: null,
      provider: 'openai-codex',
    }));
    const argv = buildCodexArgs({ config: normalizeCodexRuntimeConfig({}) });

    expect(boundary.runtime).toMatchObject({
      model: null,
      reasoning: null,
      fastMode: false,
    });
    expect(argv).toEqual(expect.arrayContaining([
      '--disable', CODEX_FAST_MODE_FEATURE,
      '-c', 'service_tier="default"',
    ]));
    expect(argv).not.toContain('--model');
    expect(argv.some((value) => value.startsWith('model_reasoning_effort='))).toBe(false);
  });

  it('never persists prompt, environment, credential, or argument secret values', () => {
    const first = buildRuntimeBoundaryV1(input({
      prompt: 'private prompt marker 39af',
      runtimeConfig: {
        maxTurns: 12,
        apiKey: 'sk-private-first',
        env: { FEATURE_FLAG: 'enabled', ACCESS_TOKEN: 'token-first' },
        extraArgs: ['--api-key', 'argument-first', '--safe-mode'],
      },
    }));
    const rotated = buildRuntimeBoundaryV1(input({
      prompt: 'private prompt marker 39af',
      runtimeConfig: {
        maxTurns: 12,
        apiKey: 'sk-private-second',
        env: { FEATURE_FLAG: 'disabled', ACCESS_TOKEN: 'token-second' },
        extraArgs: ['--api-key', 'argument-second', '--safe-mode'],
      },
    }));
    const changedPolicy = buildRuntimeBoundaryV1(input({
      prompt: 'private prompt marker 39af',
      runtimeConfig: {
        maxTurns: 13,
        apiKey: 'sk-private-second',
        env: { FEATURE_FLAG: 'disabled', ACCESS_TOKEN: 'token-second' },
        extraArgs: ['--api-key', 'argument-second', '--safe-mode'],
      },
    }));

    const persisted = JSON.stringify(first);
    for (const secret of ['private prompt marker 39af', 'sk-private-first', 'enabled', 'token-first', 'argument-first']) {
      expect(persisted).not.toContain(secret);
    }
    expect(rotated.runtime.configRevision).toBe(first.runtime.configRevision);
    expect(changedPolicy.runtime.configRevision).not.toBe(first.runtime.configRevision);
  });

  it('removes URL credentials from the auditable repository source', () => {
    const boundary = buildRuntimeBoundaryV1(input({
      repoAccessMode: 'clone',
      repoSource: 'clone:https://git-user:git-password@example.test/org/repo.git?access_token=query-secret&X-Amz-Signature=signed-secret&ref=main#access_token=fragment-secret',
    }));

    expect(boundary.workspace.repoSource).toBe(
      'clone:https://example.test/org/repo.git?access_token=%5Bredacted%5D&X-Amz-Signature=%5Bredacted%5D&ref=main',
    );
    expect(JSON.stringify(boundary)).not.toContain('git-password');
    expect(JSON.stringify(boundary)).not.toContain('query-secret');
    expect(JSON.stringify(boundary)).not.toContain('signed-secret');
    expect(JSON.stringify(boundary)).not.toContain('fragment-secret');
  });

  it('accepts an explicit managed target without requiring a local path', () => {
    const boundary = buildRuntimeBoundaryV1(input({
      runtimeType: 'claude-code-managed',
      workspaceRoot: null,
      activeRepoRoot: null,
      repoAccessMode: null,
      executionTarget: {
        id: 'managed:claude:team-a',
        kind: 'managed',
        trustLevel: 'untrusted',
        capabilities: ['network', 'inspect', 'network'],
      },
    }));

    expect(boundary.executionTarget).toEqual({
      id: 'managed:claude:team-a',
      kind: 'managed',
      trustLevel: 'untrusted',
      capabilities: ['inspect', 'network'],
    });
    expect(boundary.workspace).toMatchObject({
      workspaceRoot: null,
      activeRepoRoot: 'remote://managed%3Aclaude%3Ateam-a',
      repoAccessMode: 'remote',
    });
  });

  it('projects only the secret-free execution target contract', () => {
    const boundary = buildRuntimeBoundaryV1(input({
      runtimeType: 'claude-code-managed',
      executionTarget: {
        id: 'managed:https://target-user:target-password@example.test/agents?access_token=target-token',
        kind: 'managed',
        trustLevel: 'untrusted',
        capabilities: ['network'],
        providerApiKey: 'target-api-key',
        providerMetadata: { authorization: 'Bearer target-secret' },
      } as BuildRuntimeBoundaryV1Input['executionTarget'] & Record<string, unknown>,
    }));

    expect(boundary.executionTarget).toEqual({
      id: 'managed:https://example.test/agents?access_token=%5Bredacted%5D',
      kind: 'managed',
      trustLevel: 'untrusted',
      capabilities: ['network'],
    });
    expect(JSON.stringify(boundary)).not.toContain('target-password');
    expect(JSON.stringify(boundary)).not.toContain('target-token');
    expect(JSON.stringify(boundary)).not.toContain('target-api-key');
    expect(JSON.stringify(boundary)).not.toContain('target-secret');
  });
});
