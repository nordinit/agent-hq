import {
  fingerprintRuntimeBoundaryV1,
  isRuntimeExecutionTransitionAllowed,
  validateRuntimeBoundaryV1,
  validateRuntimeCheckpointV1,
  type RuntimeBoundaryV1,
  type RuntimeCheckpointV1,
} from './runtimeBoundary';

function boundary(): RuntimeBoundaryV1 {
  return {
    version: 1,
    identity: {
      tenantId: 1,
      projectId: 86,
      workflowId: 111,
      taskId: 906,
      instanceId: 4711,
      durableRunId: 'f13001ae-e499-493f-9437-8b027990d20c',
      agentId: 14,
      agentSlug: 'cinder-backend',
    },
    runtime: {
      type: 'claude-code',
      driverVersion: 'claude-code-driver/1',
      executableFingerprint: 'sha256:test-claude-executable',
      configRevision: 'config:42',
      model: 'claude-sonnet-4-5',
      reasoning: 'high',
      fastMode: false,
      timeoutSeconds: 900,
      tokenBudget: null,
      turnLimit: 30,
    },
    workspace: {
      workspaceRoot: '/work/agent',
      activeRepoRoot: '/work/agent/task-4711',
      repoAccessMode: 'worktree',
      repoSource: 'worktree:/repo',
      branch: 'agent/task-906',
      commit: 'abc123',
      fingerprint: 'sha256:workspace',
    },
    prompt: { bundleFingerprint: 'sha256:prompt' },
    executionTarget: {
      id: 'local:api-host',
      kind: 'local-process',
      trustLevel: 'workspace',
      capabilities: ['signals', 'inspect', 'workspace-write'],
    },
    tools: {
      builtIn: ['Read', 'Bash'],
      mcpServers: [{
        name: 'agent-hq',
        configFingerprint: 'sha256:mcp',
        requiredToolNames: ['agent_hq_check_in', 'agent_hq_post_task_outcome'],
      }],
      requiredLifecycleTools: ['agent_hq_post_task_outcome', 'agent_hq_check_in'],
      skills: [{ name: 'agent-hq', revision: '12' }],
    },
    auth: {
      provider: 'anthropic',
      providerConnectionId: 9,
      credentialRefs: [{ kind: 'operator-profile', reference: 'claude-config:agent-14' }],
    },
    evidence: { required: true, requirements: ['commit', 'tests'] },
    callback: { identity: 'agent-hq-instance:4711' },
    priorCheckpoint: null,
    observability: {
      traceId: 'trace-1',
      correlationId: 'dispatch-4711',
      requestedBy: 'scheduler',
    },
  };
}

describe('RuntimeBoundaryV1', () => {
  it('validates a complete boundary', () => {
    expect(validateRuntimeBoundaryV1(boundary())).toEqual({ ok: true, issues: [] });
  });

  it('reports invalid identity, target and timeout paths together', () => {
    const invalid = boundary() as unknown as Record<string, any>;
    invalid.identity.instanceId = 0;
    invalid.runtime.timeoutSeconds = -1;
    invalid.executionTarget.kind = 'telepathy';

    const result = validateRuntimeBoundaryV1(invalid);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        'identity.instanceId',
        'runtime.timeoutSeconds',
        'executionTarget.kind',
      ]));
    }
  });

  it('fingerprints semantic sets deterministically and ignores recovery telemetry', () => {
    const first = boundary();
    const reordered = boundary();
    reordered.executionTarget.capabilities.reverse();
    reordered.tools.builtIn.reverse();
    reordered.tools.requiredLifecycleTools.reverse();
    reordered.observability.traceId = 'recovery-trace';
    reordered.priorCheckpoint = {
      executionId: 22,
      checkpointId: 90,
      sequence: 4,
      boundaryFingerprint: 'sha256:prior',
    };

    expect(fingerprintRuntimeBoundaryV1(reordered)).toBe(fingerprintRuntimeBoundaryV1(first));
  });

  it.each([
    ['executable fingerprint', (value: RuntimeBoundaryV1) => { value.runtime.executableFingerprint = 'sha256:other-executable'; }],
    ['workspace fingerprint', (value: RuntimeBoundaryV1) => { value.workspace.fingerprint = 'sha256:other'; }],
    ['model', (value: RuntimeBoundaryV1) => { value.runtime.model = 'claude-opus-4-1'; }],
    ['MCP config', (value: RuntimeBoundaryV1) => { value.tools.mcpServers[0].configFingerprint = 'sha256:other'; }],
    ['target', (value: RuntimeBoundaryV1) => { value.executionTarget.id = 'managed:remote'; }],
  ])('changes when the resume-critical %s changes', (_name, mutate) => {
    const first = boundary();
    const changed = boundary();
    mutate(changed);
    expect(fingerprintRuntimeBoundaryV1(changed)).not.toBe(fingerprintRuntimeBoundaryV1(first));
  });
});

describe('runtime execution state transitions', () => {
  it('allows idempotent and forward lifecycle transitions', () => {
    expect(isRuntimeExecutionTransitionAllowed('running', 'running')).toBe(true);
    expect(isRuntimeExecutionTransitionAllowed('running', 'interrupting')).toBe(true);
    expect(isRuntimeExecutionTransitionAllowed('interrupting', 'cancelled')).toBe(true);
  });

  it('does not reopen terminal states', () => {
    expect(isRuntimeExecutionTransitionAllowed('succeeded', 'running')).toBe(false);
    expect(isRuntimeExecutionTransitionAllowed('lost', 'preparing')).toBe(false);
  });
});

describe('RuntimeCheckpointV1', () => {
  it('validates a durable progress checkpoint', () => {
    const checkpoint: RuntimeCheckpointV1 = {
      version: 1,
      id: 9,
      tenantId: 1,
      executionId: 4,
      sequence: 3,
      kind: 'progress',
      state: 'running',
      sessionId: 'session-42',
      boundaryFingerprint: 'sha256:boundary',
      transcriptCursor: { line: 91 },
      data: { heartbeat: true },
      createdAt: '2026-08-04T12:00:00.000Z',
    };
    expect(validateRuntimeCheckpointV1(checkpoint)).toEqual({ ok: true, issues: [] });
  });
});
